import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTask } from "../src/task/task-manager.js";
import { createToolRuntime } from "../src/tools/runtime.js";
import {
  applyShadowWorkspaceChanges,
  cleanupShadowWorkspace,
  createShadowWorkspace,
  resolveApplyBackConflicts,
  summarizeApplyBackConflicts
} from "../src/workspace/shadow-workspace.js";

test("createShadowWorkspace falls back to filtered temporary copy", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-"));
  const copyRoot = await mkdtemp(path.join(tmpdir(), "lamp-agent-shadow-root-"));
  try {
    await writeFile(path.join(cwd, "package.json"), "{}");
    await mkdir(path.join(cwd, "node_modules"), { recursive: true });
    await writeFile(path.join(cwd, "node_modules", "ignored.txt"), "ignore");
    const activeTask = await createTask(cwd, "Create shadow");

    const shadow = await createShadowWorkspace(cwd, activeTask, { copyRoot });

    assert.equal(shadow.ok, true);
    assert.equal(shadow.type, "temporary-copy");
    assert.equal(await exists(path.join(shadow.path, "package.json")), true);
    assert.equal(await exists(path.join(shadow.path, "node_modules")), false);
    assert.equal(await exists(path.join(shadow.path, ".agent")), false);

    const metadata = JSON.parse(await readFile(path.join(activeTask.dir, "shadow-workspace.json"), "utf8"));
    assert.equal(metadata.path, shadow.path);

    const cleanup = await cleanupShadowWorkspace(shadow);
    assert.equal(cleanup.ok, true);
    assert.equal(await exists(shadow.path), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(copyRoot, { recursive: true, force: true });
  }
});

test("applyShadowWorkspaceChanges copies tracked shadow changes back to target", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-"));
  const copyRoot = await mkdtemp(path.join(tmpdir(), "lamp-agent-shadow-root-"));
  try {
    await writeFile(path.join(cwd, "example.txt"), "alpha\nbeta\n");
    const activeTask = await createTask(cwd, "Change example");
    const shadow = await createShadowWorkspace(cwd, activeTask, { copyRoot });
    const shadowTools = createToolRuntime({
      cwd: shadow.path,
      config: config(),
      requestApproval: async () => ({ approved: true })
    });

    const patch = await shadowTools.applyPatchTracked(activeTask, `--- a/example.txt
+++ b/example.txt
@@ -1,2 +1,2 @@
 alpha
-beta
+bravo
`);
    assert.equal(patch.ok, true);
    assert.equal(await readFile(path.join(cwd, "example.txt"), "utf8"), "alpha\nbeta\n");

    const applied = await applyShadowWorkspaceChanges({ activeTask, shadow, targetRoot: cwd });
    assert.equal(applied.ok, true);
    assert.deepEqual(applied.applied, ["example.txt"]);
    assert.equal(await readFile(path.join(cwd, "example.txt"), "utf8"), "alpha\nbravo\n");

    const metadata = JSON.parse(await readFile(path.join(activeTask.dir, "apply-back.json"), "utf8"));
    assert.equal(metadata.shadow_path, shadow.path);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(copyRoot, { recursive: true, force: true });
  }
});

test("applyShadowWorkspaceChanges blocks when real workspace file changed", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-"));
  const copyRoot = await mkdtemp(path.join(tmpdir(), "lamp-agent-shadow-root-"));
  try {
    await writeFile(path.join(cwd, "example.txt"), "alpha\nbeta\n");
    const activeTask = await createTask(cwd, "Change example");
    const shadow = await createShadowWorkspace(cwd, activeTask, { copyRoot });
    const shadowTools = createToolRuntime({
      cwd: shadow.path,
      config: config(),
      requestApproval: async () => ({ approved: true })
    });

    const patch = await shadowTools.applyPatchTracked(activeTask, `--- a/example.txt
+++ b/example.txt
@@ -1,2 +1,2 @@
 alpha
-beta
+bravo
`);
    assert.equal(patch.ok, true);
    await writeFile(path.join(cwd, "example.txt"), "alpha\nreal edit\n");

    const applied = await applyShadowWorkspaceChanges({ activeTask, shadow, targetRoot: cwd });
    assert.equal(applied.ok, false);
    assert.equal(applied.conflicts[0].path, "example.txt");
    assert.match(applied.conflicts[0].reason, /changed/);
    assert.equal(await readFile(path.join(cwd, "example.txt"), "utf8"), "alpha\nreal edit\n");

    const metadata = JSON.parse(await readFile(path.join(activeTask.dir, "apply-back-conflicts.json"), "utf8"));
    assert.equal(metadata.conflicts[0].path, "example.txt");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(copyRoot, { recursive: true, force: true });
  }
});

test("summarizeApplyBackConflicts shows real and shadow summaries", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-"));
  const copyRoot = await mkdtemp(path.join(tmpdir(), "lamp-agent-shadow-root-"));
  try {
    const { activeTask, shadow } = await createConflictedShadowEdit({ cwd, copyRoot });
    await applyShadowWorkspaceChanges({ activeTask, shadow, targetRoot: cwd });

    const summary = await summarizeApplyBackConflicts({ activeTask, shadow, targetRoot: cwd });
    assert.equal(summary.ok, true);
    assert.equal(summary.conflicts[0].path, "example.txt");
    assert.match(summary.conflicts[0].real.preview, /real edit/);
    assert.match(summary.conflicts[0].shadow.preview, /bravo/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(copyRoot, { recursive: true, force: true });
  }
});

