// Resolve an import source string (the bit after `from "..."`) to a
// workspace-relative file path. Used by the code-index for cross-file
// binding (symbol callers, symbol dependencies) and by the
// failed-test → source mapper.
//
// Resolution strategies, in order:
//   1. Relative paths (`./foo`, `../auth/login`) against the workspace
//      file set, with common JS/TS extensions and `index.<ext>` fallback.
//   2. tsconfig / jsconfig path aliases (`compilerOptions.paths`,
//      anchored at `compilerOptions.baseUrl` or the tsconfig dir),
//      loaded once via `loadTsconfigAliases` and threaded into each
//      `resolveImport` call as the optional `aliases` argument.
//
// Bare specifiers without an alias match (`lodash`, `@scope/pkg`) and
// absolute paths return null — they're either npm dependencies or
// outside the workspace.

import fs from "node:fs";
import path from "node:path";

const JS_TS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const RESOURCE_EXTS = [".json"];

/**
 * @param {object} args
 * @param {string} args.from     - Workspace-relative path of the importing file.
 * @param {string} args.source   - The string passed to `from "..."` / `require("...")`.
 * @param {Set<string>|string[]} args.fileSet - Workspace files. A Set is preferred for O(1) lookup.
 * @param {object} [args.aliases] - Optional output of `loadTsconfigAliases(cwd)`.
 * @returns {string|null} Workspace-relative resolved path, or null when unresolvable.
 */
export function resolveImport({ from, source, fileSet, aliases = null }) {
  if (typeof source !== "string" || !source) return null;
  const set = fileSet instanceof Set ? fileSet : new Set(Array.from(fileSet || []));

  // Python file routing — Python source strings are dotted module
  // paths, not relative file paths, so they need their own logic.
  if (typeof from === "string" && from.toLowerCase().endsWith(".py")) {
    return resolvePythonImport({ from, source, set });
  }

  if (source.startsWith(".")) {
    return resolveAgainstFileSet({ from, source, set });
  }

  // Path-alias attempt: only for non-relative, non-absolute specifiers.
  if (!source.startsWith("/") && aliases) {
    for (const candidate of applyTsconfigAlias({ source, aliases })) {
      const resolved = resolveAgainstFileSet({ from: "", source: `./${candidate}`, set });
      if (resolved) return resolved;
    }
  }

  return null;
}

function resolvePythonImport({ from, source, set }) {
  if (!source) return null;
  const fromDir = path.posix.dirname(normalizePath(from));
  let dotCount = 0;
  while (dotCount < source.length && source[dotCount] === ".") dotCount += 1;

  let baseDir;
  let modulePath;
  if (dotCount > 0) {
    // Relative import: `.foo` is the same package, `..foo` parent, etc.
    let dir = fromDir;
    for (let i = 0; i < dotCount - 1; i += 1) {
      dir = path.posix.dirname(dir);
      if (dir === ".") dir = "";
    }
    baseDir = dir;
    modulePath = source.slice(dotCount).replace(/\./g, "/");
  } else {
    // Absolute import — anchor at the workspace root.
    baseDir = "";
    modulePath = source.replace(/\./g, "/");
  }

  const joined = modulePath
    ? (baseDir ? `${baseDir}/${modulePath}` : modulePath)
    : baseDir;
  return tryPythonCandidates(joined, set);
}

function tryPythonCandidates(joined, set) {
  if (!joined) return null;
  // Packages (directories with __init__.py) take precedence over
  // single-file modules with the same name.
  const initCandidate = `${joined}/__init__.py`;
  if (set.has(initCandidate)) return initCandidate;
  const moduleCandidate = `${joined}.py`;
  if (set.has(moduleCandidate)) return moduleCandidate;
  return null;
}

/**
 * Apply `compilerOptions.paths` substitutions to a bare specifier.
 * Returns the workspace-relative candidate paths to try (extension
 * resolution still runs on each).
 *
 * @param {object} args
 * @param {string} args.source
 * @param {object} args.aliases - Output of `loadTsconfigAliases`.
 * @returns {string[]}
 */
