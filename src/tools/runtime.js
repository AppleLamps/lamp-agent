import { access, appendFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { createPermissionEngine } from "../permissions/permission-engine.js";
import { applyFilePatch, parseUnifiedPatch } from "../patch/patch-engine.js";
import { summarizeSnapshotDiff } from "../workspace/checkpoint.js";
import { parseCheckOutput } from "../checks/check-parser.js";
import { detectTestRunner, findRelatedTestFiles } from "../checks/test-runner-detector.js";
import { appendEvent } from "../log/event-log.js";
import { buildCodeIndex, detectRoutes, findReferences as findReferencesIndex } from "../code/code-index.js";

const IGNORED_DIRS = new Set([".git", "node_modules", ".agent", "dist", "build", ".next", "coverage"]);

export function createToolRuntime({ cwd, config, requestApproval = denyApproval }) {
  const permissions = createPermissionEngine({ cwd, config });
  let cachedIndex = null;

  async function getCodeIndex() {
    if (cachedIndex) return cachedIndex;
    const all = [];
    await walk(cwd, all, cwd);
    cachedIndex = await buildCodeIndex({ cwd, files: all });
    return cachedIndex;
  }

  function invalidateCodeIndex() {
    cachedIndex = null;
  }

  return {
    cwd,
    config,
    permissions,

    async listFiles(relativePath = ".") {
      const allowed = permissions.classifyPath(relativePath, "read");
      const permission = await resolvePermission(allowed, requestApproval, { path: relativePath });
      if (!permission.approved) return denied(permission);
      const root = path.resolve(cwd, relativePath);
      const files = [];
      await walk(root, files, cwd);
      return { ok: true, files };
    },

    async readFile(relativePath) {
      const allowed = permissions.classifyPath(relativePath, "read");
      const permission = await resolvePermission(allowed, requestApproval, { path: relativePath });
      if (!permission.approved) return denied(permission);
      const content = await readFile(path.resolve(cwd, relativePath), "utf8");
      return { ok: true, content };
    },

    async searchFiles(query, glob) {
      const all = await this.listFiles(".");
      if (!all.ok) return all;
      const matches = [];
      const needle = query.toLowerCase();
      for (const file of all.files) {
        if (glob && !file.includes(glob)) continue;
        try {
          const content = await readFile(path.join(cwd, file), "utf8");
          const lines = content.split(/\r?\n/);
          lines.forEach((line, index) => {
            if (line.toLowerCase().includes(needle)) {
              matches.push({ path: file, line: index + 1, text: line.trim() });
            }
          });
        } catch {
          // Binary or unreadable files are skipped.
        }
      }
      return { ok: true, matches };
    },

    async writeFileTracked(activeTask, relativePath, content) {
      const allowed = permissions.classifyPath(relativePath, "write");
      const permission = await resolvePermission(allowed, requestApproval, { path: relativePath, taskId: activeTask?.id });
      if (!permission.approved) return denied(permission);
      await snapshotFile(activeTask, cwd, relativePath);
      const absolute = path.resolve(cwd, relativePath);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content);
      await trackChangedFile(activeTask, relativePath);
      invalidateCodeIndex();
      return { ok: true };
    },

    async createFileTracked(activeTask, relativePath, content) {
      const allowed = permissions.classifyPath(relativePath, "write");
      const permission = await resolvePermission(allowed, requestApproval, { path: relativePath, taskId: activeTask?.id });
      if (!permission.approved) return denied(permission);
      const absolute = path.resolve(cwd, relativePath);
      if (await exists(absolute)) {
        return { ok: false, message: `File already exists: ${relativePath}. Use write_file or replace_exact to modify it.` };
      }
      await snapshotFile(activeTask, cwd, relativePath);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content);
      await trackChangedFile(activeTask, relativePath);
      await logEditEvent(activeTask, "create_file", { path: relativePath, bytes: Buffer.byteLength(content) });
      invalidateCodeIndex();
      return { ok: true, path: relativePath };
    },

    async deleteFileTracked(activeTask, relativePath) {
      const allowed = permissions.classifyPath(relativePath, "write");
      const permission = await resolvePermission(allowed, requestApproval, { path: relativePath, taskId: activeTask?.id });
      if (!permission.approved) return denied(permission);
      const askDelete = await resolvePermission(
        decisionAsk("delete_file", "Deleting a workspace file is irreversible without snapshot restore."),
        requestApproval,
        { path: relativePath, taskId: activeTask?.id, operation: "delete_file" }
      );
      if (!askDelete.approved) return denied(askDelete);
      const absolute = path.resolve(cwd, relativePath);
      if (!(await exists(absolute))) {
        return { ok: false, message: `Cannot delete: file does not exist: ${relativePath}` };
      }
      await snapshotFile(activeTask, cwd, relativePath);
      await rm(absolute, { force: true });
      await trackChangedFile(activeTask, relativePath);
      await logEditEvent(activeTask, "delete_file", { path: relativePath });
      invalidateCodeIndex();
      return { ok: true, path: relativePath };
    },

    async renameFileTracked(activeTask, oldPath, newPath) {
      const fromAllowed = permissions.classifyPath(oldPath, "write");
      const fromPerm = await resolvePermission(fromAllowed, requestApproval, { path: oldPath, taskId: activeTask?.id });
      if (!fromPerm.approved) return denied(fromPerm);
      const toAllowed = permissions.classifyPath(newPath, "write");
      const toPerm = await resolvePermission(toAllowed, requestApproval, { path: newPath, taskId: activeTask?.id });
      if (!toPerm.approved) return denied(toPerm);

      const absoluteOld = path.resolve(cwd, oldPath);
      const absoluteNew = path.resolve(cwd, newPath);
      if (!(await exists(absoluteOld))) {
        return { ok: false, message: `Cannot rename: source does not exist: ${oldPath}` };
      }
      if (await exists(absoluteNew)) {
        return { ok: false, message: `Cannot rename: destination already exists: ${newPath}` };
      }
      const content = await readFile(absoluteOld, "utf8");
      await snapshotFile(activeTask, cwd, oldPath);
      await snapshotFile(activeTask, cwd, newPath);
      await mkdir(path.dirname(absoluteNew), { recursive: true });
      await writeFile(absoluteNew, content);
      await rm(absoluteOld, { force: true });
      await trackChangedFile(activeTask, oldPath);
      await trackChangedFile(activeTask, newPath);
      await logEditEvent(activeTask, "rename_file", { from: oldPath, to: newPath });
      invalidateCodeIndex();
      return { ok: true, from: oldPath, to: newPath };
    },

    async replaceRangeTracked(activeTask, relativePath, startLine, endLine, content) {
      const allowed = permissions.classifyPath(relativePath, "write");
      const permission = await resolvePermission(allowed, requestApproval, { path: relativePath, taskId: activeTask?.id });
      if (!permission.approved) return denied(permission);
      const absolute = path.resolve(cwd, relativePath);
      if (!(await exists(absolute))) {
        return { ok: false, message: `Cannot replace range: file does not exist: ${relativePath}` };
      }
      if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
        return { ok: false, message: `Invalid range: start_line=${startLine}, end_line=${endLine}. Both must be 1-indexed integers with end >= start.` };
      }
      const original = await readFile(absolute, "utf8");
      const trailingNewline = original.endsWith("\n");
      const lines = trailingNewline ? original.slice(0, -1).split("\n") : original.split("\n");
      if (endLine > lines.length) {
        return { ok: false, message: `Range end_line ${endLine} is beyond file length ${lines.length}.` };
      }
      const insertion = content.replace(/\r\n/g, "\n");
      const insertionLines = insertion === "" ? [] : (insertion.endsWith("\n") ? insertion.slice(0, -1).split("\n") : insertion.split("\n"));
      const next = [...lines.slice(0, startLine - 1), ...insertionLines, ...lines.slice(endLine)];
      const result = next.join("\n") + (trailingNewline && next.length > 0 ? "\n" : "");
      await snapshotFile(activeTask, cwd, relativePath);
      await writeFile(absolute, result);
      await trackChangedFile(activeTask, relativePath);
      await logEditEvent(activeTask, "replace_range", {
        path: relativePath,
        start_line: startLine,
        end_line: endLine,
        replaced_lines: endLine - startLine + 1,
        new_lines: insertionLines.length
      });
      invalidateCodeIndex();
      return {
        ok: true,
        path: relativePath,
        replaced_lines: endLine - startLine + 1,
        new_lines: insertionLines.length
      };
    },

    async replaceExactTracked(activeTask, relativePath, oldText, newText) {
      const allowed = permissions.classifyPath(relativePath, "write");
      const permission = await resolvePermission(allowed, requestApproval, { path: relativePath, taskId: activeTask?.id });
      if (!permission.approved) return denied(permission);
      const absolute = path.resolve(cwd, relativePath);
      if (!(await exists(absolute))) {
        return { ok: false, message: `Cannot replace: file does not exist: ${relativePath}` };
      }
      if (typeof oldText !== "string" || oldText.length === 0) {
        return { ok: false, message: "old_text must be a non-empty string." };
      }
      const original = await readFile(absolute, "utf8");
      const occurrences = countOccurrences(original, oldText);
      if (occurrences === 0) {
        return { ok: false, message: `old_text was not found in ${relativePath}.` };
      }
      if (occurrences > 1) {
        return {
          ok: false,
          message: `old_text matched ${occurrences} times in ${relativePath}. Provide a longer, unique snippet.`,
          occurrences
        };
      }
      const result = original.replace(oldText, () => newText);
      await snapshotFile(activeTask, cwd, relativePath);
      await writeFile(absolute, result);
      await trackChangedFile(activeTask, relativePath);
      await logEditEvent(activeTask, "replace_exact", {
        path: relativePath,
        old_length: oldText.length,
        new_length: newText.length
      });
      invalidateCodeIndex();
      return { ok: true, path: relativePath };
    },

    async insertBeforeTracked(activeTask, relativePath, marker, content) {
      const result = await insertAtMarker({
        permissions, requestApproval, cwd, activeTask,
        relativePath, marker, content, position: "before"
      });
      if (result.ok) invalidateCodeIndex();
      return result;
    },

    async insertAfterTracked(activeTask, relativePath, marker, content) {
      const result = await insertAtMarker({
        permissions, requestApproval, cwd, activeTask,
        relativePath, marker, content, position: "after"
      });
      if (result.ok) invalidateCodeIndex();
      return result;
    },

    async applyPatchTracked(activeTask, patchText) {
      let filePatches;
      try {
        filePatches = parseUnifiedPatch(patchText);
      } catch (error) {
        return { ok: false, message: error.message };
      }

      const changed = [];
      for (const filePatch of filePatches) {
        const relativePath = filePatch.path;
        const allowed = permissions.classifyPath(relativePath, "write");
        const permission = await resolvePermission(allowed, requestApproval, { path: relativePath, taskId: activeTask?.id });
        if (!permission.approved) return denied(permission);

        try {
          const current = await readWorkspaceFile(cwd, relativePath);
          const next = applyFilePatch(current, filePatch);
          await snapshotFile(activeTask, cwd, relativePath);
          const absolute = path.resolve(cwd, relativePath);
          await mkdir(path.dirname(absolute), { recursive: true });
          await writeFile(absolute, next);
          await trackChangedFile(activeTask, relativePath);
          changed.push(relativePath);
        } catch (error) {
          return { ok: false, changed, message: error.message };
        }
      }

      invalidateCodeIndex();
      return { ok: true, changed };
    },

    async runCommand(command, purpose = "Run command", activeTask = null) {
      const decision = permissions.classifyCommand(command);
      const permission = await resolvePermission(decision, requestApproval, { command, purpose, taskId: activeTask?.id });
      if (!permission.approved) {
        const result = denied(permission);
        await logCommand(activeTask, { command, purpose, status: "skipped", decision, result });
        return result;
      }
      const result = await runShell(command, cwd);
      const commandResult = { ok: result.code === 0, ...result, purpose, decision };
      await logCommand(activeTask, {
        command,
        purpose,
        status: commandResult.ok ? "passed" : "failed",
        decision,
        result: commandResult
      });
      return commandResult;
    },

    async detectPackageManager() {
      if (await exists(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
      if (await exists(path.join(cwd, "yarn.lock"))) return "yarn";
      if (await exists(path.join(cwd, "bun.lockb"))) return "bun";
      if (await exists(path.join(cwd, "package-lock.json"))) return "npm";
      if (await exists(path.join(cwd, "package.json"))) return "npm";
      return null;
    },

    async packageScripts() {
      const packagePath = path.join(cwd, "package.json");
      if (!(await exists(packagePath))) return {};
      const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
      return packageJson.scripts || {};
    },

    async gitStatus() {
      const gitDir = path.join(cwd, ".git");
      if (!(await exists(gitDir))) {
        const changed = await changedFilesFromAgent(cwd);
        return {
          ok: true,
          summary: changed.length
            ? `This is not a git repo. Tracked task changes: ${changed.join(", ")}`
            : "This is not a git repo, and no task changes are currently tracked."
        };
      }
      const result = await runShell("git status --short", cwd);
      return {
        ok: result.code === 0,
        summary: result.stdout.trim() || "Git working tree is clean.",
        ...result
      };
    },

    async gitDiff() {
      if (!(await exists(path.join(cwd, ".git")))) {
        return { ok: false, message: "This workspace is not a git repo." };
      }
      const result = await runShell("git diff", cwd);
      return { ok: result.code === 0, diff: result.stdout, ...result };
    },

    async taskDiff(activeTask) {
      if (!activeTask) return { ok: false, message: "No active task." };
      if (await exists(path.join(cwd, ".git"))) {
        const diff = await this.gitDiff();
        return {
          ...diff,
          source: "git"
        };
      }
      const diff = await summarizeSnapshotDiff(activeTask, cwd);
      return {
        ...diff,
        source: "snapshots"
      };
    },

    async runAvailableChecks(activeTask = null) {
      const scripts = await this.packageScripts();
      const manager = await this.detectPackageManager();
      if (!manager) return [{ name: "checks", skipped: true, message: "No package manager detected." }];
      const checks = ["test", "lint", "typecheck", "build"].filter((name) => scripts[name]);
      if (checks.length === 0) return [{ name: "checks", skipped: true, message: "No test, lint, typecheck, or build scripts are defined." }];
      const results = [];
      for (const check of checks) {
        results.push(await this.runPackageScript(check, activeTask));
      }
      return results;
    },

    async runPackageScript(scriptName, activeTask = null) {
      const scripts = await this.packageScripts();
      const manager = await this.detectPackageManager();
      if (!manager) return { name: scriptName, skipped: true, message: "No package manager detected." };
      if (!scripts[scriptName]) return { name: scriptName, skipped: true, message: `No ${scriptName} script is defined.` };
      return {
        name: scriptName,
        ...(await this.runCheckCommand(scriptName, `${manager} run ${scriptName}`, activeTask))
      };
    },

    async runCheckCommand(checkType, command, activeTask = null) {
      const result = await this.runCommand(command, `Run ${checkType}`, activeTask);
      if (!activeTask) return result;
      const parsed = parseCheckOutput({
        checkType,
        command,
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr
      });
      await recordCheckResult(activeTask, parsed, {
        stdout: result.stdout || "",
        stderr: result.stderr || ""
      });
      return {
        ...result,
        parsed
      };
    },

    async runTests(activeTask = null) {
      return this.runPackageScript("test", activeTask);
    },

    async runLint(activeTask = null) {
      return this.runPackageScript("lint", activeTask);
    },

    async runTypecheck(activeTask = null) {
      return this.runPackageScript("typecheck", activeTask);
    },

    async runBuild(activeTask = null) {
      return this.runPackageScript("build", activeTask);
    },

    async detectTestRunner() {
      return detectTestRunner(cwd);
    },

    async runTestFile(filePath, activeTask = null) {
      const runner = await detectTestRunner(cwd);
      if (runner.runner === "unknown" || !runner.runFileCmd) {
        return {
          ok: false,
          skipped: true,
          message: `No supported test runner detected. Cannot run targeted test for file: ${filePath}`
        };
      }
      const command = runner.runFileCmd(filePath);
      if (!command) {
        return {
          ok: false,
          skipped: true,
          message: `Runner ${runner.runner} does not support targeted file execution.`
        };
      }
      return this.runCheckCommand("test", command, activeTask);
    },

    async runTestName(testName, activeTask = null) {
      const runner = await detectTestRunner(cwd);
      if (runner.runner === "unknown" || !runner.runNameCmd) {
        return {
          ok: false,
          skipped: true,
          message: `No supported test runner detected. Cannot run targeted test: ${testName}`
        };
      }
      const command = runner.runNameCmd(testName);
      if (!command) {
        return {
          ok: false,
          skipped: true,
          message: `Runner ${runner.runner} does not support targeted test name execution.`
        };
      }
      return this.runCheckCommand("test", command, activeTask);
    },

    async runRelatedTests(changedFile, activeTask = null) {
      const all = await this.listFiles(".");
      if (!all.ok) return { ok: false, skipped: true, message: all.message };

      const related = findRelatedTestFiles(changedFile, all.files);
      if (!related.length) {
        return {
          ok: true,
          skipped: true,
          message: `No related test files found for ${changedFile}.`
        };
      }

      const runner = await detectTestRunner(cwd);
      if (runner.runner === "unknown") {
        return {
          ok: false,
          skipped: true,
          message: `No supported test runner detected. Related files: ${related.join(", ")}`
        };
      }

      const results = [];
      for (const testFile of related) {
        const command = runner.runFileCmd(testFile);
        if (!command) continue;
        results.push({
          file: testFile,
          ...(await this.runCheckCommand("test", command, activeTask))
        });
      }

      if (!results.length) {
        return {
          ok: true,
          skipped: true,
          message: `Runner ${runner.runner} does not support file-level targeting. Related: ${related.join(", ")}`
        };
      }

      const allPassed = results.every((r) => r.ok);
      return {
        ok: allPassed,
        runner: runner.runner,
        relatedFiles: related,
        results
      };
    },

    async findSymbols(query, { kind, limit = 50 } = {}) {
      const index = await getCodeIndex();
      const needle = (query || "").toLowerCase();
      const matches = [];
      for (const symbol of index.symbols) {
        if (kind && symbol.kind !== kind) continue;
        if (needle && !symbol.name.toLowerCase().includes(needle)) continue;
        matches.push(symbol);
        if (matches.length >= limit) break;
      }
      return { ok: true, matches, indexed: index.files.length };
    },

    async findDefinition(symbol) {
      const index = await getCodeIndex();
      const list = index.defsByName.get(symbol) || [];
      return { ok: true, symbol, definitions: list };
    },

    async findReferences(symbol) {
      const index = await getCodeIndex();
      const definition = index.defsByName.get(symbol)?.[0];
      const result = await findReferencesIndex({
        cwd,
        files: index.files,
        symbol,
        definitionFile: definition?.file,
        definitionLine: definition?.line
      });
      if (!result.ok) return result;
      return {
        ok: true,
        symbol,
        definition: definition || null,
        references: result.references,
        indexed: index.files.length
      };
    },

    async findImports(relativePath) {
      const index = await getCodeIndex();
      const normalized = relativePath.replaceAll("\\", "/");
      const list = index.imports.get(normalized) || [];
      return { ok: true, path: normalized, imports: list };
    },

    async findExports(relativePath) {
      const index = await getCodeIndex();
      const normalized = relativePath.replaceAll("\\", "/");
      const list = index.exports.get(normalized) || [];
      return { ok: true, path: normalized, exports: list };
    },

    async routeMap() {
      const index = await getCodeIndex();
      const routes = await detectRoutes({ cwd, files: index.files });
      return { ok: true, routes, indexed: index.files.length };
    },

    invalidateCodeIndex,

    async undoTask(activeTask) {
      const checkpointDir = path.join(activeTask.dir, "snapshots");
      if (!(await exists(checkpointDir))) {
        return { ok: false, message: "No snapshots exist for the last task." };
      }
      const files = await readJson(path.join(activeTask.dir, "changed-files.json"), []);
      for (const file of files) {
        const snapshot = path.join(checkpointDir, encodePath(file));
        const target = path.join(cwd, file);
        if (await exists(`${snapshot}.missing`)) {
          await rm(target, { force: true });
        } else if (await exists(snapshot)) {
          await mkdir(path.dirname(target), { recursive: true });
          await cp(snapshot, target, { force: true });
        }
      }
      return { ok: true, message: `Undid ${files.length} tracked file change(s).` };
    }
  };
}

