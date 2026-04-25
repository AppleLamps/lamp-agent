import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTask } from "../src/task/task-manager.js";
import { createToolRuntime } from "../src/tools/runtime.js";

test("createTask records task-start checkpoint metadata", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-"));
  try {
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    const activeTask = await createTask(cwd, "Explain this project");
    const task = JSON.parse(await readFile(path.join(activeTask.dir, "task.json"), "utf8"));
    assert.match(task.checkpoint_id, /^checkpoint-/);
    assert.match(task.checkpoint_path, /^\.agent\/checkpoints\/checkpoint-/);

    const checkpoint = JSON.parse(await readFile(path.join(cwd, task.checkpoint_path), "utf8"));
    assert.equal(checkpoint.task_id, activeTask.id);
    assert.equal(checkpoint.workspace_type, "plain-directory");
    assert.equal(checkpoint.package_manager, "npm");
    assert.equal(checkpoint.file_count, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("taskDiff summarizes non-git snapshot changes", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-"));
  try {
    await writeFile(path.join(cwd, "example.txt"), "alpha\nbeta\ngamma\n");
    const activeTask = await createTask(cwd, "Change beta");
    const tools = createToolRuntime({
      cwd,
      config: config(),
      requestApproval: async () => ({ approved: true })
    });

    const result = await tools.applyPatchTracked(activeTask, `--- a/example.txt
+++ b/example.txt
@@ -1,3 +1,3 @@
 alpha
-beta
+bravo
 gamma
`);
    assert.equal(result.ok, true);

    const diff = await tools.taskDiff(activeTask);
    assert.equal(diff.ok, true);
    assert.equal(diff.source, "snapshots");
    assert.equal(diff.summary[0].path, "example.txt");
    assert.equal(diff.summary[0].status, "modified");
    assert.equal(diff.summary[0].changed, 1);
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
