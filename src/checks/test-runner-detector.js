import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

/**
 * Detect the test runner used in the given workspace directory.
 *
 * Returns a descriptor object:
 * {
 *   runner: "jest" | "vitest" | "node" | "mocha" | "playwright" | "cypress" |
 *           "pytest" | "cargo" | "go" | "unknown",
 *   packageManager: "npm" | "pnpm" | "yarn" | "bun" | null,
 *   version: string | null,
 *   runFileCmd: (file: string) => string | null,
 *   runNameCmd: (name: string) => string | null,
 *   runFileAndNameCmd: (file: string, name: string) => string | null,
 * }
 */
export async function detectTestRunner(cwd) {
  // ---- Node.js ecosystem (package.json based) ----
  const pkgPath = path.join(cwd, "package.json");
  if (await exists(pkgPath)) {
    let pkg;
    try {
      pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    } catch {
      pkg = {};
    }

    const allDeps = {
      ...pkg.devDependencies,
      ...pkg.dependencies
    };
    const testScript = pkg.scripts?.test || "";
    const pm = await detectPackageManager(cwd);

    // Playwright
    if (allDeps["@playwright/test"] || /playwright/i.test(testScript)) {
      const bin = execBin(pm, "playwright");
      return {
        runner: "playwright",
        packageManager: pm,
        version: allDeps["@playwright/test"] || null,
        runFileCmd: (file) => `${bin} test ${quote(file)}`,
        runNameCmd: (name) => `${bin} test -g ${quote(name)}`,
        runFileAndNameCmd: (file, name) => `${bin} test ${quote(file)} -g ${quote(name)}`
      };
    }

    // Cypress
    if (allDeps["cypress"] || /cypress/i.test(testScript)) {
      const bin = execBin(pm, "cypress");
      return {
        runner: "cypress",
        packageManager: pm,
        version: allDeps["cypress"] || null,
        runFileCmd: (file) => `${bin} run --spec ${quote(file)}`,
        runNameCmd: (name) => `${bin} run --env grepTags=${quote(name)}`,
        runFileAndNameCmd: (file, name) => `${bin} run --spec ${quote(file)} --env grepTags=${quote(name)}`
      };
    }

    // Vitest
    if (allDeps["vitest"] || /vitest/i.test(testScript)) {
      const bin = execBin(pm, "vitest");
      return {
        runner: "vitest",
        packageManager: pm,
        version: allDeps["vitest"] || null,
        runFileCmd: (file) => `${bin} run ${quote(file)}`,
        runNameCmd: (name) => `${bin} run -t ${quote(name)}`,
        runFileAndNameCmd: (file, name) => `${bin} run ${quote(file)} -t ${quote(name)}`,
        structuredReporter: {
          format: "vitest-json",
          runFileCmd: (file) => `${bin} run --reporter=json ${quote(file)}`,
          runNameCmd: (name) => `${bin} run --reporter=json -t ${quote(name)}`,
          runFileAndNameCmd: (file, name) =>
            `${bin} run --reporter=json ${quote(file)} -t ${quote(name)}`
        }
      };
    }

    // Jest
    if (allDeps["jest"] || allDeps["@jest/core"] || /jest/i.test(testScript)) {
      const bin = execBin(pm, "jest");
      return {
        runner: "jest",
        packageManager: pm,
        version: allDeps["jest"] || allDeps["@jest/core"] || null,
        runFileCmd: (file) => `${bin} ${quote(file)}`,
        runNameCmd: (name) => `${bin} -t ${quote(name)}`,
        runFileAndNameCmd: (file, name) => `${bin} ${quote(file)} -t ${quote(name)}`,
        structuredReporter: {
          format: "jest-json",
          runFileCmd: (file) => `${bin} --json ${quote(file)}`,
          runNameCmd: (name) => `${bin} --json -t ${quote(name)}`,
          runFileAndNameCmd: (file, name) => `${bin} --json ${quote(file)} -t ${quote(name)}`
        }
      };
    }

    // Mocha
    if (allDeps["mocha"] || /mocha/i.test(testScript)) {
      const bin = execBin(pm, "mocha");
      return {
        runner: "mocha",
        packageManager: pm,
        version: allDeps["mocha"] || null,
        runFileCmd: (file) => `${bin} ${quote(file)}`,
        runNameCmd: (name) => `${bin} --grep ${quote(name)}`,
        runFileAndNameCmd: (file, name) => `${bin} ${quote(file)} --grep ${quote(name)}`
      };
    }

    // Node built-in test runner (node --test)
    if (/node\s+--test/.test(testScript)) {
      return {
        runner: "node",
        packageManager: pm,
        version: null,
        runFileCmd: (file) => `node --test ${quote(file)}`,
        runNameCmd: (name) => `node --test --test-name-pattern=${quote(name)}`,
        runFileAndNameCmd: (file, name) =>
          `node --test --test-name-pattern=${quote(name)} ${quote(file)}`,
        structuredReporter: {
          format: "tap",
          runFileCmd: (file) => `node --test --test-reporter=tap ${quote(file)}`,
          runNameCmd: (name) =>
            `node --test --test-reporter=tap --test-name-pattern=${quote(name)}`,
          runFileAndNameCmd: (file, name) =>
            `node --test --test-reporter=tap --test-name-pattern=${quote(name)} ${quote(file)}`
        }
      };
    }
  }

  // ---- Python / pytest ----
  const hasPytestIni = await exists(path.join(cwd, "pytest.ini"));
  const hasSetupCfg = await exists(path.join(cwd, "setup.cfg"));
  const hasPyproject = await exists(path.join(cwd, "pyproject.toml"));
  const hasRequirements = await exists(path.join(cwd, "requirements.txt"));

  if (hasPytestIni || hasPyproject || hasSetupCfg || hasRequirements) {
    // Only claim pytest if there's evidence
    if (
      hasPytestIni ||
      (hasPyproject && (await fileContains(path.join(cwd, "pyproject.toml"), "pytest"))) ||
      (hasSetupCfg && (await fileContains(path.join(cwd, "setup.cfg"), "pytest")))
    ) {
      return {
        runner: "pytest",
        version: null,
        runFileCmd: (file) => `python -m pytest ${quote(file)}`,
        runNameCmd: (name) => `python -m pytest -k ${quote(name)}`,
        runFileAndNameCmd: (file, name) => `python -m pytest ${quote(file)} -k ${quote(name)}`
      };
    }
  }

  // ---- Rust / Cargo ----
  if (await exists(path.join(cwd, "Cargo.toml"))) {
    return {
      runner: "cargo",
      version: null,
      runFileCmd: (_file) => "cargo test",
      runNameCmd: (name) => `cargo test ${quote(name)}`,
      runFileAndNameCmd: (_file, name) => `cargo test ${quote(name)}`
    };
  }

  // ---- Go ----
  if (await exists(path.join(cwd, "go.mod"))) {
    return {
      runner: "go",
      version: null,
      runFileCmd: (file) => {
        // Convert file path to package path
        const pkgDir = path.dirname(file).replaceAll("\\", "/");
        return `go test ./${pkgDir}/...`;
      },
      runNameCmd: (name) => `go test ./... -run ${quote(name)}`,
      runFileAndNameCmd: (file, name) => {
        const pkgDir = path.dirname(file).replaceAll("\\", "/");
        return `go test ./${pkgDir}/... -run ${quote(name)}`;
      }
    };
  }

  return {
    runner: "unknown",
    version: null,
    runFileCmd: (_file) => null,
    runNameCmd: (_name) => null,
    runFileAndNameCmd: (_file, _name) => null
  };
}