export function applyTsconfigAlias({ source, aliases }) {
  if (!aliases || !Array.isArray(aliases.patterns) || !source) return [];
  const out = [];
  for (const pattern of aliases.patterns) {
    if (pattern.suffix === null) {
      if (source === pattern.pattern) {
        for (const tpl of pattern.templates) out.push(tpl);
      }
      continue;
    }
    if (!source.startsWith(pattern.prefix)) continue;
    if (pattern.suffix && !source.endsWith(pattern.suffix)) continue;
    const captured = source.slice(pattern.prefix.length, source.length - pattern.suffix.length);
    if (!captured) continue;
    for (const tpl of pattern.templates) {
      out.push(tpl.replace("*", captured));
    }
  }
  return out;
}

/**
 * Read tsconfig.json (or jsconfig.json) at the workspace root and
 * extract a path-alias table suitable for `applyTsconfigAlias`.
 *
 * @param {string} cwd - Workspace root.
 * @returns {{source: string, baseDir: string, patterns: object[]}|null}
 */
export function loadTsconfigAliases(cwd) {
  for (const filename of ["tsconfig.json", "jsconfig.json"]) {
    let raw;
    try {
      raw = fs.readFileSync(path.resolve(cwd, filename), "utf8");
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(stripJsonComments(raw));
    } catch {
      continue;
    }
    const compilerOptions = parsed?.compilerOptions || {};
    const paths = compilerOptions.paths;
    if (!paths || typeof paths !== "object") continue;
    const baseDir = normalizeBaseDir(compilerOptions.baseUrl);
    const patterns = [];
    for (const [pattern, templates] of Object.entries(paths)) {
      if (!Array.isArray(templates) || !templates.length) continue;
      const wildcardIdx = pattern.indexOf("*");
      const isWildcard = wildcardIdx !== -1;
      const prefix = isWildcard ? pattern.slice(0, wildcardIdx) : pattern;
      const suffix = isWildcard ? pattern.slice(wildcardIdx + 1) : null;
      const resolvedTemplates = [];
      for (const tpl of templates) {
        if (typeof tpl !== "string" || !tpl) continue;
        const cleaned = tpl.replaceAll("\\", "/").replace(/^\.\//, "");
        const anchored = baseDir ? path.posix.join(baseDir, cleaned) : cleaned;
        resolvedTemplates.push(anchored);
      }
      if (resolvedTemplates.length) {
        patterns.push({ pattern, prefix, suffix, templates: resolvedTemplates });
      }
    }
    if (patterns.length) {
      return { source: filename, baseDir, patterns };
    }
  }
  return null;
}

/**
 * Normalise a workspace-relative path: backslashes → slashes, strip
 * a leading `./` if present.
 */
export function normalizePath(filePath) {
  return String(filePath || "").replaceAll("\\", "/").replace(/^\.\//, "");
}

export const RESOLVABLE_EXTENSIONS = JS_TS_EXTS;

function resolveAgainstFileSet({ from, source, set }) {
  const fromDir = from ? path.posix.dirname(normalizePath(from)) : "";
  const joined = fromDir
    ? path.posix.normalize(`${fromDir}/${source}`)
    : path.posix.normalize(source.replace(/^\.\//, ""));

  if (path.posix.extname(joined) && set.has(joined)) return joined;
  for (const ext of JS_TS_EXTS) {
    const candidate = `${joined}${ext}`;
    if (set.has(candidate)) return candidate;
  }
  for (const ext of JS_TS_EXTS) {
    const candidate = `${joined}/index${ext}`;
    if (set.has(candidate)) return candidate;
  }
  // Resource fallback (`.json`, etc.) — covers `require("./config")`
  // pointing at config.json. Tried after JS/TS so source-code matches
  // win when both forms exist.
  for (const ext of RESOURCE_EXTS) {
    const candidate = `${joined}${ext}`;
    if (set.has(candidate)) return candidate;
  }
  if (set.has(joined)) return joined;
  return null;
}

function normalizeBaseDir(baseUrl) {
  if (!baseUrl) return "";
  const cleaned = String(baseUrl).replaceAll("\\", "/").replace(/^\.\//, "");
  if (!cleaned || cleaned === ".") return "";
  return cleaned.replace(/\/+$/, "");
}

function stripJsonComments(text) {
  let out = "";
  let inString = null;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next || "";
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out.replace(/,(\s*[\]}])/g, "$1");
}
