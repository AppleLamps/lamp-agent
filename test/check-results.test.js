import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTask } from "../src/task/task-manager.js";
import { createToolRuntime } from "../src/tools/runtime.js";

test("check tools persist structured check-results.json", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-"));
  try {
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({
      scripts: {
        test: "node -e \"console.error('FAIL src/login.test.js'); console.error('    at Object.<anonymous> (src/login.test.js:3:1)'); process.exit(1)\""
      }
    }));
    const activeTask = await createTask(cwd, "Fix failing test");
    const tools = createToolRuntime({
      cwd,
      config: config(),
      requestApproval: async () => ({ approved: true })
    });

    const result = await tools.runTests(activeTask);
    assert.equal(result.ok, false);
    assert.equal(result.parsed.status, "failed");

    const checks = JSON.parse(await readFile(path.join(activeTask.dir, "check-results.json"), "utf8"));
    assert.equal(checks.length, 1);
    assert.equal(checks[0].check_type, "test");
    assert.equal(checks[0].status, "failed");
    assert.equal(checks[0].failed_tests[0], "src/login.test.js");
    assert.equal(checks[0].likely_relevant_files[0], "src/login.test.js");
    assert.match(await readFile(path.join(activeTask.dir, checks[0].raw_stderr_path), "utf8"), /FAIL/);
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
