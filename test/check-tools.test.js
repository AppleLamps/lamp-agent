import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTask } from "../src/task/task-manager.js";
import { createToolRuntime } from "../src/tools/runtime.js";

test("dedicated check tools run or skip individual scripts", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-"));
  try {
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({
      scripts: {
        test: "node -e \"process.exit(0)\""
      }
    }));
    const activeTask = await createTask(cwd, "Run checks");
    const tools = createToolRuntime({
      cwd,
      config: config(),
      requestApproval: async () => ({ approved: true })
    });

    const testResult = await tools.runTests(activeTask);
    const lintResult = await tools.runLint(activeTask);

    assert.equal(testResult.name, "test");
    assert.equal(testResult.ok, true);
    assert.equal(lintResult.name, "lint");
    assert.equal(lintResult.skipped, true);
    assert.equal(lintResult.message, "No lint script is defined.");

    const commands = await readFile(path.join(activeTask.dir, "commands.jsonl"), "utf8");
    assert.match(commands, /npm run test/);
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
