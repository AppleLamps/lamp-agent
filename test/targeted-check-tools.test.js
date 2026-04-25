import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createToolRuntime } from "../src/tools/runtime.js";

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
