import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildCodeIndex, detectComponents, detectRoutes, findReferences } from "../src/code/code-index.js";
import { createToolRuntime } from "../src/tools/runtime.js";

function config() {
  return { permissions: { allowLocalChecks: true, allowLocalEdits: true } };
}

async function makeDir() {
  return mkdtemp(path.join(tmpdir(), "lamp-agent-codeidx-"));
}

test("buildCodeIndex parses ESM imports, exports, and symbols", async () => {
  const cwd = await makeDir();
  try {
    await writeFile(path.join(cwd, "user.js"), [
      "import { db } from './db.js';",
      "import * as utils from './utils.js';",
      "import defaultThing from './x.js';",
      "",
      "export function updateUser(id) {",
      "  return db.user.update(id);",
      "}",
      "",
      "export class UserRepo {}",
      "",
      "export const ROLE = 'admin';",
      "",
      "export default function makeAgent() {}",
      ""
    ].join("\n"));

    const index = await buildCodeIndex({ cwd, files: ["user.js"] });
    const names = index.symbols.map((s) => `${s.name}:${s.kind}`);
    assert.ok(names.includes("updateUser:function"));
    assert.ok(names.includes("UserRepo:class"));
    assert.ok(names.includes("ROLE:variable"));
    assert.ok(names.includes("makeAgent:function"));

    const imports = index.imports.get("user.js");
    const sources = imports.map((i) => i.source);
    assert.ok(sources.includes("./db.js"));
    assert.ok(sources.includes("./utils.js"));
    assert.ok(sources.includes("./x.js"));

    const exports_ = index.exports.get("user.js").map((e) => `${e.name}:${e.kind}`);
    assert.ok(exports_.includes("updateUser:named"));
    assert.ok(exports_.includes("UserRepo:named"));
    assert.ok(exports_.includes("ROLE:named"));
    assert.ok(exports_.includes("default:default"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("buildCodeIndex parses TypeScript-only constructs", async () => {
  const cwd = await makeDir();
  try {
    await writeFile(path.join(cwd, "types.ts"), [
      "export interface User { id: string }",
      "export type Role = 'admin' | 'user';",
      "export enum Status { Active, Inactive }",
      ""
    ].join("\n"));
    const index = await buildCodeIndex({ cwd, files: ["types.ts"] });
    const kinds = Object.fromEntries(index.symbols.map((s) => [s.name, s.kind]));
    assert.equal(kinds.User, "interface");
    assert.equal(kinds.Role, "type");
    assert.equal(kinds.Status, "enum");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("buildCodeIndex parses CommonJS exports and require", async () => {
  const cwd = await makeDir();
  try {
    await writeFile(path.join(cwd, "cjs.js"), [
      "const fs = require('node:fs');",
      "function helper() {}",
      "module.exports.helper = helper;",
      ""
    ].join("\n"));
    const index = await buildCodeIndex({ cwd, files: ["cjs.js"] });
    const imports = index.imports.get("cjs.js");
    assert.ok(imports.some((i) => i.source === "node:fs" && i.kind === "require"));
    const exports_ = index.exports.get("cjs.js");
    assert.ok(exports_.some((e) => e.name === "helper"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("buildCodeIndex parses Python defs and imports", async () => {
  const cwd = await makeDir();
  try {
    await writeFile(path.join(cwd, "lib.py"), [
      "from collections import defaultdict",
      "import os",
      "",
      "def login(user):",
      "    return user",
      "",
      "class Session:",
      "    pass",
      ""
    ].join("\n"));
    const index = await buildCodeIndex({ cwd, files: ["lib.py"] });
    const names = index.symbols.map((s) => s.name).sort();
    assert.deepEqual(names, ["Session", "login"]);
    const imports = index.imports.get("lib.py");
    assert.ok(imports.some((i) => i.source === "collections"));
    assert.ok(imports.some((i) => i.source === "os"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("findReferences locates identifier usages and skips the definition", async () => {
  const cwd = await makeDir();
  try {
    await writeFile(path.join(cwd, "a.js"), "export function updateUser() {}\n");
    await writeFile(path.join(cwd, "b.js"), [
      "import { updateUser } from './a.js';",
      "updateUser();",
      "// updateUser appears here too",
      ""
    ].join("\n"));
    const index = await buildCodeIndex({ cwd, files: ["a.js", "b.js"] });
    const def = index.defsByName.get("updateUser")[0];
    const result = await findReferences({
      cwd,
      files: index.files,
      symbol: "updateUser",
      definitionFile: def.file,
      definitionLine: def.line
    });
    assert.equal(result.ok, true);
    const inB = result.references.filter((r) => r.file === "b.js");
    assert.equal(inB.length, 3);
    const inA = result.references.filter((r) => r.file === "a.js");
    assert.equal(inA.length, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("findReferences rejects non-identifier symbols", async () => {
  const result = await findReferences({ cwd: "/", files: [], symbol: "a.b" });
  assert.equal(result.ok, false);
});

test("detectRoutes finds Express, React Router, and Next.js routes", async () => {
  const cwd = await makeDir();
  try {
    await writeFile(path.join(cwd, "server.js"), [
      "app.get('/users', handler);",
      "router.post('/users/:id', handler);",
      ""
    ].join("\n"));
    await writeFile(path.join(cwd, "App.jsx"), [
      "<Route path=\"/dashboard\" element={<Dashboard/>} />",
      ""
    ].join("\n"));
    await mkdir(path.join(cwd, "pages"), { recursive: true });
    await writeFile(path.join(cwd, "pages/about.tsx"), "export default function About(){}\n");
    await mkdir(path.join(cwd, "app/blog/[slug]"), { recursive: true });
    await writeFile(path.join(cwd, "app/blog/[slug]/page.tsx"), "export default function Post(){}\n");

    const files = [
      "server.js",
      "App.jsx",
      "pages/about.tsx",
      "app/blog/[slug]/page.tsx"
    ];
    const routes = await detectRoutes({ cwd, files });
    const summary = routes.map((r) => `${r.framework} ${r.method} ${r.path}`).sort();
    assert.ok(summary.includes("express-like GET /users"));
    assert.ok(summary.includes("express-like POST /users/:id"));
    assert.ok(summary.includes("react-router GET /dashboard"));
    assert.ok(summary.includes("next-pages GET /about"));
    assert.ok(summary.includes("next-app GET /blog/:slug"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("detectComponents finds React components and render edges", async () => {
  const cwd = await makeDir();
  try {
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src/Button.tsx"), [
      "export default function Button() {",
      "  return <button />;",
      "}",
      ""
    ].join("\n"));
    await writeFile(path.join(cwd, "src/Card.tsx"), [
      "export const Card = () => (",
      "  <section><Button /></section>",
      ");",
      ""
    ].join("\n"));
    await writeFile(path.join(cwd, "src/App.tsx"), [
      "import PrimaryButton from './Button';",
      "import { Card } from './Card';",
      "",
      "export default function App() {",
      "  return <main><Card /><PrimaryButton /></main>;",
      "}",
      ""
    ].join("\n"));

    const index = await buildCodeIndex({
      cwd,
      files: ["src/Button.tsx", "src/Card.tsx", "src/App.tsx"]
    });
    const map = await detectComponents({ cwd, codeIndex: index });
    assert.equal(map.ok, true);
    assert.equal(map.component_count, 3);
    const ids = map.components.map((component) => component.id);
    assert.deepEqual(ids, ["src/App.tsx#App", "src/Button.tsx#Button", "src/Card.tsx#Card"]);
    assert.ok(map.edges.some((edge) => edge.from === "src/App.tsx#App" && edge.to === "src/Button.tsx#Button" && edge.tag === "PrimaryButton" && edge.via === "import"));
    assert.ok(map.edges.some((edge) => edge.from === "src/App.tsx#App" && edge.to === "src/Card.tsx#Card" && edge.via === "import"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runtime exposes findSymbols, findDefinition, findReferences", async () => {
  const cwd = await makeDir();
  try {
    await writeFile(path.join(cwd, "a.js"), "export function updateUser(){}\n");
    await writeFile(path.join(cwd, "b.js"), [
      "import { updateUser } from './a.js';",
      "updateUser();",
      ""
    ].join("\n"));
    const tools = createToolRuntime({ cwd, config: config(), requestApproval: async () => ({ approved: true }) });
    const symbols = await tools.findSymbols("update");
    assert.ok(symbols.matches.some((s) => s.name === "updateUser"));

    const def = await tools.findDefinition("updateUser");
    assert.equal(def.definitions[0].file, "a.js");

    const refs = await tools.findReferences("updateUser");
    assert.ok(refs.references.length >= 1);
    assert.ok(refs.references.every((r) => r.file === "b.js"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runtime component_map returns React component discovery", async () => {
  const cwd = await makeDir();
  try {
    await writeFile(path.join(cwd, "Widget.jsx"), [
      "export const Widget = () => <div />;",
      ""
    ].join("\n"));
    const tools = createToolRuntime({ cwd, config: config(), requestApproval: async () => ({ approved: true }) });
    const map = await tools.componentMap();
    assert.equal(map.ok, true);
    assert.ok(map.components.some((component) => component.id === "Widget.jsx#Widget"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runtime route_map returns detected routes", async () => {
  const cwd = await makeDir();
  try {
    await writeFile(path.join(cwd, "api.js"), "app.get('/health', handler);\n");
    const tools = createToolRuntime({ cwd, config: config(), requestApproval: async () => ({ approved: true }) });
    const map = await tools.routeMap();
    assert.equal(map.ok, true);
    assert.ok(map.routes.some((r) => r.path === "/health" && r.method === "GET"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("code index invalidates after an edit primitive", async () => {
  const cwd = await makeDir();
  const activeTask = { id: "t", dir: path.join(cwd, ".agent", "tasks", "t") };
  await mkdir(activeTask.dir, { recursive: true });
  try {
    await writeFile(path.join(cwd, "a.js"), "export function oldName(){}\n");
    const tools = createToolRuntime({ cwd, config: config(), requestApproval: async () => ({ approved: true }) });
    const before = await tools.findDefinition("oldName");
    assert.equal(before.definitions.length, 1);
    const replace = await tools.replaceExactTracked(activeTask, "a.js", "oldName", "newName");
    assert.equal(replace.ok, true);
    const afterOld = await tools.findDefinition("oldName");
    assert.equal(afterOld.definitions.length, 0);
    const afterNew = await tools.findDefinition("newName");
    assert.equal(afterNew.definitions.length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
