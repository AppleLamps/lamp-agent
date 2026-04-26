import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildCodeIndex, dependencyGraph, findSymbolCallers, findSymbolDependencies } from "../src/code/code-index.js";
import { createToolRuntime } from "../src/tools/runtime.js";

async function setupWorkspace(layout) {
  const root = await mkdtemp(path.join(tmpdir(), "callers-"));
  const files = [];
  for (const [relative, content] of Object.entries(layout)) {
    const full = path.join(root, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
    files.push(relative.replaceAll("\\", "/"));
  }
  return { root, files };
}

test("symbol_callers picks up named imports across the workspace", async () => {
  const { root, files } = await setupWorkspace({
    "src/auth/login.ts": "export function login() { return 1; }\n",
    "src/api/handler.ts": [
      "import { login } from \"../auth/login\";",
      "export function handle() {",
      "  const result = login();",
      "  return result;",
      "}",
      ""
    ].join("\n"),
    "src/api/other.ts": [
      "import { somethingElse } from \"../auth/login\";",
      "export const x = somethingElse;",
      ""
    ].join("\n"),
    "src/unrelated.ts": "export const login = 'a string named login';\n"
  });
  try {
    const codeIndex = await buildCodeIndex({ cwd: root, files });
    const result = await findSymbolCallers({ cwd: root, codeIndex, symbol: "login" });
    assert.equal(result.ok, true);
    // The handler.ts file is the only true caller (imports `login`
    // from src/auth/login and uses it).
    const callerFiles = result.callers.map((c) => c.file).sort();
    assert.deepEqual(callerFiles, ["src/api/handler.ts"]);
    const caller = result.callers[0];
    assert.equal(caller.local_name, "login");
    assert.equal(caller.resolved_from, "src/auth/login.ts");
    assert.ok(caller.references.some((ref) => /login\(\)/.test(ref.text)),
      "should record the call site as a reference");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("symbol_callers respects aliased imports (import { foo as bar })", async () => {
  const { root, files } = await setupWorkspace({
    "src/auth/login.ts": "export function login() { return 1; }\n",
    "src/api/handler.ts": [
      "import { login as authenticate } from \"../auth/login\";",
      "export function handle() {",
      "  return authenticate();",
      "}",
      ""
    ].join("\n")
  });
  try {
    const codeIndex = await buildCodeIndex({ cwd: root, files });
    const result = await findSymbolCallers({ cwd: root, codeIndex, symbol: "login" });
    const caller = result.callers.find((c) => c.file === "src/api/handler.ts");
    assert.ok(caller, "should find the aliased caller");
    assert.equal(caller.local_name, "authenticate",
      "scan should look for the local alias, not the original");
    assert.ok(caller.references.some((ref) => /authenticate\(\)/.test(ref.text)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("symbol_callers does not return files that import the same name from a different module", async () => {
  const { root, files } = await setupWorkspace({
    "src/auth/login.ts": "export function login() { return 1; }\n",
    "src/billing/login.ts": "export function login() { return 2; }\n",
    "src/api/auth-handler.ts": [
      "import { login } from \"../auth/login\";",
      "export const a = login();",
      ""
    ].join("\n"),
    "src/api/billing-handler.ts": [
      "import { login } from \"../billing/login\";",
      "export const b = login();",
      ""
    ].join("\n")
  });
  try {
    const codeIndex = await buildCodeIndex({ cwd: root, files });
    const authCallers = await findSymbolCallers({ cwd: root, codeIndex, symbol: "login" });
    // Both files appear because both files import a `login` whose
    // definitions match somewhere in the workspace. The caller record
    // identifies which definition each one points to.
    const authResolutions = authCallers.callers.map((c) => c.resolved_from).sort();
    assert.deepEqual(authResolutions, ["src/auth/login.ts", "src/billing/login.ts"]);
    // Each caller is correctly attributed to its own definition file.
    const authHandler = authCallers.callers.find((c) => c.file === "src/api/auth-handler.ts");
    assert.equal(authHandler.resolved_from, "src/auth/login.ts");
    const billingHandler = authCallers.callers.find((c) => c.file === "src/api/billing-handler.ts");
    assert.equal(billingHandler.resolved_from, "src/billing/login.ts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("symbol_callers handles default imports", async () => {
  const { root, files } = await setupWorkspace({
    "src/util/calc.ts": "export default function calc(a, b) { return a + b; }\n",
    "src/page.ts": [
      "import calc from \"./util/calc\";",
      "export const total = calc(1, 2);",
      ""
    ].join("\n")
  });
  try {
    const codeIndex = await buildCodeIndex({ cwd: root, files });
    const result = await findSymbolCallers({ cwd: root, codeIndex, symbol: "calc" });
    const caller = result.callers.find((c) => c.file === "src/page.ts");
    assert.ok(caller, "default import of calc should be picked up");
    assert.equal(caller.local_name, "calc");
    assert.equal(caller.resolved_from, "src/util/calc.ts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("symbol_callers ignores reference-only mentions in files that do not import the symbol", async () => {
  const { root, files } = await setupWorkspace({
    "src/auth/login.ts": "export function login() { return 1; }\n",
    "docs/notes.ts": "// the login function lives in src/auth/login\nexport const note = 'login';\n"
  });
  try {
    const codeIndex = await buildCodeIndex({ cwd: root, files });
    const result = await findSymbolCallers({ cwd: root, codeIndex, symbol: "login" });
    const noteHit = result.callers.find((c) => c.file === "docs/notes.ts");
    assert.equal(noteHit, undefined,
      "a file that only mentions the name without importing it is not a caller");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("symbol_dependencies resolves relative imports against the workspace", async () => {
  const { root, files } = await setupWorkspace({
    "src/auth/login.ts": "export function login() { return 1; }\n",
    "src/auth/session.ts": "export function session() { return 2; }\n",
    "src/api/handler.ts": [
      "import { login } from \"../auth/login\";",
      "import { session } from \"../auth/session\";",
      "import lodash from \"lodash\";",
      "export const x = login() + session();",
      ""
    ].join("\n")
  });
  try {
    const codeIndex = await buildCodeIndex({ cwd: root, files });
    const result = findSymbolDependencies({ codeIndex, file: "src/api/handler.ts" });
    assert.equal(result.ok, true);
    assert.equal(result.internal_count, 2);
    assert.equal(result.external_count, 1);
    const resolvedSources = result.dependencies
      .filter((entry) => entry.resolved)
      .map((entry) => entry.resolved)
      .sort();
    assert.deepEqual(resolvedSources, ["src/auth/login.ts", "src/auth/session.ts"]);
    const lodash = result.dependencies.find((entry) => entry.source === "lodash");
    assert.equal(lodash.resolved, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dependency_graph returns workspace nodes, internal edges, and external imports", async () => {
  const { root, files } = await setupWorkspace({
    "src/auth/login.ts": "export function login() { return 1; }\n",
    "src/auth/session.ts": "export function session() { return 2; }\n",
    "src/api/handler.ts": [
      "import { login } from \"../auth/login\";",
      "import { session } from \"../auth/session\";",
      "import lodash from \"lodash\";",
      "export const x = login() + session();",
      ""
    ].join("\n"),
    "src/page.ts": [
      "import { x } from \"./api/handler\";",
      "export const page = x;",
      ""
    ].join("\n")
  });
  try {
    const codeIndex = await buildCodeIndex({ cwd: root, files });
    const graph = dependencyGraph({ codeIndex });
    assert.equal(graph.ok, true);
    assert.deepEqual(graph.nodes, [
      "src/api/handler.ts",
      "src/auth/login.ts",
      "src/auth/session.ts",
      "src/page.ts"
    ]);
    assert.deepEqual(graph.edges, [
      { from: "src/api/handler.ts", to: "src/auth/login.ts" },
      { from: "src/api/handler.ts", to: "src/auth/session.ts" },
      { from: "src/page.ts", to: "src/api/handler.ts" }
    ]);
    assert.deepEqual(graph.external_imports, {
      "src/api/handler.ts": ["lodash"]
    });
    assert.equal(graph.internal_edge_count, 3);
    assert.equal(graph.external_import_count, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dependency_graph can focus on one file plus direct dependents", async () => {
  const { root, files } = await setupWorkspace({
    "src/core.ts": "export const core = 1;\n",
    "src/feature.ts": "import { core } from \"./core\";\nexport const feature = core;\n",
    "src/page.ts": "import { feature } from \"./feature\";\nexport const page = feature;\n",
    "src/other.ts": "export const other = 1;\n"
  });
  try {
    const codeIndex = await buildCodeIndex({ cwd: root, files });
    const graph = dependencyGraph({ codeIndex, file: "src/feature.ts" });
    assert.deepEqual(graph.nodes, ["src/core.ts", "src/feature.ts", "src/page.ts"]);
    assert.deepEqual(graph.edges, [
      { from: "src/feature.ts", to: "src/core.ts" },
      { from: "src/page.ts", to: "src/feature.ts" }
    ]);
    assert.equal(graph.root, "src/feature.ts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime exposes findSymbolCallers and findSymbolDependencies", async () => {
  const { root, files } = await setupWorkspace({
    "src/util.ts": "export function hello() { return 'hi'; }\n",
    "src/main.ts": [
      "import { hello } from \"./util\";",
      "export const greet = hello();",
      ""
    ].join("\n")
  });
  try {
    const tools = createToolRuntime({
      cwd: root,
      config: { permissions: { allowLocalChecks: true, allowLocalEdits: true } },
      requestApproval: async () => ({ approved: true })
    });
    const callers = await tools.findSymbolCallers("hello");
    assert.equal(callers.ok, true);
    assert.equal(callers.callers.length, 1);
    assert.equal(callers.callers[0].file, "src/main.ts");

    const deps = await tools.findSymbolDependencies("src/main.ts");
    assert.equal(deps.ok, true);
    assert.equal(deps.internal_count, 1);
    assert.equal(deps.dependencies[0].resolved, "src/util.ts");

    const graph = await tools.dependencyGraph("src/main.ts");
    assert.equal(graph.ok, true);
    assert.deepEqual(graph.edges, [{ from: "src/main.ts", to: "src/util.ts" }]);
  } finally {
    // Suppress reference to allow GC of any cached index.
    files.length = 0;
    await rm(root, { recursive: true, force: true });
  }
});
