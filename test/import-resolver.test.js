import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveImport,
  normalizePath,
  loadTsconfigAliases,
  applyTsconfigAlias
} from "../src/code/import-resolver.js";

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

async function makeTsconfig(contents) {
  const root = await mkdtemp(path.join(tmpdir(), "tsconfig-"));
  await writeFile(path.join(root, "tsconfig.json"), contents);
  return root;
}

test("loadTsconfigAliases returns null when no tsconfig is present", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "no-tsconfig-"));
  try {
    assert.equal(loadTsconfigAliases(root), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadTsconfigAliases parses tsconfig with comments and trailing commas", async () => {
  const root = await makeTsconfig(`{
    // base settings
    "compilerOptions": {
      "baseUrl": ".",
      /* path aliases */
      "paths": {
        "@/*": ["./src/*"],
        "lib": ["./vendor/lib"],
      },
    },
  }`);
  try {
    const aliases = loadTsconfigAliases(root);
    assert.ok(aliases);
    assert.equal(aliases.patterns.length, 2);
    const wildcard = aliases.patterns.find((p) => p.pattern === "@/*");
    assert.equal(wildcard.prefix, "@/");
    assert.equal(wildcard.suffix, "");
    assert.deepEqual(wildcard.templates, ["src/*"]);
    const exact = aliases.patterns.find((p) => p.pattern === "lib");
    assert.equal(exact.suffix, null);
    assert.deepEqual(exact.templates, ["vendor/lib"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadTsconfigAliases anchors templates to baseUrl", async () => {
  const root = await makeTsconfig(`{
    "compilerOptions": {
      "baseUrl": "./src",
      "paths": { "@/*": ["./*"] }
    }
  }`);
  try {
    const aliases = loadTsconfigAliases(root);
    const wildcard = aliases.patterns.find((p) => p.pattern === "@/*");
    // baseUrl="./src" + template "./*" → workspace-relative "src/*".
    assert.deepEqual(wildcard.templates, ["src/*"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applyTsconfigAlias substitutes wildcards and rejects non-matching prefixes", () => {
  const aliases = {
    patterns: [
      { pattern: "@/*", prefix: "@/", suffix: "", templates: ["src/*"] },
      { pattern: "lib", prefix: "lib", suffix: null, templates: ["vendor/lib"] },
      { pattern: "@scope/*", prefix: "@scope/", suffix: "", templates: ["packages/*", "vendor/*"] }
    ]
  };
  assert.deepEqual(applyTsconfigAlias({ source: "@/auth/login", aliases }), ["src/auth/login"]);
  assert.deepEqual(applyTsconfigAlias({ source: "lib", aliases }), ["vendor/lib"]);
  assert.deepEqual(
    applyTsconfigAlias({ source: "@scope/foo", aliases }),
    ["packages/foo", "vendor/foo"]
  );
  // Prefix-only match without payload — empty capture rejected.
  assert.deepEqual(applyTsconfigAlias({ source: "@/", aliases }), []);
  // Fully unrelated specifier.
  assert.deepEqual(applyTsconfigAlias({ source: "lodash", aliases }), []);
});

test("resolveImport honors tsconfig aliases and tries each template in order", () => {
  const fileSet = new Set([
    "src/auth/login.ts",
    "vendor/lib.js"
  ]);
  const aliases = {
    patterns: [
      { pattern: "@/*", prefix: "@/", suffix: "", templates: ["src/*"] },
      { pattern: "lib", prefix: "lib", suffix: null, templates: ["vendor/lib"] }
    ]
  };
  assert.equal(
    resolveImport({ from: "src/cli.ts", source: "@/auth/login", fileSet, aliases }),
    "src/auth/login.ts"
  );
  assert.equal(
    resolveImport({ from: "src/cli.ts", source: "lib", fileSet, aliases }),
    "vendor/lib.js"
  );
});

test("resolveImport falls back to null when an alias matches but no file exists", () => {
  const fileSet = new Set(["src/auth/login.ts"]);
  const aliases = {
    patterns: [
      { pattern: "@/*", prefix: "@/", suffix: "", templates: ["src/*"] }
    ]
  };
  assert.equal(
    resolveImport({ from: "src/cli.ts", source: "@/auth/missing", fileSet, aliases }),
    null
  );
});

test("resolveImport falls back to .json when no JS/TS sibling exists", () => {
  const fileSet = new Set(["src/config.json", "src/main.ts"]);
  assert.equal(
    resolveImport({ from: "src/main.ts", source: "./config", fileSet }),
    "src/config.json"
  );
});

test("resolveImport prefers a JS/TS sibling over a .json with the same name", () => {
  const fileSet = new Set(["src/config.ts", "src/config.json", "src/main.ts"]);
  assert.equal(
    resolveImport({ from: "src/main.ts", source: "./config", fileSet }),
    "src/config.ts"
  );
});

test("resolveImport handles Python absolute from-imports", () => {
  const fileSet = new Set([
    "src/auth/__init__.py",
    "src/auth/login.py",
    "src/main.py",
    "src/api/handler.py"
  ]);
  // `from src.auth import login` from src/main.py → the package's __init__.py.
  assert.equal(
    resolveImport({ from: "src/main.py", source: "src.auth", fileSet }),
    "src/auth/__init__.py"
  );
  // `import src.auth.login` → the module itself.
  assert.equal(
    resolveImport({ from: "src/main.py", source: "src.auth.login", fileSet }),
    "src/auth/login.py"
  );
});

test("resolveImport handles Python relative from-imports with leading dots", () => {
  const fileSet = new Set([
    "src/api/__init__.py",
    "src/api/handler.py",
    "src/api/auth/__init__.py",
    "src/api/auth/login.py",
    "src/auth/__init__.py"
  ]);
  // `from .auth import login` from src/api/handler.py → src/api/auth/__init__.py.
  assert.equal(
    resolveImport({ from: "src/api/handler.py", source: ".auth", fileSet }),
    "src/api/auth/__init__.py"
  );
  // `from ..auth import login` from src/api/handler.py → src/auth/__init__.py.
  assert.equal(
    resolveImport({ from: "src/api/handler.py", source: "..auth", fileSet }),
    "src/auth/__init__.py"
  );
  // `from .auth.login import x` resolves the dotted submodule.
  assert.equal(
    resolveImport({ from: "src/api/handler.py", source: ".auth.login", fileSet }),
    "src/api/auth/login.py"
  );
});

test("resolveImport prefers package __init__.py over a same-named .py module", () => {
  const fileSet = new Set(["pkg/auth/__init__.py", "pkg/auth.py", "pkg/main.py"]);
  // The package wins.
  assert.equal(
    resolveImport({ from: "pkg/main.py", source: "pkg.auth", fileSet }),
    "pkg/auth/__init__.py"
  );
});

test("resolveImport returns null for Python imports that don't exist in the workspace", () => {
  const fileSet = new Set(["src/main.py"]);
  assert.equal(resolveImport({ from: "src/main.py", source: "missing.module", fileSet }), null);
  // Bare external (`pytest`, `numpy`) won't match either.
  assert.equal(resolveImport({ from: "src/main.py", source: "pytest", fileSet }), null);
});

test("resolveImport leaves bare specifiers null when no alias provided or matches", () => {
  const fileSet = new Set(["src/auth/login.ts"]);
  assert.equal(resolveImport({ from: "src/cli.ts", source: "@/auth/login", fileSet }), null);
  const aliases = {
    patterns: [{ pattern: "~/*", prefix: "~/", suffix: "", templates: ["src/*"] }]
  };
  assert.equal(
    resolveImport({ from: "src/cli.ts", source: "lodash", fileSet, aliases }),
    null
  );
});
