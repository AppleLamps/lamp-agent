import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCheckOutput } from "../src/checks/check-parser.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD_ERRORS = path.join(HERE, "fixtures", "check-output", "build-errors");

function fixture(name) {
  return readFile(path.join(BUILD_ERRORS, name), "utf8");
}

function only(parsed, source) {
  return parsed.errors.filter((entry) => entry.source === source);
}

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

test("parseCheckOutput extracts esbuild errors with file/line/column", async () => {
  const stdout = await fixture("esbuild.txt");
  const parsed = parseCheckOutput({
    checkType: "build", command: "npx esbuild ...", code: 1, stdout
  });
  const esbuild = only(parsed, "esbuild");
  assert.equal(esbuild.length, 2);
  assert.equal(esbuild[0].file, "src/foo.ts");
  assert.equal(esbuild[0].line, 3);
  assert.equal(esbuild[0].column, 23);
  assert.match(esbuild[0].message, /Could not resolve "missing-pkg"/);
  assert.equal(esbuild[1].file, "src/bar.ts");
  assert.equal(esbuild[1].line, 42);
  assert.ok(parsed.failed_files.includes("src/foo.ts"));
  assert.ok(parsed.failed_files.includes("src/bar.ts"));
});

test("parseCheckOutput extracts Vite/Rollup plugin errors", async () => {
  const stdout = await fixture("vite.txt");
  const parsed = parseCheckOutput({
    checkType: "build", command: "npx vite build", code: 1, stdout
  });
  const vite = only(parsed, "vite");
  assert.equal(vite.length, 2);
  assert.equal(vite[0].plugin, "react");
  assert.match(vite[0].file, /components\/Button\.tsx$/);
  assert.equal(vite[0].line, 24);
  assert.equal(vite[0].column, 13);
  assert.match(vite[0].message, /Failed to parse JSX/);
  assert.equal(vite[1].plugin, "import-analysis");
  assert.match(vite[1].message, /Failed to resolve import/);
});

test("parseCheckOutput extracts webpack errors (with and without line/col)", async () => {
  const stdout = await fixture("webpack.txt");
  const parsed = parseCheckOutput({
    checkType: "build", command: "npx webpack --mode production", code: 1, stdout
  });
  const webpack = only(parsed, "webpack");
  assert.equal(webpack.length, 2);
  const tsError = webpack.find((entry) => entry.code === "TS2304");
  assert.ok(tsError, "should pick the TS2304 webpack error");
  assert.equal(tsError.file, "src/foo.ts");
  assert.equal(tsError.line, 5);
  assert.equal(tsError.column, 7);
  const moduleNotFound = webpack.find((entry) => /Module not found/.test(entry.message));
  assert.ok(moduleNotFound, "should pick the Module-not-found webpack error");
  assert.equal(moduleNotFound.file, "src/components/Button.tsx");
  assert.equal(moduleNotFound.line, null);
});

test("parseCheckOutput extracts Next.js compile errors", async () => {
  const stdout = await fixture("nextjs.txt");
  const parsed = parseCheckOutput({
    checkType: "build", command: "next build", code: 1, stdout
  });
  const nextjs = only(parsed, "nextjs");
  assert.equal(nextjs.length, 2);
  assert.equal(nextjs[0].file, "src/app/page.tsx");
  assert.equal(nextjs[0].line, 7);
  assert.equal(nextjs[0].column, 13);
  assert.equal(nextjs[0].kind, "Type error");
  assert.match(nextjs[0].message, /Property 'foo' does not exist/);
  assert.equal(nextjs[1].kind, "Module not found");
  assert.equal(nextjs[1].file, "src/components/Header.tsx");
});

test("parseCheckOutput extracts TypeScript pretty-mode errors", async () => {
  const stdout = await fixture("typescript-pretty.txt");
  const parsed = parseCheckOutput({
    checkType: "typecheck", command: "npx tsc --noEmit", code: 2, stdout
  });
  const ts = only(parsed, "typescript");
  // Pretty mode adds two entries; the (line,col) form is not present
  // in this fixture so all two come through the pretty collector.
  assert.equal(ts.length, 2);
  assert.equal(ts[0].file, "src/foo.ts");
  assert.equal(ts[0].line, 5);
  assert.equal(ts[0].column, 7);
  assert.equal(ts[0].code, "TS2304");
  assert.equal(ts[0].severity, "error");
  assert.equal(ts[1].code, "TS2322");
  assert.equal(ts[1].file, "src/bar.ts");
});

test("parseCheckOutput extracts Cargo errors", async () => {
  const stdout = await fixture("cargo.txt");
  const parsed = parseCheckOutput({
    checkType: "build", command: "cargo build", code: 101, stdout
  });
  const cargo = only(parsed, "cargo");
  assert.equal(cargo.length, 2);
  assert.equal(cargo[0].code, "E0425");
  assert.equal(cargo[0].file, "src/main.rs");
  assert.equal(cargo[0].line, 5);
  assert.equal(cargo[0].column, 5);
  assert.equal(cargo[0].severity, "error");
  assert.match(cargo[0].message, /cannot find value `unknown_fn`/);
  assert.equal(cargo[1].code, "E0308");
  assert.equal(cargo[1].file, "src/lib.rs");
});

test("parseCheckOutput extracts Go compile errors", async () => {
  const stdout = await fixture("go.txt");
  const parsed = parseCheckOutput({
    checkType: "build", command: "go build ./...", code: 2, stdout
  });
  const go = only(parsed, "go");
  assert.equal(go.length, 3);
  assert.equal(go[0].file, "calc.go");
  assert.equal(go[0].line, 7);
  assert.equal(go[0].column, 9);
  assert.match(go[0].message, /undefined: undefinedFunc/);
  assert.equal(go[2].file, "internal/util/format.go");
});

test("parseCheckOutput cleanly composes errors from multiple tools in one run", async () => {
  // Concatenate two fixtures. The collectors run in parallel and should
  // all produce the right entries without crosstalk.
  const merged = `${await fixture("esbuild.txt")}\n${await fixture("typescript-pretty.txt")}`;
  const parsed = parseCheckOutput({
    checkType: "build", command: "npm run build", code: 1, stdout: merged
  });
  assert.ok(only(parsed, "esbuild").length === 2);
  assert.ok(only(parsed, "typescript").length === 2);
  // failed_files should include both ecosystems' files.
  assert.ok(parsed.failed_files.includes("src/foo.ts"));
  assert.ok(parsed.failed_files.includes("src/bar.ts"));
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
