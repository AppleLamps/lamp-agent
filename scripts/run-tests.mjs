#!/usr/bin/env node
// Walks a directory tree under test/ and hands the explicit list of
// *.test.{js,mjs,cjs} files to `node --test`. We do this for two reasons:
//
// 1) On Node 24, passing a directory to `node --test` is treated as a module
//    path rather than a directory to walk.
// 2) Node's auto-discovery treats *every* file under a directory named
//    `test`/`tests`/`__tests__` as a test file, which would load our e2e
//    helpers and fixture sources (and run any `node:test` calls inside them)
//    as part of the parent suite. An explicit file list avoids that.
//
// Usage:
//   node scripts/run-tests.mjs [dir]
//
// Defaults to `test`. Pass `test/e2e` to run only the end-to-end suite.
import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

const SKIP_DIR_NAMES = new Set(["helpers", "fixtures", "node_modules"]);

async function collectTests(dir) {
  const files = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;
      files.push(...(await collectTests(full)));
      continue;
    }
    if (entry.isFile() && /\.test\.(?:js|mjs|cjs)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

const requested = process.argv[2] || "test";
const root = path.isAbsolute(requested) ? requested : path.join(REPO_ROOT, requested);

let info;
try {
  info = await stat(root);
} catch (error) {
  console.error(`Cannot find test root: ${root}`);
  process.exit(1);
}
if (!info.isDirectory()) {
  console.error(`Test root is not a directory: ${root}`);
  process.exit(1);
}

const files = await collectTests(root);
if (!files.length) {
  console.error(`No test files matching *.test.{js,mjs,cjs} found under ${root}.`);
  process.exit(1);
}

const child = spawn(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  cwd: REPO_ROOT
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
