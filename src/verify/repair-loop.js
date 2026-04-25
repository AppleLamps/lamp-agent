import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendEvent } from "../log/event-log.js";

export async function verifyAndRepair({
  activeTask,
  tools,
  model,
  userRequest,
  projectSummary,
  maxAttempts = 3,
  allowedRepairTools = null,
  onProgress = () => {}
}) {
  await appendEvent(activeTask.dir, {
    type: "verify_started",
    message: "Running available checks before final review"
  });

  let checks = await tools.runAvailableChecks(activeTask);
  let failed = failedChecks(checks);
  // Record the runner info once for context in repair loops
  const testRunnerInfo = tools.detectTestRunner ? await tools.detectTestRunner().catch(() => null) : null;
  const attempts = [];

  if (!failed.length) {
    await writeVerificationSummary(activeTask, { status: "passed", attempts, checks: summarizeChecks(checks) });
    return { status: "passed", attempts, checks };
  }

  await appendEvent(activeTask.dir, {
    type: "check_failed",
    message: "One or more checks failed",
    failed: summarizeChecks(failed)
  });

  for (let attempt = 1; attempt <= maxAttempts && failed.length; attempt += 1) {
    onProgress(`Repair attempt ${attempt}/${maxAttempts}`);
    await appendEvent(activeTask.dir, {
      type: "repair_attempt_started",
      message: `Repair attempt ${attempt} started`,
      attempt,
      failed: summarizeChecks(failed)
    });

    const repair = model?.repair
      ? await model.repair({
        activeTask,
        tools,
        userRequest,
        projectSummary,
        failedChecks: failed.map((check) => check.parsed || check),
        testRunner: testRunnerInfo,
        attempt,
        maxAttempts,
        allowedTools: allowedRepairTools
      })
      : { ok: false, message: "Model repair is not available." };

    attempts.push({ attempt, repair });
    await appendEvent(activeTask.dir, {
      type: "repair_attempt_finished",
      message: repair.message || "Repair attempt finished",
      attempt,
      ok: repair.ok
    });

    if (!repair.ok || repair.noop) break;

    // Use targeted check when the runner supports it and we know the failed files.
    const failedTestFiles = extractFailedTestFiles(failed);
    const canTargetRunner =
      testRunnerInfo &&
      testRunnerInfo.runner !== "unknown" &&
      failedTestFiles.length > 0;

    if (canTargetRunner && tools.runTestFile) {
      onProgress(`Running targeted checks for ${failedTestFiles.length} failed file(s)`);
      const targetedResults = [];
      for (const file of failedTestFiles) {
        targetedResults.push(await tools.runTestFile(file, activeTask));
      }
      // Merge with non-test check results (lint, build, typecheck)
      const nonTestChecks = checks.filter((c) => c.name !== "test");
      checks = [...nonTestChecks, ...targetedResults.map((r) => ({ name: "test", ...r }))];
    } else {
      checks = await tools.runAvailableChecks(activeTask);
    }
    failed = failedChecks(checks);
    if (failed.length) {
      await appendEvent(activeTask.dir, {
        type: "check_failed",
        message: `Checks still failing after repair attempt ${attempt}`,
        attempt,
        failed: summarizeChecks(failed)
      });
    }
  }

  const status = failed.length ? "failed" : "passed";
  if (failed.length) {
    await appendEvent(activeTask.dir, {
      type: "repair_limit_reached",
      message: "Verification still has failing checks after bounded repair attempts",
      max_attempts: maxAttempts,
      failed: summarizeChecks(failed)
    });
  }

  const summary = { status, attempts, checks: summarizeChecks(checks), failed: summarizeChecks(failed) };
  await writeVerificationSummary(activeTask, summary);
  return { ...summary, rawChecks: checks };
}

function failedChecks(checks) {
  return checks.filter((check) => check.ok === false && !check.skipped);
}

function extractFailedTestFiles(failed) {
  const files = [];
  for (const check of failed) {
    const parsed = check.parsed;
    if (!parsed) continue;
    // Only use test-type failures to pick targeted files
    if (parsed.check_type !== "test") continue;
    for (const f of parsed.failed_files || []) {
      if (f) files.push(f);
    }
  }
  return [...new Set(files)];
}

function summarizeChecks(checks) {
  return checks.map((check) => ({
    name: check.name,
    ok: check.ok,
    skipped: check.skipped,
    message: check.message,
    summary: check.parsed?.summary,
    likely_relevant_files: check.parsed?.likely_relevant_files || []
  }));
}

async function writeVerificationSummary(activeTask, summary) {
  await writeFile(path.join(activeTask.dir, "verification.json"), `${JSON.stringify({
    ...summary,
    updated_at: new Date().toISOString()
  }, null, 2)}\n`);
}

export async function readExistingCheckResults(activeTask) {
  try {
    return JSON.parse(await readFile(path.join(activeTask.dir, "check-results.json"), "utf8"));
  } catch {
    return [];
  }
}
