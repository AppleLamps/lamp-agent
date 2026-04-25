import test from "node:test";
import assert from "node:assert/strict";
import { buildPrePatchPlan } from "../src/task/pre-patch-plan.js";

test("buildPrePatchPlan picks candidate files via keyword overlap", () => {
  const plan = buildPrePatchPlan({
    userRequest: "Fix the failing login redirect",
    projectSummary: {
      notableFiles: [
        "src/auth/login.ts",
        "src/auth/login.test.ts",
        "src/billing/invoice.ts",
        "README.md"
      ],
      scripts: ["test", "lint"]
    },
    riskyBoundaries: []
  });
  assert.equal(plan.task_type, "fix");
  assert.ok(plan.expected_scope.candidate_files.includes("src/auth/login.ts"));
  // "login" should win because the request mentions it; invoice.ts should not
  // match any token, so it should not appear at the top.
  assert.equal(plan.expected_scope.candidate_files[0], "src/auth/login.ts");
  assert.deepEqual(plan.expected_scope.predicted_checks, ["test", "lint"]);
});

test("buildPrePatchPlan classifies danger zones from the workspace file list", () => {
  const plan = buildPrePatchPlan({
    userRequest: "Update something",
    projectSummary: {
      notableFiles: ["package.json", "package-lock.json", ".env", "src/app.ts"]
    },
    codeIndex: {
      files: ["package.json", "package-lock.json", ".env", "src/app.ts"]
    },
    riskyBoundaries: []
  });
  assert.deepEqual(plan.danger_zones.lockfiles, ["package-lock.json"]);
  assert.deepEqual(plan.danger_zones.dependency_manifests, ["package.json"]);
  assert.deepEqual(plan.danger_zones.secret_paths, [".env"]);
});

test("buildPrePatchPlan emits warnings for risky boundaries", () => {
  const plan = buildPrePatchPlan({
    userRequest: "Deploy the build to production",
    projectSummary: { notableFiles: [], scripts: [] },
    riskyBoundaries: ["external_publish", "network"]
  });
  const tiers = plan.warnings.map((entry) => entry.tier);
  assert.ok(tiers.includes("external_publish"));
  assert.ok(tiers.includes("network"));
  // external_publish should be marked as error severity.
  const publish = plan.warnings.find((entry) => entry.tier === "external_publish");
  assert.equal(publish.severity, "error");
});

test("buildPrePatchPlan flags lockfile + dependency manifest only when candidates cross those paths", () => {
  // Candidates here include both files because keyword overlap matches
  // "package" in package.json / package-lock.json against the request.
  const plan = buildPrePatchPlan({
    userRequest: "Add lodash as a package dependency",
    projectSummary: { notableFiles: ["package.json", "package-lock.json"] },
    codeIndex: { files: ["package.json", "package-lock.json"] },
    riskyBoundaries: ["dependency_change"]
  });
  const tiers = plan.warnings.map((entry) => entry.tier);
  assert.ok(tiers.includes("dependency_change"));
  assert.ok(tiers.includes("lockfile"));
  assert.ok(tiers.includes("dependency_manifest"));
  // The file-scope tiers should be marked blocking, the operation-only
  // tier (`dependency_change`) should not.
  const lockfile = plan.warnings.find((entry) => entry.tier === "lockfile");
  const manifest = plan.warnings.find((entry) => entry.tier === "dependency_manifest");
  const dependency = plan.warnings.find((entry) => entry.tier === "dependency_change");
  assert.equal(lockfile.blocking, true);
  assert.equal(manifest.blocking, true);
  assert.notEqual(dependency.blocking, true);
});

test("buildPrePatchPlan does NOT block when candidates do not cross danger paths", () => {
  // Workspace contains a lockfile but the user is touching auth — the
  // candidate file set does not include the lockfile, so no blocking
  // warning should fire.
  const plan = buildPrePatchPlan({
    userRequest: "Fix the failing login test",
    projectSummary: {
      notableFiles: ["src/auth/login.ts", "package.json", "package-lock.json"]
    },
    codeIndex: {
      files: ["src/auth/login.ts", "package.json", "package-lock.json"]
    },
    riskyBoundaries: []
  });
  const blocking = plan.warnings.filter((entry) => entry.blocking === true);
  assert.equal(blocking.length, 0,
    `expected no blocking warnings; got ${JSON.stringify(blocking)}`);
});

test("buildPrePatchPlan surfaces avoid_touching matches when candidates overlap", () => {
  const plan = buildPrePatchPlan({
    userRequest: "Fix the auth login",
    projectSummary: { notableFiles: ["src/auth/login.ts"] },
    codeIndex: { files: ["src/auth/login.ts", "src/billing/invoice.ts"] },
    projectMemory: { avoid_touching: ["src/auth/login.ts"] },
    riskyBoundaries: []
  });
  const avoid = plan.warnings.find((entry) => entry.tier === "avoid_touching");
  assert.ok(avoid);
  assert.equal(avoid.blocking, true);
  assert.match(avoid.message, /src\/auth\/login\.ts/);
});

test("buildPrePatchPlan adds a schema warning when the request mentions migrations", () => {
  const plan = buildPrePatchPlan({
    userRequest: "Add a new schema migration for the users table",
    projectSummary: { notableFiles: ["migrations/001.sql"] },
    riskyBoundaries: []
  });
  const tiers = plan.warnings.map((entry) => entry.tier);
  assert.ok(tiers.includes("schema"));
});

test("buildPrePatchPlan does NOT flag the schema warning for explain-style requests", () => {
  const plan = buildPrePatchPlan({
    userRequest: "Explain how the schema migrations work",
    projectSummary: { notableFiles: [] },
    riskyBoundaries: []
  });
  const tiers = plan.warnings.map((entry) => entry.tier);
  assert.ok(!tiers.includes("schema"));
});

test("buildPrePatchPlan flags a secret_file blocker when candidates cross a secret path", () => {
  // Use a request whose keyword tokens include the file we want to flag.
  const plan = buildPrePatchPlan({
    userRequest: "Move credential keys out of the .env config",
    projectSummary: { notableFiles: [".env"] },
    codeIndex: { files: [".env", "src/app.ts"] },
    riskyBoundaries: ["secret"]
  });
  const secretFile = plan.warnings.find((entry) => entry.tier === "secret_file");
  assert.ok(secretFile, "expected a secret_file warning when candidates cross a secret path");
  assert.equal(secretFile.blocking, true);
  assert.equal(secretFile.severity, "error");
  // The operation-tier `secret` warning should still be present, but
  // not blocking.
  const secretOp = plan.warnings.find((entry) => entry.tier === "secret");
  assert.ok(secretOp);
  assert.notEqual(secretOp.blocking, true);
});
