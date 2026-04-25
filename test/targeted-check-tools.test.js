import { describe, it, before, after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createToolRuntime } from "../src/tools/runtime.js";
import { createTask } from "../src/task/task-manager.js";

function config() {
  return {
    permissions: {
      allowLocalChecks: true,
      allowLocalEdits: true
    }
  };
}

async function makeTmp() {
  return mkdtemp(path.join(tmpdir(), "targeted-check-"));
}

describe("detectTestRunner via runtime", () => {
  let tmp;
  let tools;

  before(async () => {
    tmp = await makeTmp();
    await writeFile(
      path.join(tmp, "package.json"),
      JSON.stringify({
        scripts: { test: "node --test" }
      })
    );
    tools = createToolRuntime({ cwd: tmp, config: config(), requestApproval: async () => ({ approved: true }) });
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("detectTestRunner returns runner info", async () => {
    const result = await tools.detectTestRunner();
    assert.equal(result.runner, "node");
    assert.ok(typeof result.runFileCmd, "function");
  });
});

describe("runTestFile skips when runner is unknown", () => {
  let tmp;
  let tools;

  before(async () => {
    tmp = await makeTmp();
    await writeFile(
      path.join(tmp, "package.json"),
      JSON.stringify({
        scripts: { test: "echo no-runner" }
      })
    );
    tools = createToolRuntime({ cwd: tmp, config: config(), requestApproval: async () => ({ approved: true }) });
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns skipped when no supported runner found", async () => {
    const result = await tools.runTestFile("test/foo.test.js");
    assert.equal(result.skipped, true);
    assert.match(result.message, /No supported test runner/);
  });
});

describe("runTestName skips when runner is unknown", () => {
  let tmp;
  let tools;

  before(async () => {
    tmp = await makeTmp();
    await writeFile(
      path.join(tmp, "package.json"),
      JSON.stringify({
        scripts: { test: "echo no-runner" }
      })
    );
    tools = createToolRuntime({ cwd: tmp, config: config(), requestApproval: async () => ({ approved: true }) });
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns skipped when no supported runner found", async () => {
    const result = await tools.runTestName("my test name");
    assert.equal(result.skipped, true);
    assert.match(result.message, /No supported test runner/);
  });
});

describe("runRelatedTests finds and reports test files", () => {
  let tmp;
  let tools;

  before(async () => {
    tmp = await makeTmp();
    await writeFile(
      path.join(tmp, "package.json"),
      JSON.stringify({
        scripts: { test: "node --test" }
      })
    );
    // Create source and test files
    await writeFile(path.join(tmp, "foo.js"), "export function foo() {}\n");
    await writeFile(
      path.join(tmp, "foo.test.js"),
      "import { describe, it } from 'node:test';\nimport assert from 'node:assert/strict';\ndescribe('foo', () => { it('passes', () => assert.ok(true)); });\n"
    );
    tools = createToolRuntime({ cwd: tmp, config: config(), requestApproval: async () => ({ approved: true }) });
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("finds related test for source file", async () => {
    const result = await tools.runRelatedTests("foo.js");
    assert.ok(Array.isArray(result.relatedFiles), "should have relatedFiles");
    assert.ok(result.relatedFiles.includes("foo.test.js"), "should include foo.test.js");
  });

  it("returns skipped when no related tests exist", async () => {
    const result = await tools.runRelatedTests("bar.js");
    assert.equal(result.skipped, true);
    assert.match(result.message, /No related test files found/);
  });
});

// Strip env vars that mark the current process as running inside Node's
// test runner so the inner `node --test` does not attach to the parent
// runner and report exit code 0 on real failures (same fix the e2e
// driver uses).
function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "NODE_TEST_CONTEXT" || key.startsWith("NODE_TEST_")) {
      delete env[key];
    }
  }
  return env;
}

describe("runTestFile picks the structured-reporter parser when one is exposed", () => {
  let tmp;
  let tools;
  let originalEnv;

  before(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "structured-runner-"));
    await writeFile(
      path.join(tmp, "package.json"),
      JSON.stringify({ type: "module", scripts: { test: "node --test specs/main.mjs" } })
    );
    await mkdir(path.join(tmp, "specs"));
    await writeFile(
      path.join(tmp, "specs", "main.mjs"),
      [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "",
        "test('off-by-one bug', () => {",
        "  assert.equal(2 + 3, 6);",
        "});",
        ""
      ].join("\n")
    );
    originalEnv = process.env;
    process.env = cleanEnv();
    tools = createToolRuntime({ cwd: tmp, config: config(), requestApproval: async () => ({ approved: true }) });
  });

  after(async () => {
    process.env = originalEnv;
    await rm(tmp, { recursive: true, force: true });
  });

  test("structured TAP parser runs and tags the result with parsed_source", async () => {
    const activeTask = await createTask(tmp, "Run failing spec");
    const result = await tools.runTestFile("specs/main.mjs", activeTask);

    assert.equal(result.parsed.parsed_source, "structured:tap",
      "parsed_source should reflect that the structured TAP parser ran");
    assert.equal(result.parsed.status, "failed");
    assert.deepEqual(result.parsed.failed_tests, ["off-by-one bug"]);
    // The structured-reporter command builder is what runCheckCommand
    // received; the parsed entry preserves it for audit.
    assert.match(result.parsed.command, /--test-reporter=tap/);

    // The artifact written under the task dir should also carry the tag.
    const checkResults = JSON.parse(
      await readFile(path.join(activeTask.dir, "check-results.json"), "utf8")
    );
    assert.equal(checkResults[0].parsed_source, "structured:tap");
    assert.equal(checkResults[0].status, "failed");
  });
});

