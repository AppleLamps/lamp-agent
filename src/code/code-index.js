import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveImport } from "./import-resolver.js";

const JS_TS_EXTS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);
const PY_EXTS = new Set([".py"]);

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

  for (const relative of files) {
    const ext = path.extname(relative).toLowerCase();
    const language = JS_TS_EXTS.has(ext) ? "js" : PY_EXTS.has(ext) ? "py" : null;
    if (!language) continue;

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

  return { files: indexed, symbols, imports, exports: exports_, defsByName, skipped };
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
  const importsByFile = codeIndex?.imports || new Map();
  const callers = [];

  for (const [importingFile, imports] of importsByFile) {
    for (const importEntry of imports) {
      const resolved = resolveImport({
        from: importingFile,
        source: importEntry?.source || "",
        fileSet
      });
      if (!resolved) continue;

      // Determine whether this import statement actually brings the
      // target symbol into the importing file. Default imports match
      // when the source file has a default export and the symbol is
      // its default name; named imports match when the symbol's
      // exported name appears on the import statement; namespace
      // imports always pull in every export.
      const localName = importLocalName(importEntry, ident, resolved, codeIndex);
      if (!localName) continue;

      // Only files that import the symbol from one of its defining
      // files count as true callers. Without this, an exported name
      // shared by two modules (e.g. two `init` functions) would
      // bleed across them.
      if (definingFiles.size > 0 && !definingFiles.has(resolved)) continue;

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
 * For a given file, return its imports with each `source` resolved
 * to a workspace-relative path when possible. Bare specifiers (npm
 * packages) appear with `resolved: null`.
 */
export function findSymbolDependencies({ codeIndex, file }) {
  const norm = String(file || "").replaceAll("\\", "/");
  const imports = codeIndex?.imports?.get(norm) || [];
  const fileSet = new Set(codeIndex?.files || []);
  const dependencies = imports.map((entry) => ({
    source: entry.source,
    line: entry.line,
    kind: entry.kind,
    names: entry.names,
    resolved: resolveImport({ from: norm, source: entry.source || "", fileSet })
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

function importLocalName(importEntry, exportedName, resolvedFile, codeIndex) {
  const names = importEntry?.names || [];
  for (const entry of names) {
    if (entry.kind === "named") {
      // `original` is the exported name when the import uses an alias.
      const exportName = entry.original || entry.name;
      if (exportName === exportedName) return entry.name;
    } else if (entry.kind === "default") {
      // The local default-import name satisfies any default export.
      // Verify the resolved file actually exports a default.
      const exports = codeIndex?.exports?.get(resolvedFile) || [];
      const hasDefault = exports.some((e) => e.kind === "default" || e.name === "default");
      if (hasDefault && entry.name === exportedName) return entry.name;
    } else if (entry.kind === "namespace") {
      // `import * as ns from "./mod"` brings every export under `ns`.
      // The local name to search for in the file body is `ns.exportedName`,
      // but our regex is identifier-only — we report the namespace
      // identifier so the caller can see the file is a likely user.
      return entry.name;
    }
  }
  return null;
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
