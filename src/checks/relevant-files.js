// Failed-test → source mapping.
//
// When a check produces failed test files, we use the code index to walk
// the imports of each failing test file and turn relative-path imports
// into concrete workspace files. Combined with the existing stack-frame
// extraction and a co-location heuristic, this produces a richer
// `likely_relevant_files` ranking with explicit provenance the repair
// loop and review surface can use.
//
// Provenance tags currently recorded:
//   - "stack"        → file appeared in a stack trace
//   - "import-graph" → file was reached via the failing test's imports
//   - "co-located"   → file matches the test file by name (.test./.spec. dropped)

import path from "node:path";
import { resolveImport } from "../code/import-resolver.js";

// A file qualifies as a "test file" if its name marks it as a test
// (`.test.`/`.spec.`/`_test.`) OR it lives inside a directory commonly
// used for tests (`test`/`tests`/`__tests__`/`spec`/`specs`). The
// directory check covers fixtures like `specs/main.mjs` or
// `__tests__/foo.js` that don't carry the conventional suffix.
const TEST_FILENAME_RE = /(?:\.|_)(?:test|spec)\.(?:c|m)?[jt]sx?$/i;
const TEST_DIR_RE = /(?:^|\/)(?:test|tests|__tests__|spec|specs)\//i;
const JS_TS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

function isTestFile(filePath) {
  const norm = String(filePath || "").replaceAll("\\", "/");
  return TEST_FILENAME_RE.test(norm) || TEST_DIR_RE.test(norm);
}

/**
 * Given a parsed check record (from `parseCheckOutput` or
 * `parseStructuredOutput`), the workspace's code index and file list,
 * return a re-ranked `{ likely_relevant_files, likely_relevant_files_provenance }`
 * pair. The original `parsed` object is not mutated.
 *
 * @param {object} parsed   - The parsed check record.
 * @param {object} options
 * @param {{ imports: Map<string, Array<{source: string}>> }} options.codeIndex
 * @param {string[]} options.allFiles - Workspace-relative file list.
 * @param {string} [options.cwd] - Workspace root, used to relativize
 *   absolute paths that some parsers (notably TAP) produce.
 * @returns {{ likely_relevant_files: string[], likely_relevant_files_provenance: Record<string, string[]> }}
 */
export function mapFailedTestsToSources(parsed, { codeIndex, allFiles = [], cwd = "" } = {}) {
  const cwdNormalized = normalize(cwd);
  const relativize = (file) => {
    const norm = normalize(file);
    if (!norm) return norm;
    if (cwdNormalized && norm.startsWith(`${cwdNormalized}/`)) {
      return norm.slice(cwdNormalized.length + 1);
    }
    return norm;
  };
  const provenance = new Map();
  const recordProvenance = (file, tag) => {
    const normalized = relativize(file);
    if (!normalized) return;
    const existing = provenance.get(normalized) || [];
    if (!existing.includes(tag)) existing.push(tag);
    provenance.set(normalized, existing);
  };

  // Stack frames give the lowest-priority hits — they often point at
  // framework internals or the assertion site, not the SUT.
  for (const frame of parsed.stack_traces || []) {
    if (frame?.path) recordProvenance(frame.path, "stack");
  }

  // Existing failed_files often include both test files and any
  // mentioned source files. Carry them through with whichever
  // provenance fits.
  for (const file of parsed.failed_files || []) {
    if (isTestFile(file)) {
      recordProvenance(file, "stack");
    } else {
      // Anything else carries through as a generic hit. We give it
      // "stack" provenance as the safest default.
      recordProvenance(file, "stack");
    }
  }

  const fileSet = new Set(allFiles.map(normalize).filter(Boolean));
  const importsByFile = codeIndex?.imports || new Map();
  const aliases = codeIndex?.tsconfigAliases || null;

  // For each failed test file, walk its imports.
  for (const candidate of (parsed.failed_files || []).concat(parsed.failed_tests || [])) {
    const file = relativize(candidate);
    if (!file || !isTestFile(file)) continue;

    // Co-location: drop `.test.`/`.spec.` to find a same-named source.
    for (const sibling of coLocatedCandidates(file, fileSet)) {
      recordProvenance(sibling, "co-located");
    }

    // Import-graph: use the code index's imports for this file.
    const imports = importsByFile.get(file) || [];
    for (const importEntry of imports) {
      const source = importEntry?.source || "";
      const resolved = resolveRelativeImport({ from: file, source, fileSet, aliases });
      if (resolved) recordProvenance(resolved, "import-graph");
    }
  }

  // Build the ranked list. Priority: import-graph > co-located > stack.
  // Tie-break on the order each provenance was first recorded.
  const ranked = [...provenance.entries()]
    .map(([file, tags]) => ({ file, tags, score: priorityScore(tags) }))
    .sort((a, b) => b.score - a.score);

  return {
    likely_relevant_files: ranked.map((entry) => entry.file).slice(0, 20),
    likely_relevant_files_provenance: Object.fromEntries(
      ranked.slice(0, 20).map((entry) => [entry.file, entry.tags])
    )
  };
}

function coLocatedCandidates(testFile, fileSet) {
  // Drop `.test.` / `.spec.` (or leading `_test`) from the filename and
  // try common extensions. Files in `specs/`/`test/` etc. without the
  // conventional suffix do not have a co-located equivalent so we skip
  // the heuristic for them.
  const dir = path.posix.dirname(testFile);
  const base = path.posix.basename(testFile);
  const stripped = base
    .replace(/\.(test|spec)(?=\.)/i, "")
    .replace(/_(test|spec)(?=\.)/i, "");
  const matches = [];
  if (stripped !== base) {
    const candidate = dir === "." ? stripped : `${dir}/${stripped}`;
    if (fileSet.has(candidate)) matches.push(candidate);
    // Try alternative extensions: foo.test.ts → foo.tsx, foo.js etc.
    const noExt = candidate.replace(/\.[^./]+$/, "");
    for (const ext of JS_TS_EXTS) {
      const alt = `${noExt}${ext}`;
      if (alt !== candidate && fileSet.has(alt)) matches.push(alt);
    }
  }
  return matches;
}

function resolveRelativeImport({ from, source, fileSet, aliases = null }) {
  return resolveImport({ from, source, fileSet, aliases });
}

function priorityScore(tags) {
  let score = 0;
  if (tags.includes("import-graph")) score += 100;
  if (tags.includes("co-located")) score += 50;
  if (tags.includes("stack")) score += 10;
  return score;
}

function normalize(filePath) {
  return String(filePath || "").replaceAll("\\", "/").replace(/^\.\//, "");
}
