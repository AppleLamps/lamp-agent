import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createToolRuntime } from "../src/tools/runtime.js";

function config() {
  return {
    permissions: {
      allowLocalChecks: true,
      allowLocalEdits: true
    }
  };
}

async function makeWorkspace() {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-edit-"));
  const activeTask = { id: "task-edit", dir: path.join(cwd, ".agent", "tasks", "task-edit") };
  await mkdir(activeTask.dir, { recursive: true });
  return { cwd, activeTask };
}

function newRuntime(cwd, approvals = []) {
  return createToolRuntime({
    cwd,
    config: config(),
    requestApproval: async (decision) => {
      approvals.push(decision.tier);
      return { approved: true };
    }
  });
}

async function exists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readChangedFiles(activeTask) {
  return JSON.parse(await readFile(path.join(activeTask.dir, "changed-files.json"), "utf8"));
}

test("create_file writes a new file and tracks it", async () => {
  const { cwd, activeTask } = await makeWorkspace();
  try {
    const tools = newRuntime(cwd);
    const result = await tools.createFileTracked(activeTask, "src/new.txt", "hello\n");
    assert.equal(result.ok, true);
    assert.equal(await readFile(path.join(cwd, "src/new.txt"), "utf8"), "hello\n");
    assert.deepEqual(await readChangedFiles(activeTask), ["src/new.txt"]);
    const missingMarker = path.join(activeTask.dir, "snapshots", "src__new.txt.missing");
    assert.equal(await exists(missingMarker), true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("create_file errors when the file already exists", async () => {
  const { cwd, activeTask } = await makeWorkspace();
  try {
    await writeFile(path.join(cwd, "x.txt"), "old\n");
    const tools = newRuntime(cwd);
    const result = await tools.createFileTracked(activeTask, "x.txt", "new\n");
    assert.equal(result.ok, false);
    assert.match(result.message, /already exists/);
    assert.equal(await readFile(path.join(cwd, "x.txt"), "utf8"), "old\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("delete_file snapshots and removes a file, and undo restores it", async () => {
  const { cwd, activeTask } = await makeWorkspace();
  try {
    await writeFile(path.join(cwd, "doomed.txt"), "keep me\n");
    const tools = newRuntime(cwd);
    const result = await tools.deleteFileTracked(activeTask, "doomed.txt");
    assert.equal(result.ok, true);
    assert.equal(await exists(path.join(cwd, "doomed.txt")), false);

    const undo = await tools.undoTask(activeTask);
    assert.equal(undo.ok, true);
    assert.equal(await readFile(path.join(cwd, "doomed.txt"), "utf8"), "keep me\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("delete_file rejects when approval for delete is denied", async () => {
  const { cwd, activeTask } = await makeWorkspace();
  try {
    await writeFile(path.join(cwd, "keep.txt"), "stay\n");
    const tools = createToolRuntime({
      cwd,
      config: config(),
      requestApproval: async (decision) => decision.tier === "delete_file" ? { approved: false } : { approved: true }
    });
    const result = await tools.deleteFileTracked(activeTask, "keep.txt");
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.equal(await readFile(path.join(cwd, "keep.txt"), "utf8"), "stay\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("rename_file moves a file and tracks both paths", async () => {
  const { cwd, activeTask } = await makeWorkspace();
  try {
    await writeFile(path.join(cwd, "old.txt"), "data\n");
    const tools = newRuntime(cwd);
    const result = await tools.renameFileTracked(activeTask, "old.txt", "renamed/new.txt");
    assert.equal(result.ok, true);
    assert.equal(await exists(path.join(cwd, "old.txt")), false);
    assert.equal(await readFile(path.join(cwd, "renamed/new.txt"), "utf8"), "data\n");
    const changed = await readChangedFiles(activeTask);
    assert.deepEqual(changed.sort(), ["old.txt", "renamed/new.txt"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("rename_file errors when the destination already exists", async () => {
  const { cwd, activeTask } = await makeWorkspace();
  try {
    await writeFile(path.join(cwd, "a.txt"), "a\n");
    await writeFile(path.join(cwd, "b.txt"), "b\n");
    const tools = newRuntime(cwd);
    const result = await tools.renameFileTracked(activeTask, "a.txt", "b.txt");
    assert.equal(result.ok, false);
    assert.match(result.message, /already exists/);
    assert.equal(await readFile(path.join(cwd, "a.txt"), "utf8"), "a\n");
    assert.equal(await readFile(path.join(cwd, "b.txt"), "utf8"), "b\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("replace_range swaps lines inclusive and preserves trailing newline", async () => {
  const { cwd, activeTask } = await makeWorkspace();
  try {
    await writeFile(path.join(cwd, "f.txt"), "one\ntwo\nthree\nfour\n");
    const tools = newRuntime(cwd);
    const result = await tools.replaceRangeTracked(activeTask, "f.txt", 2, 3, "TWO\nTHREE\n");
    assert.equal(result.ok, true);
    assert.equal(result.replaced_lines, 2);
    assert.equal(result.new_lines, 2);
    assert.equal(await readFile(path.join(cwd, "f.txt"), "utf8"), "one\nTWO\nTHREE\nfour\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("replace_range can delete a range with empty content", async () => {
  const { cwd, activeTask } = await makeWorkspace();
  try {
    await writeFile(path.join(cwd, "f.txt"), "a\nb\nc\n");
    const tools = newRuntime(cwd);
    const result = await tools.replaceRangeTracked(activeTask, "f.txt", 2, 2, "");
    assert.equal(result.ok, true);
    assert.equal(await readFile(path.join(cwd, "f.txt"), "utf8"), "a\nc\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("replace_range rejects invalid ranges", async () => {
  const { cwd, activeTask } = await makeWorkspace();
  try {
    await writeFile(path.join(cwd, "f.txt"), "a\nb\n");
    const tools = newRuntime(cwd);
    const beyondEnd = await tools.replaceRangeTracked(activeTask, "f.txt", 1, 5, "x\n");
    assert.equal(beyondEnd.ok, false);
    assert.match(beyondEnd.message, /beyond file length/);

    const inverted = await tools.replaceRangeTracked(activeTask, "f.txt", 2, 1, "x\n");
    assert.equal(inverted.ok, false);
    assert.match(inverted.message, /Invalid range/);

    const missing = await tools.replaceRangeTracked(activeTask, "no-such.txt", 1, 1, "x\n");
    assert.equal(missing.ok, false);
    assert.match(missing.message, /does not exist/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("replace_exact replaces a unique snippet", async () => {
  const { cwd, activeTask } = await makeWorkspace();
  try {
    await writeFile(path.join(cwd, "f.txt"), "function add(a, b) { return a + b }\n");
    const tools = newRuntime(cwd);
    const result = await tools.replaceExactTracked(activeTask, "f.txt", "a + b", "a + b + 1");
    assert.equal(result.ok, true);
    assert.equal(await readFile(path.join(cwd, "f.txt"), "utf8"), "function add(a, b) { return a + b + 1 }\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("replace_exact errors when snippet is missing or ambiguous", async () => {
  const { cwd, activeTask } = await makeWorkspace();
  try {
    await writeFile(path.join(cwd, "f.txt"), "x x x\n");
    const tools = newRuntime(cwd);
    const ambiguous = await tools.replaceExactTracked(activeTask, "f.txt", "x", "y");
    assert.equal(ambiguous.ok, false);
    assert.equal(ambiguous.occurrences, 3);
    assert.match(ambiguous.message, /matched 3 times/);

    const missing = await tools.replaceExactTracked(activeTask, "f.txt", "z", "y");
    assert.equal(missing.ok, false);
    assert.match(missing.message, /not found/);
    assert.equal(await readFile(path.join(cwd, "f.txt"), "utf8"), "x x x\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("insert_before and insert_after add content at unique marker", async () => {
  const { cwd, activeTask } = await makeWorkspace();
  try {
    await writeFile(path.join(cwd, "f.txt"), "alpha\nMARKER\nomega\n");
    const tools = newRuntime(cwd);
    const before = await tools.insertBeforeTracked(activeTask, "f.txt", "MARKER", "before-line\n");
    assert.equal(before.ok, true);
    assert.equal(await readFile(path.join(cwd, "f.txt"), "utf8"), "alpha\nbefore-line\nMARKER\nomega\n");

    const after = await tools.insertAfterTracked(activeTask, "f.txt", "MARKER", "\nafter-line");
    assert.equal(after.ok, true);
    assert.equal(await readFile(path.join(cwd, "f.txt"), "utf8"), "alpha\nbefore-line\nMARKER\nafter-line\nomega\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("insert_before fails on missing or ambiguous marker", async () => {
  const { cwd, activeTask } = await makeWorkspace();
  try {
    await writeFile(path.join(cwd, "f.txt"), "x\nx\n");
    const tools = newRuntime(cwd);
    const ambiguous = await tools.insertBeforeTracked(activeTask, "f.txt", "x", "y\n");
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.message, /matched 2 times/);
    const missing = await tools.insertAfterTracked(activeTask, "f.txt", "z", "y\n");
    assert.equal(missing.ok, false);
    assert.match(missing.message, /not found/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("edit primitives respect the path permission denial", async () => {
  const { cwd, activeTask } = await makeWorkspace();
  try {
    await writeFile(path.join(cwd, ".env"), "SECRET=1\n");
    const tools = createToolRuntime({
      cwd,
      config: config(),
      requestApproval: async (decision) => decision.tier === "secret" ? { approved: false } : { approved: true }
    });
    const result = await tools.replaceExactTracked(activeTask, ".env", "SECRET=1", "SECRET=2");
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.equal(await readFile(path.join(cwd, ".env"), "utf8"), "SECRET=1\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
