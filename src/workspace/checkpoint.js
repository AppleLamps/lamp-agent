import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";

const IGNORED_DIRS = new Set([".git", "node_modules", ".agent", "dist", "build", ".next", "coverage"]);

export async function createCheckpoint(cwd, taskId) {
  const now = new Date();
  const id = `checkpoint-${formatTimestamp(now)}`;
  const checkpointDir = path.join(cwd, ".agent", "checkpoints");
  await mkdir(checkpointDir, { recursive: true });

  const isGitRepo = await exists(path.join(cwd, ".git"));
  const files = [];
  await walk(cwd, cwd, files);
  const packageManager = await detectPackageManager(cwd);
  const gitStatus = isGitRepo ? await runShell("git status --short", cwd) : null;

  const checkpoint = {
    id,
    task_id: taskId,
    created_at: now.toISOString(),
    workspace_root: cwd,
    workspace_type: isGitRepo ? "git" : "plain-directory",
    git_status: gitStatus?.stdout?.trim() || null,
    package_manager: packageManager,
    file_count: files.length,
    files
  };

  const checkpointPath = path.join(checkpointDir, `${id}.json`);
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
  return { id, path: checkpointPath, checkpoint };
}

export async function summarizeSnapshotDiff(activeTask, cwd) {
  const changed = await readJson(path.join(activeTask.dir, "changed-files.json"), []);
  const summaries = [];

  for (const relativePath of changed) {
    const snapshotPath = path.join(activeTask.dir, "snapshots", encodePath(relativePath));
    const missingSnapshotPath = `${snapshotPath}.missing`;
    const currentPath = path.join(cwd, relativePath);
    const beforeMissing = await exists(missingSnapshotPath);
    const before = beforeMissing ? "" : await readTextIfExists(snapshotPath);
    const after = await readTextIfExists(currentPath);
    const afterMissing = !(await exists(currentPath));
    summaries.push(diffText(relativePath, before, after, beforeMissing, afterMissing));
  }

  return {
    ok: true,
    changed_files: changed,
    summary: summaries
  };
}

function diffText(relativePath, before, after, beforeMissing, afterMissing) {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const max = Math.max(beforeLines.length, afterLines.length);
  let added = 0;
  let removed = 0;
  let changed = 0;
  const preview = [];

  for (let index = 0; index < max; index += 1) {
    const oldLine = beforeLines[index];
    const newLine = afterLines[index];
    if (oldLine === newLine) continue;
    if (oldLine === undefined) {
      added += 1;
      pushPreview(preview, `+${newLine}`);
    } else if (newLine === undefined) {
      removed += 1;
      pushPreview(preview, `-${oldLine}`);
    } else {
      changed += 1;
      pushPreview(preview, `-${oldLine}`);
      pushPreview(preview, `+${newLine}`);
    }
  }

  return {
    path: relativePath,
    status: beforeMissing ? "created" : afterMissing ? "deleted" : "modified",
    added,
    removed,
    changed,
    preview
  };
}

function pushPreview(preview, line) {
  if (preview.length < 12) preview.push(line.length > 220 ? `${line.slice(0, 220)}...` : line);
}

function splitLines(content) {
  if (!content) return [];
  const normalized = content.replace(/\r\n/g, "\n");
  return normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n");
}

async function walk(root, cwd, files) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const absolute = path.join(root, entry.name);
    const relative = path.relative(cwd, absolute).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      await walk(absolute, cwd, files);
    } else {
      const info = await stat(absolute);
      files.push({
        path: relative,
        size: info.size,
        hash: await hashFile(absolute),
        modified_at: info.mtime.toISOString()
      });
    }
  }
}

async function hashFile(filePath) {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

async function detectPackageManager(cwd) {
  if (await exists(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(path.join(cwd, "yarn.lock"))) return "yarn";
  if (await exists(path.join(cwd, "bun.lockb"))) return "bun";
  if (await exists(path.join(cwd, "package-lock.json"))) return "npm";
  if (await exists(path.join(cwd, "package.json"))) return "npm";
  return null;
}

async function readTextIfExists(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function encodePath(relativePath) {
  return relativePath.replaceAll("\\", "/").replaceAll("/", "__");
}

async function exists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("") + "-" + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
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
