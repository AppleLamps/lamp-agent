import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTask } from "../src/task/task-manager.js";
import { createToolRuntime } from "../src/tools/runtime.js";
import { verifyAndRepair } from "../src/verify/repair-loop.js";

test("verifyAndRepair reruns checks after a successful repair", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-"));
  try {
    await writeFile(path.join(cwd, "flag.txt"), "fail");
    await writeFile(path.join(cwd, "check.js"), "const fs=require('fs'); process.exit(fs.readFileSync('flag.txt','utf8') === 'pass' ? 0 : 1);");
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node check.js" } }));
    const activeTask = await createTask(cwd, "Fix failing test");
    const tools = createToolRuntime({ cwd, config: config(), requestApproval: async () => ({ approved: true }) });
    const model = {
      repair: async () => {
        await tools.writeFileTracked(activeTask, "flag.txt", "pass");
        return { ok: true, message: "Updated flag." };
      }
    };

    const result = await verifyAndRepair({
      activeTask,
      tools,
      model,
      userRequest: "Fix failing test",
      projectSummary: {},
      maxAttempts: 3
    });

    assert.equal(result.status, "passed");
    assert.equal(result.attempts.length, 1);
    assert.equal(JSON.parse(await readFile(path.join(activeTask.dir, "check-results.json"), "utf8")).length, 2);
    const verification = JSON.parse(await readFile(path.join(activeTask.dir, "verification.json"), "utf8"));
    assert.equal(verification.status, "passed");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("verifyAndRepair passes a summarized structured failure into model.repair", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-"));
  try {
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({
      scripts: { test: "node -e \"console.error('FAIL src/api.test.js'); process.exit(1)\"" }
    }));
    const activeTask = await createTask(cwd, "Inspect repair payload");
    const tools = createToolRuntime({ cwd, config: config(), requestApproval: async () => ({ approved: true }) });

    let captured = null;
    const model = {
      repair: async (args) => {
        captured = args;
        return { ok: false, noop: true, message: "stub: stop after one attempt." };
      }
    };

    await verifyAndRepair({
      activeTask,
      tools,
      model,
      userRequest: "Inspect repair payload",
      projectSummary: {},
      maxAttempts: 1
    });

    assert.ok(captured, "model.repair should have been invoked");
    assert.ok(Array.isArray(captured.failedChecks) && captured.failedChecks.length >= 1,
      "failedChecks should be present");
    const summary = captured.failedChecks[0];
    // The summarised shape carries the structured fields the model needs.
    assert.equal(summary.status, "failed");
    assert.ok("errors" in summary);
    assert.ok("failed_tests" in summary);
    assert.ok("likely_relevant_files" in summary,
      "likely_relevant_files should be present in the summary");
    // Each likely_relevant_files entry carries provenance, not just a path.
    if (summary.likely_relevant_files.length > 0) {
      const entry = summary.likely_relevant_files[0];
      assert.ok("path" in entry && "provenance" in entry,
        `entries should be {path, provenance}; got ${JSON.stringify(entry)}`);
    }
    // Audit-only fields are not in the model payload.
    assert.equal(summary.raw_stdout_path, undefined);
    assert.equal(summary.created_at, undefined);
    assert.equal(summary.id, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("verifyAndRepair passes the failed test import graph into model.repair", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-"));
  try {
    const activeTask = await createTask(cwd, "Fix failing import-backed test");
    const tools = {
      runAvailableChecks: async () => [{
        name: "test",
        ok: false,
        parsed: {
          check_type: "test",
          status: "failed",
          failed_files: ["test/foo.test.js"],
          likely_relevant_files: ["src.js"]
        }
      }],
      getCodeIndex: async () => ({
        files: ["test/foo.test.js", "src.js", "helper.js", "test-setup.js"],
        imports: new Map([
          ["test/foo.test.js", [
            { source: "../src.js", names: [{ name: "foo", kind: "named" }], kind: "import", line: 1 },
            { source: "../helper.js", names: [{ name: "helper", kind: "named" }], kind: "import", line: 2 },
            { source: "../test-setup.js", names: [{ name: "ready", kind: "named" }], kind: "import", line: 3 },
            { source: "node:test", names: [], kind: "import", line: 4 }
          ]]
        ])
      })
    };

    let captured = null;
    const model = {
      repair: async (args) => {
        captured = args;
        return { ok: false, noop: true, message: "stub: stop after one attempt." };
      }
    };

    await verifyAndRepair({
      activeTask,
      tools,
      model,
      userRequest: "Fix failing import-backed test",
      projectSummary: {},
      maxAttempts: 1
    });

    const summary = captured.failedChecks[0];
    assert.deepEqual(summary.import_graph, {
      "test/foo.test.js": ["src.js", "helper.js", "test-setup.js"]
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("verifyAndRepair records failure when repair is unavailable", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-"));
  try {
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({
      scripts: { test: "node -e \"process.exit(1)\"" }
    }));
    const activeTask = await createTask(cwd, "Fix failing test");
    const tools = createToolRuntime({ cwd, config: config(), requestApproval: async () => ({ approved: true }) });

    const result = await verifyAndRepair({
      activeTask,
      tools,
      model: { repair: async () => ({ ok: false, noop: true, message: "No model." }) },
      userRequest: "Fix failing test",
      projectSummary: {},
      maxAttempts: 3
    });

    assert.equal(result.status, "failed");
    assert.equal(result.attempts.length, 1);
    const verification = JSON.parse(await readFile(path.join(activeTask.dir, "verification.json"), "utf8"));
    assert.equal(verification.status, "failed");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

function config() {
  return {
    permissions: {
      allowLocalChecks: true,
      allowLocalEdits: true
    }
  };
}
