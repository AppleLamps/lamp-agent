import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveImport, loadTsconfigAliases } from "./import-resolver.js";

const JS_TS_EXTS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);
const PY_EXTS = new Set([".py"]);
// Tracked but not parsed — surfaced so resolveImport's resource
// fallback can resolve `require("./config")` to a workspace .json.
const RESOURCE_EXTS = new Set([".json"]);

const MAX_FILE_BYTES = 512 * 1024;

/**
 * Build a code intelligence index over a list of workspace files.
 *
 * Returns:
 * {
 *   files: string[],                          // indexed paths
 *   symbols: Array<{ name, kind, file, line, exported }>,
 *   imports: Map<file, Array<{ source, names, kind, line }>>,
 *   exports: Map<file, Array<{ name, kind, line }>>,
 *   defsByName: Map<name, Array<{ file, line, kind }>>,
 *   skipped: string[]
 * }
 */
export async function buildCodeIndex({ cwd, files }) {
  const symbols = [];
  const imports = new Map();
  const exports_ = new Map();
  const defsByName = new Map();
  const indexed = [];
  const skipped = [];
  const tsconfigAliases = loadTsconfigAliases(cwd);

  for (const relative of files) {
    const ext = path.extname(relative).toLowerCase();
    const language = JS_TS_EXTS.has(ext) ? "js" : PY_EXTS.has(ext) ? "py" : null;
    if (!language) {
      if (RESOURCE_EXTS.has(ext)) indexed.push(relative);
      continue;
    }

    let content;
    try {
      content = await readFile(path.resolve(cwd, relative), "utf8");
    } catch {
      skipped.push(relative);
      continue;
    }
    if (content.length > MAX_FILE_BYTES) {
      skipped.push(relative);
      continue;
    }

    indexed.push(relative);

    const fileSymbols = [];
    const fileImports = [];
    const fileExports = [];

    if (language === "js") {
      parseJsLike(content, fileSymbols, fileImports, fileExports);
    } else if (language === "py") {
      parsePython(content, fileSymbols, fileImports, fileExports);
    }

    for (const symbol of fileSymbols) {
      const entry = { ...symbol, file: relative };
      symbols.push(entry);
      const list = defsByName.get(symbol.name) || [];
      list.push({ file: relative, line: symbol.line, kind: symbol.kind });
      defsByName.set(symbol.name, list);
    }
    if (fileImports.length) imports.set(relative, fileImports);
    if (fileExports.length) exports_.set(relative, fileExports);
  }

  return { files: indexed, symbols, imports, exports: exports_, defsByName, skipped, tsconfigAliases };
}

/**
 * Find files that import a symbol from one of its defining files,
 * and the lines inside those importing files where the local name
 * is referenced. Unlike `findReferences` (which is a workspace-wide
 * regex scan over the identifier), this routes through the import
 * graph: a file is only a "caller" when it actually imports the
 * symbol from its definition. Honors aliased imports
 * (`import { login as loginUser }`) by scanning for the local name
 * in the importing file rather than the original.
 *
 * @param {object} args
 * @param {string} args.cwd
 * @param {object} args.codeIndex
 * @param {string} args.symbol
 * @returns {Promise<{ok: true, symbol, definitions, callers}|{ok:false, message}>}
 */
