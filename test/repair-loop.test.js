import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTask } from "../src/task/task-manager.js";
import { createToolRuntime } from "../src/tools/runtime.js";
import { verifyAndRepair } from "../src/verify/repair-loop.js";

test("verifyAndRepair reruns checks after a successful repair", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-"));
  try {
    await writeFile(path.join(cwd, "flag.txt"), "fail");
    await writeFile(path.join(cwd, "check.js"), "const fs=require('fs'); process.exit(fs.readFileSync('flag.txt','utf8') === 'pass' ? 0 : 1);");
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node check.js" } }));
    const activeTask = await createTask(cwd, "Fix failing test");
    const tools = createToolRuntime({ cwd, config: config(), requestApproval: async () => ({ approved: true }) });
    const model = {
      repair: async () => {
        await tools.writeFileTracked(activeTask, "flag.txt", "pass");
        return { ok: true, message: "Updated flag." };
      }
    };

    const result = await verifyAndRepair({
      activeTask,
      tools,
      model,
      userRequest: "Fix failing test",
      projectSummary: {},
      maxAttempts: 3
    });

    assert.equal(result.status, "passed");
    assert.equal(result.attempts.length, 1);
    assert.equal(JSON.parse(await readFile(path.join(activeTask.dir, "check-results.json"), "utf8")).length, 2);
    const verification = JSON.parse(await readFile(path.join(activeTask.dir, "verification.json"), "utf8"));
    assert.equal(verification.status, "passed");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("verifyAndRepair records failure when repair is unavailable", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-"));
  try {
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({
      scripts: { test: "node -e \"process.exit(1)\"" }
    }));
    const activeTask = await createTask(cwd, "Fix failing test");
    const tools = createToolRuntime({ cwd, config: config(), requestApproval: async () => ({ approved: true }) });

    const result = await verifyAndRepair({
      activeTask,
      tools,
      model: { repair: async () => ({ ok: false, noop: true, message: "No model." }) },
      userRequest: "Fix failing test",
      projectSummary: {},
      maxAttempts: 3
    });

    assert.equal(result.status, "failed");
    assert.equal(result.attempts.length, 1);
    const verification = JSON.parse(await readFile(path.join(activeTask.dir, "verification.json"), "utf8"));
    assert.equal(verification.status, "failed");
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
