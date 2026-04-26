import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { copyFixture } from "./helpers/copy-fixture.js";
import { spawnCli } from "./helpers/cli-driver.js";
import { STUB_ADAPTER_PATH, writeStubScript } from "./helpers/stub-script.js";

// Detect whether `python -m pytest --version` is available so the pytest
// fixture test can skip cleanly on machines without it.
const PYTHON_PYTEST_AVAILABLE = (() => {
  try {
    const result = spawnSync("python", ["-m", "pytest", "--version"], {
      stdio: "ignore",
      timeout: 5000,
      windowsHide: true
    });
    return result.status === 0;
  } catch {
    return false;
  }
})();

test("e2e: CLI prints the banner and exits cleanly on /exit", async () => {
  const fixture = await copyFixture("non-git-plain");
  const cli = spawnCli({ cwd: fixture.cwd });
  try {
    await cli.expect(/Lamp Agent/);
    await cli.sendLine("/exit");
    const result = await cli.exit();
    assert.equal(result.code, 0, "CLI should exit cleanly");
    assert.match(cli.stdout(), /Plain-English coding harness/);
    assert.equal(cli.stderr().trim(), "", "no stderr output expected on a clean exit");
  } finally {
    cli.kill();
    await fixture.cleanup();
  }
});

test("e2e: explain-style request takes the short lifecycle (no verify / critique / review card)", async () => {
  const fixture = await copyFixture("node-builtin-test-passing");
  const cli = spawnCli({ cwd: fixture.cwd });
  try {
    await cli.expect(/Lamp Agent/);
    await cli.sendLine("What kind of project is this?");
    // The agent prints the answer in an assistant box. No review card
    // follows because explain tasks short-circuit verify, critique,
    // and final_review.
    await cli.expect(/\+-- assistant /, { timeout: 60000 });
    await cli.sendLine("/exit");
    const result = await cli.exit();
    assert.equal(result.code, 0);

    // No "Next actions:" review card is printed for explain tasks.
    assert.doesNotMatch(cli.stdout(), /Next actions:/,
      "explain task should not produce a 'Next actions:' review card");

    const tasksDir = path.join(fixture.cwd, ".agent", "tasks");
    const taskIds = await readdir(tasksDir);
    assert.equal(taskIds.length, 1, "exactly one task directory expected");
    const taskDir = path.join(tasksDir, taskIds[0]);

    const task = JSON.parse(await readFile(path.join(taskDir, "task.json"), "utf8"));
    assert.equal(task.task_type, "explain");
    assert.equal(task.status, "answered",
      `explain task should end with status 'answered' (got ${task.status})`);
    assert.ok(Array.isArray(task.current_plan) && task.current_plan.length > 0,
      "task plan should be recorded");

    const phases = JSON.parse(await readFile(path.join(taskDir, "phases.json"), "utf8"));
    // Triage / plan / patch run; verify / critique / final_review skip.
    assert.equal(phases.intake?.state, "completed");
    assert.equal(phases.triage?.state, "completed");
    assert.equal(phases.plan?.state, "completed");
    assert.equal(phases.patch?.state, "completed");
    assert.equal(phases.verify?.state, "skipped");
    assert.equal(phases.critique?.state, "skipped");
    assert.equal(phases.final_review?.state, "skipped");

    const events = (await readFile(path.join(taskDir, "events.jsonl"), "utf8"))
      .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const eventTypes = new Set(events.map((e) => e.type));
    assert.ok(eventTypes.has("task_created"));
    assert.ok(eventTypes.has("task_plan"));
    assert.ok(eventTypes.has("phase_skipped"),
      "phase_skipped events should be recorded for explain tasks");
    const skippedPhases = events.filter((e) => e.type === "phase_skipped").map((e) => e.phase).sort();
    assert.deepEqual(skippedPhases, ["critique", "final_review", "verify"]);
    // Verify- and critique-specific events do not appear on the
    // short lifecycle.
    assert.ok(!eventTypes.has("verify_started"));
    assert.ok(!eventTypes.has("critique"));

    // Triage still refreshes project memory.
    const memory = JSON.parse(await readFile(
      path.join(fixture.cwd, ".agent", "memory", "project.json"), "utf8"
    ));
    assert.equal(memory.package_manager, "npm");
    assert.ok(Array.isArray(memory.important_files) && memory.important_files.includes("package.json"));
  } finally {
    cli.kill();
    await fixture.cleanup();
  }
});

