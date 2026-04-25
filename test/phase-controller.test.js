import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTask } from "../src/task/task-manager.js";
import {
  buildTaskPlan,
  createPhaseController,
  identifyRiskyBoundaries,
  initializePhaseController,
  phaseStateExists
} from "../src/task/phase-controller.js";

test("initializePhaseController records completed intake phase", async () => {
  const cwd = await makeDir();
  try {
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    const activeTask = await createTask(cwd, "Explain this project");
    const controller = await initializePhaseController(activeTask);
    const phases = await controller.read();

    assert.equal(await phaseStateExists(activeTask), true);
    assert.equal(phases.intake.state, "completed");
    assert.equal(phases.intake.outputs.task_json, true);

    const events = await readFile(path.join(activeTask.dir, "events.jsonl"), "utf8");
    assert.match(events, /"phase":"intake"/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("phase controller enforces phase order and required outputs", async () => {
  const cwd = await makeDir();
  try {
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: {} }));
    const activeTask = await createTask(cwd, "Add login");
    const controller = createPhaseController(activeTask);

    await assert.rejects(
      () => controller.begin("plan"),
      /previous phase triage is not complete/
    );

    await initializePhaseController(activeTask);
    await controller.begin("triage");
    await assert.rejects(
      () => controller.complete("triage", {}),
      /missing required output/
    );

    await controller.complete("triage", {
      project_summary: { fileCount: 1, notableFiles: ["package.json"] }
    });
    await controller.begin("plan");
    // Plan completion now also requires a pre_patch_plan; missing it is
    // a hard error.
    await assert.rejects(
      () => controller.complete("plan", {
        current_plan: ["Inspect files"],
        risky_boundaries: []
      }),
      /missing required output\(s\): pre_patch_plan/
    );
    await controller.complete("plan", {
      current_plan: ["Inspect files"],
      risky_boundaries: [],
      pre_patch_plan: { expected_scope: { candidate_files: [], risk_labels: [], predicted_checks: [] } }
    });

    await assert.rejects(
      () => controller.begin("patch", {
        project_summary: { notableFiles: ["package.json"] },
        inspected_files: ["package.json"],
        current_plan: ["Inspect files"]
      }),
      /risky boundaries/
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("phase controller records the full happy-path lifecycle", async () => {
  const cwd = await makeDir();
  try {
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    const activeTask = await createTask(cwd, "Fix failing test");
    const controller = await initializePhaseController(activeTask);
    const projectSummary = { fileCount: 1, scripts: ["test"], notableFiles: ["package.json"] };
    const currentPlan = buildTaskPlan({ userRequest: activeTask.task.user_request, projectSummary });
    const riskyBoundaries = identifyRiskyBoundaries({ userRequest: activeTask.task.user_request, projectSummary });

    await controller.begin("triage");
    await controller.complete("triage", { project_summary: projectSummary });
    await controller.begin("plan");
    await controller.complete("plan", {
      current_plan: currentPlan,
      risky_boundaries: riskyBoundaries,
      pre_patch_plan: {
        expected_scope: { candidate_files: [], risk_labels: [], predicted_checks: [] }
      }
    });
    await controller.begin("patch", {
      task_type: activeTask.task.task_type,
      project_summary: projectSummary,
      inspected_files: projectSummary.notableFiles,
      current_plan: currentPlan,
      risky_boundaries: riskyBoundaries
    });
    await controller.complete("patch", { assistant_response: { message: "Done." } });
    await controller.begin("verify");
    await controller.complete("verify", { verification_result: { ok: true } });
    await controller.begin("critique");
    await controller.complete("critique", { critique: { status: "reviewed" } });
    await controller.begin("final_review", {
      diff_available: true,
      checks_recorded: true,
      critique_complete: true
    });
    await controller.complete("final_review", { final_review: "Done." });

    const phases = JSON.parse(await readFile(path.join(activeTask.dir, "phases.json"), "utf8"));
    assert.equal(phases.final_review.state, "completed");
    assert.deepEqual(phases.plan.outputs.current_plan, { type: "array", count: currentPlan.length });

    const task = JSON.parse(await readFile(path.join(activeTask.dir, "task.json"), "utf8"));
    assert.equal(task.status, "ready_to_review");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("buildTaskPlan and identifyRiskyBoundaries create patch gates", () => {
  const projectSummary = {
    scripts: ["test"],
    memory: { scripts: ["test"] }
  };
  const plan = buildTaskPlan({ userRequest: "Install a package and fix the login test", projectSummary });
  const risks = identifyRiskyBoundaries({ userRequest: "Install a package and update .env", projectSummary });

  assert.ok(plan.some((step) => /Run the narrowest/.test(step)));
  assert.ok(risks.includes("dependency_change"));
  assert.ok(risks.includes("secret"));
});

async function makeDir() {
  return mkdtemp(path.join(tmpdir(), "lamp-agent-phases-"));
}
