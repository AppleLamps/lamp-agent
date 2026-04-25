// Request a structured plan from the model and persist it under
// `.agent/tasks/<id>/plan.json`. Falls back gracefully when the
// adapter does not support JSON output, or when validation fails —
// the harness's heuristic plan is always available so the task does
// not block on a model hiccup.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { appendEvent } from "../log/event-log.js";
import { describeSchema, PLAN_SCHEMA, validate } from "../model/structured-output.js";

const PLAN_PROMPT = [
  "You are an AI coding agent producing a short structured plan before any patching begins.",
  "Return ONLY a JSON object that matches the schema below — no commentary, no markdown fences.",
  "Keep `steps` to 3-6 items, each one short imperative phrase.",
  "`risky_boundaries` is a flat list of tags drawn from: dependency_change, network, secret, delete, external_publish, schema, lockfile, dependency_manifest.",
  "`expected_files` lists workspace-relative paths the plan is likely to touch.",
  "`expected_checks` lists the package scripts you expect to run (e.g. test, lint, typecheck, build).",
  "`summary` is a one-sentence explanation of the approach.",
  "",
  "Schema:",
  describeSchema(PLAN_SCHEMA)
].join("\n");

/**
 * @param {object} args
 * @param {object} args.adapter         - Model adapter (must expose respondJson).
 * @param {string} args.userRequest     - The plain-English request.
 * @param {object} args.projectSummary  - Triage summary.
 * @param {string[]} args.riskyBoundaries
 * @param {string[]} args.heuristicPlan - Fallback plan from buildTaskPlan.
 * @param {object} args.activeTask      - Task descriptor (for persistence).
 * @returns {Promise<{ok: boolean, plan?: object, source: string, errors?: any[], message?: string}>}
 */
export async function requestStructuredPlan({
  adapter,
  userRequest,
  projectSummary,
  riskyBoundaries = [],
  heuristicPlan = [],
  activeTask
} = {}) {
  if (typeof adapter?.respondJson !== "function") {
    return { ok: false, source: "unsupported", message: "Adapter does not implement respondJson." };
  }
  const result = await adapter.respondJson({
    system: PLAN_PROMPT,
    user: {
      user_request: userRequest,
      project_summary: projectSummary,
      heuristic_plan: heuristicPlan,
      risky_boundaries_hint: riskyBoundaries
    },
    activeTask,
    purpose: "structured_plan"
  });
  if (!result.ok) return { ok: false, source: "request_failed", message: result.message };

  const validation = validate(result.structured, PLAN_SCHEMA);
  if (!validation.ok) {
    if (activeTask?.dir) {
      await appendEvent(activeTask.dir, {
        type: "structured_plan_invalid",
        message: "Model plan failed schema validation; falling back to heuristic plan.",
        errors: validation.errors,
        raw_preview: typeof result.raw === "string" ? result.raw.slice(0, 400) : null
      });
    }
    return { ok: false, source: "schema_invalid", errors: validation.errors };
  }

  if (activeTask?.dir) {
    await writeFile(
      path.join(activeTask.dir, "plan.json"),
      `${JSON.stringify(result.structured, null, 2)}\n`
    );
    await appendEvent(activeTask.dir, {
      type: "structured_plan_recorded",
      message: "Persisted plan.json from model output",
      step_count: result.structured.steps?.length ?? 0,
      summary: result.structured.summary
    });
  }
  return { ok: true, source: "model", plan: result.structured };
}
