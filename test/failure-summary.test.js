import test from "node:test";
import assert from "node:assert/strict";
import {
  summarizeFailureForRepair,
  summarizeFailureForRepairWithSnippet
} from "../src/checks/failure-summary.js";

test("summarizeFailureForRepair picks the model-useful fields and drops noisy ones", () => {
  const parsed = {
    id: "check-001",
    command: "npx vitest run --reporter=json",
    check_type: "test",
    status: "failed",
    exit_code: 1,
    parsed_source: "structured:vitest-json",
    failed_files: ["src/foo.test.ts"],
    failed_tests: ["foo > rejects bad input"],
    errors: [{
      source: "vitest",
      file: "src/foo.test.ts",
      line: 12,
      column: 4,
      message: "AssertionError: expected 1 to be 2",
      full_message: "AssertionError: expected 1 to be 2\n    at .../foo.test.ts:12:4"
    }],
    stack_traces: [{ path: "src/foo.test.ts", line: 12, column: 4 }],
    expected: 2,
    actual: 1,
    likely_relevant_files: ["src/foo.ts", "src/foo.test.ts"],
    likely_relevant_files_provenance: {
      "src/foo.ts": ["import-graph", "co-located"],
      "src/foo.test.ts": ["stack"]
    },
    raw_stdout_path: "checks/check-001.stdout.txt",
    raw_stderr_path: "checks/check-001.stderr.txt",
    created_at: "2026-04-25T20:00:00.000Z",
    summary: "test failed in 1 test."
  };

  const summary = summarizeFailureForRepair(parsed);

  assert.equal(summary.check_type, "test");
  assert.equal(summary.status, "failed");
  assert.equal(summary.exit_code, 1);
  assert.equal(summary.parsed_source, "structured:vitest-json");
  assert.deepEqual(summary.failed_files, ["src/foo.test.ts"]);
  assert.deepEqual(summary.failed_tests, ["foo > rejects bad input"]);
  assert.equal(summary.expected, 2);
  assert.equal(summary.actual, 1);
  assert.equal(summary.command, "npx vitest run --reporter=json");

  // Errors are simplified: full_message is dropped, useful fields kept.
  assert.equal(summary.errors.length, 1);
  assert.equal(summary.errors[0].source, "vitest");
  assert.equal(summary.errors[0].file, "src/foo.test.ts");
  assert.equal(summary.errors[0].line, 12);
  assert.equal(summary.errors[0].message, "AssertionError: expected 1 to be 2");
  assert.equal(summary.errors[0].full_message, undefined,
    "noisy full_message field should be dropped");

  // Likely-relevant files are zipped with their provenance tags.
  assert.deepEqual(summary.likely_relevant_files, [
    { path: "src/foo.ts", provenance: ["import-graph", "co-located"] },
    { path: "src/foo.test.ts", provenance: ["stack"] }
  ]);

  // Audit-only fields must not leak into the model prompt.
  assert.equal(summary.id, undefined);
  assert.equal(summary.raw_stdout_path, undefined);
  assert.equal(summary.raw_stderr_path, undefined);
  assert.equal(summary.created_at, undefined);
});

test("summarizeFailureForRepair handles missing/partial input gracefully", () => {
  assert.deepEqual(summarizeFailureForRepair(null), {
    status: "unknown",
    summary: "No parsed check available."
  });
  const partial = summarizeFailureForRepair({ status: "failed" });
  assert.equal(partial.status, "failed");
  assert.deepEqual(partial.failed_files, []);
  assert.deepEqual(partial.errors, []);
  assert.deepEqual(partial.likely_relevant_files, []);
});

test("summarizeFailureForRepair caps long lists so prompts stay bounded", () => {
  const errors = Array.from({ length: 50 }, (_, index) => ({
    source: "go",
    file: `pkg/file${index}.go`,
    line: index + 1,
    message: `error ${index}`
  }));
  const summary = summarizeFailureForRepair({
    status: "failed",
    errors,
    failed_files: errors.map((e) => e.file),
    likely_relevant_files: errors.map((e) => e.file)
  });
  assert.equal(summary.errors.length, 20);
  assert.equal(summary.failed_files.length, 20);
  assert.equal(summary.likely_relevant_files.length, 20);
});

test("summarizeFailureForRepair attaches resolved internal imports for failed files", () => {
  const codeIndex = {
    files: ["test/foo.test.js", "src/foo.js", "src/helper.js"],
    imports: new Map([
      ["test/foo.test.js", [
        { source: "../src/foo.js", names: [{ name: "foo", kind: "named" }], kind: "import", line: 1 },
        { source: "../src/helper", names: [{ name: "helper", kind: "named" }], kind: "import", line: 2 },
        { source: "node:test", names: [], kind: "import", line: 3 }
      ]]
    ])
  };

  const summary = summarizeFailureForRepair({
    status: "failed",
    check_type: "test",
    failed_files: ["test/foo.test.js", "test/missing.test.js"]
  }, { codeIndex });

  assert.deepEqual(summary.import_graph, {
    "test/foo.test.js": ["src/foo.js", "src/helper.js"]
  });
});

test("summarizeFailureForRepairWithSnippet appends a tail of the raw output", () => {
  const stderr = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n");
  const summary = summarizeFailureForRepairWithSnippet(
    { status: "failed", check_type: "build" },
    { stdout: "", stderr }
  );
  // Default snippet keeps the last 30 lines.
  const snippetLines = summary.output_snippet.split("\n");
  assert.equal(snippetLines.length, 30);
  assert.equal(snippetLines[snippetLines.length - 1], "line 50");
  assert.equal(snippetLines[0], "line 21");
});