test("resolveApplyBackConflicts can keep the real workspace version", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-"));
  const copyRoot = await mkdtemp(path.join(tmpdir(), "lamp-agent-shadow-root-"));
  try {
    const { activeTask, shadow } = await createConflictedShadowEdit({ cwd, copyRoot });

    const resolved = await resolveApplyBackConflicts({
      activeTask,
      shadow,
      targetRoot: cwd,
      resolutions: { "example.txt": "keep_real" }
    });

    assert.equal(resolved.ok, true);
    assert.deepEqual(resolved.kept_real, ["example.txt"]);
    assert.equal(await readFile(path.join(cwd, "example.txt"), "utf8"), "alpha\nreal edit\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(copyRoot, { recursive: true, force: true });
  }
});

test("resolveApplyBackConflicts can explicitly apply the shadow version", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-"));
  const copyRoot = await mkdtemp(path.join(tmpdir(), "lamp-agent-shadow-root-"));
  try {
    const { activeTask, shadow } = await createConflictedShadowEdit({ cwd, copyRoot });

    const resolved = await resolveApplyBackConflicts({
      activeTask,
      shadow,
      targetRoot: cwd,
      resolutions: { "example.txt": "apply_shadow" }
    });

    assert.equal(resolved.ok, true);
    assert.deepEqual(resolved.applied, ["example.txt"]);
    assert.equal(await readFile(path.join(cwd, "example.txt"), "utf8"), "alpha\nbravo\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(copyRoot, { recursive: true, force: true });
  }
});

test("resolveApplyBackConflicts can save the shadow version aside", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-"));
  const copyRoot = await mkdtemp(path.join(tmpdir(), "lamp-agent-shadow-root-"));
  try {
    const { activeTask, shadow } = await createConflictedShadowEdit({ cwd, copyRoot });

    const resolved = await resolveApplyBackConflicts({
      activeTask,
      shadow,
      targetRoot: cwd,
      resolutions: { "example.txt": "save_shadow" }
    });

    assert.equal(resolved.ok, true);
    assert.equal(await readFile(path.join(cwd, "example.txt"), "utf8"), "alpha\nreal edit\n");
    const savedPath = path.join(activeTask.dir, resolved.saved_shadow[0].saved_path);
    assert.equal(await readFile(savedPath, "utf8"), "alpha\nbravo\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(copyRoot, { recursive: true, force: true });
  }
});

test("resolveApplyBackConflicts applies clean files while resolving conflicted files", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-"));
  const copyRoot = await mkdtemp(path.join(tmpdir(), "lamp-agent-shadow-root-"));
  try {
    await writeFile(path.join(cwd, "example.txt"), "alpha\nbeta\n");
    await writeFile(path.join(cwd, "clean.txt"), "one\ntwo\n");
    const activeTask = await createTask(cwd, "Change files");
    const shadow = await createShadowWorkspace(cwd, activeTask, { copyRoot });
    const shadowTools = createToolRuntime({
      cwd: shadow.path,
      config: config(),
      requestApproval: async () => ({ approved: true })
    });

    await shadowTools.replaceExactTracked(activeTask, "example.txt", "beta", "bravo");
    await shadowTools.replaceExactTracked(activeTask, "clean.txt", "two", "three");
    await writeFile(path.join(cwd, "example.txt"), "alpha\nreal edit\n");

    const resolved = await resolveApplyBackConflicts({
      activeTask,
      shadow,
      targetRoot: cwd,
      resolutions: { "example.txt": "keep_real" }
    });

    assert.equal(resolved.ok, true);
    assert.equal(await readFile(path.join(cwd, "example.txt"), "utf8"), "alpha\nreal edit\n");
    assert.equal(await readFile(path.join(cwd, "clean.txt"), "utf8"), "one\nthree\n");
    assert.ok(resolved.applied.includes("clean.txt"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(copyRoot, { recursive: true, force: true });
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

async function exists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function createConflictedShadowEdit({ cwd, copyRoot }) {
  await writeFile(path.join(cwd, "example.txt"), "alpha\nbeta\n");
  const activeTask = await createTask(cwd, "Change example");
  const shadow = await createShadowWorkspace(cwd, activeTask, { copyRoot });
  const shadowTools = createToolRuntime({
    cwd: shadow.path,
    config: config(),
    requestApproval: async () => ({ approved: true })
  });

  const patch = await shadowTools.applyPatchTracked(activeTask, `--- a/example.txt
+++ b/example.txt
@@ -1,2 +1,2 @@
 alpha
-beta
+bravo
`);
  assert.equal(patch.ok, true);
  await writeFile(path.join(cwd, "example.txt"), "alpha\nreal edit\n");
  return { activeTask, shadow };
}
