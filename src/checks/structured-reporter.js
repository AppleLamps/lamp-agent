// Reporter-aware check parsers.
//
// These parsers read the structured output that test runners and linters
// emit when asked nicely (TAP, JSON, JUnit XML) and produce the same
// `{ command, check_type, status, exit_code, failed_files, failed_tests,
//    errors, stack_traces, expected, actual, likely_relevant_files,
//    summary }` shape that `parseCheckOutput` produces from raw stdout.
//
// Each parser returns `null` when the input does not look like the
// requested format so callers can fall back to the existing regex parser
// in `check-parser.js`. They never throw on bad input.

const FILE_LINE_RE = /([A-Za-z]:)?[^\s:()'"]+?\.(?:[cm]?[jt]sx?|tsx?|jsx?|py|go|rs|java|cs|rb|php):(\d+)(?::(\d+))?/g;

export function parseStructuredOutput(args) {
  const { format } = args;
  switch (format) {
    case "tap":
    case "tap-v13":
    case "tap-v14":
      return parseTap(args);
    case "vitest-json":
      return parseVitestJson(args);
    case "jest-json":
      return parseJestJson(args);
    case "pytest-junit":
      return parsePytestJUnit(args);
    case "eslint-json":
      return parseEslintJson(args);
    default:
      return null;
  }
}

/* ---------------- TAP (Node --test, tap reporter) ---------------- */

export function parseTap({ command, checkType = "test", code = 0, stdout = "", stderr = "" }) {
  const text = String(stdout || "");
  if (!/^TAP version\s+\d+/m.test(text) && !/^\s*(?:not\s+ok|ok)\s+\d+/m.test(text)) {
    return null;
  }

  const lines = text.split(/\r?\n/);
  const failures = [];
  let currentFailure = null;
  let yamlIndent = null;
  let blockKey = null;
  let blockBuffer = [];
  let blockBaseIndent = null;

  const flushBlock = () => {
    if (!currentFailure || !blockKey) return;
    currentFailure.fields[blockKey] = blockBuffer.join("\n");
    blockKey = null;
    blockBuffer = [];
    blockBaseIndent = null;
  };

  for (const rawLine of lines) {
    if (currentFailure && yamlIndent !== null) {
      // We are inside a YAML block belonging to currentFailure.
      const trimmed = rawLine.trim();
      if (trimmed === "...") {
        flushBlock();
        yamlIndent = null;
        currentFailure = null;
        continue;
      }
      if (blockKey) {
        // Multi-line literal scalar (`key: |-`). Stop on dedent or another
        // key at the YAML indent level.
        if (rawLine.startsWith(" ".repeat(yamlIndent)) && !/^\s*[A-Za-z_]\w*\s*:/.test(rawLine.slice(yamlIndent).trimStart() ? rawLine : "")) {
          if (blockBaseIndent === null) {
            blockBaseIndent = leadingSpaces(rawLine);
          }
          if (rawLine.length === 0) {
            blockBuffer.push("");
            continue;
          }
          if (leadingSpaces(rawLine) >= blockBaseIndent) {
            blockBuffer.push(rawLine.slice(blockBaseIndent));
            continue;
          }
        }
        flushBlock();
      }
      const keyMatch = rawLine.slice(yamlIndent).match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
      if (keyMatch) {
        const key = keyMatch[1];
        const value = keyMatch[2];
        if (value === "|" || value === "|-" || value === ">" || value === ">-") {
          blockKey = key;
          blockBuffer = [];
          blockBaseIndent = null;
          continue;
        }
        currentFailure.fields[key] = stripYamlQuotes(value);
      }
      continue;
    }

    const okMatch = rawLine.match(/^\s*(?:not ok)\s+(\d+)\s*-\s*(.+?)\s*$/);
    if (okMatch) {
      const failure = {
        number: Number(okMatch[1]),
        title: okMatch[2],
        fields: {}
      };
      failures.push(failure);
      // Look ahead for the YAML block start.
      currentFailure = failure;
      yamlIndent = null;
      continue;
    }

    if (currentFailure && /^\s*---\s*$/.test(rawLine)) {
      yamlIndent = leadingSpaces(rawLine);
      continue;
    }
  }

  // If we never encountered any `not ok` lines, treat the run as passing
  // when the exit code is zero, otherwise as failed without details.
  const hasFailures = failures.length > 0;
  const status = code === 0 && !hasFailures ? "passed" : "failed";

  const failed_tests = failures.map((failure) => failure.title);
  const errors = failures.map((failure) => ({
    source: "node-test",
    file: extractTapFile(failure.fields.location),
    line: extractTapLine(failure.fields.location),
    column: extractTapColumn(failure.fields.location),
    code: failure.fields.code || null,
    name: failure.fields.name || null,
    message: (failure.fields.error || failure.title || "").trim(),
    operator: failure.fields.operator || null,
    expected: failure.fields.expected ?? null,
    actual: failure.fields.actual ?? null
  }));

  const stack_traces = [];
  for (const failure of failures) {
    const stack = String(failure.fields.stack || "");
    for (const match of stack.matchAll(FILE_LINE_RE)) {
      stack_traces.push({
        path: normalizePath(match[0].replace(/:(\d+)(?::(\d+))?$/, "")),
        line: Number(match[2]),
        column: match[3] ? Number(match[3]) : 1
      });
    }
  }

  const failed_files = collectFailedFiles(failures, errors, stack_traces);
  const summary = hasFailures
    ? `${checkType} failed in ${failed_tests.length} test${failed_tests.length === 1 ? "" : "s"}.`
    : status === "passed"
      ? `${checkType} passed.`
      : `${checkType} failed.`;

  return {
    command,
    check_type: checkType,
    status,
    exit_code: code,
    failed_files,
    failed_tests,
    errors,
    stack_traces,
    expected: errors[0]?.expected ?? null,
    actual: errors[0]?.actual ?? null,
    likely_relevant_files: failed_files.slice(0, 20),
    summary
  };
}

/* ---------------- Vitest JSON ---------------- */

export function parseVitestJson({ command, checkType = "test", code = 0, stdout = "", stderr = "" }) {
  const data = safeParseJson(stdout) || safeParseJson(stderr);
  if (!data || !Array.isArray(data.testResults)) return null;

  const failed_tests = [];
  const errors = [];
  const stack_traces = [];
  const failed_files = [];

  for (const file of data.testResults) {
    const filePath = normalizePath(file.name || file.testFilePath || "");
    const fileFailed = (file.assertionResults || []).filter((r) => r.status === "failed");
    if (fileFailed.length && filePath) failed_files.push(filePath);
    for (const result of fileFailed) {
      failed_tests.push(result.fullName || result.title || "(unnamed test)");
      const messages = Array.isArray(result.failureMessages) ? result.failureMessages : [];
      for (const message of messages) {
        const cleanMessage = stripAnsi(String(message)).trim();
        const firstLine = cleanMessage.split(/\r?\n/)[0] || cleanMessage;
        errors.push({
          source: "vitest",
          file: filePath || null,
          line: null,
          column: null,
          name: result.fullName || result.title || null,
          message: firstLine,
          full_message: cleanMessage
        });
        for (const match of cleanMessage.matchAll(FILE_LINE_RE)) {
          stack_traces.push({
            path: normalizePath(match[0].replace(/:(\d+)(?::(\d+))?$/, "")),
            line: Number(match[2]),
            column: match[3] ? Number(match[3]) : 1
          });
        }
      }
    }
  }

  const hasFailures = failed_tests.length > 0;
  const numFailed = Number.isInteger(data.numFailedTests) ? data.numFailedTests : failed_tests.length;
  const status = (code === 0 && !hasFailures) ? "passed" : "failed";
  const summary = hasFailures
    ? `${checkType} failed in ${numFailed} test${numFailed === 1 ? "" : "s"}.`
    : `${checkType} passed.`;

  return {
    command,
    check_type: checkType,
    status,
    exit_code: code,
    failed_files: unique(failed_files),
    failed_tests,
    errors,
    stack_traces,
    expected: null,
    actual: null,
    likely_relevant_files: unique([...failed_files, ...stack_traces.map((f) => f.path)]).slice(0, 20),
    summary
  };
}

/* ---------------- Jest JSON (`jest --json`) ---------------- */

// Jest's JSON shape is similar enough to Vitest that we delegate when the
// top-level keys overlap. Both expose `testResults[i].assertionResults`.
export function parseJestJson(args) {
  const data = safeParseJson(args.stdout) || safeParseJson(args.stderr);
  if (!data || !Array.isArray(data.testResults)) return null;
  return parseVitestJson(args);
}

/* ---------------- pytest JUnit XML ---------------- */

export function parsePytestJUnit({ command, checkType = "test", code = 0, stdout = "", stderr = "" }) {
  // The XML can land on either stream depending on `--junit-xml=-` form vs
  // file capture. We accept either; tests pass it via stdout.
  const xml = String(stdout || "").trim() || String(stderr || "").trim();
  if (!xml.startsWith("<?xml") && !xml.startsWith("<testsuites") && !xml.startsWith("<testsuite")) {
    return null;
  }

  const cases = [];
  for (const match of xml.matchAll(/<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/g)) {
    cases.push({
      attrs: parseXmlAttrs(match[1]),
      body: match[2]
    });
  }
  // Self-closing testcases (passing) — no body.
  for (const match of xml.matchAll(/<testcase\b([^>]*)\/>/g)) {
    cases.push({ attrs: parseXmlAttrs(match[1]), body: "" });
  }

  if (!cases.length) return null;

  const failed_tests = [];
  const errors = [];
  const stack_traces = [];
  const failed_files = [];
  let firstExpected = null;
  let firstActual = null;

  for (const tc of cases) {
    const failureMatch = /<failure\b([^>]*)>([\s\S]*?)<\/failure>/.exec(tc.body);
    const errorMatch = /<error\b([^>]*)>([\s\S]*?)<\/error>/.exec(tc.body);
    const node = failureMatch || errorMatch;
    if (!node) continue;

    const attrs = parseXmlAttrs(node[1]);
    const body = decodeXmlEntities(node[2]).trim();
    const testName = tc.attrs.name || "(unnamed)";
    const className = tc.attrs.classname || "";
    const fullName = className ? `${className}::${testName}` : testName;
    failed_tests.push(fullName);

    const fileLine = extractFirstFileLine(body);
    if (fileLine?.path) failed_files.push(fileLine.path);

    const message = (attrs.message || body.split(/\r?\n/)[0] || "").trim();
    errors.push({
      source: failureMatch ? "pytest" : "pytest-error",
      file: fileLine?.path || null,
      line: fileLine?.line ?? null,
      column: fileLine?.column ?? null,
      message,
      full_message: body,
      class: className,
      name: testName
    });

    for (const m of body.matchAll(FILE_LINE_RE)) {
      stack_traces.push({
        path: normalizePath(m[0].replace(/:(\d+)(?::(\d+))?$/, "")),
        line: Number(m[2]),
        column: m[3] ? Number(m[3]) : 1
      });
    }

    if (firstExpected === null) {
      const eq = /assert\s+(.+?)\s*==\s*(.+?)(?:\r?\n|$)/.exec(body);
      if (eq) {
        firstActual = eq[1].trim();
        firstExpected = eq[2].trim();
      }
    }
  }

  const hasFailures = failed_tests.length > 0;
  const status = (code === 0 && !hasFailures) ? "passed" : (hasFailures ? "failed" : (code === 0 ? "passed" : "failed"));

  return {
    command,
    check_type: checkType,
    status,
    exit_code: code,
    failed_files: unique(failed_files),
    failed_tests,
    errors,
    stack_traces,
    expected: firstExpected,
    actual: firstActual,
    likely_relevant_files: unique([...failed_files, ...stack_traces.map((f) => f.path)]).slice(0, 20),
    summary: hasFailures
      ? `${checkType} failed in ${failed_tests.length} test${failed_tests.length === 1 ? "" : "s"}.`
      : `${checkType} passed.`
  };
}

/* ---------------- ESLint JSON ---------------- */

export function parseEslintJson({ command, checkType = "lint", code = 0, stdout = "", stderr = "" }) {
  const data = safeParseJson(stdout) || safeParseJson(stderr);
  if (!Array.isArray(data)) return null;

  const errors = [];
  const failed_files = [];

  for (const fileEntry of data) {
    if (!fileEntry || typeof fileEntry !== "object") continue;
    const filePath = normalizePath(String(fileEntry.filePath || ""));
    const messages = Array.isArray(fileEntry.messages) ? fileEntry.messages : [];
    let fileHasError = false;
    for (const message of messages) {
      const severity = message.severity === 2 ? "error" : message.severity === 1 ? "warning" : "info";
      if (severity === "error") fileHasError = true;
      errors.push({
        source: "eslint",
        file: filePath,
        line: Number.isInteger(message.line) ? message.line : null,
        column: Number.isInteger(message.column) ? message.column : null,
        rule: message.ruleId || null,
        severity,
        message: String(message.message || "")
      });
    }
    if (fileHasError) failed_files.push(filePath);
  }

  const errorCount = errors.filter((entry) => entry.severity === "error").length;
  const hasErrors = errorCount > 0;
  const status = code === 0 && !hasErrors ? "passed" : (hasErrors ? "failed" : "passed");

  return {
    command,
    check_type: checkType,
    status,
    exit_code: code,
    failed_files: unique(failed_files),
    failed_tests: [],
    errors,
    stack_traces: [],
    expected: null,
    actual: null,
    likely_relevant_files: unique(failed_files).slice(0, 20),
    summary: hasErrors
      ? `${checkType} failed with ${errorCount} error${errorCount === 1 ? "" : "s"}.`
      : `${checkType} passed.`
  };
}

/* ---------------- Helpers ---------------- */

function safeParseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(String(text).trim());
  } catch {
    return null;
  }
}

