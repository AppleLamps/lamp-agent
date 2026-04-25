import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

const MEMORY_VERSION = 1;

const CONFIG_FILE_RE = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|README\.md|readme\.md|tsconfig\.json|jsconfig\.json|vite\.config\.[cm]?[jt]s|next\.config\.[cm]?[jt]s|pytest\.ini|pyproject\.toml|setup\.cfg|requirements\.txt|go\.mod|Cargo\.toml)$/;
const ROUTE_CANDIDATE_RE = /(^|\/)(app|pages|api|routes?|router|server)\/.*\.[cm]?[jt]sx?$|(^|\/)(server|api|app|routes?|router)\.[cm]?[jt]sx?$/;

export function defaultProjectMemory(now = new Date().toISOString()) {
  return {
    version: MEMORY_VERSION,
    framework: null,
    package_manager: null,
    test_runner: null,
    scripts: {},
    routes: [],
    important_files: [],
    conventions: [],
    decisions: [],
    avoid_touching: [],
    source_fingerprints: {},
    updated_at: now
  };
}

export async function loadProjectMemory(cwd) {
  const memoryPath = projectMemoryPath(cwd);
  await mkdir(path.dirname(memoryPath), { recursive: true });
  try {
    const existing = normalizeMemory(JSON.parse(await readFile(memoryPath, "utf8")));
    await saveProjectMemory(cwd, existing);
    return existing;
  } catch (error) {
    if (error.code && error.code !== "ENOENT") throw error;
    const created = defaultProjectMemory();
    await saveProjectMemory(cwd, created);
    return created;
  }
}

export async function saveProjectMemory(cwd, memory) {
  const memoryPath = projectMemoryPath(cwd);
  await mkdir(path.dirname(memoryPath), { recursive: true });
  await writeFile(memoryPath, `${JSON.stringify(normalizeMemory(memory), null, 2)}\n`);
}

export async function refreshProjectMemory({ cwd, tools, previousMemory = null }) {
  const existing = previousMemory ? normalizeMemory(previousMemory) : await loadProjectMemory(cwd);
  const allFilesResult = await tools.listFiles(".");
  const files = allFilesResult.ok ? allFilesResult.files : [];
  const nextFingerprints = await fingerprintSources(cwd, files, existing.routes);

  if (fingerprintsEqual(existing.source_fingerprints, nextFingerprints)) {
    return { memory: existing, refreshed: false, reason: "fresh" };
  }

  const packageManager = await tools.detectPackageManager();
  const scripts = await tools.packageScripts();
  const testRunner = await tools.detectTestRunner().catch(() => ({ runner: "unknown" }));
  const routesResult = await tools.routeMap().catch(() => ({ ok: false, routes: [] }));
  const packageJson = await readPackageJson(cwd);
  const routes = filterProjectRoutes(routesResult.ok ? routesResult.routes : [], packageJson);
  const now = new Date().toISOString();

  const refreshed = normalizeMemory({
    ...existing,
    version: MEMORY_VERSION,
    framework: inferFramework({ packageJson, routes, files }),
    package_manager: packageManager,
    test_runner: testRunner?.runner && testRunner.runner !== "unknown" ? testRunner.runner : null,
    scripts,
    routes: routes.map(normalizeRoute).slice(0, 200),
    important_files: findImportantFiles(files),
    conventions: inferConventions({ packageJson, scripts, testRunner, routes, files }),
    decisions: existing.decisions || [],
    avoid_touching: existing.avoid_touching || [],
    source_fingerprints: await fingerprintSources(cwd, files, routes),
    updated_at: now
  });

  await saveProjectMemory(cwd, refreshed);
  return { memory: refreshed, refreshed: true, reason: "stale" };
}

export function summarizeProjectMemory(memory) {
  const normalized = normalizeMemory(memory);
  return {
    framework: normalized.framework,
    package_manager: normalized.package_manager,
    test_runner: normalized.test_runner,
    scripts: Object.keys(normalized.scripts || {}),
    routes: normalized.routes || [],
    important_files: normalized.important_files || [],
    conventions: normalized.conventions || [],
    decisions: normalized.decisions || [],
    avoid_touching: normalized.avoid_touching || [],
    updated_at: normalized.updated_at
  };
}

function projectMemoryPath(cwd) {
  return path.join(cwd, ".agent", "memory", "project.json");
}

function normalizeMemory(memory) {
  const base = defaultProjectMemory(memory?.updated_at || new Date().toISOString());
  return {
    ...base,
    ...memory,
    version: MEMORY_VERSION,
    scripts: memory?.scripts && typeof memory.scripts === "object" ? memory.scripts : {},
    routes: Array.isArray(memory?.routes) ? memory.routes : [],
    important_files: Array.isArray(memory?.important_files) ? memory.important_files : [],
    conventions: Array.isArray(memory?.conventions) ? memory.conventions : [],
    decisions: Array.isArray(memory?.decisions) ? memory.decisions : [],
    avoid_touching: Array.isArray(memory?.avoid_touching) ? memory.avoid_touching : [],
    source_fingerprints: memory?.source_fingerprints && typeof memory.source_fingerprints === "object"
      ? memory.source_fingerprints
      : {}
  };
}

