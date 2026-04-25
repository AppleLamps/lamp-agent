// E2E test stub for the lamp-agent model adapter.
//
// This module is loaded by the spawned CLI process when the test driver
// sets `LAMP_MODEL_ADAPTER=<absolute path to this file>`. The script the
// stub follows is read from the JSON file pointed at by `LAMP_STUB_SCRIPT`.
// The script shape is:
//
//   {
//     "respond":  { "steps": [ ... ], "message": "...", "taskPatch": {...} },
//     "repair":   { "steps": [ ... ], "ok": true,  "message": "...", "noop": false },
//     "critique": { "ok": true, "message": "...", "structured": {...} }
//   }
//
// Each step has shape `{ tool: <name>, args: { ... } }` and is invoked
// against the `tools` object passed to `respond` / `repair`. Steps run
// sequentially. If a tool returns `{ blocked: true, ... }` and the step
// has `bail_on_blocked: true`, the loop stops.
//
// The stub bypasses the openrouter.js phase-tool restriction (it calls
// tools directly), which is intentional for failure-mode testing — the
// goal is to exercise the permission engine, edit primitives, and
// verify-and-repair loop, not the per-phase tool filter.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  assertModelAdapter,
  normalizeModelCapabilities
} from "../../../src/model/adapter-contract.js";

const STUB_FILE = fileURLToPath(import.meta.url);

export async function createAdapter(modelConfig) {
  const scriptPath = process.env.LAMP_STUB_SCRIPT;
  if (!scriptPath) {
    throw new Error(
      `Stub adapter (${STUB_FILE}) requires LAMP_STUB_SCRIPT to point at a script JSON file.`
    );
  }
  const absolute = path.isAbsolute(scriptPath)
    ? scriptPath
    : path.resolve(process.cwd(), scriptPath);
  const script = JSON.parse(await readFile(absolute, "utf8"));

  const capabilities = normalizeModelCapabilities({
    provider: "stub",
    toolCalling: true,
    jsonMode: false,
    streaming: false,
    usage: false,
    maxContext: modelConfig?.maxContext ?? null
  });

  return assertModelAdapter({
    capabilities() {
      return capabilities;
    },

    async streamText() {
      return { ok: false, message: "Stub adapter does not support streaming." };
    },

    async respond({ tools, activeTask, onProgress = () => {} }) {
      const respondScript = script.respond || {};
      maybeThrow(respondScript, "respond");
      const toolResults = await runSteps(respondScript.steps || [], { tools, activeTask, onProgress, label: "stub respond" });
      return {
        message: respondScript.message || "Stub response: no message configured.",
        taskPatch: respondScript.taskPatch || {},
        stub: { tool_results: toolResults }
      };
    },

    async repair({ tools, activeTask, onProgress = () => {} }) {
      const repairScript = script.repair;
      if (!repairScript) {
        return {
          ok: false,
          noop: true,
          message: "Stub repair: no repair scripted (treating as no-op)."
        };
      }
      maybeThrow(repairScript, "repair");
      const toolResults = await runSteps(repairScript.steps || [], { tools, activeTask, onProgress, label: "stub repair" });
      return {
        ok: repairScript.ok ?? true,
        noop: repairScript.noop ?? false,
        message: repairScript.message || "Stub repair: no message configured.",
        stub: { tool_results: toolResults }
      };
    },

    async critique() {
      const critiqueScript = script.critique;
      if (!critiqueScript) {
        return { ok: false, message: "Stub critique: not configured (falling back to local critique)." };
      }
      maybeThrow(critiqueScript, "critique");
      return critiqueScript;
    }
  });
}

function maybeThrow(scriptSection, methodLabel) {
  const error = scriptSection?.throw;
  if (!error) return;
  const message = typeof error === "string" ? error : (error.message || `Stub adapter ${methodLabel} failure.`);
  const err = new Error(message);
  if (error && typeof error === "object" && error.code) err.code = error.code;
  throw err;
}

async function runSteps(steps, { tools, activeTask, onProgress, label }) {
  const results = [];
  for (const [index, step] of steps.entries()) {
    onProgress(`${label} step ${index + 1}: ${step.tool}`);
    const result = await runStubTool(step, tools, activeTask);
    results.push({
      tool: step.tool,
      args: step.args,
      ok: Boolean(result?.ok),
      blocked: Boolean(result?.blocked),
      skipped: Boolean(result?.skipped),
      message: result?.message
    });
    if (step.bail_on_blocked && (result?.blocked || result?.skipped)) break;
    if (step.bail_on_error && result?.ok === false) break;
  }
  return results;
}

async function runStubTool(step, tools, activeTask) {
  const args = step.args || {};
  switch (step.tool) {
    case "list_files":
      return tools.listFiles(args.path || ".");
    case "read_file":
      return tools.readFile(args.path);
    case "search_files":
      return tools.searchFiles(args.query, args.glob);
    case "apply_patch":
      return tools.applyPatchTracked(activeTask, args.patch);
    case "write_file":
      return tools.writeFileTracked(activeTask, args.path, args.content);
    case "create_file":
      return tools.createFileTracked(activeTask, args.path, args.content);
    case "delete_file":
      return tools.deleteFileTracked(activeTask, args.path);
    case "rename_file":
      return tools.renameFileTracked(activeTask, args.old_path, args.new_path);
    case "replace_range":
      return tools.replaceRangeTracked(activeTask, args.path, args.start_line, args.end_line, args.content);
    case "replace_exact":
      return tools.replaceExactTracked(activeTask, args.path, args.old_text, args.new_text);
    case "insert_before":
      return tools.insertBeforeTracked(activeTask, args.path, args.marker, args.content);
    case "insert_after":
      return tools.insertAfterTracked(activeTask, args.path, args.marker, args.content);
    case "run_command":
      return tools.runCommand(args.command, args.purpose || "Stub command", activeTask);
    case "run_available_checks":
      return tools.runAvailableChecks(activeTask);
    case "run_tests":
      return tools.runTests(activeTask);
    case "run_lint":
      return tools.runLint(activeTask);
    case "run_typecheck":
      return tools.runTypecheck(activeTask);
    case "run_build":
      return tools.runBuild(activeTask);
    case "git_status":
      return tools.gitStatus();
    case "git_diff":
      return tools.gitDiff();
    case "find_symbols":
      return tools.findSymbols(args.query || "", { kind: args.kind, limit: args.limit });
    case "find_definition":
      return tools.findDefinition(args.symbol);
    case "find_references":
      return tools.findReferences(args.symbol);
    case "find_imports":
      return tools.findImports(args.path);
    case "find_exports":
      return tools.findExports(args.path);
    case "route_map":
      return tools.routeMap();
    case "detect_test_runner":
      return tools.detectTestRunner();
    case "run_test_file":
      return tools.runTestFile(args.path, activeTask);
    case "run_test_name":
      return tools.runTestName(args.name, activeTask);
    case "run_related_tests":
      return tools.runRelatedTests(args.path, activeTask);
    default:
      throw new Error(`Stub adapter does not handle tool: ${step.tool}`);
  }
}