/**
 * Given a list of changed source files, return candidate test files to run.
 * Rules:
 * - If the file itself looks like a test file, return it directly.
 * - Otherwise, look for co-located test files using common naming conventions.
 */
export function findRelatedTestFiles(changedFile, allFiles) {
  const normalized = changedFile.replaceAll("\\", "/");

  // If the changed file is already a test file, return it.
  if (isTestFile(normalized)) {
    return [normalized];
  }

  const related = [];
  const ext = path.extname(normalized);
  const base = path.basename(normalized, ext);
  const dir = path.dirname(normalized);

  // Common co-located test file patterns
  const patterns = [
    `${base}.test${ext}`,
    `${base}.spec${ext}`,
    `${base}.test.ts`,
    `${base}.spec.ts`,
    `${base}.test.js`,
    `${base}.spec.js`,
    `${base}_test${ext}`,
    `${base}_test.go`
  ];

  // Also look in test/tests/ directories at same level
  const testDirPatterns = [
    `test/${base}.test${ext}`,
    `test/${base}.spec${ext}`,
    `test/${base}.test.ts`,
    `test/${base}.spec.ts`,
    `test/${base}.test.js`,
    `test/${base}.spec.js`,
    `tests/${base}.test${ext}`,
    `tests/${base}.spec${ext}`,
    `__tests__/${base}.test${ext}`,
    `__tests__/${base}.spec${ext}`
  ];

  const dirPrefix = dir === "." ? "" : `${dir}/`;

  for (const file of allFiles) {
    const f = file.replaceAll("\\", "/");
    // Check co-located patterns
    for (const pattern of patterns) {
      if (f === `${dirPrefix}${pattern}` || f.endsWith(`/${pattern}`)) {
        related.push(f);
        break;
      }
    }
    // Check test directory patterns
    for (const pattern of testDirPatterns) {
      if (f === pattern || f.endsWith(`/${pattern}`)) {
        related.push(f);
        break;
      }
    }
  }

  return [...new Set(related)];
}

function isTestFile(filePath) {
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(filePath) ||
    /_test\.[cm]?[jt]sx?$/.test(filePath) ||
    /_test\.go$/.test(filePath) ||
    /\/test\/[^/]+\.[cm]?[jt]sx?$/.test(filePath) ||
    /\/tests\/[^/]+\.[cm]?[jt]sx?$/.test(filePath) ||
    /\/__tests__\//.test(filePath)
  );
}

/**
 * Return the right exec invocation for a locally-installed binary based on the
 * detected package manager.
 *
 *   npm  → npx <pkg>
 *   pnpm → pnpm exec <pkg>
 *   yarn → yarn <pkg>
 *   bun  → bunx <pkg>
 */
function execBin(pm, pkg) {
  switch (pm) {
    case "pnpm": return `pnpm exec ${pkg}`;
    case "yarn": return `yarn ${pkg}`;
    case "bun":  return `bunx ${pkg}`;
    default:     return `npx ${pkg}`;
  }
}

async function detectPackageManager(cwd) {
  if (await exists(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(path.join(cwd, "yarn.lock")))       return "yarn";
  if (await exists(path.join(cwd, "bun.lockb")))       return "bun";
  return "npm";
}

function quote(str) {
  if (!str) return '""';
  // If string has spaces or special chars, quote it
  if (/[ "']/.test(str)) return `"${str.replace(/"/g, '\\"')}"`;
  return str;
}

async function exists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function fileContains(filePath, needle) {
  try {
    const content = await readFile(filePath, "utf8");
    return content.includes(needle);
  } catch {
    return false;
  }
}
