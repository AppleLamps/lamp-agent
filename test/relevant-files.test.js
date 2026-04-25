import test from "node:test";
import assert from "node:assert/strict";
import { mapFailedTestsToSources } from "../src/checks/relevant-files.js";

function buildIndex(filesAndImports) {
  // Helper: builds a minimal code-index-shaped object out of a map of
  // { file: [{ source: "..." }, ...] } entries.
  const imports = new Map();
  const files = [];
  for (const [file, imps] of Object.entries(filesAndImports)) {
    files.push(file);
    imports.set(file, imps);
  }
  return { files, imports, exports: new Map(), defsByName: new Map(), symbols: [] };
}

test("import-graph wins over stack frames when both are present", () => {
  const index = buildIndex({
    "src/auth/login.test.ts": [
      { source: "./login" }
    ],
    "src/auth/login.ts": []
  });
  const allFiles = ["src/auth/login.test.ts", "src/auth/login.ts", "node_modules/x/y.js"];

  const parsed = {
    failed_files: ["src/auth/login.test.ts"],
    failed_tests: [],
    stack_traces: [
      { path: "src/auth/login.test.ts", line: 12, column: 1 },
      { path: "node:internal/foo.js", line: 1, column: 1 }
    ]
  };

  const mapping = mapFailedTestsToSources(parsed, { codeIndex: index, allFiles });

  // login.ts should be ranked above the test file because import-graph
  // outranks stack provenance. login.ts is also co-located so it
  // legitimately carries both tags.
  assert.equal(mapping.likely_relevant_files[0], "src/auth/login.ts");
  const sutTags = mapping.likely_relevant_files_provenance["src/auth/login.ts"];
  assert.ok(sutTags.includes("import-graph"));
  assert.ok(sutTags.includes("co-located"));
  assert.deepEqual(
    mapping.likely_relevant_files_provenance["src/auth/login.test.ts"],
    ["stack"]
  );
});

test("co-located heuristic finds same-named source files", () => {
  const index = buildIndex({
    "src/billing/invoice.test.js": []
  });
  const allFiles = [
    "src/billing/invoice.test.js",
    "src/billing/invoice.js",
    "src/billing/other.js"
  ];

  const parsed = {
    failed_files: ["src/billing/invoice.test.js"],
    failed_tests: [],
    stack_traces: []
  };

  const mapping = mapFailedTestsToSources(parsed, { codeIndex: index, allFiles });
  assert.ok(mapping.likely_relevant_files.includes("src/billing/invoice.js"));
  assert.deepEqual(
    mapping.likely_relevant_files_provenance["src/billing/invoice.js"],
    ["co-located"]
  );
});

test("co-located heuristic also tries other JS/TS extensions", () => {
  const index = buildIndex({
    "src/foo.spec.ts": []
  });
  const allFiles = ["src/foo.spec.ts", "src/foo.tsx"];

  const parsed = { failed_files: ["src/foo.spec.ts"], failed_tests: [], stack_traces: [] };
  const mapping = mapFailedTestsToSources(parsed, { codeIndex: index, allFiles });
  assert.ok(mapping.likely_relevant_files.includes("src/foo.tsx"));
});

test("relative import resolution handles index files and various extensions", () => {
  const index = buildIndex({
    "src/auth/session.test.ts": [
      { source: "./session" },
      { source: "../shared" },
      { source: "../shared/util" }
    ]
  });
  const allFiles = [
    "src/auth/session.test.ts",
    "src/auth/session.ts",
    "src/shared/index.ts",
    "src/shared/util.tsx"
  ];

  const parsed = { failed_files: ["src/auth/session.test.ts"], failed_tests: [], stack_traces: [] };
  const mapping = mapFailedTestsToSources(parsed, { codeIndex: index, allFiles });

  // Each relative source should resolve to a concrete file.
  assert.ok(mapping.likely_relevant_files.includes("src/auth/session.ts"));
  assert.ok(mapping.likely_relevant_files.includes("src/shared/index.ts"));
  assert.ok(mapping.likely_relevant_files.includes("src/shared/util.tsx"));
});

test("bare specifier imports are skipped (likely third-party deps)", () => {
  const index = buildIndex({
    "src/api.test.ts": [
      { source: "lodash" },
      { source: "@scope/pkg" },
      { source: "./client" }
    ]
  });
  const allFiles = ["src/api.test.ts", "src/client.ts"];

  const parsed = { failed_files: ["src/api.test.ts"], failed_tests: [], stack_traces: [] };
  const mapping = mapFailedTestsToSources(parsed, { codeIndex: index, allFiles });

  assert.ok(mapping.likely_relevant_files.includes("src/client.ts"));
  assert.ok(!mapping.likely_relevant_files.includes("lodash"));
  assert.ok(!mapping.likely_relevant_files.includes("@scope/pkg"));
});

test("non-test failed_files pass through with stack provenance", () => {
  // A failing typecheck/lint reports source files directly; nothing to
  // resolve, but the files should still appear with provenance recorded.
  const index = buildIndex({});
  const allFiles = ["src/foo.ts"];

  const parsed = { failed_files: ["src/foo.ts"], failed_tests: [], stack_traces: [] };
  const mapping = mapFailedTestsToSources(parsed, { codeIndex: index, allFiles });

  assert.deepEqual(mapping.likely_relevant_files, ["src/foo.ts"]);
  assert.deepEqual(
    mapping.likely_relevant_files_provenance["src/foo.ts"],
    ["stack"]
  );
});

test("normalises Windows-style backslash paths", () => {
  const index = buildIndex({
    "src/auth/login.test.ts": [{ source: "./login" }]
  });
  const allFiles = ["src/auth/login.test.ts", "src/auth/login.ts"];

  const parsed = {
    failed_files: ["src\\auth\\login.test.ts"],
    failed_tests: [],
    stack_traces: [{ path: "src\\auth\\login.test.ts", line: 1, column: 1 }]
  };
  const mapping = mapFailedTestsToSources(parsed, { codeIndex: index, allFiles });

  assert.ok(mapping.likely_relevant_files.includes("src/auth/login.test.ts"));
  assert.ok(mapping.likely_relevant_files.includes("src/auth/login.ts"));
});

test("a path picked up by both co-location and import-graph carries both tags", () => {
  const index = buildIndex({
    "src/foo.test.ts": [{ source: "./foo" }]
  });
  const allFiles = ["src/foo.test.ts", "src/foo.ts"];

  const parsed = { failed_files: ["src/foo.test.ts"], failed_tests: [], stack_traces: [] };
  const mapping = mapFailedTestsToSources(parsed, { codeIndex: index, allFiles });

  const tags = mapping.likely_relevant_files_provenance["src/foo.ts"] || [];
  assert.ok(tags.includes("import-graph"));
  assert.ok(tags.includes("co-located"));
});
