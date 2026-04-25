import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { requestStructuredPlan } from "../src/task/structured-plan.js";
import { requestStructuredEditSpec } from "../src/task/edit-spec.js";

function makeAdapter(impl) {
  return {
    capabilities: () => ({ provider: "stub", jsonMode: true }),
    streamText: async () => ({ ok: false }),
    respond: async () => ({ message: "stub" }),
    repair: async () => ({ ok: false }),
    critique: async () => ({ ok: false }),
    respondJson: impl
  };
}

async function makeTask() {
  const root = await mkdtemp(path.join(tmpdir(), "structured-task-"));
  const dir = path.join(root, ".agent", "tasks", "task-x");
  await mkdir(dir, { recursive: true });
  return {
    activeTask: { id: "task-x", dir },
    cleanup: () => rm(root, { recursive: true, force: true })
  };
}

test("requestStructuredPlan persists plan.json on a valid response", async () => {
  const { activeTask, cleanup } = await makeTask();
  try {
    const adapter = makeAdapter(async () => ({
      ok: true,
      raw: "{...}",
      structured: {
        summary: "Wire the login redirect.",
        steps: ["Inspect login.ts", "Update redirect", "Run tests"],
        risky_boundaries: ["network"],
        expected_files: ["src/auth/login.ts"],
        expected_checks: ["test"]
      }
    }));
    const result = await requestStructuredPlan({
      adapter,
      userRequest: "Fix login",
      projectSummary: { fileCount: 1 },
      riskyBoundaries: [],
      heuristicPlan: ["Inspect", "Patch"],
      activeTask
    });
    assert.equal(result.ok, true);
    assert.equal(result.source, "model");
    assert.equal(result.plan.summary, "Wire the login redirect.");
    const persisted = JSON.parse(await readFile(path.join(activeTask.dir, "plan.json"), "utf8"));
    assert.equal(persisted.steps.length, 3);
    const events = (await readFile(path.join(activeTask.dir, "events.jsonl"), "utf8")).trim();
    assert.match(events, /structured_plan_recorded/);
  } finally {
    await cleanup();
  }
});

test("requestStructuredPlan reports schema_invalid and writes no plan.json", async () => {
  const { activeTask, cleanup } = await makeTask();
  try {
    const adapter = makeAdapter(async () => ({
      ok: true,
      raw: "{}",
      structured: { steps: ["one"] } // missing summary
    }));
    const result = await requestStructuredPlan({
      adapter,
      userRequest: "x",
      projectSummary: {},
      riskyBoundaries: [],
      heuristicPlan: [],
      activeTask
    });
    assert.equal(result.ok, false);
    assert.equal(result.source, "schema_invalid");
    await assert.rejects(
      () => readFile(path.join(activeTask.dir, "plan.json"), "utf8"),
      /ENOENT/
    );
    const events = (await readFile(path.join(activeTask.dir, "events.jsonl"), "utf8")).trim();
    assert.match(events, /structured_plan_invalid/);
  } finally {
    await cleanup();
  }
});

test("requestStructuredPlan returns unsupported when adapter has no respondJson", async () => {
  const { activeTask, cleanup } = await makeTask();
  try {
    const adapter = {
      capabilities: () => ({}),
      streamText: async () => ({ ok: false }),
      respond: async () => ({}),
      repair: async () => ({}),
      critique: async () => ({})
    };
    const result = await requestStructuredPlan({
      adapter,
      userRequest: "x",
      projectSummary: {},
      riskyBoundaries: [],
      heuristicPlan: [],
      activeTask
    });
    assert.equal(result.ok, false);
    assert.equal(result.source, "unsupported");
  } finally {
    await cleanup();
  }
});

test("requestStructuredEditSpec persists edit-spec.json on a valid response", async () => {
  const { activeTask, cleanup } = await makeTask();
  try {
    const adapter = makeAdapter(async () => ({
      ok: true,
      raw: "{...}",
      structured: {
        summary: "Add a tiny helper",
        estimated_risk: "low",
        edits: [
          { tool: "create_file", path: "src/extra.js", intent: "introduce helper", args: { content: "..." } }
        ]
      }
    }));
    const result = await requestStructuredEditSpec({
      adapter,
      userRequest: "Add util",
      projectSummary: { fileCount: 1 },
      currentPlan: ["Add helper"],
      prePatchPlan: null,
      activeTask
    });
    assert.equal(result.ok, true);
    const spec = JSON.parse(await readFile(path.join(activeTask.dir, "edit-spec.json"), "utf8"));
    assert.equal(spec.edits[0].tool, "create_file");
    assert.equal(spec.estimated_risk, "low");
  } finally {
    await cleanup();
  }
});

test("requestStructuredEditSpec rejects an invalid tool entry", async () => {
  const { activeTask, cleanup } = await makeTask();
  try {
    const adapter = makeAdapter(async () => ({
      ok: true,
      raw: "{...}",
      structured: {
        summary: "Bad spec",
        edits: [{ intent: "no tool" }] // missing required tool
      }
    }));
    const result = await requestStructuredEditSpec({
      adapter,
      userRequest: "x",
      projectSummary: {},
      currentPlan: [],
      activeTask
    });
    assert.equal(result.ok, false);
    assert.equal(result.source, "schema_invalid");
  } finally {
    await cleanup();
  }
});
