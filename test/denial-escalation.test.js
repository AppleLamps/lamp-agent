import test from "node:test";
import assert from "node:assert/strict";
import { escalateOnConsecutiveDenials } from "../src/model/openrouter.js";

test("first denial passes through unchanged", () => {
  const state = { lastKey: null, count: 0 };
  const result = escalateOnConsecutiveDenials({
    result: { ok: false, denied: true, decision: { tier: "external_publish" } },
    toolName: "run_command",
    state
  });
  assert.equal(result.harness_note, undefined);
  assert.equal(state.count, 1);
  assert.equal(state.lastKey, "external_publish|run_command");
});

test("second consecutive denial of the same tier+tool augments with harness_note", () => {
  const state = { lastKey: null, count: 0 };
  escalateOnConsecutiveDenials({
    result: { ok: false, denied: true, decision: { tier: "external_publish" } },
    toolName: "run_command",
    state
  });
  const second = escalateOnConsecutiveDenials({
    result: { ok: false, denied: true, decision: { tier: "external_publish" } },
    toolName: "run_command",
    state
  });
  assert.match(second.harness_note, /denied operations of tier "external_publish" twice/);
  assert.match(second.harness_note, /Either propose a fundamentally different path/);
  // After escalation the counter resets so the next denial of the
  // same key starts a fresh run.
  assert.equal(state.count, 0);
  assert.equal(state.lastKey, null);
});

test("a denial followed by a different tier resets the counter", () => {
  const state = { lastKey: null, count: 0 };
  escalateOnConsecutiveDenials({
    result: { ok: false, denied: true, decision: { tier: "external_publish" } },
    toolName: "run_command",
    state
  });
  // Denial of a different tier — should NOT escalate.
  const second = escalateOnConsecutiveDenials({
    result: { ok: false, denied: true, decision: { tier: "dependency_change" } },
    toolName: "run_command",
    state
  });
  assert.equal(second.harness_note, undefined);
  assert.equal(state.count, 1);
  assert.equal(state.lastKey, "dependency_change|run_command");
});

test("a successful tool result resets the denial counter", () => {
  const state = { lastKey: null, count: 0 };
  escalateOnConsecutiveDenials({
    result: { ok: false, denied: true, decision: { tier: "external_publish" } },
    toolName: "run_command",
    state
  });
  // Success — should clear state.
  escalateOnConsecutiveDenials({
    result: { ok: true, message: "did the thing" },
    toolName: "read_file",
    state
  });
  assert.equal(state.count, 0);
  assert.equal(state.lastKey, null);
  // Now a single denial of the original tier should NOT escalate
  // (because the previous denial was reset).
  const after = escalateOnConsecutiveDenials({
    result: { ok: false, denied: true, decision: { tier: "external_publish" } },
    toolName: "run_command",
    state
  });
  assert.equal(after.harness_note, undefined);
});

test("denials with no decision tier still get escalated by tool name", () => {
  const state = { lastKey: null, count: 0 };
  escalateOnConsecutiveDenials({
    result: { ok: false, denied: true },
    toolName: "delete_file",
    state
  });
  const second = escalateOnConsecutiveDenials({
    result: { ok: false, denied: true },
    toolName: "delete_file",
    state
  });
  assert.match(second.harness_note, /denied operations of tier "denied" twice/);
});