export async function findSymbolCallers({ cwd, codeIndex, symbol }) {
  const ident = String(symbol || "").trim();
  if (!ident || !/^[A-Za-z_$][\w$]*$/.test(ident)) {
    return { ok: false, message: "Symbol must be a single identifier (letters, digits, _ or $)." };
  }
  const definitions = codeIndex?.defsByName?.get(ident) || [];
  const definingFiles = new Set(definitions.map((entry) => entry.file));

  const fileSet = new Set(codeIndex?.files || []);
  const aliases = codeIndex?.tsconfigAliases || null;
  const importsByFile = codeIndex?.imports || new Map();
  const callers = [];

  for (const [importingFile, imports] of importsByFile) {
    for (const importEntry of imports) {
      const resolved = resolveImport({
        from: importingFile,
        source: importEntry?.source || "",
        fileSet,
        aliases
      });
      if (!resolved) continue;

      // Determine whether this import statement brings the target
      // symbol — possibly under a different local name — into the
      // importing file. `exposesSymbol` walks barrel modules and
      // aliased re-exports so a chain like
      // `import { authenticate } from "./auth"` →
      // `auth/index.ts: export { login as authenticate } from "./login"`
      // → defining file `login.ts` is recognised as a caller of
      // `login`.
      const localName = exposureLocalName({
        importEntry,
        targetSymbol: ident,
        resolvedFile: resolved,
        definingFiles,
        codeIndex,
        fileSet,
        aliases
      });
      if (!localName) continue;

      // Scan the importing file body for word-boundary matches of the
      // local name. Skip the import statement's own line.
      const lines = await readWorkspaceLines(cwd, importingFile);
      const re = new RegExp(`\\b${escapeRegex(localName)}\\b`);
      const references = [];
      for (let i = 0; i < lines.length; i += 1) {
        const lineNumber = i + 1;
        if (lineNumber === importEntry.line) continue;
        if (re.test(lines[i])) {
          references.push({ line: lineNumber, text: lines[i].trim() });
        }
      }
      callers.push({
        file: importingFile,
        import_line: importEntry.line,
        local_name: localName,
        resolved_from: resolved,
        references
      });
    }
  }

  return {
    ok: true,
    symbol: ident,
    definitions,
    callers
  };
}

/**
 * Synchronous, read-free version of `findSymbolCallers` that returns
 * just the file lists (no per-line reference snippets). Suitable for
 * blast-radius computation in pre-patch planning, where the goal is
 * to enumerate affected files before any byte is written.
 *
 * Returns `null` when the symbol is not defined anywhere in the
 * workspace, so callers can ignore prose mentions that don't refer
 * to a real workspace symbol.
 *
 * @param {object} args
 * @param {object} args.codeIndex
 * @param {string} args.symbol
 * @returns {{symbol, defining_files: string[], caller_files: string[]} | null}
 */
export function listSymbolImpact({ codeIndex, symbol }) {
  const ident = String(symbol || "").trim();
  if (!ident || !/^[A-Za-z_$][\w$]*$/.test(ident)) return null;
  const definitions = codeIndex?.defsByName?.get(ident) || [];
  const definingFiles = new Set(definitions.map((entry) => entry.file));
  if (definingFiles.size === 0) return null;

  const fileSet = new Set(codeIndex?.files || []);
  const aliases = codeIndex?.tsconfigAliases || null;
  const importsByFile = codeIndex?.imports || new Map();
  const callerFiles = new Set();

  for (const [importingFile, imports] of importsByFile) {
    for (const importEntry of imports) {
      const resolved = resolveImport({
        from: importingFile,
        source: importEntry?.source || "",
        fileSet,
        aliases
      });
      if (!resolved) continue;
      const localName = exposureLocalName({
        importEntry,
        targetSymbol: ident,
        resolvedFile: resolved,
        definingFiles,
        codeIndex,
        fileSet,
        aliases
      });
      if (!localName) continue;
      callerFiles.add(importingFile);
      break;
    }
  }

  return {
    symbol: ident,
    defining_files: [...definingFiles].sort(),
    caller_files: [...callerFiles].sort()
  };
}

/**
 * For a given file, return its imports with each `source` resolved
 * to a workspace-relative path when possible. Bare specifiers (npm
 * packages) appear with `resolved: null`.
 */
export function findSymbolDependencies({ codeIndex, file }) {
  const norm = String(file || "").replaceAll("\\", "/");
  const imports = codeIndex?.imports?.get(norm) || [];
  const fileSet = new Set(codeIndex?.files || []);
  const aliases = codeIndex?.tsconfigAliases || null;
  const dependencies = imports.map((entry) => ({
    source: entry.source,
    line: entry.line,
    kind: entry.kind,
    names: entry.names,
    resolved: resolveImport({ from: norm, source: entry.source || "", fileSet, aliases })
  }));
  const internalCount = dependencies.filter((entry) => entry.resolved).length;
  return {
    ok: true,
    file: norm,
    dependencies,
    internal_count: internalCount,
    external_count: dependencies.length - internalCount
  };
}

/**
 * Build an import graph over the indexed workspace. Edges are internal
 * imports resolved to workspace-relative files; bare package imports
 * are kept separately as external dependencies. When `file` is
 * provided, return the reachable dependency subgraph for that file
 * plus direct dependents that import it.
 */
