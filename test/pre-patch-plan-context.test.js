import test from "node:test";
import assert from "node:assert/strict";
import { compactPrePatchPlanForModel } from "../src/model/openrouter.js";

test("returns null for null/undefined/non-object input", () => {
  assert.equal(compactPrePatchPlanForModel(null), null);
  assert.equal(compactPrePatchPlanForModel(undefined), null);
  assert.equal(compactPrePatchPlanForModel("string"), null);
  assert.equal(compactPrePatchPlanForModel(42), null);
});

test("returns null when no scope/risk/danger fields are populated", () => {
  assert.equal(compactPrePatchPlanForModel({}), null);
  assert.equal(compactPrePatchPlanForModel({
    expected_scope: { candidate_files: [], risk_labels: [] },
    danger_zones: { avoid_touching: [], secret_paths: [] }
  }), null);
});

test("renders a candidate-files line when candidate_files is non-empty", () => {
  const out = compactPrePatchPlanForModel({
    expected_scope: { candidate_files: ["src/auth/login.ts", "src/api/handler.ts"] }
  });
  assert.match(out, /Likely scope: src\/auth\/login\.ts, src\/api\/handler\.ts/);
});

test("truncates candidate_files at 12 entries to stay token-friendly", () => {
  const files = Array.from({ length: 30 }, (_, i) => `file${i}.ts`);
  const out = compactPrePatchPlanForModel({
    expected_scope: { candidate_files: files }
  });
  assert.match(out, /file0\.ts/);
  assert.match(out, /file11\.ts/);
  assert.equal(/file12\.ts/.test(out), false, "13th+ entries should be dropped");
});

test("renders all four optional sections when provided", () => {
  const out = compactPrePatchPlanForModel({
    expected_scope: {
      candidate_files: ["a.ts"],
      risk_labels: ["dependency_change", "secret"]
    },
    danger_zones: {
      avoid_touching: ["legacy/*"],
      secret_paths: [".env"]
    }
  });
  assert.match(out, /Likely scope: a\.ts/);
  assert.match(out, /Risk labels: dependency_change, secret/);
  assert.match(out, /Avoid touching \(project memory\): legacy\/\*/);
  assert.match(out, /Secret-bearing paths in workspace: \.env/);
});

test("includes a heuristic-disclaimer line when any content rendered", () => {
  const out = compactPrePatchPlanForModel({
    expected_scope: { candidate_files: ["a.ts"] }
  });
  assert.match(out, /This plan is heuristic\./);
});