async function readWorkspaceFile(cwd, relativePath) {
  try {
    return await readFile(path.resolve(cwd, relativePath), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function logCommand(activeTask, entry) {
  if (!activeTask?.dir) return;
  const logEntry = {
    command: entry.command,
    purpose: entry.purpose,
    status: entry.status,
    decision: entry.decision,
    exit_code: entry.result?.code,
    stdout: trimLogText(entry.result?.stdout),
    stderr: trimLogText(entry.result?.stderr),
    message: entry.result?.message,
    timestamp: new Date().toISOString()
  };
  await mkdir(activeTask.dir, { recursive: true });
  await appendFile(path.join(activeTask.dir, "commands.jsonl"), `${JSON.stringify(logEntry)}\n`);
}

async function recordCheckResult(activeTask, parsed, raw) {
  const checksDir = path.join(activeTask.dir, "checks");
  await mkdir(checksDir, { recursive: true });
  const existing = await readJson(path.join(activeTask.dir, "check-results.json"), []);
  const id = `check-${String(existing.length + 1).padStart(3, "0")}`;
  const stdoutPath = path.join("checks", `${id}.stdout.txt`);
  const stderrPath = path.join("checks", `${id}.stderr.txt`);
  await writeFile(path.join(activeTask.dir, stdoutPath), raw.stdout || "");
  await writeFile(path.join(activeTask.dir, stderrPath), raw.stderr || "");
  const entry = {
    id,
    ...parsed,
    raw_stdout_path: stdoutPath.replaceAll("\\", "/"),
    raw_stderr_path: stderrPath.replaceAll("\\", "/"),
    created_at: new Date().toISOString()
  };
  existing.push(entry);
  await writeFile(path.join(activeTask.dir, "check-results.json"), `${JSON.stringify(existing, null, 2)}\n`);
}

function trimLogText(text) {
  if (!text) return "";
  return text.length > 6000 ? `${text.slice(0, 6000)}\n[truncated]` : text;
}

async function resolvePermission(decision, requestApproval, details) {
  if (decision.action === "allow") return { approved: true, decision };
  if (decision.action === "blocked") return { approved: false, blocked: true, decision, message: decision.reason };
  const approval = await requestApproval(decision, details);
  return { approved: Boolean(approval.approved), decision, approval };
}

function denied(permission) {
  return {
    ok: false,
    skipped: true,
    blocked: Boolean(permission.blocked),
    decision: permission.decision,
    message: permission.message || permission.decision.reason
  };
}

function denyApproval(decision) {
  return Promise.resolve({ approved: false, reason: decision.reason });
}

async function walk(root, files, cwd) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const absolute = path.join(root, entry.name);
    const relative = path.relative(cwd, absolute).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      await walk(absolute, files, cwd);
    } else {
      files.push(relative);
    }
  }
}

