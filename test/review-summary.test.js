import test from "node:test";
import assert from "node:assert/strict";
import {
  groupChangedFileReasons,
  groupWarningsBySeverity,
  summarizeBlastRadius,
  summarizeTimeline
} from "../src/review/review-summary.js";

test("groupChangedFileReasons explains edits from events and diff summary", () => {
  const result = groupChangedFileReasons({
    changed: ["src/app.js"],
    diff: {
      summary: [{ path: "src/app.js", status: "modified", added: 1, removed: 0, changed: 2 }]
    },
    events: [{ type: "edit", tool: "replace_exact", path: "src/app.js" }]
  });

  assert.equal(result[0].path, "src/app.js");
  assert.ok(result[0].reasons.some((reason) => /replace_exact/.test(reason)));
  assert.ok(result[0].reasons.some((reason) => /3 changed line/.test(reason)));
});

test("summarizeBlastRadius groups changed files and check risk", () => {
  const result = summarizeBlastRadius({
    changed: ["src/app.js", "test/app.test.js", "package.json"],
    checks: [{ name: "test", ok: false, skipped: false }],
    critique: { findings: [{ severity: "warning", text: "Review this." }] }
  });

  assert.equal(result.risk, "higher");
  assert.ok(result.labels.includes("1 source file(s)"));
  assert.ok(result.labels.includes("1 test file(s)"));
  assert.ok(result.labels.includes("1 config/package file(s)"));
  assert.match(result.verification, /failed checks/);
});

test("groupWarningsBySeverity combines checks, critique, beliefs", () => {
  const result = groupWarningsBySeverity({
    checks: [{ name: "lint", ok: false, skipped: false, message: "Lint failed." }],
    critique: { findings: [{ severity: "info", text: "Looks scoped." }] },
    beliefs: {
      risks: [{ text: "Risk remains." }],
      assumptions: [{ text: "Assumption remains." }]
    }
  });

  assert.ok(result.error.includes("Failed lint: Lint failed."));
  assert.ok(result.warning.includes("Risk remains."));
  assert.ok(result.info.includes("Looks scoped."));
  assert.ok(result.info.includes("Assumption: Assumption remains."));
});

test("summarizeTimeline combines phase and important event entries", () => {
  const result = summarizeTimeline({
    phases: {
      triage: { phase: "triage", state: "completed", completed_at: "2026-01-01T00:00:02.000Z" }
    },
    events: [
      { type: "task_created", timestamp: "2026-01-01T00:00:01.000Z" },
      { type: "tool_call", timestamp: "2026-01-01T00:00:03.000Z" }
    ]
  });

  assert.deepEqual(result.map((item) => item.label), ["task_created", "triage: completed"]);
});