export function dependencyGraph({ codeIndex, file = null } = {}) {
  const fileSet = new Set(codeIndex?.files || []);
  const aliases = codeIndex?.tsconfigAliases || null;
  const importsByFile = codeIndex?.imports || new Map();
  const graph = new Map();
  const external = new Map();

  for (const indexedFile of fileSet) {
    graph.set(indexedFile, new Set());
    external.set(indexedFile, new Set());
  }

  for (const [from, imports] of importsByFile) {
    if (!graph.has(from)) graph.set(from, new Set());
    if (!external.has(from)) external.set(from, new Set());
    for (const entry of imports || []) {
      const resolved = resolveImport({ from, source: entry?.source || "", fileSet, aliases });
      if (resolved) {
        graph.get(from).add(resolved);
      } else if (entry?.source) {
        external.get(from).add(entry.source);
      }
    }
  }

  const normalizedRoot = file ? String(file).replaceAll("\\", "/") : null;
  const included = normalizedRoot ? collectRelatedGraphFiles(graph, normalizedRoot) : new Set(graph.keys());
  const nodes = [...included].sort();
  const edges = [];
  const externalImports = {};

  for (const from of nodes) {
    for (const to of graph.get(from) || []) {
      if (!included.has(to)) continue;
      edges.push({ from, to });
    }
    const externals = [...(external.get(from) || [])].sort();
    if (externals.length) externalImports[from] = externals;
  }

  edges.sort((a, b) => `${a.from}\0${a.to}`.localeCompare(`${b.from}\0${b.to}`));
  return {
    ok: true,
    root: normalizedRoot,
    nodes,
    edges,
    external_imports: externalImports,
    internal_edge_count: edges.length,
    external_import_count: Object.values(externalImports).reduce((sum, list) => sum + list.length, 0),
    indexed: fileSet.size
  };
}

/**
 * Best-effort React component discovery. This stays regex-based to
 * match the rest of the current code index: it detects common
 * function, arrow, class, and default-export component declarations
 * in JS/TS React files, then links JSX tags inside each component
 * body to local or imported components when the target can be
 * resolved through the existing import graph.
 */
export async function detectComponents({ cwd, codeIndex }) {
  const fileSet = new Set(codeIndex?.files || []);
  const aliases = codeIndex?.tsconfigAliases || null;
  const importsByFile = codeIndex?.imports || new Map();
  const components = [];
  const tagsByComponent = new Map();

  for (const file of codeIndex?.files || []) {
    if (!isReactLikeFile(file)) continue;
    const lines = await readWorkspaceLines(cwd, file);
    if (!lines.length) continue;

    const fileComponents = findComponentsInLines(lines, file);
    const importMap = componentImportMap(importsByFile.get(file) || [], file, fileSet, aliases);
    const localNames = new Set(fileComponents.map((component) => component.name));

    for (let index = 0; index < fileComponents.length; index += 1) {
      const component = fileComponents[index];
      const next = fileComponents[index + 1];
      const endLine = next ? next.line - 1 : lines.length;
      const bodyLines = lines.slice(component.line - 1, endLine);
      const jsxTags = findJsxTags(bodyLines);
      tagsByComponent.set(component.id, jsxTags);
      components.push({
        ...component,
        end_line: endLine,
        jsx_tags: jsxTags,
        imported_components: [...new Set(jsxTags.filter((tag) => importMap.has(tag)))].sort(),
        local_components: [...new Set(jsxTags.filter((tag) => localNames.has(tag) && tag !== component.name))].sort()
      });
    }
  }

  const componentByFileAndName = new Map(components.map((component) => [`${component.file}\0${component.name}`, component]));
  const edges = [];
  for (const component of components) {
    const importMap = componentImportMap(importsByFile.get(component.file) || [], component.file, fileSet, aliases);
    for (const tag of tagsByComponent.get(component.id) || []) {
      let target = componentByFileAndName.get(`${component.file}\0${tag}`);
      let via = "local";
      if (!target && importMap.has(tag)) {
        const imported = importMap.get(tag);
        target = componentByFileAndName.get(`${imported.resolved}\0${tag}`);
        if (!target && imported.kind === "default") {
          target = components.find((candidate) => candidate.file === imported.resolved && candidate.default_export);
          target ||= components.find((candidate) => candidate.file === imported.resolved && candidate.exported);
          target ||= components.find((candidate) => candidate.file === imported.resolved);
        }
        via = "import";
      }
      if (!target || target.id === component.id) continue;
      edges.push({
        from: component.id,
        to: target.id,
        from_file: component.file,
        to_file: target.file,
        tag,
        via
      });
    }
  }

  edges.sort((a, b) => `${a.from}\0${a.to}\0${a.tag}`.localeCompare(`${b.from}\0${b.to}\0${b.tag}`));
  return {
    ok: true,
    components: components.sort((a, b) => a.id.localeCompare(b.id)),
    edges,
    component_count: components.length,
    edge_count: edges.length,
    indexed: fileSet.size
  };
}

