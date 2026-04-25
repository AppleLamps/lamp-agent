const FILE_LINE_RE = /([A-Za-z]:)?[^:\s()]+?\.(?:[cm]?[jt]sx?|tsx?|jsx?|py|go|rs|java|cs|rb|php):(\d+):(\d+)/g;
const STACK_FRAME_RE = /\bat\s+(?:.+?\s+\()?(.+?\.(?:[cm]?[jt]sx?|tsx?|jsx?|py|go|rs)):(\d+):(\d+)\)?/g;
const TS_ERROR_RE = /(.+?\.(?:ts|tsx|js|jsx))\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)/g;
const ESLINT_RE = /(.+?\.(?:[cm]?[jt]sx?|tsx?|jsx?))\n\s*(\d+):(\d+)\s+(error|warning)\s+(.+)/g;
const FAIL_LINE_RE = /^\s*(?:FAIL|✗|×|not ok)\s+(.+)$/gim;
const TEST_NAME_RE = /^\s*(?:test|it)\(["'`](.+?)["'`]/gim;
const EXPECTED_RE = /Expected(?: value)?[:\s]+(.+)/i;
const RECEIVED_RE = /Received(?: value)?[:\s]+(.+)/i;

export function parseCheckOutput({ checkType, command, code, stdout = "", stderr = "" }) {
  const output = [stdout, stderr].filter(Boolean).join("\n");
  const status = code === 0 ? "passed" : "failed";
  const parsed = {
    command,
    check_type: checkType,
    status,
    exit_code: code,
    failed_files: [],
    failed_tests: [],
    errors: [],
    stack_traces: [],
    expected: null,
    actual: null,
    likely_relevant_files: [],
    summary: status === "passed" ? `${checkType} passed.` : `${checkType} failed.`
  };

  if (!output) return parsed;

  collectTypeScriptErrors(output, parsed);
  collectEslintErrors(output, parsed);
  collectFailedTests(output, parsed);
  collectStackFrames(output, parsed);
  collectFileLines(output, parsed);
  collectExpectedActual(output, parsed);

  parsed.failed_files = unique(parsed.failed_files);
  parsed.failed_tests = unique(parsed.failed_tests);
  parsed.likely_relevant_files = unique([
    ...parsed.failed_files,
    ...parsed.stack_traces.map((frame) => frame.path)
  ]).slice(0, 20);
  if (parsed.errors.length) {
    parsed.summary = `${checkType} failed with ${parsed.errors.length} parsed error${parsed.errors.length === 1 ? "" : "s"}.`;
  } else if (parsed.failed_tests.length) {
    parsed.summary = `${checkType} failed in ${parsed.failed_tests.length} test${parsed.failed_tests.length === 1 ? "" : "s"}.`;
  }
  return parsed;
}

function collectTypeScriptErrors(output, parsed) {
  for (const match of output.matchAll(TS_ERROR_RE)) {
    const [, file, line, column, code, message] = match;
    parsed.failed_files.push(normalizePath(file));
    parsed.errors.push({
      source: "typescript",
      file: normalizePath(file),
      line: Number(line),
      column: Number(column),
      code,
      message: message.trim()
    });
  }
}

function collectEslintErrors(output, parsed) {
  for (const match of output.matchAll(ESLINT_RE)) {
    const [, file, line, column, severity, message] = match;
    parsed.failed_files.push(normalizePath(file));
    parsed.errors.push({
      source: "eslint",
      file: normalizePath(file),
      line: Number(line),
      column: Number(column),
      severity,
      message: message.trim()
    });
  }
}

function collectFailedTests(output, parsed) {
  for (const match of output.matchAll(FAIL_LINE_RE)) {
    const name = match[1].trim();
    if (name) parsed.failed_tests.push(name);
  }
  for (const match of output.matchAll(TEST_NAME_RE)) {
    const name = match[1].trim();
    if (name && /fail|error|should|expect/i.test(output)) parsed.failed_tests.push(name);
  }
}

function collectStackFrames(output, parsed) {
  for (const match of output.matchAll(STACK_FRAME_RE)) {
    const [, file, line, column] = match;
    parsed.stack_traces.push({
      path: normalizePath(file),
      line: Number(line),
      column: Number(column)
    });
  }
}

function collectFileLines(output, parsed) {
  for (const match of output.matchAll(FILE_LINE_RE)) {
    const raw = match[0];
    const pathPart = raw.replace(/:(\d+):(\d+)$/, "");
    parsed.failed_files.push(normalizePath(pathPart));
  }
}

function collectExpectedActual(output, parsed) {
  const expected = EXPECTED_RE.exec(output);
  const received = RECEIVED_RE.exec(output);
  if (expected) parsed.expected = expected[1].trim();
  if (received) parsed.actual = received[1].trim();
}

function normalizePath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^file:\/+/, "");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
