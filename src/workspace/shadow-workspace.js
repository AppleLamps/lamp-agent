import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const COPY_EXCLUDES = [".git", ".agent", "node_modules", "dist", "build", ".next", "coverage"];

export async function createShadowWorkspace(cwd, activeTask, options = {}) {
  const root = options.root || path.join(cwd, ".agent", "shadow-workspaces");
  await mkdir(root, { recursive: true });

  if (await exists(path.join(cwd, ".git"))) {
    const worktreePath = path.join(root, activeTask.id);
    const result = await runShell(`git worktree add --detach "${worktreePath}" HEAD`, cwd);
    if (result.code === 0) {
      return writeShadowMetadata(activeTask, {
        type: "git-worktree",
        path: worktreePath,
        repo_root: cwd,
        created_at: new Date().toISOString(),
        cleanup: `git worktree remove "${worktreePath}"`,
        command: "git worktree add --detach <path> HEAD"
      });
    }
  }

  const copyPath = path.join(options.copyRoot || tmpdir(), `lamp-agent-shadow-${activeTask.id}`);
  await rm(copyPath, { recursive: true, force: true });
  await cp(cwd, copyPath, {
    recursive: true,
    filter(source) {
      const relative = path.relative(cwd, source).replaceAll("\\", "/");
      return !COPY_EXCLUDES.some((excluded) => relative === excluded || relative.startsWith(`${excluded}/`));
    }
  });

  return writeShadowMetadata(activeTask, {
    type: "temporary-copy",
    path: copyPath,
    repo_root: cwd,
    created_at: new Date().toISOString(),
    cleanup: `remove ${copyPath}`,
    excludes: COPY_EXCLUDES
  });
}

export async function cleanupShadowWorkspace(metadata) {
  if (!metadata?.path) return { ok: false, message: "No shadow workspace path." };
  if (metadata.type === "git-worktree") {
    const result = await runShell(`git worktree remove "${metadata.path}" --force`, metadata.repo_root || path.dirname(metadata.path));
    return { ok: result.code === 0, ...result };
  }
  await rm(metadata.path, { recursive: true, force: true });
  return { ok: true };
}

