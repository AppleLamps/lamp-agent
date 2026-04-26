// Resolve an import source string (the bit after `from "..."`) to a
// workspace-relative file path. Used by the code-index for cross-file
// binding (symbol callers, symbol dependencies) and by the
// failed-test → source mapper. The implementation is deliberately
// small: relative paths, common JS/TS extensions, and `index.<ext>`
// fallback. Bare specifiers (`lodash`, `@scope/pkg`) and absolute
// paths return null — they're either npm dependencies or outside the
// workspace.
//
// Path-alias resolution (tsconfig `paths`, jsconfig `paths`,
// webpack/vite aliases) is intentionally out of scope here; layering
// it on top is an isolated future change.

import path from "node:path";

const JS_TS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * @param {object} args
 * @param {string} args.from     - Workspace-relative path of the importing file.
 * @param {string} args.source   - The string passed to `from "..."` / `require("...")`.
 * @param {Set<string>|string[]} args.fileSet - Workspace files. A Set is preferred for O(1) lookup.
 * @returns {string|null} Workspace-relative resolved path, or null when unresolvable.
 */
export function resolveImport({ from, source, fileSet }) {
  if (typeof source !== "string" || !source) return null;
  if (!source.startsWith(".")) {
    // Bare specifiers (npm packages, scope-prefixed) are out of scope.
    return null;
  }

  const set = fileSet instanceof Set ? fileSet : new Set(Array.from(fileSet || []));
  const fromDir = path.posix.dirname(normalizePath(from));
  const joined = path.posix.normalize(`${fromDir}/${source}`);

  // 1) Path with an explicit extension that matches a workspace file as-is.
  if (path.posix.extname(joined) && set.has(joined)) {
    return joined;
  }
  // 2) Try common JS/TS extensions.
  for (const ext of JS_TS_EXTS) {
    const candidate = `${joined}${ext}`;
    if (set.has(candidate)) return candidate;
  }
  // 3) Try `<joined>/index.<ext>`.
  for (const ext of JS_TS_EXTS) {
    const candidate = `${joined}/index${ext}`;
    if (set.has(candidate)) return candidate;
  }
  // 4) Path already had an extension and matches as-is (covered above
  //    but kept for completeness when the lookup runs on edge cases).
  if (set.has(joined)) return joined;
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
