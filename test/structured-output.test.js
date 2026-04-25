import test from "node:test";
import assert from "node:assert/strict";
import {
  PLAN_SCHEMA,
  EDIT_SPEC_SCHEMA,
  REPAIR_FINDINGS_SCHEMA,
  validate,
  describeSchema
} from "../src/model/structured-output.js";

test("validate accepts a well-formed plan", () => {
  const result = validate({
    summary: "Wire login redirect",
    steps: ["Inspect login.ts", "Update redirect target", "Run tests"],
    risky_boundaries: ["network"],
    expected_files: ["src/auth/login.ts"],
    expected_checks: ["test"]
  }, PLAN_SCHEMA);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("validate rejects a plan missing required fields", () => {
  const result = validate({ steps: ["Inspect"] }, PLAN_SCHEMA);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => /summary/.test(entry.path)));
});

test("validate rejects wrong types inside arrays", () => {
  const result = validate({
    summary: "x",
    steps: ["one", 2, "three"]
  }, PLAN_SCHEMA);
  assert.equal(result.ok, false);
  // The integer at index 1 should fail the items.string check.
  assert.ok(result.errors.some((entry) => /\$\.steps\[1\]/.test(entry.path)));
});

test("validate handles edit-spec entries and enums", () => {
  const valid = validate({
    summary: "Add util module",
    estimated_risk: "low",
    edits: [{
      tool: "create_file",
      path: "src/extra.js",
      args: { content: "export const x = 1;" },
      intent: "Introduce a tiny helper"
    }]
  }, EDIT_SPEC_SCHEMA);
  assert.equal(valid.ok, true);

  const invalidRisk = validate({
    summary: "Bad",
    estimated_risk: "catastrophic",
    edits: []
  }, EDIT_SPEC_SCHEMA);
  assert.equal(invalidRisk.ok, false);
  assert.ok(invalidRisk.errors.some((entry) => /enum/.test(entry.message)));

  const missingTool = validate({
    summary: "Missing",
    edits: [{ intent: "no tool" }]
  }, EDIT_SPEC_SCHEMA);
  assert.equal(missingTool.ok, false);
});

test("validate handles repair-findings shape", () => {
  const ok = validate({
    diagnosis: "Off by one in the date math",
    summary: "Adjust modulo by 1",
    severity: "low",
    proposed_fix: { summary: "Subtract 1 from the modulus", steps: ["Edit calc.js"] }
  }, REPAIR_FINDINGS_SCHEMA);
  assert.equal(ok.ok, true);

  const bad = validate({
    diagnosis: 12,
    summary: "Wrong type"
  }, REPAIR_FINDINGS_SCHEMA);
  assert.equal(bad.ok, false);
});

test("validate accepts arbitrary args via the 'any' type", () => {
  const result = validate({
    summary: "ok",
    edits: [{ tool: "run_command", intent: "run tests", args: { command: "npm test" } }]
  }, EDIT_SPEC_SCHEMA);
  assert.equal(result.ok, true);
});

test("describeSchema produces a readable system-prompt block", () => {
  const text = describeSchema(PLAN_SCHEMA);
  assert.match(text, /"summary"\*: string/);
  assert.match(text, /"steps"\*: array of/);
  assert.match(text, /"risky_boundaries": array of/);
});
