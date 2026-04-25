import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTask } from "../src/task/task-manager.js";
import { createToolRuntime } from "../src/tools/runtime.js";
import { critiqueTask } from "../src/review/critique.js";

test("critiqueTask writes review.md and flags no-change build tasks", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-"));
  try {
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    const activeTask = await createTask(cwd, "Add a profile page");
    const tools = createToolRuntime({
      cwd,
      config: config(),
      requestApproval: async () => ({ approved: true })
    });

    const critique = await critiqueTask({
      activeTask,
      tools,
      response: {
        message: "No changes made.",
        taskPatch: { assumptions: ["No model-backed implementation was attempted."] }
      },
      model: {
        critique: async () => ({ ok: false, message: "Model critique skipped in test." })
      },
      projectSummary: { fileCount: 1 }
    });

    assert.equal(critique.source, "local");
    assert.equal(critique.status, "reviewed");
    assert.equal(critique.findings.some((finding) => finding.text.includes("No files changed")), true);

    const review = await readFile(path.join(activeTask.dir, "review.md"), "utf8");
    assert.match(review, /# Review/);
    assert.match(review, /No files changed/);
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
