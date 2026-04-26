import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { requestRepairFindings } from "../src/task/repair-findings.js";

async function makeTask() {
  const root = await mkdtemp(path.join(tmpdir(), "repair-findings-"));
  const dir = path.join(root, ".agent", "tasks", "T1");
  await mkdir(dir, { recursive: true });
  return { root, dir };
}

function stubAdapter(structured) {
  return {
    async respondJson() {
      return { ok: true, structured, raw: JSON.stringify(structured) };
    }
  };
}

test("requestRepairFindings persists repair-findings.json on a valid model response", async () => {
  const { root, dir } = await makeTask();
  try {
    const findings = {
      diagnosis: "Root cause: assert.equal compared the wrong field.",
      summary: "Test still failing — wrong field selected.",
      severity: "medium",
      blockers: [],
      proposed_fix: {
        summary: "Replace `result.id` with `result.uuid` in the test.",
        steps: ["Open user.test.ts", "Update line 42", "Re-run targeted check"]
      }
    };
    const result = await requestRepairFindings({
      adapter: stubAdapter(findings),
      userRequest: "Fix the failing user test",
      projectSummary: { fileCount: 5 },
      status: "failed",
      failedChecks: [{ check_type: "test", failed_files: ["test/user.test.ts"] }],
      attempts: [{ attempt: 1, repair: { ok: true } }],
      activeTask: { dir }
    });
    assert.equal(result.ok, true);
    assert.equal(result.findings.severity, "medium");
    const persisted = JSON.parse(await readFile(path.join(dir, "repair-findings.json"), "utf8"));
    assert.equal(persisted.diagnosis, findings.diagnosis);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requestRepairFindings short-circuits when status is passed and no failed checks", async () => {
  let called = false;
  const adapter = {
    async respondJson() { called = true; return { ok: true, structured: {} }; }
  };
  const result = await requestRepairFindings({
    adapter,
    userRequest: "Anything",
    projectSummary: {},
    status: "passed",
    failedChecks: [],
    attempts: [],
    activeTask: null
  });
  assert.equal(result.ok, false);
  assert.equal(result.source, "skipped");
  assert.equal(called, false, "no model round-trip when there's nothing to diagnose");
});

test("requestRepairFindings reports schema_invalid when the model response is missing required fields", async () => {
  const { root, dir } = await makeTask();
  try {
    const adapter = stubAdapter({ summary: "Test still red" }); // missing diagnosis
    const result = await requestRepairFindings({
      adapter,
      userRequest: "Fix it",
      projectSummary: {},
      status: "failed",
      failedChecks: [{ check_type: "test" }],
      attempts: [],
      activeTask: { dir }
    });
    assert.equal(result.ok, false);
    assert.equal(result.source, "schema_invalid");
    assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
    // Should not have written the artifact.
    await assert.rejects(() => readFile(path.join(dir, "repair-findings.json"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requestRepairFindings reports unsupported when the adapter has no respondJson", async () => {
  const result = await requestRepairFindings({
    adapter: {},
    status: "failed",
    failedChecks: [{ check_type: "test" }],
    activeTask: null
  });
  assert.equal(result.ok, false);
  assert.equal(result.source, "unsupported");
});