async function fingerprintSources(cwd, files, routes = []) {
  const routeFiles = new Set((routes || []).map((route) => route.file).filter(Boolean));
  const sourceFiles = files
    .filter((file) => CONFIG_FILE_RE.test(file) || routeFiles.has(file) || ROUTE_CANDIDATE_RE.test(file))
    .sort();
  const entries = {};
  for (const file of sourceFiles) {
    const absolute = path.join(cwd, file);
    try {
      const info = await stat(absolute);
      entries[file] = `${info.size}:${Math.round(info.mtimeMs)}`;
    } catch {
      entries[file] = "missing";
    }
  }
  entries.__source_list = sha1(sourceFiles.join("\n"));
  return entries;
}

function fingerprintsEqual(a = {}, b = {}) {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key, index) => key === bKeys[index] && a[key] === b[key]);
}

async function readPackageJson(cwd) {
  try {
    return JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function inferFramework({ packageJson, routes, files }) {
  const deps = allDependencies(packageJson);
  if (deps.next || files.some((file) => /^app\/.+\/page\.[cm]?[jt]sx?$/.test(file) || /^pages\/.+\.[cm]?[jt]sx?$/.test(file))) {
    return "next";
  }
  if (deps["@vitejs/plugin-react"] || deps.vite) return deps.react ? "vite-react" : "vite";
  if (routes.some((route) => route.framework === "react-router") || deps["react-router"] || deps["react-router-dom"]) {
    return "react-router";
  }
  if (deps.express || routes.some((route) => route.framework === "express-like")) return "express-like";
  if (deps.react) return "react";
  if (files.some((file) => file.endsWith(".py"))) return "python";
  if (files.includes("go.mod")) return "go";
  if (files.includes("Cargo.toml")) return "cargo";
  if (packageJson) return packageJson.type === "module" ? "node-esm" : "node";
  return null;
}

function filterProjectRoutes(routes, packageJson) {
  const deps = allDependencies(packageJson);
  const hasExpressLikeDependency = Boolean(deps.express || deps.fastify || deps.koa || deps.hono);
  return (routes || []).filter((route) => {
    const file = route.file || "";
    if (/^(test|tests|__tests__)\//.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) return false;
    if (route.path === "/..." || route.path === "...") return false;
    if (route.framework !== "express-like") return true;
    if (hasExpressLikeDependency) return true;
    return /(^|\/)(server|api|app|routes?|router)\.[cm]?[jt]sx?$/.test(file)
      || /(^|\/)(server|api|routes?|router)\//.test(file);
  });
}

function inferConventions({ packageJson, scripts, testRunner, routes, files }) {
  const conventions = [];
  if (packageJson?.type === "module") conventions.push("Uses ESM modules.");
  if (Object.keys(scripts || {}).length) conventions.push("Uses package.json scripts for project commands.");
  if (testRunner?.runner && testRunner.runner !== "unknown") conventions.push(`Uses ${testRunner.runner} for tests.`);
  if (files.some((file) => /^test\//.test(file))) conventions.push("Keeps tests under test/.");
  if (files.some((file) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file))) conventions.push("Uses .test/.spec naming for JavaScript or TypeScript tests.");
  if (routes.some((route) => route.framework === "next-app")) conventions.push("Uses Next.js app directory file routes.");
  if (routes.some((route) => route.framework === "next-pages")) conventions.push("Uses Next.js pages directory file routes.");
  if (routes.some((route) => route.framework === "express-like")) conventions.push("Defines HTTP routes with app/router method calls.");
  return [...new Set(conventions)];
}

function findImportantFiles(files) {
  const ranked = files.filter((file) => {
    const lower = file.toLowerCase();
    return lower === "package.json"
      || lower.endsWith("readme.md")
      || CONFIG_FILE_RE.test(file)
      || /^src\/index\.[cm]?[jt]s$/.test(file)
      || /^src\/main\.[cm]?[jt]sx?$/.test(file)
      || /^src\/app\.[cm]?[jt]sx?$/.test(file)
      || /^test\//.test(file);
  });
  return [...new Set(ranked)].slice(0, 50);
}

function normalizeRoute(route) {
  return {
    method: route.method,
    path: route.path,
    framework: route.framework,
    file: route.file,
    line: route.line
  };
}

function allDependencies(packageJson) {
  return {
    ...packageJson?.dependencies,
    ...packageJson?.devDependencies
  };
}

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}
