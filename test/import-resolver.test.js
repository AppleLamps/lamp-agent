import test from "node:test";
import assert from "node:assert/strict";
import { resolveImport, normalizePath } from "../src/code/import-resolver.js";

test("resolveImport handles relative paths with each common JS/TS extension", () => {
  const fileSet = new Set([
    "src/auth/login.test.ts",
    "src/auth/login.ts",
    "src/auth/session.tsx",
    "src/utils/string.js",
    "src/utils/date.cjs",
    "src/utils/url.mjs"
  ]);
  assert.equal(
    resolveImport({ from: "src/auth/login.test.ts", source: "./login", fileSet }),
    "src/auth/login.ts"
  );
  assert.equal(
    resolveImport({ from: "src/auth/login.test.ts", source: "./session", fileSet }),
    "src/auth/session.tsx"
  );
  assert.equal(
    resolveImport({ from: "src/auth/login.ts", source: "../utils/string", fileSet }),
    "src/utils/string.js"
  );
  assert.equal(
    resolveImport({ from: "src/auth/login.ts", source: "../utils/date", fileSet }),
    "src/utils/date.cjs"
  );
  assert.equal(
    resolveImport({ from: "src/auth/login.ts", source: "../utils/url", fileSet }),
    "src/utils/url.mjs"
  );
});

test("resolveImport falls back to <dir>/index.<ext>", () => {
  const fileSet = new Set([
    "src/billing/index.ts",
    "src/utils/index.tsx",
    "src/api/index.js"
  ]);
  assert.equal(
    resolveImport({ from: "src/cli.ts", source: "./billing", fileSet }),
    "src/billing/index.ts"
  );
  assert.equal(
    resolveImport({ from: "src/cli.ts", source: "./utils", fileSet }),
    "src/utils/index.tsx"
  );
  assert.equal(
    resolveImport({ from: "src/cli.ts", source: "./api", fileSet }),
    "src/api/index.js"
  );
});

test("resolveImport accepts an explicit extension that already matches", () => {
  const fileSet = new Set(["src/auth/login.ts"]);
  assert.equal(
    resolveImport({ from: "src/cli.ts", source: "./auth/login.ts", fileSet }),
    "src/auth/login.ts"
  );
});

test("resolveImport returns null for bare specifiers and absolute paths", () => {
  const fileSet = new Set(["lodash.js"]);
  assert.equal(resolveImport({ from: "src/cli.ts", source: "lodash", fileSet }), null);
  assert.equal(resolveImport({ from: "src/cli.ts", source: "@scope/pkg", fileSet }), null);
  assert.equal(resolveImport({ from: "src/cli.ts", source: "/etc/config", fileSet }), null);
});

test("resolveImport returns null when the source does not match any workspace file", () => {
  const fileSet = new Set(["src/auth/login.ts"]);
  assert.equal(
    resolveImport({ from: "src/cli.ts", source: "./missing", fileSet }),
    null
  );
});

test("resolveImport accepts an array fileSet for convenience", () => {
  const result = resolveImport({
    from: "src/a.ts",
    source: "./b",
    fileSet: ["src/a.ts", "src/b.ts"]
  });
  assert.equal(result, "src/b.ts");
});

test("normalizePath converts backslashes and strips ./", () => {
  assert.equal(normalizePath("src\\auth\\login.ts"), "src/auth/login.ts");
  assert.equal(normalizePath("./src/cli.ts"), "src/cli.ts");
  assert.equal(normalizePath(""), "");
});
