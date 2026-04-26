import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createToolRuntime } from "../src/tools/runtime.js";
import { createTask } from "../src/task/task-manager.js";

function config() {
  return {
    permissions: {
      allowLocalChecks: true,
      allowLocalEdits: true
    }
  };
}

test("denying an approval with 'another approach' records a constraint belief", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-alt-"));
  try {
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: {} }));
    const activeTask = await createTask(cwd, "Try a dependency change");
    const tools = createToolRuntime({
      cwd,
      config: config(),
      requestApproval: async (decision) => {
        // Always answer with "another approach" so the runtime records
        // the belief without actually running anything.
        return { approved: false, alternative: true, message: "User requested another approach." };
      }
    });

    const result = await tools.runCommand("npm install lodash", "Add a dep", activeTask);
    assert.equal(result.ok, false);
    assert.equal(result.alternative_requested, true);

    const beliefs = JSON.parse(await readFile(path.join(activeTask.dir, "beliefs.json"), "utf8"));
    const claim = (beliefs.claims || []).find((entry) =>
      entry.type === "constraint" && /alternative approach/i.test(entry.text)
    );
    assert.ok(claim, `expected a constraint belief; got ${JSON.stringify(beliefs.claims)}`);
    assert.match(claim.text, /npm install lodash/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a normal denial (without alternative) does NOT add a constraint belief", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-alt-"));
  try {
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: {} }));
    const activeTask = await createTask(cwd, "Plain deny");
    const tools = createToolRuntime({
      cwd,
      config: config(),
      requestApproval: async () => ({ approved: false })
    });

    await tools.runCommand("npm install lodash", "Add a dep", activeTask);

    const beliefs = JSON.parse(await readFile(path.join(activeTask.dir, "beliefs.json"), "utf8"));
    const constraints = (beliefs.claims || []).filter((entry) => entry.type === "constraint");
    assert.equal(constraints.length, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