test("e2e: CLI records a failing verify run on a broken Node fixture", async () => {
  const fixture = await copyFixture("node-builtin-test-failing");
  const cli = spawnCli({ cwd: fixture.cwd });
  try {
    await cli.expect(/Lamp Agent/);
    await cli.sendLine("Find the broken add function.");
    await cli.expect(/Next actions:/, { timeout: 60000 });
    await cli.sendLine("/exit");
    const result = await cli.exit();
    assert.equal(result.code, 0);

    const tasksDir = path.join(fixture.cwd, ".agent", "tasks");
    const taskIds = await readdir(tasksDir);
    assert.equal(taskIds.length, 1);
    const taskDir = path.join(tasksDir, taskIds[0]);

    const checkResults = JSON.parse(await readFile(path.join(taskDir, "check-results.json"), "utf8"));
    const failed = checkResults.filter((entry) => entry.status === "failed");
    assert.ok(failed.length >= 1,
      `at least one failed check expected; got ${checkResults.length} entries:\n${JSON.stringify(checkResults, null, 2)}`);
    assert.equal(failed[0].check_type, "test");
    assert.notEqual(failed[0].exit_code, 0);

    const verification = JSON.parse(await readFile(path.join(taskDir, "verification.json"), "utf8"));
    assert.equal(verification.status, "failed");
    assert.ok(Array.isArray(verification.attempts));

    const events = (await readFile(path.join(taskDir, "events.jsonl"), "utf8"))
      .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const eventTypes = events.map((event) => event.type);
    assert.ok(eventTypes.includes("check_failed"), "check_failed event should be recorded");
    assert.ok(
      eventTypes.includes("repair_attempt_started") || eventTypes.includes("repair_limit_reached"),
      "a repair attempt or repair-limit event should be recorded"
    );

    const critique = (events.find((event) => event.type === "critique")) || {};
    assert.ok(["needs_attention", "reviewed"].includes(critique.status),
      `critique status should be set (got ${critique.status})`);

    const phases = JSON.parse(await readFile(path.join(taskDir, "phases.json"), "utf8"));
    assert.equal(phases.final_review?.state, "completed",
      "final_review should still complete after a failing verify");
  } finally {
    cli.kill();
    await fixture.cleanup();
  }
});

