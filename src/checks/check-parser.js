const FILE_LINE_RE = /([A-Za-z]:)?[^:\s()]+?\.(?:[cm]?[jt]sx?|tsx?|jsx?|py|go|rs|java|cs|rb|php):(\d+):(\d+)/g;
const STACK_FRAME_RE = /\bat\s+(?:.+?\s+\()?(.+?\.(?:[cm]?[jt]sx?|tsx?|jsx?|py|go|rs)):(\d+):(\d+)\)?/g;
const TS_ERROR_RE = /(.+?\.(?:ts|tsx|js|jsx))\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)/g;
const TS_PRETTY_RE = /^([^\s].*?\.(?:ts|tsx|cts|mts|js|jsx|cjs|mjs)):(\d+):(\d+)\s+-\s+(error|warning|info)\s+(TS\d+):\s+(.+)$/gm;
const ESLINT_RE = /(.+?\.(?:[cm]?[jt]sx?|tsx?|jsx?))\n\s*(\d+):(\d+)\s+(error|warning)\s+(.+)/g;
const FAIL_LINE_RE = /^\s*(?:FAIL|✗|×|not ok)\s+(.+)$/gim;
const TEST_NAME_RE = /^\s*(?:test|it)\(["'`](.+?)["'`]/gim;
const EXPECTED_RE = /Expected(?: value)?[:\s]+(.+)/i;
const RECEIVED_RE = /Received(?: value)?[:\s]+(.+)/i;

// esbuild emits a heading line (`✘ [ERROR] ...`) followed by an indented
// `path:line:col:` block. We capture the heading message and the location
// from the indented line.
const ESBUILD_RE = /^(?:✘|×|✗)\s+\[(ERROR|WARNING)\]\s+(.+?)\n+\s+([^\s:]+(?:\.[A-Za-z]+)?):(\d+):(\d+):/gm;
// Vite reports compile errors with a few flavors. Most reliable: a
// `[plugin:<name>]` heading followed by `path (line:col):` and the message.
const VITE_RE = /\[plugin:(?:vite:)?([\w-]+)\]\s*([^\n]+?)\s*\(\s*(\d+):(\d+)\s*\)\s*\n+\s*([^\n]+)/g;
// Webpack 5 prefixes errors with `ERROR in` and a target path. Two common
// shapes: `ERROR in path:line:col` followed by a code/message line, and
// `ERROR in path` followed by a `Module not found` line. We capture both.
const WEBPACK_LOC_RE = /^ERROR in\s+(?:\.\/)?(.+?):(\d+):(\d+)\n([^\n]+)/gm;
const WEBPACK_MODULE_RE = /^ERROR in\s+(?:\.\/)?([^\s]+)\n(Module not found:[^\n]+)/gm;
// Next.js compile output: a `./path:line:col` line followed by a
// `Type error:` (or similar) line. Anchored on a line by itself so we do
// not confuse it with stack frames.
const NEXTJS_RE = /^\.\/(\S+?):(\d+):(\d+)\n(Type error|Syntax error|Error|Module not found):\s*(.+)/gm;
// Cargo / rustc errors: `error[CODE]: message` followed by `--> file:line:col`.
const CARGO_RE = /^(error|warning)(?:\[([^\]]+)\])?:\s+(.+?)\n\s*-->\s+(.+?):(\d+):(\d+)/gm;
// Go compile/test errors: clean `path:line:col: message` form, often
// preceded by a `# package` heading. We pick lines starting with
// `./` or a relative path that looks like a Go file.
const GO_RE = /^(?:\.\/)?([^\s:]+\.go):(\d+):(\d+):\s+(.+)$/gm;

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
  collectTypeScriptPrettyErrors(output, parsed);
  collectEslintErrors(output, parsed);
  collectEsbuildErrors(output, parsed);
  collectViteErrors(output, parsed);
  collectWebpackErrors(output, parsed);
  collectNextjsErrors(output, parsed);
  collectCargoErrors(output, parsed);
  collectGoErrors(output, parsed);
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

function collectTypeScriptPrettyErrors(output, parsed) {
  for (const match of output.matchAll(TS_PRETTY_RE)) {
    const [, file, line, column, severity, code, message] = match;
    parsed.failed_files.push(normalizePath(file));
    parsed.errors.push({
      source: "typescript",
      file: normalizePath(file),
      line: Number(line),
      column: Number(column),
      severity: severity.toLowerCase(),
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

function collectEsbuildErrors(output, parsed) {
  for (const match of output.matchAll(ESBUILD_RE)) {
    const [, severityRaw, message, file, line, column] = match;
    const severity = severityRaw.toLowerCase() === "warning" ? "warning" : "error";
    parsed.failed_files.push(normalizePath(file));
    parsed.errors.push({
      source: "esbuild",
      file: normalizePath(file),
      line: Number(line),
      column: Number(column),
      severity,
      message: message.trim()
    });
  }
}

function collectViteErrors(output, parsed) {
  for (const match of output.matchAll(VITE_RE)) {
    const [, plugin, fileRaw, line, column, message] = match;
    // The file comes from the trailing capture before the parens.
    const file = fileRaw.trim().replace(/[\s>]+$/, "");
    parsed.failed_files.push(normalizePath(file));
    parsed.errors.push({
      source: "vite",
      file: normalizePath(file),
      line: Number(line),
      column: Number(column),
      plugin,
      severity: "error",
      message: message.trim()
    });
  }
}

function collectWebpackErrors(output, parsed) {
  for (const match of output.matchAll(WEBPACK_LOC_RE)) {
    const [, file, line, column, messageLine] = match;
    const codeMatch = messageLine.match(/^([A-Z]{1,3}\d{2,5}):\s*(.+)$/);
    parsed.failed_files.push(normalizePath(file));
    parsed.errors.push({
      source: "webpack",
      file: normalizePath(file),
      line: Number(line),
      column: Number(column),
      severity: "error",
      code: codeMatch ? codeMatch[1] : null,
      message: (codeMatch ? codeMatch[2] : messageLine).trim()
    });
  }
  for (const match of output.matchAll(WEBPACK_MODULE_RE)) {
    const [, file, message] = match;
    parsed.failed_files.push(normalizePath(file));
    parsed.errors.push({
      source: "webpack",
      file: normalizePath(file),
      line: null,
      column: null,
      severity: "error",
      message: message.trim()
    });
  }
}

function collectNextjsErrors(output, parsed) {
  for (const match of output.matchAll(NEXTJS_RE)) {
    const [, file, line, column, kind, message] = match;
    parsed.failed_files.push(normalizePath(file));
    parsed.errors.push({
      source: "nextjs",
      file: normalizePath(file),
      line: Number(line),
      column: Number(column),
      severity: "error",
      kind,
      message: message.trim()
    });
  }
}

function collectCargoErrors(output, parsed) {
  for (const match of output.matchAll(CARGO_RE)) {
    const [, severity, code, message, file, line, column] = match;
    parsed.failed_files.push(normalizePath(file));
    parsed.errors.push({
      source: "cargo",
      file: normalizePath(file),
      line: Number(line),
      column: Number(column),
      severity,
      code: code || null,
      message: message.trim()
    });
  }
}

function collectGoErrors(output, parsed) {
  for (const match of output.matchAll(GO_RE)) {
    const [, file, line, column, message] = match;
    if (!/\.go$/.test(file)) continue;
    parsed.failed_files.push(normalizePath(file));
    parsed.errors.push({
      source: "go",
      file: normalizePath(file),
      line: Number(line),
      column: Number(column),
      severity: "error",
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