function collectRelatedGraphFiles(graph, root) {
  const included = new Set();
  if (!graph.has(root)) return included;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    if (included.has(current)) continue;
    included.add(current);
    for (const dep of graph.get(current) || []) {
      if (!included.has(dep)) stack.push(dep);
    }
  }
  for (const [from, deps] of graph) {
    if (deps.has(root)) included.add(from);
  }
  return included;
}

function isReactLikeFile(file) {
  return /\.(jsx|tsx)$/.test(file) || /\.(js|ts)$/.test(file);
}

function findComponentsInLines(lines, file) {
  const components = [];
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = stripLineComments(lines[idx]);
    const lineNumber = idx + 1;
    let match;
    let name;
    let kind;
    let exported = false;
    let defaultExport = false;

    if ((match = line.match(/^\s*export\s+default\s+(?:async\s+)?function\s+([A-Z][\w$]*)\b/))) {
      name = match[1];
      kind = "function";
      exported = true;
      defaultExport = true;
    } else if ((match = line.match(/^\s*export\s+(?:async\s+)?function\s+([A-Z][\w$]*)\b/))) {
      name = match[1];
      kind = "function";
      exported = true;
    } else if ((match = line.match(/^\s*(?:async\s+)?function\s+([A-Z][\w$]*)\b/))) {
      name = match[1];
      kind = "function";
    } else if ((match = line.match(/^\s*export\s+(?:const|let|var)\s+([A-Z][\w$]*)\s*=\s*(?:React\.)?(?:memo|forwardRef)\s*\(/))) {
      name = match[1];
      kind = "wrapped";
      exported = true;
    } else if ((match = line.match(/^\s*export\s+(?:const|let|var)\s+([A-Z][\w$]*)\s*=\s*/))) {
      name = match[1];
      kind = "arrow";
      exported = true;
    } else if ((match = line.match(/^\s*(?:const|let|var)\s+([A-Z][\w$]*)\s*=\s*(?:React\.)?(?:memo|forwardRef)\s*\(/))) {
      name = match[1];
      kind = "wrapped";
    } else if ((match = line.match(/^\s*(?:const|let|var)\s+([A-Z][\w$]*)\s*=\s*/))) {
      name = match[1];
      kind = "arrow";
    } else if ((match = line.match(/^\s*export\s+default\s+class\s+([A-Z][\w$]*)\b/))) {
      name = match[1];
      kind = "class";
      exported = true;
      defaultExport = true;
    } else if ((match = line.match(/^\s*export\s+class\s+([A-Z][\w$]*)\b/))) {
      name = match[1];
      kind = "class";
      exported = true;
    } else if ((match = line.match(/^\s*class\s+([A-Z][\w$]*)\b/))) {
      name = match[1];
      kind = "class";
    }

    if (!name) continue;
    const bodyPreview = lines.slice(idx, Math.min(lines.length, idx + 12)).join("\n");
    const looksLikeComponent = kind === "class"
      ? /extends\s+(?:React\.)?(?:Pure)?Component\b/.test(line)
      : /<[A-Z][\w$.]*\b|<[a-z][\w-]*\b|React\.createElement\s*\(/.test(bodyPreview);
    if (!looksLikeComponent) continue;
    components.push({ id: `${file}#${name}`, name, file, line: lineNumber, kind, exported, default_export: defaultExport });
  }
  return components;
}

function componentImportMap(imports, from, fileSet, aliases = null) {
  const map = new Map();
  for (const entry of imports || []) {
    const resolved = resolveImport({ from, source: entry?.source || "", fileSet, aliases });
    if (!resolved) continue;
    for (const name of entry.names || []) {
      if (!name?.name || !/^[A-Z]/.test(name.name)) continue;
      map.set(name.name, { resolved, kind: name.kind });
    }
  }
  return map;
}

function findJsxTags(lines) {
  const tags = new Set();
  const tagRe = /<\/?\s*([A-Z][\w$]*)(?:\s|\/|>|\.)/g;
  for (const line of lines) {
    let match;
    while ((match = tagRe.exec(line))) {
      tags.add(match[1]);
    }
  }
  return [...tags].sort();
}

/**
 * For an import statement (`importEntry`) that resolves to
 * `resolvedFile`, return the local name in the importing file
 * under which `targetSymbol` (defined in one of `definingFiles`)
 * is brought in — or `null` if the statement does not actually
 * import that symbol. Walks barrel re-exports so
 * `export { foo } from "./real"` (direct), `export * from "./real"`
 * (star), and `export { foo as bar } from "./real"` (aliased) are
 * all transparent.
 */
function exposureLocalName({
  importEntry,
  targetSymbol,
  resolvedFile,
  definingFiles,
  codeIndex,
  fileSet,
  aliases
}) {
  const names = importEntry?.names || [];
  for (const entry of names) {
    if (entry.kind === "named") {
      // The name on the *exporting* file's side is `entry.original`
      // when the consumer aliased on import (`import { foo as bar }`),
      // else just `entry.name`.
      const importedName = entry.original || entry.name;
      if (exposesSymbol({
        name: importedName,
        resolvedFile,
        targetSymbol,
        definingFiles,
        codeIndex,
        fileSet,
        aliases
      })) {
        return entry.name;
      }
    } else if (entry.kind === "default") {
      // Local default-import name only counts when the resolved file
      // exposes a default and the user is asking about that default.
      const exports = codeIndex?.exports?.get(resolvedFile) || [];
      const hasDefault = exports.some((e) => e.kind === "default" || e.name === "default");
      if (hasDefault && entry.name === targetSymbol) return entry.name;
    } else if (entry.kind === "namespace") {
      // `import * as ns from "./mod"` brings every export under `ns`.
      // We treat the file as a caller when the namespace's resolved
      // file (or a re-export chain from it) exposes the target.
      if (exposesSymbol({
        name: targetSymbol,
        resolvedFile,
        targetSymbol,
        definingFiles,
        codeIndex,
        fileSet,
        aliases
      })) {
        return entry.name;
      }
    }
  }
  return null;
}

/**
 * Does `resolvedFile` expose a value under the local name `name`
 * that ultimately corresponds to `targetSymbol` defined in one of
 * `definingFiles`? Walks `export { foo } from "..."`, `export *`,
 * and `export { foo as bar } from "..."` chains. Bounded depth.
 */
function exposesSymbol({
  name,
  resolvedFile,
  targetSymbol,
  definingFiles,
  codeIndex,
  fileSet,
  aliases,
  depth = 8,
  visited = new Set()
}) {
  if (name === targetSymbol && definingFiles.has(resolvedFile)) return true;
  const visitKey = `${resolvedFile}|${name}`;
  if (depth <= 0 || visited.has(visitKey)) return false;
  visited.add(visitKey);
  const exports = codeIndex?.exports?.get(resolvedFile) || [];
  for (const exp of exports) {
    if (exp?.kind !== "re-export" || !exp?.source) continue;
    const nextResolved = resolveImport({
      from: resolvedFile,
      source: exp.source,
      fileSet,
      aliases
    });
    if (!nextResolved) continue;
    if (exp.name === "*") {
      // `export * from "./real"` — the exposed name flows through unchanged.
      if (exposesSymbol({
        name,
        resolvedFile: nextResolved,
        targetSymbol,
        definingFiles,
        codeIndex,
        fileSet,
        aliases,
        depth: depth - 1,
        visited
      })) return true;
    } else if (exp.name === name) {
      // The exposed name on `resolvedFile` is `exp.name`. Upstream,
      // the same value is exported under `exp.original || exp.name`.
      const upstreamName = exp.original || exp.name;
      if (exposesSymbol({
        name: upstreamName,
        resolvedFile: nextResolved,
        targetSymbol,
        definingFiles,
        codeIndex,
        fileSet,
        aliases,
        depth: depth - 1,
        visited
      })) return true;
    }
  }
  return false;
}

async function readWorkspaceLines(cwd, relative) {
  try {
    const content = await readFile(path.resolve(cwd, relative), "utf8");
    if (content.length > MAX_FILE_BYTES) return [];
    return content.split(/\r?\n/);
  } catch {
    return [];
  }
}

/**
 * Find references to a symbol by identifier word-boundary scan.
 * Skips the file/line of the definition itself when present.
 */
export async function findReferences({ cwd, files, symbol, definitionFile, definitionLine }) {
  const ident = symbol.trim();
  if (!ident || !/^[A-Za-z_$][\w$]*$/.test(ident)) {
    return { ok: false, message: "Symbol must be a single identifier (letters, digits, _ or $)." };
  }
  const re = new RegExp(`\\b${escapeRegex(ident)}\\b`);
  const matches = [];

  for (const relative of files) {
    const ext = path.extname(relative).toLowerCase();
    if (!JS_TS_EXTS.has(ext) && !PY_EXTS.has(ext)) continue;
    let content;
    try {
      content = await readFile(path.resolve(cwd, relative), "utf8");
    } catch {
      continue;
    }
    if (content.length > MAX_FILE_BYTES) continue;
    const lines = content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      if (re.test(line)) {
        const lineNumber = idx + 1;
        if (relative === definitionFile && lineNumber === definitionLine) return;
        matches.push({ file: relative, line: lineNumber, text: line.trim() });
      }
    });
  }

  return { ok: true, references: matches };
}

