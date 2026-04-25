import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyFilePatch, parseUnifiedPatch } from "../src/patch/patch-engine.js";
import { createToolRuntime } from "../src/tools/runtime.js";

test("applies a unified patch to existing content", () => {
  const [filePatch] = parseUnifiedPatch(`--- a/example.txt
+++ b/example.txt
@@ -1,3 +1,3 @@
 alpha
-beta
+bravo
 gamma
`);

  const result = applyFilePatch("alpha\nbeta\ngamma\n", filePatch);
  assert.equal(result, "alpha\nbravo\ngamma\n");
});

test("runtime applyPatchTracked snapshots and changes files", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-"));
  try {
    await writeFile(path.join(cwd, "example.txt"), "alpha\nbeta\ngamma\n");
    const activeTask = { id: "task-test", dir: path.join(cwd, ".agent", "tasks", "task-test") };
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
    assert.equal(await readFile(path.join(cwd, "example.txt"), "utf8"), "alpha\nbravo\ngamma\n");
    assert.deepEqual(
      JSON.parse(await readFile(path.join(activeTask.dir, "changed-files.json"), "utf8")),
      ["example.txt"]
    );
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