async function snapshotFile(activeTask, cwd, relativePath) {
  const snapshotDir = path.join(activeTask.dir, "snapshots");
  await mkdir(snapshotDir, { recursive: true });
  const snapshotPath = path.join(snapshotDir, encodePath(relativePath));
  if (await exists(snapshotPath) || await exists(`${snapshotPath}.missing`)) return;
  const source = path.join(cwd, relativePath);
  if (await exists(source)) {
    await mkdir(path.dirname(snapshotPath), { recursive: true });
    await cp(source, snapshotPath, { force: true });
  } else {
    await writeFile(`${snapshotPath}.missing`, "");
  }
}

async function trackChangedFile(activeTask, relativePath) {
  const changedPath = path.join(activeTask.dir, "changed-files.json");
  const changed = await readJson(changedPath, []);
  if (!changed.includes(relativePath)) changed.push(relativePath);
  await writeFile(changedPath, `${JSON.stringify(changed, null, 2)}\n`);
}

async function changedFilesFromAgent(cwd) {
  const tasksDir = path.join(cwd, ".agent", "tasks");
  if (!(await exists(tasksDir))) return [];
  const tasks = await readdir(tasksDir);
  const latest = tasks.sort().at(-1);
  if (!latest) return [];
  return readJson(path.join(tasksDir, latest, "changed-files.json"), []);
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

function decisionAsk(tier, reason) {
  return { action: "ask", tier, reason };
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return count;
    count += 1;
    from = idx + needle.length;
  }
}

