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

test("runtime previewPatch projects the diff without writing", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-preview-"));
  try {
    await writeFile(path.join(cwd, "example.txt"), "alpha\nbeta\ngamma\n");
    const tools = createToolRuntime({
      cwd,
      config: config(),
      requestApproval: async () => ({ approved: true })
    });

    const result = await tools.previewPatch(`--- a/example.txt
+++ b/example.txt
@@ -1,3 +1,3 @@
 alpha
-beta
+bravo
 gamma
`);

    assert.equal(result.ok, true);
    assert.equal(result.previews.length, 1);
    const preview = result.previews[0];
    assert.equal(preview.path, "example.txt");
    assert.equal(preview.status, "modified");
    assert.equal(preview.changed, 1);
    assert.equal(preview.added, 0);
    assert.equal(preview.removed, 0);
    // Confirm nothing was actually written.
    assert.equal(
      await readFile(path.join(cwd, "example.txt"), "utf8"),
      "alpha\nbeta\ngamma\n",
      "preview must not write the file"
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runtime previewPatch reports parse errors without writing", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-preview-bad-"));
  try {
    const tools = createToolRuntime({
      cwd,
      config: config(),
      requestApproval: async () => ({ approved: true })
    });
    const result = await tools.previewPatch("not a patch");
    assert.equal(result.ok, false);
    assert.match(result.message, /Invalid patch|expected|--- /);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runtime previewPatch handles new-file creation cleanly", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-preview-new-"));
  try {
    const tools = createToolRuntime({
      cwd,
      config: config(),
      requestApproval: async () => ({ approved: true })
    });
    const result = await tools.previewPatch(`--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
`);
    assert.equal(result.ok, true);
    const preview = result.previews[0];
    assert.equal(preview.path, "new.txt");
    assert.equal(preview.status, "created");
    assert.equal(preview.added, 2);
    assert.equal(preview.before_size, 0);
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