/**
 * Detect routes in the workspace.
 * Covers Express/Fastify/Koa/Hono-style `app.get('/...')` calls and
 * Next.js-style file routes under `pages/` or `app/`.
 */
export async function detectRoutes({ cwd, files }) {
  const routes = [];

  for (const relative of files) {
    const ext = path.extname(relative).toLowerCase();
    if (JS_TS_EXTS.has(ext)) {
      let content;
      try {
        content = await readFile(path.resolve(cwd, relative), "utf8");
      } catch {
        continue;
      }
      if (content.length > MAX_FILE_BYTES) continue;
      const lines = content.split(/\r?\n/);
      lines.forEach((line, idx) => {
        const match = line.match(/\b(?:app|router|fastify|server|api)\s*\.\s*(get|post|put|delete|patch|options|head|all|use)\s*\(\s*(['"`])([^'"`]+)\2/);
        if (match) {
          routes.push({
            method: match[1].toUpperCase(),
            path: match[3],
            framework: "express-like",
            file: relative,
            line: idx + 1
          });
        }
        const reactRoute = line.match(/<Route\b[^>]*\bpath\s*=\s*(['"`])([^'"`]+)\1/);
        if (reactRoute) {
          routes.push({
            method: "GET",
            path: reactRoute[2],
            framework: "react-router",
            file: relative,
            line: idx + 1
          });
        }
      });
    }

    const fileRoute = detectFileBasedRoute(relative);
    if (fileRoute) routes.push(fileRoute);
  }

  return routes;
}

function detectFileBasedRoute(relative) {
  const norm = relative.replaceAll("\\", "/");
  const pagesMatch = norm.match(/(?:^|\/)pages\/(.+)\.(?:tsx|ts|jsx|js)$/);
  if (pagesMatch && !pagesMatch[1].startsWith("api/")) {
    const route = "/" + pagesMatch[1]
      .replace(/\/index$/, "")
      .replace(/\[\.\.\.([^\]]+)\]/g, "*")
      .replace(/\[([^\]]+)\]/g, ":$1");
    return {
      method: "GET",
      path: route === "/" || route === "" ? "/" : route,
      framework: "next-pages",
      file: relative,
      line: 1
    };
  }
  const appPageMatch = norm.match(/(?:^|\/)app\/(.+)\/page\.(?:tsx|ts|jsx|js)$/);
  if (appPageMatch) {
    const route = "/" + appPageMatch[1]
      .replace(/\(.+?\)\/?/g, "")
      .replace(/\[\.\.\.([^\]]+)\]/g, "*")
      .replace(/\[([^\]]+)\]/g, ":$1")
      .replace(/\/$/, "");
    return {
      method: "GET",
      path: route === "" ? "/" : route,
      framework: "next-app",
      file: relative,
      line: 1
    };
  }
  return null;
}

function parseJsLike(content, symbols, imports, exports_) {
  const lines = content.split(/\r?\n/);

  lines.forEach((line, idx) => {
    const lineNumber = idx + 1;
    const trimmed = stripLineComments(line);

    // import statements
    let m;
    if ((m = trimmed.match(/^\s*import\s+(?:type\s+)?(?:(\w+)\s*,?\s*)?(?:\{([^}]+)\})?\s*(?:,?\s*\*\s+as\s+(\w+))?\s*from\s+['"]([^'"]+)['"]/))) {
      const names = [];
      if (m[1]) names.push({ name: m[1], kind: "default" });
      if (m[2]) {
        for (const part of m[2].split(",")) {
          const piece = part.trim();
          if (!piece) continue;
          const aliasMatch = piece.match(/^(\w+)(?:\s+as\s+(\w+))?$/);
          if (aliasMatch) names.push({ name: aliasMatch[2] || aliasMatch[1], original: aliasMatch[1], kind: "named" });
        }
      }
      if (m[3]) names.push({ name: m[3], kind: "namespace" });
      imports.push({ source: m[4], names, kind: "import", line: lineNumber });
      return;
    }
    if ((m = trimmed.match(/^\s*import\s+['"]([^'"]+)['"]/))) {
      imports.push({ source: m[1], names: [], kind: "side-effect", line: lineNumber });
      return;
    }
    if ((m = trimmed.match(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/))) {
      imports.push({ source: m[1], names: [], kind: "require", line: lineNumber });
    }
    if ((m = trimmed.match(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/))) {
      imports.push({ source: m[1], names: [], kind: "dynamic", line: lineNumber });
    }

    // export-from re-exports
    if ((m = trimmed.match(/^\s*export\s+\*\s+from\s+['"]([^'"]+)['"]/))) {
      exports_.push({ name: "*", kind: "re-export", source: m[1], line: lineNumber });
      return;
    }
    if ((m = trimmed.match(/^\s*export\s+\{([^}]+)\}\s*(?:from\s+['"]([^'"]+)['"])?/))) {
      for (const part of m[1].split(",")) {
        const piece = part.trim();
        if (!piece) continue;
        const aliasMatch = piece.match(/^(\w+)(?:\s+as\s+(\w+))?$/);
        if (aliasMatch) {
          exports_.push({
            name: aliasMatch[2] || aliasMatch[1],
            original: aliasMatch[1],
            kind: m[2] ? "re-export" : "named",
            source: m[2] || null,
            line: lineNumber
          });
        }
      }
      return;
    }

    // exported declarations
    if ((m = trimmed.match(/^\s*export\s+default\s+(?:async\s+)?function\s*(\*\s*)?(\w+)?/))) {
      const name = m[2] || "default";
      symbols.push({ name, kind: "function", line: lineNumber, exported: true });
      exports_.push({ name: "default", kind: "default", line: lineNumber });
      return;
    }
    if ((m = trimmed.match(/^\s*export\s+default\s+class\s+(\w+)?/))) {
      const name = m[1] || "default";
      symbols.push({ name, kind: "class", line: lineNumber, exported: true });
      exports_.push({ name: "default", kind: "default", line: lineNumber });
      return;
    }
    if (/^\s*export\s+default\s+/.test(trimmed)) {
      exports_.push({ name: "default", kind: "default", line: lineNumber });
      // fallthrough to look for inline anonymous symbols below
    }
    if ((m = trimmed.match(/^\s*export\s+(?:async\s+)?function\s*(\*\s*)?(\w+)/))) {
      symbols.push({ name: m[2], kind: "function", line: lineNumber, exported: true });
      exports_.push({ name: m[2], kind: "named", line: lineNumber });
      return;
    }
    if ((m = trimmed.match(/^\s*export\s+class\s+(\w+)/))) {
      symbols.push({ name: m[1], kind: "class", line: lineNumber, exported: true });
      exports_.push({ name: m[1], kind: "named", line: lineNumber });
      return;
    }
    if ((m = trimmed.match(/^\s*export\s+(?:abstract\s+)?interface\s+(\w+)/))) {
      symbols.push({ name: m[1], kind: "interface", line: lineNumber, exported: true });
      exports_.push({ name: m[1], kind: "named", line: lineNumber });
      return;
    }
    if ((m = trimmed.match(/^\s*export\s+type\s+(\w+)/))) {
      symbols.push({ name: m[1], kind: "type", line: lineNumber, exported: true });
      exports_.push({ name: m[1], kind: "named", line: lineNumber });
      return;
    }
    if ((m = trimmed.match(/^\s*export\s+enum\s+(\w+)/))) {
      symbols.push({ name: m[1], kind: "enum", line: lineNumber, exported: true });
      exports_.push({ name: m[1], kind: "named", line: lineNumber });
      return;
    }
    if ((m = trimmed.match(/^\s*export\s+(?:const|let|var)\s+(\w+)/))) {
      symbols.push({ name: m[1], kind: "variable", line: lineNumber, exported: true });
      exports_.push({ name: m[1], kind: "named", line: lineNumber });
      return;
    }

    // module.exports / exports.x
    if ((m = trimmed.match(/^\s*module\.exports\s*=\s*\{([^}]*)\}/))) {
      for (const part of m[1].split(",")) {
        const piece = part.trim();
        if (!piece) continue;
        const aliasMatch = piece.match(/^(\w+)\s*(?::\s*\w+)?$/);
        if (aliasMatch) exports_.push({ name: aliasMatch[1], kind: "commonjs", line: lineNumber });
      }
      return;
    }
    if ((m = trimmed.match(/^\s*(?:module\.)?exports\.(\w+)\s*=/))) {
      exports_.push({ name: m[1], kind: "commonjs", line: lineNumber });
      return;
    }

    // top-level (non-exported) declarations
    if ((m = trimmed.match(/^\s*(?:async\s+)?function\s*(\*\s*)?(\w+)/))) {
      symbols.push({ name: m[2], kind: "function", line: lineNumber, exported: false });
      return;
    }
    if ((m = trimmed.match(/^\s*class\s+(\w+)/))) {
      symbols.push({ name: m[1], kind: "class", line: lineNumber, exported: false });
      return;
    }
    if ((m = trimmed.match(/^\s*(?:abstract\s+)?interface\s+(\w+)/))) {
      symbols.push({ name: m[1], kind: "interface", line: lineNumber, exported: false });
      return;
    }
    if ((m = trimmed.match(/^\s*type\s+(\w+)\s*=/))) {
      symbols.push({ name: m[1], kind: "type", line: lineNumber, exported: false });
      return;
    }
    if ((m = trimmed.match(/^\s*enum\s+(\w+)/))) {
      symbols.push({ name: m[1], kind: "enum", line: lineNumber, exported: false });
      return;
    }
    if ((m = trimmed.match(/^\s*const\s+(\w+)\s*=\s*(?:\([^)]*\)|[A-Za-z_$])/))) {
      // arrow functions or top-level constants
      symbols.push({ name: m[1], kind: "variable", line: lineNumber, exported: false });
    }
  });
}

