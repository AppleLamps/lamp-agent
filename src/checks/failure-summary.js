import { findSymbolDependencies } from "../code/code-index.js";

// Build a compact, model-friendly summary of a parsed failure for the
// repair loop. The full parsed record is rich but noisy — it carries
// pointers to raw stdout/stderr files, timestamps, and IDs that are
// useful for audits but waste prompt tokens. This summariser picks the
// fields the model actually uses to plan a fix.

const SNIPPET_LINES = 30;
const ERRORS_LIMIT = 20;
const FILES_LIMIT = 20;

/**
 * Reduce a parsed check record (from `parseCheckOutput` or
 * `parseStructuredOutput`) to a compact shape suitable for inclusion
 * in a repair-loop prompt.
 *
 * @param {object} parsed - The persisted check record or live parsed
 *   value. Either form (with or without raw_stdout_path /
 *   raw_stderr_path) is accepted.
 * @param {object} options
 * @param {object} options.codeIndex - Optional workspace code index.
 * @returns {object} A compact summary object. Field set is deliberate
 *   and stable so model prompts can rely on it.
 */
export function summarizeFailureForRepair(parsed, { codeIndex = null } = {}) {
  if (!parsed || typeof parsed !== "object") {
    return { status: "unknown", summary: "No parsed check available." };
  }
  const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
  const failedFiles = Array.isArray(parsed.failed_files) ? parsed.failed_files : [];
  const failedTests = Array.isArray(parsed.failed_tests) ? parsed.failed_tests : [];
  const stackTraces = Array.isArray(parsed.stack_traces) ? parsed.stack_traces : [];
  const provenance = (parsed.likely_relevant_files_provenance && typeof parsed.likely_relevant_files_provenance === "object")
    ? parsed.likely_relevant_files_provenance
    : {};
  const likelyRelevant = Array.isArray(parsed.likely_relevant_files) ? parsed.likely_relevant_files : [];
  const importGraph = buildImportGraph(failedFiles, codeIndex);

  const summary = {
    check_type: parsed.check_type || null,
    status: parsed.status || "unknown",
    exit_code: parsed.exit_code ?? null,
    parsed_source: parsed.parsed_source || null,
    summary: parsed.summary || null,
    failed_files: failedFiles.slice(0, FILES_LIMIT),
    failed_tests: failedTests.slice(0, FILES_LIMIT),
    errors: errors.slice(0, ERRORS_LIMIT).map(simplifyError),
    stack_traces: stackTraces.slice(0, FILES_LIMIT).map(simplifyFrame),
    expected: parsed.expected ?? null,
    actual: parsed.actual ?? null,
    likely_relevant_files: likelyRelevant.slice(0, FILES_LIMIT).map((file) => ({
      path: file,
      provenance: provenance[file] || []
    })),
    command: parsed.command || null
  };
  if (Object.keys(importGraph).length) {
    summary.import_graph = importGraph;
  }
  return summary;
}

/**
 * Like `summarizeFailureForRepair`, but keeps the original raw output
 * snippet inline. Used when the model needs to inspect the exact text
 * (for example, when no parser matched).
 */
export function summarizeFailureForRepairWithSnippet(parsed, { stdout = "", stderr = "" } = {}) {
  const base = summarizeFailureForRepair(parsed);
  return {
    ...base,
    output_snippet: snippet(stdout, stderr)
  };
}

function buildImportGraph(failedFiles, codeIndex) {
  if (!codeIndex || !Array.isArray(failedFiles)) return {};
  const indexedFiles = new Set(codeIndex.files || []);
  const graph = {};
  for (const file of failedFiles.slice(0, FILES_LIMIT)) {
    const normalized = String(file || "").replaceAll("\\", "/");
    if (!normalized || !indexedFiles.has(normalized)) continue;
    const deps = findSymbolDependencies({ codeIndex, file: normalized });
    const internal = (deps.dependencies || [])
      .map((entry) => entry.resolved)
      .filter(Boolean);
    const unique = [...new Set(internal)].slice(0, FILES_LIMIT);
    if (unique.length) graph[normalized] = unique;
  }
  return graph;
}

function simplifyError(error) {
  if (!error || typeof error !== "object") return error;
  // Pick the fields a repair model can use; drop full_message which is
  // an alternate copy of the same content for parsers that emit one.
  return {
    source: error.source || null,
    file: error.file || null,
    line: error.line ?? null,
    column: error.column ?? null,
    severity: error.severity || null,
    code: error.code || null,
    rule: error.rule || null,
    plugin: error.plugin || null,
    kind: error.kind || null,
    message: error.message || null
  };
}

function simplifyFrame(frame) {
  if (!frame || typeof frame !== "object") return frame;
  return {
    path: frame.path || null,
    line: frame.line ?? null,
    column: frame.column ?? null
  };
}

function snippet(stdout, stderr) {
  const text = (String(stderr || "").trim() || String(stdout || "").trim());
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  if (lines.length <= SNIPPET_LINES) return text;
  // Keep the last N lines (failures usually trail the run).
  return lines.slice(-SNIPPET_LINES).join("\n");
}