test("e2e: stub adapter shows destructive commands are blocked by the permission engine", async () => {
  const fixture = await copyFixture("node-builtin-test-passing");
  const stub = await writeStubScript({
    respond: {
      steps: [
        {
          tool: "run_command",
          args: { command: "rm -rf /", purpose: "Probe permission engine" }
        }
      ],
      message: "Stub attempted a destructive command; the harness should have blocked it."
    }
  });
  const cli = spawnCli({
    cwd: fixture.cwd,
    env: {
      LAMP_MODEL_ADAPTER: STUB_ADAPTER_PATH,
      LAMP_STUB_SCRIPT: stub.path
    }
  });
  try {
    await cli.expect(/Lamp Agent/);
    await cli.sendLine("Build a probe that tries a destructive command.");
    await cli.expect(/Next actions:/, { timeout: 60000 });
    await cli.sendLine("/exit");
    const result = await cli.exit();
    assert.equal(result.code, 0);

    const tasksDir = path.join(fixture.cwd, ".agent", "tasks");
    const taskIds = await readdir(tasksDir);
    const taskDir = path.join(tasksDir, taskIds[0]);

    const commandsLog = (await readFile(path.join(taskDir, "commands.jsonl"), "utf8"))
      .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const destructive = commandsLog.find((entry) => /rm\s+-rf\s+\//.test(entry.command));
    assert.ok(destructive, "destructive command attempt should be recorded in commands.jsonl");
    assert.equal(destructive.status, "skipped");
    assert.equal(destructive.decision?.action, "blocked");
    assert.equal(destructive.decision?.tier, "destructive");

    // The permission engine blocking the command must not break the rest
    // of the lifecycle: the task should still reach final_review.
    const phases = JSON.parse(await readFile(path.join(taskDir, "phases.json"), "utf8"));
    assert.equal(phases.final_review?.state, "completed");

    const finalSummary = await readFile(path.join(taskDir, "final-summary.md"), "utf8");
    assert.match(finalSummary, /Stub attempted a destructive command/);
  } finally {
    cli.kill();
    await Promise.all([fixture.cleanup(), stub.cleanup()]);
  }
});

test("e2e: stub adapter — malformed unified diff is rejected and no files change", async () => {
  const fixture = await copyFixture("node-builtin-test-passing");
  const stub = await writeStubScript({
    respond: {
      steps: [
        {
          tool: "apply_patch",
          args: { patch: "not a valid unified diff" }
        }
      ],
      message: "Stub tried to apply a malformed patch; the harness should have rejected it."
    }
  });
  const cli = spawnCli({
    cwd: fixture.cwd,
    env: {
      LAMP_MODEL_ADAPTER: STUB_ADAPTER_PATH,
      LAMP_STUB_SCRIPT: stub.path
    }
  });
  try {
    await cli.expect(/Lamp Agent/);
    await cli.sendLine("Build a probe that applies a malformed patch.");
    await cli.expect(/Next actions:/, { timeout: 60000 });
    await cli.sendLine("/exit");
    const result = await cli.exit();
    assert.equal(result.code, 0);

    const tasksDir = path.join(fixture.cwd, ".agent", "tasks");
    const taskIds = await readdir(tasksDir);
    const taskDir = path.join(tasksDir, taskIds[0]);

    const changed = JSON.parse(await readFile(path.join(taskDir, "changed-files.json"), "utf8"));
    assert.deepEqual(changed, [], "no files should be tracked when the patch is rejected");

    // The fixture's existing source files must remain untouched on disk.
    const math = await readFile(path.join(fixture.cwd, "src", "math.js"), "utf8");
    assert.match(math, /export function add/);

    const phases = JSON.parse(await readFile(path.join(taskDir, "phases.json"), "utf8"));
    assert.equal(phases.final_review?.state, "completed");
  } finally {
    cli.kill();
    await Promise.all([fixture.cleanup(), stub.cleanup()]);
  }
});

test("e2e: stub adapter creates a tracked file and verify still passes", async () => {
  const fixture = await copyFixture("node-builtin-test-passing");
  const stub = await writeStubScript({
    respond: {
      steps: [
        {
          tool: "create_file",
          args: {
            path: "src/extra.js",
            content: "export const extra = 42;\n"
          }
        }
      ],
      message: "Stub created src/extra.js as a benign new module."
    }
  });
  const cli = spawnCli({
    cwd: fixture.cwd,
    env: {
      LAMP_MODEL_ADAPTER: STUB_ADAPTER_PATH,
      LAMP_STUB_SCRIPT: stub.path
    }
  });
  try {
    await cli.expect(/Lamp Agent/);
    await cli.sendLine("Add a tiny utility module.");
    await cli.expect(/Next actions:/, { timeout: 60000 });
    await cli.sendLine("/exit");
    const result = await cli.exit();
    assert.equal(result.code, 0);

    const tasksDir = path.join(fixture.cwd, ".agent", "tasks");
    const taskIds = await readdir(tasksDir);
    const taskDir = path.join(tasksDir, taskIds[0]);

    const changed = JSON.parse(await readFile(path.join(taskDir, "changed-files.json"), "utf8"));
    assert.ok(changed.includes("src/extra.js"),
      `src/extra.js should be tracked (got ${JSON.stringify(changed)})`);

    // The new file must exist in the workspace with the expected content.
    const written = await readFile(path.join(fixture.cwd, "src", "extra.js"), "utf8");
    assert.match(written, /export const extra = 42;/);

    // The fixture's existing tests still pass under verify.
    const checkResults = JSON.parse(await readFile(path.join(taskDir, "check-results.json"), "utf8"));
    const testRun = checkResults.find((entry) => entry.check_type === "test");
    assert.ok(testRun, "verify phase should have run the test script");
    assert.equal(testRun.status, "passed");

    const verification = JSON.parse(await readFile(path.join(taskDir, "verification.json"), "utf8"));
    assert.equal(verification.status, "passed");

    const events = (await readFile(path.join(taskDir, "events.jsonl"), "utf8"))
      .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const editEvent = events.find((event) => event.type === "edit" && event.tool === "create_file");
    assert.ok(editEvent, "create_file should emit an edit event");
    assert.equal(editEvent.path, "src/extra.js");
  } finally {
    cli.kill();
    await Promise.all([fixture.cleanup(), stub.cleanup()]);
  }
});

test("e2e: stub adapter — dependency-change command triggers approval and is denied", async () => {
  const fixture = await copyFixture("node-builtin-test-passing");
  const stub = await writeStubScript({
    respond: {
      steps: [
        {
          tool: "run_command",
          args: { command: "npm install lodash", purpose: "Pretend to add a dep" }
        }
      ],
      message: "Stub tried to install a dependency; approval should have been required."
    }
  });
  const cli = spawnCli({
    cwd: fixture.cwd,
    env: {
      LAMP_MODEL_ADAPTER: STUB_ADAPTER_PATH,
      LAMP_STUB_SCRIPT: stub.path
    }
  });
  try {
    await cli.expect(/Lamp Agent/);
    await cli.sendLine("Build a probe that asks to install a dependency.");
    // The pre-patch planner will fire first because the user request
    // mentions `install` + `dependency` and the fixture has a
    // package.json/package-lock.json that lands in the candidate set.
    // Approve the pre-patch warning, then deny the actual install.
    await cli.respondToApproval("yes", { timeout: 30000 });
    await cli.respondToApproval("no", { timeout: 30000 });
    await cli.expect(/Next actions:/, { timeout: 60000 });
    await cli.sendLine("/exit");
    const result = await cli.exit();
    assert.equal(result.code, 0);

    const tasksDir = path.join(fixture.cwd, ".agent", "tasks");
    const taskIds = await readdir(tasksDir);
    const taskDir = path.join(tasksDir, taskIds[0]);

    const commandsLog = (await readFile(path.join(taskDir, "commands.jsonl"), "utf8"))
      .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const installAttempt = commandsLog.find((entry) => /npm\s+install/.test(entry.command));
    assert.ok(installAttempt, "dependency-change command attempt should be logged");
    assert.equal(installAttempt.status, "skipped");
    assert.equal(installAttempt.decision?.action, "ask");
    assert.equal(installAttempt.decision?.tier, "dependency_change");

    // The approval message should also appear on the assistant's stdout,
    // and the pre-patch planner should have flagged a manifest blocker.
    assert.match(cli.stdout(), /change project dependencies/);
    assert.match(cli.stdout(), /dependency_manifest/);

    const phases = JSON.parse(await readFile(path.join(taskDir, "phases.json"), "utf8"));
    assert.equal(phases.final_review?.state, "completed");
  } finally {
    cli.kill();
    await Promise.all([fixture.cleanup(), stub.cleanup()]);
  }
});

test("e2e: stub adapter — secret-file read triggers approval and is denied", async () => {
  const fixture = await copyFixture("node-builtin-test-passing");
  // Drop a .env into the tmpdir copy of the fixture. The fixture itself
  // does not check in a .env so the live workspace stays clean.
  await writeFile(path.join(fixture.cwd, ".env"), "FAKE_SECRET=for-tests-only\n");
  const stub = await writeStubScript({
    respond: {
      steps: [
        {
          tool: "read_file",
          args: { path: ".env" }
        }
      ],
      message: "Stub tried to read a secret file; approval should have been required."
    }
  });
  const cli = spawnCli({
    cwd: fixture.cwd,
    env: {
      LAMP_MODEL_ADAPTER: STUB_ADAPTER_PATH,
      LAMP_STUB_SCRIPT: stub.path
    }
  });
  try {
    await cli.expect(/Lamp Agent/);
    await cli.sendLine("Build a probe that wants to read .env.");
    // The pre-patch planner fires first because `.env` is in the
    // candidate set. Approve it, then deny the actual secret read.
    await cli.respondToApproval("yes", { timeout: 30000 });
    await cli.respondToApproval("no", { timeout: 30000 });
    await cli.expect(/Next actions:/, { timeout: 60000 });
    await cli.sendLine("/exit");
    const result = await cli.exit();
    assert.equal(result.code, 0);

    // The approval prompt text should reference the secret-file boundary,
    // and the pre-patch planner should have flagged a secret_file blocker.
    assert.match(cli.stdout(), /may contain secrets/);
    assert.match(cli.stdout(), /secret_file/);

    // Secrets must have been left unread by the harness; we can confirm by
    // checking that the .env file on disk is unchanged from what the test
    // wrote.
    const env = await readFile(path.join(fixture.cwd, ".env"), "utf8");
    assert.match(env, /FAKE_SECRET=for-tests-only/);

    const tasksDir = path.join(fixture.cwd, ".agent", "tasks");
    const taskIds = await readdir(tasksDir);
    const taskDir = path.join(tasksDir, taskIds[0]);
    const phases = JSON.parse(await readFile(path.join(taskDir, "phases.json"), "utf8"));
    assert.equal(phases.final_review?.state, "completed");
  } finally {
    cli.kill();
    await Promise.all([fixture.cleanup(), stub.cleanup()]);
  }
});

test("e2e: stub adapter — git push triggers external-publish approval and is denied", async () => {
  const fixture = await copyFixture("node-builtin-test-passing");
  const stub = await writeStubScript({
    respond: {
      steps: [
        {
          tool: "run_command",
          args: { command: "git push origin main", purpose: "Pretend to publish" }
        }
      ],
      message: "Stub tried to push; external-publish approval should have been required."
    }
  });
  const cli = spawnCli({
    cwd: fixture.cwd,
    env: {
      LAMP_MODEL_ADAPTER: STUB_ADAPTER_PATH,
      LAMP_STUB_SCRIPT: stub.path
    }
  });
  try {
    await cli.expect(/Lamp Agent/);
    await cli.sendLine("Build a probe that wants to push to origin.");
    await cli.respondToApproval("no", { timeout: 30000 });
    await cli.expect(/Next actions:/, { timeout: 60000 });
    await cli.sendLine("/exit");
    const result = await cli.exit();
    assert.equal(result.code, 0);

    const tasksDir = path.join(fixture.cwd, ".agent", "tasks");
    const taskIds = await readdir(tasksDir);
    const taskDir = path.join(tasksDir, taskIds[0]);

    const commandsLog = (await readFile(path.join(taskDir, "commands.jsonl"), "utf8"))
      .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const pushAttempt = commandsLog.find((entry) => /git\s+push/.test(entry.command));
    assert.ok(pushAttempt, "git push attempt should be logged");
    assert.equal(pushAttempt.status, "skipped");
    assert.equal(pushAttempt.decision?.tier, "external_publish");

    assert.match(cli.stdout(), /publish or push outside/);
  } finally {
    cli.kill();
    await Promise.all([fixture.cleanup(), stub.cleanup()]);
  }
});

test("e2e: stub adapter — model.respond throwing is caught and the task still completes", async () => {
  const fixture = await copyFixture("node-builtin-test-passing");
  const stub = await writeStubScript({
    respond: {
      throw: { message: "Simulated provider 503 from stub" }
    }
  });
  const cli = spawnCli({
    cwd: fixture.cwd,
    env: {
      LAMP_MODEL_ADAPTER: STUB_ADAPTER_PATH,
      LAMP_STUB_SCRIPT: stub.path
    }
  });
  try {
    await cli.expect(/Lamp Agent/);
    await cli.sendLine("Build a feature that requires the model to be up.");
    await cli.expect(/Next actions:/, { timeout: 60000 });
    await cli.sendLine("/exit");
    const result = await cli.exit();
    assert.equal(result.code, 0);

    // The harness should have surfaced a warning to the user and continued.
    assert.match(cli.stdout(), /Model error: Simulated provider 503 from stub/);

    const tasksDir = path.join(fixture.cwd, ".agent", "tasks");
    const taskIds = await readdir(tasksDir);
    const taskDir = path.join(tasksDir, taskIds[0]);

    const events = (await readFile(path.join(taskDir, "events.jsonl"), "utf8"))
      .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const errorEvent = events.find((event) => event.type === "model_error");
    assert.ok(errorEvent, "model_error event should be recorded");
    assert.equal(errorEvent.phase, "patch");
    assert.match(errorEvent.message, /Simulated provider 503/);

    // The lifecycle should still reach final_review even though respond threw.
    const phases = JSON.parse(await readFile(path.join(taskDir, "phases.json"), "utf8"));
    assert.equal(phases.patch?.state, "completed");
    assert.equal(phases.final_review?.state, "completed");
  } finally {
    cli.kill();
    await Promise.all([fixture.cleanup(), stub.cleanup()]);
  }
});

test("e2e: shadow apply-back is blocked when the real workspace changes during the task", async () => {
  const fixture = await copyFixture("node-builtin-test-passing");

  // Turn shadow mode on for this run by writing the harness's config file
  // before spawning. The harness picks up `.agent/config.json` at startup.
  await mkdir(path.join(fixture.cwd, ".agent"), { recursive: true });
  await writeFile(
    path.join(fixture.cwd, ".agent", "config.json"),
    JSON.stringify({
      workspace: { shadowMode: "on" },
      model: { allowNetwork: false }
    }, null, 2)
  );

  const stub = await writeStubScript({
    respond: {
      steps: [
        {
          tool: "create_file",
          args: {
            path: "src/extra.js",
            content: "export const fromShadow = 1;\n"
          }
        }
      ],
      message: "Stub created src/extra.js inside the shadow workspace."
    }
  });

  const cli = spawnCli({
    cwd: fixture.cwd,
    env: {
      LAMP_MODEL_ADAPTER: STUB_ADAPTER_PATH,
      LAMP_STUB_SCRIPT: stub.path
    }
  });
  try {
    await cli.expect(/Lamp Agent/);
    await cli.sendLine("Add a tiny utility module under shadow.");
    await cli.expect(/Next actions:/, { timeout: 60000 });

    // While the task sits at review, mutate the same path in the *real*
    // workspace. The shadow apply-back must detect this as a conflict.
    await mkdir(path.join(fixture.cwd, "src"), { recursive: true });
    await writeFile(
      path.join(fixture.cwd, "src", "extra.js"),
      "// edited by the user out-of-band\n"
    );

    await cli.sendLine("accept");
    await cli.expect(/Real workspace changed|Apply-back is still blocked/, { timeout: 30000 });
    await cli.sendLine("/exit");
    const result = await cli.exit();
    assert.equal(result.code, 0);

    const tasksDir = path.join(fixture.cwd, ".agent", "tasks");
    const taskIds = await readdir(tasksDir);
    const taskDir = path.join(tasksDir, taskIds[0]);

    const conflicts = JSON.parse(await readFile(
      path.join(taskDir, "apply-back-conflicts.json"), "utf8"
    ));
    assert.equal(conflicts.ok, false);
    assert.ok(Array.isArray(conflicts.conflicts) && conflicts.conflicts.length >= 1,
      "at least one apply-back conflict should be recorded");
    assert.ok(
      conflicts.conflicts.some((entry) => entry.path === "src/extra.js"),
      "the conflicted file should include src/extra.js"
    );

    // The real workspace must still hold the user's out-of-band edit
    // because apply-back was blocked.
    const real = await readFile(path.join(fixture.cwd, "src", "extra.js"), "utf8");
    assert.match(real, /edited by the user out-of-band/);

    // The task's shadow workspace metadata should be present.
    const shadowMeta = JSON.parse(await readFile(
      path.join(taskDir, "shadow-workspace.json"), "utf8"
    ));
    assert.ok(shadowMeta.path, "shadow workspace metadata should record a path");
  } finally {
    cli.kill();
    await Promise.all([fixture.cleanup(), stub.cleanup()]);
  }
});

test(
  "e2e: stub adapter — pytest runner records a failed Python test through run_test_file",
  { skip: PYTHON_PYTEST_AVAILABLE ? false : "python -m pytest is not available on this machine" },
  async () => {
    const fixture = await copyFixture("pytest-failing");
    const stub = await writeStubScript({
      respond: {
        steps: [
          {
            tool: "run_test_file",
            args: { path: "specs_pytest/check_calculator.py" }
          }
        ],
        message: "Stub invoked the harness's pytest runner against the failing spec."
      }
    });
    const cli = spawnCli({
      cwd: fixture.cwd,
      env: {
        LAMP_MODEL_ADAPTER: STUB_ADAPTER_PATH,
        LAMP_STUB_SCRIPT: stub.path
      }
    });
    try {
      await cli.expect(/Lamp Agent/);
      await cli.sendLine("Build a probe that runs the failing pytest spec.");
      await cli.expect(/Next actions:/, { timeout: 60000 });
      await cli.sendLine("/exit");
      const result = await cli.exit();
      assert.equal(result.code, 0);

      const tasksDir = path.join(fixture.cwd, ".agent", "tasks");
      const taskIds = await readdir(tasksDir);
      const taskDir = path.join(tasksDir, taskIds[0]);

      const checkResults = JSON.parse(await readFile(
        path.join(taskDir, "check-results.json"), "utf8"
      ));
      const pytestRun = checkResults.find((entry) => /pytest/.test(entry.command));
      assert.ok(pytestRun, "pytest run should be recorded in check-results.json");
      assert.equal(pytestRun.check_type, "test");
      assert.equal(pytestRun.status, "failed");
      assert.notEqual(pytestRun.exit_code, 0);

      // The harness records project memory's test_runner from triage.
      const memory = JSON.parse(await readFile(
        path.join(fixture.cwd, ".agent", "memory", "project.json"), "utf8"
      ));
      assert.equal(memory.test_runner, "pytest");

      const phases = JSON.parse(await readFile(path.join(taskDir, "phases.json"), "utf8"));
      assert.equal(phases.final_review?.state, "completed");
    } finally {
      cli.kill();
      await Promise.all([fixture.cleanup(), stub.cleanup()]);
    }
  }
);

test("e2e: /tasks lists recent tasks and /show prints details", async () => {
  const fixture = await copyFixture("non-git-plain");
  const cli = spawnCli({ cwd: fixture.cwd });
  try {
    await cli.expect(/Lamp Agent/);
    // Run a small explain-style task so something appears in /tasks.
    // Explain tasks short-circuit to an assistant answer (no review
    // card), so wait for the assistant box rather than "Next actions:".
    await cli.sendLine("Explain what is in this directory.");
    await cli.expect(/\+-- assistant /, { timeout: 60000 });

    await cli.sendLine("/tasks");
    await cli.expect(/recent tasks/);
    // The card mentions the task id and its terminal status. For
    // explain tasks the status is `answered` (instead of the
    // patch-flow `ready_to_review`).
    await cli.expect(/task-\d{8}-\d{6}/);
    await cli.expect(/\[answered\]/);

    // Pull the task id out of the listing for the /show probe.
    const taskIdMatch = cli.stdout().match(/(task-\d{8}-\d{6})/);
    assert.ok(taskIdMatch, "expected /tasks output to include a task id");
    const taskId = taskIdMatch[1];

    await cli.sendLine(`/show ${taskId}`);
    await cli.expect(new RegExp(`task ${taskId.replace(/-/g, "\\-")}`));
    await cli.expect(/Phases:/);
    // /show should reflect the skipped final_review for an explain
    // task.
    await cli.expect(/final_review: skipped/);

    await cli.sendLine("/exit");
    const result = await cli.exit();
    assert.equal(result.code, 0);
  } finally {
    cli.kill();
    await fixture.cleanup();
  }
});

test("e2e: explain-style request on a non-git plain directory short-circuits to an answer", async () => {
  const fixture = await copyFixture("non-git-plain");
  const cli = spawnCli({ cwd: fixture.cwd });
  try {
    await cli.expect(/Lamp Agent/);
    await cli.sendLine("Explain what is in this directory.");
    // Explain task: agent answers in an assistant box, no review card.
    await cli.expect(/\+-- assistant /, { timeout: 60000 });
    await cli.sendLine("/exit");
    const result = await cli.exit();
    assert.equal(result.code, 0);

    const tasksDir = path.join(fixture.cwd, ".agent", "tasks");
    const taskIds = await readdir(tasksDir);
    assert.equal(taskIds.length, 1);
    const taskDir = path.join(tasksDir, taskIds[0]);

    const task = JSON.parse(await readFile(path.join(taskDir, "task.json"), "utf8"));
    assert.equal(task.task_type, "explain");
    assert.equal(task.status, "answered");

    const phases = JSON.parse(await readFile(path.join(taskDir, "phases.json"), "utf8"));
    assert.equal(phases.patch?.state, "completed");
    assert.equal(phases.final_review?.state, "skipped");

    // Checkpoint still records the non-git workspace type.
    const checkpointsDir = path.join(fixture.cwd, ".agent", "checkpoints");
    const checkpointFiles = await readdir(checkpointsDir);
    assert.ok(checkpointFiles.length >= 1, "checkpoint should be recorded for non-git workspace");
    const checkpoint = JSON.parse(await readFile(
      path.join(checkpointsDir, checkpointFiles[0]), "utf8"
    ));
    assert.equal(checkpoint.workspace_type, "plain-directory");
    assert.ok(Array.isArray(checkpoint.files) && checkpoint.files.length >= 2,
      "checkpoint should fingerprint the fixture's tracked files");
  } finally {
    cli.kill();
    await fixture.cleanup();
  }
});
