import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createToolRuntime } from "../src/tools/runtime.js";

test("runCommand writes command audit entries", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-"));
  try {
    const activeTask = { id: "task-test", dir: path.join(cwd, ".agent", "tasks", "task-test") };
    const tools = createToolRuntime({
      cwd,
      config: {
        permissions: {
          allowLocalChecks: true,
          allowLocalEdits: true
        }
      },
      requestApproval: async () => ({ approved: false })
    });

    const result = await tools.runCommand("node --test", "Run Node tests", activeTask);
    assert.equal(result.ok, true);

    const raw = await readFile(path.join(activeTask.dir, "commands.jsonl"), "utf8");
    const entry = JSON.parse(raw.trim());
    assert.equal(entry.command, "node --test");
    assert.equal(entry.purpose, "Run Node tests");
    assert.equal(entry.status, "passed");
    assert.equal(entry.decision.tier, "local_check");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