function leadingSpaces(line) {
  const match = /^( *)/.exec(line);
  return match ? match[1].length : 0;
}

function stripYamlQuotes(value) {
  const trimmed = String(value).trim();
  if (/^"(.*)"$/.test(trimmed)) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (/^'(.*)'$/.test(trimmed)) {
    // Strict YAML 1.2 single-quoted strings only escape `''` (literal
    // apostrophe). Node's TAP reporter additionally emits `\\` for each
    // single backslash in paths, so we decode that one extra escape
    // here to recover the real path. We deliberately do NOT decode
    // `\n` / `\t` style escapes — those are not used by Node inside
    // single-quoted scalars, and applying them would corrupt Windows
    // paths that contain `\t` (e.g. `...\test\fixtures\...`).
    return trimmed
      .slice(1, -1)
      .replace(/''/g, "'")
      .replace(/\\\\/g, "\\");
  }
  // Treat numeric scalars as numbers when they look like one.
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function extractTapFile(location) {
  if (!location) return null;
  const cleaned = String(location).replace(/^['"]|['"]$/g, "");
  const match = cleaned.match(/^(.*?):(\d+):(\d+)$/);
  if (!match) return null;
  return normalizePath(match[1]);
}

function extractTapLine(location) {
  if (!location) return null;
  const match = String(location).match(/:(\d+):\d+(?:['"])?$/);
  return match ? Number(match[1]) : null;
}

function extractTapColumn(location) {
  if (!location) return null;
  const match = String(location).match(/:(\d+)(?:['"])?$/);
  return match ? Number(match[1]) : null;
}

function collectFailedFiles(failures, errors, stack_traces) {
  const files = [];
  for (const failure of failures) {
    const file = extractTapFile(failure.fields.location);
    if (file) files.push(file);
  }
  for (const error of errors) {
    if (error.file) files.push(error.file);
  }
  for (const frame of stack_traces) {
    if (frame.path) files.push(frame.path);
  }
  return unique(files);
}

function parseXmlAttrs(attrString) {
  const attrs = {};
  for (const match of String(attrString || "").matchAll(/(\w[\w:.-]*)\s*=\s*"([^"]*)"/g)) {
    attrs[match[1]] = decodeXmlEntities(match[2]);
  }
  return attrs;
}

function decodeXmlEntities(text) {
  return String(text || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, "\n")
    .replace(/&#13;/g, "\r")
    .replace(/&#9;/g, "\t")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&amp;/g, "&");
}

function extractFirstFileLine(text) {
  const match = String(text).match(/([^\s:()]+\.(?:py|[cm]?[jt]sx?|tsx?|jsx?|go|rs|java|cs|rb|php)):(\d+)(?::(\d+))?/);
  if (!match) return null;
  return {
    path: normalizePath(match[1]),
    line: Number(match[2]),
    column: match[3] ? Number(match[3]) : null
  };
}

function normalizePath(filePath) {
  return String(filePath || "").replaceAll("\\", "/").replace(/^file:\/+/, "");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function stripAnsi(text) {
  return String(text || "").replace(/\x1b\[[0-9;]*m/g, "");
}
