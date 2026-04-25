import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectTestRunner, findRelatedTestFiles } from "../src/checks/test-runner-detector.js";

async function writePkg(dir, pkg) {
  await writeFile(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
}

describe("detectTestRunner", () => {
  it("detects Node built-in runner from test script", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "node-"));
    try {
      await writePkg(dir, { scripts: { test: "node --test" } });
      const result = await detectTestRunner(dir);
      assert.equal(result.runner, "node");
      assert.match(result.runFileCmd("test/foo.test.js"), /node --test/);
      assert.match(result.runNameCmd("my test"), /--test-name-pattern/);
      // Structured-reporter form is exposed for runners we have parsers
      // for. Node uses TAP via --test-reporter=tap.
      assert.equal(result.structuredReporter?.format, "tap");
      assert.match(
        result.structuredReporter.runFileCmd("test/foo.test.js"),
        /--test-reporter=tap/
      );
      assert.match(
        result.structuredReporter.runFileCmd("test/foo.test.js"),
        /foo\.test\.js/
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("exposes structured reporter forms for Jest and Vitest", async () => {
    const jestDir = await mkdtemp(path.join(tmpdir(), "jest-struct-"));
    try {
      await writePkg(jestDir, {
        scripts: { test: "jest" },
        devDependencies: { jest: "^29.0.0" }
      });
      const jest = await detectTestRunner(jestDir);
      assert.equal(jest.structuredReporter?.format, "jest-json");
      assert.match(jest.structuredReporter.runFileCmd("src/foo.test.js"), /--json/);
    } finally {
      await rm(jestDir, { recursive: true, force: true });
    }

    const vitestDir = await mkdtemp(path.join(tmpdir(), "vitest-struct-"));
    try {
      await writePkg(vitestDir, {
        scripts: { test: "vitest" },
        devDependencies: { vitest: "^1.0.0" }
      });
      const vitest = await detectTestRunner(vitestDir);
      assert.equal(vitest.structuredReporter?.format, "vitest-json");
      assert.match(
        vitest.structuredReporter.runFileCmd("src/foo.test.ts"),
        /--reporter=json/
      );
    } finally {
      await rm(vitestDir, { recursive: true, force: true });
    }
  });

  it("does not expose a structured reporter for runners without a parser yet", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mocha-struct-"));
    try {
      await writePkg(dir, {
        scripts: { test: "mocha" },
        devDependencies: { mocha: "^10.0.0" }
      });
      const result = await detectTestRunner(dir);
      assert.equal(result.runner, "mocha");
      assert.equal(result.structuredReporter, undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects Jest from devDependencies (npm)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "jest-"));
    try {
      await writePkg(dir, {
        scripts: { test: "jest" },
        devDependencies: { jest: "^29.0.0" }
      });
      const result = await detectTestRunner(dir);
      assert.equal(result.runner, "jest");
      assert.equal(result.packageManager, "npm");
      const fileCmd = result.runFileCmd("src/foo.test.js");
      assert.match(fileCmd, /npx jest/);
      assert.match(fileCmd, /foo\.test\.js/);
      const nameCmd = result.runNameCmd("should render");
      assert.match(nameCmd, /-t/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses pnpm exec when pnpm-lock.yaml is present", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "jest-pnpm-"));
    try {
      await writePkg(dir, {
        scripts: { test: "jest" },
        devDependencies: { jest: "^29.0.0" }
      });
      await writeFile(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '6.0'\n");
      const result = await detectTestRunner(dir);
      assert.equal(result.runner, "jest");
      assert.equal(result.packageManager, "pnpm");
      assert.match(result.runFileCmd("src/foo.test.js"), /pnpm exec jest/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses yarn when yarn.lock is present", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vitest-yarn-"));
    try {
      await writePkg(dir, {
        scripts: { test: "vitest run" },
        devDependencies: { vitest: "^1.0.0" }
      });
      await writeFile(path.join(dir, "yarn.lock"), "# yarn lockfile v1\n");
      const result = await detectTestRunner(dir);
      assert.equal(result.runner, "vitest");
      assert.equal(result.packageManager, "yarn");
      assert.match(result.runFileCmd("src/foo.test.ts"), /yarn vitest run/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects Vitest from devDependencies", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vitest-"));
    try {
      await writePkg(dir, {
        scripts: { test: "vitest run" },
        devDependencies: { vitest: "^1.0.0" }
      });
      const result = await detectTestRunner(dir);
      assert.equal(result.runner, "vitest");
      assert.match(result.runFileCmd("src/foo.test.ts"), /vitest run/);
      assert.match(result.runNameCmd("my test"), /-t/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects Mocha from devDependencies", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mocha-"));
    try {
      await writePkg(dir, {
        scripts: { test: "mocha test/**/*.js" },
        devDependencies: { mocha: "^10.0.0" }
      });
      const result = await detectTestRunner(dir);
      assert.equal(result.runner, "mocha");
      assert.match(result.runNameCmd("my test"), /--grep/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects Playwright from devDependencies", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pw-"));
    try {
      await writePkg(dir, {
        scripts: { test: "playwright test" },
        devDependencies: { "@playwright/test": "^1.40.0" }
      });
      const result = await detectTestRunner(dir);
      assert.equal(result.runner, "playwright");
      assert.match(result.runNameCmd("login flow"), /-g/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns unknown for a directory with no recognizable runner", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "unknown-"));
    try {
      await writePkg(dir, { scripts: { test: "echo ok" } });
      const result = await detectTestRunner(dir);
      assert.equal(result.runner, "unknown");
      assert.equal(result.runFileCmd("foo.test.js"), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects Go runner from go.mod", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "go-"));
    try {
      await writeFile(path.join(dir, "go.mod"), "module example.com/app\n\ngo 1.21\n");
      const result = await detectTestRunner(dir);
      assert.equal(result.runner, "go");
      assert.match(result.runNameCmd("TestLogin"), /go test/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("findRelatedTestFiles", () => {
  it("returns the file itself when it is a test file", () => {
    const related = findRelatedTestFiles("src/foo.test.js", ["src/foo.test.js", "src/foo.js"]);
    assert.deepEqual(related, ["src/foo.test.js"]);
  });

  it("finds co-located test file for a source file", () => {
    const files = ["src/foo.js", "src/foo.test.js", "src/bar.js"];
    const related = findRelatedTestFiles("src/foo.js", files);
    assert.ok(related.includes("src/foo.test.js"), "should include co-located test");
  });

  it("finds test file in test/ directory", () => {
    const files = ["src/auth.js", "test/auth.test.js", "test/other.test.js"];
    const related = findRelatedTestFiles("src/auth.js", files);
    assert.ok(related.includes("test/auth.test.js"), "should find test/auth.test.js");
  });

  it("finds spec files", () => {
    const files = ["src/utils.ts", "src/utils.spec.ts"];
    const related = findRelatedTestFiles("src/utils.ts", files);
    assert.ok(related.includes("src/utils.spec.ts"), "should find .spec file");
  });

  it("returns empty array when no related tests exist", () => {
    const files = ["src/foo.js", "src/bar.js", "README.md"];
    const related = findRelatedTestFiles("src/foo.js", files);
    assert.deepEqual(related, []);
  });

  it("handles backslash paths on Windows-style inputs", () => {
    const files = ["src\\foo.test.js", "src/bar.js"];
    const related = findRelatedTestFiles("src\\foo.js", files);
    // Windows backslash paths should be normalized and the test file found
    assert.equal(related.length, 1, "should find exactly one related test file");
    assert.equal(related[0], "src/foo.test.js");
  });
});
