import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseStructuredOutput,
  parseTap,
  parseVitestJson,
  parseJestJson,
  parsePytestJUnit,
  parseEslintJson
} from "../src/checks/structured-reporter.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "check-output");

async function fixture(name) {
  return readFile(path.join(FIXTURES, name), "utf8");
}

test("parseTap on a failing Node test run extracts location, expected/actual, and stack", async () => {
  const stdout = await fixture("node-tap-failing.txt");
  const result = parseTap({ command: "node --test specs/main.mjs", code: 1, stdout });

  assert.equal(result.status, "failed");
  assert.equal(result.exit_code, 1);
  assert.deepEqual(result.failed_tests, ["brokenAdd returns the correct sum"]);
  assert.equal(result.errors.length, 1);
  const err = result.errors[0];
  assert.equal(err.source, "node-test");
  assert.equal(err.code, "ERR_ASSERTION");
  assert.equal(err.name, "AssertionError");
  assert.equal(err.expected, 5);
  assert.equal(err.actual, 4);
  assert.equal(err.operator, "strictEqual");
  assert.match(err.message, /Expected values to be strictly equal/);
  assert.match(err.file, /specs\/main\.mjs$/);
  assert.equal(err.line, 5);

  // Stack frames come from the multi-line stack block.
  assert.ok(result.stack_traces.length >= 1);
  const topFrame = result.stack_traces[0];
  assert.match(topFrame.path, /specs\/main\.mjs$/);
  assert.equal(topFrame.line, 7);

  // Failed files include both the location file and the stack-frame file.
  assert.ok(result.failed_files.some((file) => /specs\/main\.mjs$/.test(file)));
  assert.equal(result.expected, 5);
  assert.equal(result.actual, 4);
  assert.match(result.summary, /failed in 1 test/);
});

test("parseTap on a passing Node test run reports no failures", async () => {
  const stdout = await fixture("node-tap-passing.txt");
  const result = parseTap({ command: "node --test specs/main.mjs", code: 0, stdout });

  assert.equal(result.status, "passed");
  assert.equal(result.exit_code, 0);
  assert.deepEqual(result.failed_tests, []);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.failed_files, []);
  assert.equal(result.summary, "test passed.");
});

test("parseTap returns null when input is not TAP", () => {
  assert.equal(parseTap({ stdout: "PASS some-test.js (1.0 s)" }), null);
  assert.equal(parseTap({ stdout: "" }), null);
});

test("parseVitestJson extracts failed tests, file, and a stack frame", async () => {
  const stdout = await fixture("vitest-failing.json");
  const result = parseVitestJson({ command: "npx vitest run --reporter=json", code: 1, stdout });

  assert.equal(result.status, "failed");
  assert.equal(result.exit_code, 1);
  assert.deepEqual(result.failed_tests, ["session > refreshes near-expiry tokens"]);
  assert.equal(result.failed_files.length, 1);
  assert.match(result.failed_files[0], /\/repo\/src\/auth\/session\.test\.ts$/);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].source, "vitest");
  assert.match(result.errors[0].message, /AssertionError/);
  // Stack frame parsed out of failureMessages.
  assert.ok(result.stack_traces.some((frame) => /session\.test\.ts$/.test(frame.path) && frame.line === 42));
  assert.match(result.summary, /failed in 1 test/);
});

test("parseVitestJson on malformed input returns null", () => {
  assert.equal(parseVitestJson({ stdout: "not json" }), null);
  assert.equal(parseVitestJson({ stdout: '{"foo": 1}' }), null);
});

test("parseJestJson handles Jest's reporter shape", async () => {
  const stdout = await fixture("jest-failing.json");
  const result = parseJestJson({ command: "npx jest --json", code: 1, stdout });

  assert.equal(result.status, "failed");
  assert.deepEqual(result.failed_tests, ["invoice rounding is bankers' rounding"]);
  assert.match(result.errors[0].message, /toBe\(expected\)/);
  assert.ok(result.stack_traces.some((frame) => /invoice\.test\.js$/.test(frame.path) && frame.line === 18));
});

test("parsePytestJUnit pulls failure file, line, and assertion summary", async () => {
  const stdout = await fixture("pytest-junit-failing.xml");
  const result = parsePytestJUnit({ command: "python -m pytest --junit-xml=-", code: 1, stdout });

  assert.equal(result.status, "failed");
  assert.equal(result.exit_code, 1);
  assert.equal(result.failed_tests.length, 1);
  assert.match(result.failed_tests[0], /test_broken_add_returns_the_correct_sum/);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].source, "pytest");
  assert.match(result.errors[0].message, /assert 4 == 5/);
  assert.match(result.errors[0].file, /check_calculator\.py$/);
  assert.equal(result.errors[0].line, 10);
  assert.equal(result.failed_files[0].endsWith("check_calculator.py"), true);
  assert.equal(result.actual, "broken_add(2, 3)");
  assert.equal(result.expected, "5");
  assert.match(result.summary, /failed in 1 test/);
});

test("parsePytestJUnit returns null on non-XML input", () => {
  assert.equal(parsePytestJUnit({ stdout: "hello" }), null);
});

test("parseEslintJson maps severity and counts errors only", async () => {
  const stdout = await fixture("eslint-failing.json");
  const result = parseEslintJson({ command: "npx eslint --format=json", code: 1, stdout });

  assert.equal(result.status, "failed");
  // 2 errors total, 1 warning ignored for failure decision.
  const errorEntries = result.errors.filter((entry) => entry.severity === "error");
  const warningEntries = result.errors.filter((entry) => entry.severity === "warning");
  assert.equal(errorEntries.length, 2);
  assert.equal(warningEntries.length, 1);
  // Failed files are only those carrying at least one error.
  assert.equal(result.failed_files.length, 2);
  assert.ok(result.failed_files.some((file) => file.endsWith("login.ts")));
  assert.ok(result.failed_files.some((file) => file.endsWith("invoice.ts")));
  // Rule names are preserved.
  assert.ok(result.errors.some((entry) => entry.rule === "no-unused-vars"));
  assert.ok(result.errors.some((entry) => entry.rule === "eqeqeq"));
  assert.match(result.summary, /failed with 2 errors/);
});

test("parseEslintJson with only warnings still reports passed", async () => {
  const stdout = await fixture("eslint-passing.json");
  const result = parseEslintJson({ command: "npx eslint --format=json", code: 0, stdout });

  assert.equal(result.status, "passed");
  assert.deepEqual(result.failed_files, []);
  // The warning is still recorded so callers can surface it.
  const warnings = result.errors.filter((entry) => entry.severity === "warning");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].rule, "prefer-const");
});

test("parseEslintJson returns null on non-array input", () => {
  assert.equal(parseEslintJson({ stdout: '{"foo": 1}' }), null);
  assert.equal(parseEslintJson({ stdout: "" }), null);
});

test("parseStructuredOutput dispatches by format and returns null for unknown formats", async () => {
  const tap = await fixture("node-tap-failing.txt");
  const dispatched = parseStructuredOutput({
    format: "tap",
    command: "node --test",
    code: 1,
    stdout: tap
  });
  assert.equal(dispatched.status, "failed");

  const unknown = parseStructuredOutput({ format: "unknown", stdout: "anything" });
  assert.equal(unknown, null);
});
