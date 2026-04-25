import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createToolRuntime } from "../src/tools/runtime.js";
import {
  loadProjectMemory,
  refreshProjectMemory,
  saveProjectMemory
} from "../src/memory/project-memory.js";
import { summarizeProject } from "../src/review/review.js";

function config() {
  return {
    permissions: {
      allowLocalChecks: true,
      allowLocalEdits: true
    }
  };
}

async function makeDir() {
  return mkdtemp(path.join(tmpdir(), "lamp-agent-memory-"));
}

test("loadProjectMemory creates .agent/memory/project.json with the default schema", async () => {
  const cwd = await makeDir();
  try {
    const memory = await loadProjectMemory(cwd);
    assert.equal(memory.version, 1);
    assert.equal(memory.framework, null);
    assert.deepEqual(memory.decisions, []);

    const raw = await readFile(path.join(cwd, ".agent", "memory", "project.json"), "utf8");
    assert.match(raw, /"package_manager"/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("refreshProjectMemory populates stable package, test, route, and convention facts", async () => {
  const cwd = await makeDir();
  try {
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({
      type: "module",
      scripts: { test: "node --test", build: "node src/index.js" }
    }, null, 2));
    await writeFile(path.join(cwd, "package-lock.json"), "{}\n");
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src", "server.js"), "app.get('/health', handler);\n");
    await mkdir(path.join(cwd, "test"), { recursive: true });
    await writeFile(path.join(cwd, "test", "server.test.js"), "import test from 'node:test';\n");

    const tools = createToolRuntime({ cwd, config: config(), requestApproval: async () => ({ approved: true }) });
    const result = await refreshProjectMemory({ cwd, tools });

    assert.equal(result.refreshed, true);
    assert.equal(result.memory.package_manager, "npm");
    assert.equal(result.memory.test_runner, "node");
    assert.deepEqual(result.memory.scripts, { test: "node --test", build: "node src/index.js" });
    assert.equal(result.memory.framework, "express-like");
    assert.ok(result.memory.routes.some((route) => route.path === "/health"));
    assert.ok(result.memory.important_files.includes("package.json"));
    assert.ok(result.memory.conventions.some((line) => /ESM/.test(line)));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("refreshProjectMemory reuses fresh memory without rediscovering derived facts", async () => {
  const cwd = await makeDir();
  try {
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    const tools = createToolRuntime({ cwd, config: config(), requestApproval: async () => ({ approved: true }) });
    const first = await refreshProjectMemory({ cwd, tools });

    let detectCalls = 0;
    const guardedTools = {
      listFiles: tools.listFiles.bind(tools),
      detectPackageManager: async () => {
        detectCalls += 1;
        return "npm";
      },
      packageScripts: async () => {
        throw new Error("packageScripts should not run when memory is fresh");
      },
      detectTestRunner: async () => {
        throw new Error("detectTestRunner should not run when memory is fresh");
      },
      routeMap: async () => {
        throw new Error("routeMap should not run when memory is fresh");
      }
    };

    const second = await refreshProjectMemory({ cwd, tools: guardedTools });
    assert.equal(second.refreshed, false);
    assert.equal(detectCalls, 0);
    assert.deepEqual(second.memory.source_fingerprints, first.memory.source_fingerprints);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("refreshProjectMemory refreshes stale config facts and preserves durable notes", async () => {
  const cwd = await makeDir();
  try {
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }, null, 2));
    const tools = createToolRuntime({ cwd, config: config(), requestApproval: async () => ({ approved: true }) });
    const first = await refreshProjectMemory({ cwd, tools });
    first.memory.decisions.push("Prefer targeted checks before full suite.");
    first.memory.avoid_touching.push(".env");
    await saveProjectMemory(cwd, first.memory);

    await writeFile(path.join(cwd, "package.json"), JSON.stringify({
      scripts: { test: "node --test", lint: "node -e \"process.exit(0)\"" }
    }, null, 2));

    const second = await refreshProjectMemory({ cwd, tools });
    assert.equal(second.refreshed, true);
    assert.equal(second.memory.scripts.lint, "node -e \"process.exit(0)\"");
    assert.deepEqual(second.memory.decisions, ["Prefer targeted checks before full suite."]);
    assert.deepEqual(second.memory.avoid_touching, [".env"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("summarizeProject includes project memory for model context", async () => {
  const cwd = await makeDir();
  try {
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({
      scripts: { test: "node --test" }
    }, null, 2));
    const tools = createToolRuntime({ cwd, config: config(), requestApproval: async () => ({ approved: true }) });
    const { memory } = await refreshProjectMemory({ cwd, tools });
    const summary = await summarizeProject(tools, memory);

    assert.equal(summary.packageManager, "npm");
    assert.equal(summary.testRunner, "node");
    assert.equal(summary.memory.package_manager, "npm");
    assert.ok(summary.memory.scripts.includes("test"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
