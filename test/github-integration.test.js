import test from "node:test";
import assert from "node:assert/strict";
import { branchCreate, prCreate, prStatus, ciLog, detectGh } from "../src/integrations/github.js";

function recordingRun(scripted = []) {
  const calls = [];
  return {
    calls,
    async runCommand(command, purpose) {
      calls.push({ command, purpose });
      const next = scripted.shift();
      if (typeof next === "function") return next({ command, purpose });
      return next || { ok: true, code: 0, stdout: "", stderr: "" };
    }
  };
}

test("detectGh parses version output and reports availability", async () => {
  const runner = recordingRun([
    { ok: true, code: 0, stdout: "gh version 2.51.0 (2024-08-13)\nhttps://github.com/cli/cli/releases/tag/v2.51.0\n", stderr: "" }
  ]);
  const result = await detectGh({ runCommand: runner.runCommand });
  assert.equal(result.ok, true);
  assert.equal(result.available, true);
  assert.equal(result.version, "2.51.0");
  assert.equal(runner.calls[0].command, "gh --version");
});

test("detectGh reports unavailable when the command fails or is denied", async () => {
  const runner = recordingRun([{ ok: false, denied: true, message: "denied by user" }]);
  const result = await detectGh({ runCommand: runner.runCommand });
  assert.equal(result.ok, false);
  assert.equal(result.available, false);
  assert.match(result.message, /denied/);
});

test("branchCreate validates names and runs git checkout -b", async () => {
  const runner = recordingRun([
    { ok: true, code: 0, stdout: "Switched to a new branch 'feature/login'\n", stderr: "" },
    { ok: true, code: 0, stdout: "abc123\n", stderr: "" }
  ]);
  const result = await branchCreate({ runCommand: runner.runCommand, name: "feature/login" });
  assert.equal(result.ok, true);
  assert.equal(result.name, "feature/login");
  assert.equal(result.sha, "abc123");
  assert.equal(runner.calls[0].command, "git checkout -b feature/login");
  assert.equal(runner.calls[1].command, "git rev-parse HEAD");
});

test("branchCreate rejects invalid branch names", async () => {
  const runner = recordingRun([]);
  for (const bad of ["", "no spaces here", "../escape", "trailing/", "-leading"]) {
    const result = await branchCreate({ runCommand: runner.runCommand, name: bad });
    assert.equal(result.ok, false);
  }
  assert.equal(runner.calls.length, 0, "no commands should run for rejected names");
});

test("branchCreate surfaces denial from the approval engine", async () => {
  const runner = recordingRun([{ ok: false, denied: true, message: "denied" }]);
  const result = await branchCreate({ runCommand: runner.runCommand, name: "feature/login" });
  assert.equal(result.ok, false);
  assert.match(result.message, /denied/i);
});

test("prCreate runs gh pr create and extracts the PR URL + number", async () => {
  const runner = recordingRun([
    { ok: true, code: 0, stdout: "https://github.com/foo/bar/pull/42\n", stderr: "" }
  ]);
  const result = await prCreate({
    runCommand: runner.runCommand,
    title: "Fix the failing login test",
    body: "## Summary\n- restored a missing assertion"
  });
  assert.equal(result.ok, true);
  assert.equal(result.url, "https://github.com/foo/bar/pull/42");
  assert.equal(result.number, 42);
  assert.match(runner.calls[0].command, /^gh pr create --title /);
  assert.match(runner.calls[0].command, /--body /);
});

test("prCreate routes user denial back to the caller", async () => {
  const runner = recordingRun([{ ok: false, denied: true, message: "denied" }]);
  const result = await prCreate({ runCommand: runner.runCommand, title: "x", body: "y" });
  assert.equal(result.ok, false);
  assert.match(result.message, /denied/i);
});

test("prStatus parses gh pr checks output into structured rows", async () => {
  const runner = recordingRun([
    {
      ok: true,
      code: 0,
      stdout: [
        "lint   pass    1m20s    https://github.com/foo/bar/runs/1",
        "test   fail    3m12s    https://github.com/foo/bar/runs/2",
        ""
      ].join("\n"),
      stderr: ""
    }
  ]);
  const result = await prStatus({ runCommand: runner.runCommand, number: 42 });
  assert.equal(result.ok, true);
  assert.equal(result.checks.length, 2);
  assert.equal(result.checks[0].name, "lint");
  assert.equal(result.checks[0].status, "pass");
  assert.equal(result.checks[1].name, "test");
  assert.equal(result.checks[1].status, "fail");
  assert.match(runner.calls[0].command, /^gh pr checks 42/);
});

test("prStatus omits the number argument when none is provided", async () => {
  const runner = recordingRun([{ ok: true, code: 0, stdout: "", stderr: "" }]);
  await prStatus({ runCommand: runner.runCommand });
  assert.equal(runner.calls[0].command, "gh pr checks");
});

test("ciLog forwards run id and optional job name", async () => {
  const runner = recordingRun([
    { ok: true, code: 0, stdout: "logs..." }
  ]);
  const result = await ciLog({ runCommand: runner.runCommand, runId: "9876543210", job: "test (ubuntu-latest)" });
  assert.equal(result.ok, true);
  assert.equal(result.log, "logs...");
  assert.match(runner.calls[0].command, /^gh run view 9876543210 --log /);
  assert.match(runner.calls[0].command, /--job /);
});

test("ciLog requires a runId", async () => {
  const runner = recordingRun([]);
  const result = await ciLog({ runCommand: runner.runCommand });
  assert.equal(result.ok, false);
  assert.equal(runner.calls.length, 0);
});