export async function applyShadowWorkspaceChanges({ activeTask, shadow, targetRoot }) {
  if (!shadow?.path) return { ok: false, message: "No shadow workspace to apply." };
  const changedFiles = await readJson(path.join(activeTask.dir, "changed-files.json"), []);
  const conflicts = await detectApplyBackConflicts({ activeTask, targetRoot, changedFiles });
  if (conflicts.length) {
    const metadata = {
      ok: false,
      message: "Real workspace changed while the shadow task was running.",
      conflicts,
      checked_at: new Date().toISOString()
    };
    await writeFile(path.join(activeTask.dir, "apply-back-conflicts.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    return metadata;
  }
  const applied = [];
  const removed = [];

  for (const relativePath of changedFiles) {
    const source = path.join(shadow.path, relativePath);
    const target = path.join(targetRoot, relativePath);
    if (await exists(source)) {
      await mkdir(path.dirname(target), { recursive: true });
      await cp(source, target, { force: true, recursive: true });
      applied.push(relativePath);
    } else {
      await rm(target, { force: true, recursive: true });
      removed.push(relativePath);
    }
  }

  const metadata = {
    ok: true,
    shadow_type: shadow.type,
    shadow_path: shadow.path,
    target_root: targetRoot,
    applied,
    removed,
    applied_at: new Date().toISOString()
  };
  await writeFile(path.join(activeTask.dir, "apply-back.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

export async function resolveApplyBackConflicts({ activeTask, shadow, targetRoot, resolutions }) {
  if (!shadow?.path) return { ok: false, message: "No shadow workspace to resolve." };
  const changedFiles = await readJson(path.join(activeTask.dir, "changed-files.json"), []);
  const conflicts = await detectApplyBackConflicts({ activeTask, targetRoot, changedFiles });
  const conflictPaths = new Set(conflicts.map((conflict) => conflict.path));
  const resolutionMap = normalizeResolutions(resolutions);
  const missing = conflicts.filter((conflict) => !resolutionMap.get(conflict.path));
  if (missing.length) {
    return {
      ok: false,
      message: "Every conflicted file needs an explicit resolution.",
      conflicts: await withConflictSummaries({ conflicts: missing, shadow, targetRoot })
    };
  }

  const applied = [];
  const removed = [];
  const kept_real = [];
  const saved_shadow = [];
  const conflict_summaries = await withConflictSummaries({ conflicts, shadow, targetRoot });

  for (const relativePath of changedFiles) {
    if (!conflictPaths.has(relativePath)) {
      const result = await applyShadowFile({ shadow, targetRoot, relativePath });
      if (result.removed) removed.push(relativePath);
      else applied.push(relativePath);
      continue;
    }

    const action = resolutionMap.get(relativePath);
    if (action === "keep_real") {
      kept_real.push(relativePath);
      continue;
    }
    if (action === "apply_shadow") {
      const result = await applyShadowFile({ shadow, targetRoot, relativePath });
      if (result.removed) removed.push(relativePath);
      else applied.push(relativePath);
      continue;
    }
    if (action === "save_shadow") {
      const saved = await saveShadowConflictCopy({ activeTask, shadow, relativePath });
      saved_shadow.push(saved);
      continue;
    }
    return { ok: false, message: `Unknown conflict resolution for ${relativePath}: ${action}` };
  }

  const metadata = {
    ok: true,
    shadow_type: shadow.type,
    shadow_path: shadow.path,
    target_root: targetRoot,
    applied,
    removed,
    kept_real,
    saved_shadow,
    conflicts: conflict_summaries,
    resolved_at: new Date().toISOString()
  };
  await writeFile(path.join(activeTask.dir, "apply-back-resolution.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  await writeFile(path.join(activeTask.dir, "apply-back.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

export async function detectApplyBackConflicts({ activeTask, targetRoot, changedFiles }) {
  const task = await readJson(path.join(activeTask.dir, "task.json"), {});
  const checkpointPath = task.checkpoint_path
    ? path.join(targetRoot, task.checkpoint_path)
    : null;
  const checkpoint = checkpointPath ? await readJson(checkpointPath, null) : null;
  const filesAtStart = new Map((checkpoint?.files || []).map((file) => [file.path, file]));
  const conflicts = [];

  for (const relativePath of changedFiles) {
    const start = filesAtStart.get(relativePath);
    const target = path.join(targetRoot, relativePath);
    const existsNow = await exists(target);
    if (!start && !existsNow) continue;
    if (!start && existsNow) {
      conflicts.push({
        path: relativePath,
        reason: "File was created in the real workspace while the shadow task was running."
      });
      continue;
    }
    if (start && !existsNow) {
      conflicts.push({
        path: relativePath,
        reason: "File was deleted in the real workspace while the shadow task was running."
      });
      continue;
    }
    const currentHash = await hashFile(target);
    if (currentHash !== start.hash) {
      conflicts.push({
        path: relativePath,
        reason: "File content changed in the real workspace while the shadow task was running."
      });
    }
  }

  return conflicts;
}

export async function summarizeApplyBackConflicts({ activeTask, shadow, targetRoot }) {
  const existing = await readJson(path.join(activeTask.dir, "apply-back-conflicts.json"), null);
  const conflicts = existing?.conflicts || await detectApplyBackConflicts({
    activeTask,
    targetRoot,
    changedFiles: await readJson(path.join(activeTask.dir, "changed-files.json"), [])
  });
  return {
    ok: true,
    conflicts: await withConflictSummaries({ conflicts, shadow, targetRoot })
  };
}

async function applyShadowFile({ shadow, targetRoot, relativePath }) {
  const source = path.join(shadow.path, relativePath);
  const target = path.join(targetRoot, relativePath);
  if (await exists(source)) {
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { force: true, recursive: true });
    return { applied: true };
  }
  await rm(target, { force: true, recursive: true });
  return { removed: true };
}

async function saveShadowConflictCopy({ activeTask, shadow, relativePath }) {
  const source = path.join(shadow.path, relativePath);
  const conflictRoot = path.join(activeTask.dir, "conflicts");
  const savedPath = path.join(conflictRoot, `${encodePath(relativePath)}.shadow`);
  await mkdir(path.dirname(savedPath), { recursive: true });
  if (await exists(source)) {
    await cp(source, savedPath, { force: true, recursive: true });
    return {
      path: relativePath,
      saved_path: path.relative(activeTask.dir, savedPath).replaceAll("\\", "/")
    };
  }
  const missingPath = `${savedPath}.missing`;
  await writeFile(missingPath, "");
  return {
    path: relativePath,
    saved_path: path.relative(activeTask.dir, missingPath).replaceAll("\\", "/"),
    shadow_missing: true
  };
}

async function withConflictSummaries({ conflicts, shadow, targetRoot }) {
  const summaries = [];
  for (const conflict of conflicts) {
    summaries.push({
      ...conflict,
      real: await fileSummary(path.join(targetRoot, conflict.path)),
      shadow: await fileSummary(path.join(shadow.path, conflict.path))
    });
  }
  return summaries;
}

async function fileSummary(filePath) {
  if (!(await exists(filePath))) return { exists: false };
  const content = await readFile(filePath);
  const text = content.toString("utf8");
  return {
    exists: true,
    size: content.length,
    hash: createHash("sha256").update(content).digest("hex"),
    preview: text.split(/\r?\n/).slice(0, 6).join("\n")
  };
}

function normalizeResolutions(resolutions) {
  if (resolutions instanceof Map) return resolutions;
  if (Array.isArray(resolutions)) {
    return new Map(resolutions.map((entry) => [entry.path, normalizeAction(entry.action)]));
  }
  return new Map(Object.entries(resolutions || {}).map(([file, action]) => [file, normalizeAction(action)]));
}

function normalizeAction(action) {
  return String(action || "").replaceAll("-", "_");
}

async function writeShadowMetadata(activeTask, metadata) {
  const filePath = path.join(activeTask.dir, "shadow-workspace.json");
  await writeFile(filePath, `${JSON.stringify(metadata, null, 2)}\n`);
  return { ok: true, ...metadata, metadata_path: filePath };
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function exists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function hashFile(filePath) {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function runShell(command, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function encodePath(relativePath) {
  return relativePath.replaceAll("\\", "/").replaceAll("/", "__");
}