describe("runCheckCommand enriches likely_relevant_files via the code index", () => {
  let tmp;
  let tools;
  let originalEnv;

  before(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "relevant-files-"));
    await writeFile(
      path.join(tmp, "package.json"),
      JSON.stringify({ type: "module", scripts: { test: "node --test specs/main.mjs" } })
    );
    await mkdir(path.join(tmp, "src"));
    await writeFile(path.join(tmp, "src", "calculator.js"),
      "export function brokenAdd(a, b) { return a + b - 1; }\n");
    await mkdir(path.join(tmp, "specs"));
    await writeFile(
      path.join(tmp, "specs", "main.mjs"),
      [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { brokenAdd } from '../src/calculator.js';",
        "",
        "test('off-by-one bug', () => {",
        "  assert.equal(brokenAdd(2, 3), 5);",
        "});",
        ""
      ].join("\n")
    );
    originalEnv = process.env;
    process.env = cleanEnv();
    tools = createToolRuntime({ cwd: tmp, config: config(), requestApproval: async () => ({ approved: true }) });
  });

  after(async () => {
    process.env = originalEnv;
    await rm(tmp, { recursive: true, force: true });
  });

  test("imports from a failing test file are surfaced under likely_relevant_files", async () => {
    const activeTask = await createTask(tmp, "Run failing spec to populate import graph");
    const result = await tools.runTestFile("specs/main.mjs", activeTask);

    assert.equal(result.parsed.status, "failed");
    // The mapping should pick up the imported source file via the
    // `../src/calculator.js` import.
    assert.ok(
      result.parsed.likely_relevant_files.includes("src/calculator.js"),
      `expected src/calculator.js in ${JSON.stringify(result.parsed.likely_relevant_files)}`
    );
    const provenance = result.parsed.likely_relevant_files_provenance || {};
    const tags = provenance["src/calculator.js"] || [];
    assert.ok(tags.includes("import-graph"),
      `expected import-graph tag, got ${JSON.stringify(tags)}`);
    // The failing test file itself should still appear with stack provenance.
    assert.ok(result.parsed.likely_relevant_files.includes("specs/main.mjs"));
  });
});

describe("runCheckCommand falls back to the regex parser when structured parsing fails", () => {
  let tmp;
  let tools;

  before(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "fallback-parser-"));
    tools = createToolRuntime({ cwd: tmp, config: config(), requestApproval: async () => ({ approved: true }) });
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("parsed_source becomes 'regex' when structured parser returns null", async () => {
    const activeTask = await createTask(tmp, "Run echo as a fake check");
    const result = await tools.runCheckCommand(
      "test",
      "node -e \"console.log('not tap output'); process.exit(1)\"",
      activeTask,
      { structuredFormat: "tap" }
    );
    assert.equal(result.parsed.parsed_source, "regex",
      "should fall back to the regex parser when structured parsing returns null");
    assert.equal(result.parsed.status, "failed");
  });
});
