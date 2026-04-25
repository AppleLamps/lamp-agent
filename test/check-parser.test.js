import test from "node:test";
import assert from "node:assert/strict";
import { parseCheckOutput } from "../src/checks/check-parser.js";

test("parseCheckOutput extracts TypeScript errors", () => {
  const parsed = parseCheckOutput({
    checkType: "typecheck",
    command: "npm run typecheck",
    code: 2,
    stdout: "src/app.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'."
  });

  assert.equal(parsed.status, "failed");
  assert.equal(parsed.errors[0].source, "typescript");
  assert.equal(parsed.errors[0].code, "TS2322");
  assert.deepEqual(parsed.failed_files, ["src/app.ts"]);
});

test("parseCheckOutput extracts stack frames and expected actual values", () => {
  const parsed = parseCheckOutput({
    checkType: "test",
    command: "npm test",
    code: 1,
    stderr: `
FAIL src/login.test.ts
Expected: /dashboard
Received: /login
    at Object.<anonymous> (src/login.test.ts:14:9)
`
  });

  assert.equal(parsed.status, "failed");
  assert.equal(parsed.failed_tests[0], "src/login.test.ts");
  assert.equal(parsed.expected, "/dashboard");
  assert.equal(parsed.actual, "/login");
  assert.deepEqual(parsed.likely_relevant_files, ["src/login.test.ts"]);
});