function parsePython(content, symbols, imports, exports_) {
  const lines = content.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const lineNumber = idx + 1;
    const trimmed = line.replace(/#.*$/, "");
    let m;
    if ((m = trimmed.match(/^\s*from\s+([\w.]+)\s+import\s+(.+)$/))) {
      const names = m[2].split(",").map((part) => {
        const piece = part.trim().replace(/\s+as\s+\w+/, "");
        return { name: piece, kind: "named" };
      }).filter((n) => n.name);
      imports.push({ source: m[1], names, kind: "from-import", line: lineNumber });
      return;
    }
    if ((m = trimmed.match(/^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?/))) {
      imports.push({ source: m[1], names: [{ name: m[2] || m[1].split(".").pop(), kind: "namespace" }], kind: "import", line: lineNumber });
      return;
    }
    if ((m = trimmed.match(/^def\s+(\w+)\s*\(/))) {
      symbols.push({ name: m[1], kind: "function", line: lineNumber, exported: !m[1].startsWith("_") });
      if (!m[1].startsWith("_")) exports_.push({ name: m[1], kind: "module-level", line: lineNumber });
      return;
    }
    if ((m = trimmed.match(/^class\s+(\w+)/))) {
      symbols.push({ name: m[1], kind: "class", line: lineNumber, exported: !m[1].startsWith("_") });
      if (!m[1].startsWith("_")) exports_.push({ name: m[1], kind: "module-level", line: lineNumber });
    }
  });
}

function stripLineComments(line) {
  // Best-effort: strip // line comments outside of strings. Block comments left intact.
  let inString = null;
  let result = "";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];
    if (inString) {
      result += ch;
      if (ch === "\\") {
        result += next || "";
        i += 1;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      inString = ch;
      result += ch;
      continue;
    }
    if (ch === "/" && next === "/") break;
    result += ch;
  }
  return result;
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