async function logEditEvent(activeTask, tool, payload) {
  if (!activeTask?.dir) return;
  await appendEvent(activeTask.dir, {
    type: "edit",
    tool,
    ...payload
  });
}

async function insertAtMarker({ permissions, requestApproval, cwd, activeTask, relativePath, marker, content, position }) {
  const allowed = permissions.classifyPath(relativePath, "write");
  const permission = await resolvePermission(allowed, requestApproval, { path: relativePath, taskId: activeTask?.id });
  if (!permission.approved) return denied(permission);
  const absolute = path.resolve(cwd, relativePath);
  if (!(await exists(absolute))) {
    return { ok: false, message: `Cannot insert: file does not exist: ${relativePath}` };
  }
  if (typeof marker !== "string" || marker.length === 0) {
    return { ok: false, message: "marker must be a non-empty string." };
  }
  const original = await readFile(absolute, "utf8");
  const occurrences = countOccurrences(original, marker);
  if (occurrences === 0) {
    return { ok: false, message: `marker not found in ${relativePath}.` };
  }
  if (occurrences > 1) {
    return {
      ok: false,
      message: `marker matched ${occurrences} times in ${relativePath}. Provide a longer, unique marker.`,
      occurrences
    };
  }
  const idx = original.indexOf(marker);
  const insertion = content.replace(/\r\n/g, "\n");
  const insertAt = position === "before" ? idx : idx + marker.length;
  const result = original.slice(0, insertAt) + insertion + original.slice(insertAt);
  await snapshotFile(activeTask, cwd, relativePath);
  await writeFile(absolute, result);
  await trackChangedFile(activeTask, relativePath);
  await logEditEvent(activeTask, position === "before" ? "insert_before" : "insert_after", {
    path: relativePath,
    inserted_bytes: Buffer.byteLength(insertion)
  });
  return { ok: true, path: relativePath };
}

function runShell(command, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true
    });
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
