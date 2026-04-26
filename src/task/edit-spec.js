// Request a structured edit-spec from the model BEFORE the patch
// phase begins. The spec is a list of intended tool invocations —
// `{ tool, path?, args, intent }` records — that the agent claims it
// will make. The harness persists it under
// `.agent/tasks/<id>/edit-spec.json` and surfaces it to the user via
// the review path.
//
// The spec is informational at this stage: the model may or may not
// follow it exactly when it actually patches. The value is in the
// preview (the user can see what the model intends before any byte
// is written) and in audit (the spec captures the model's reasoning
// for later inspection).

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { appendEvent } from "../log/event-log.js";
import { describeSchema, EDIT_SPEC_SCHEMA, validate } from "../model/structured-output.js";

const EDIT_SPEC_PROMPT = [
  "You are about to enter the patch phase. Before any tool runs, return a structured edit-spec describing your intended edits.",
  "Return ONLY a JSON object matching the schema. No commentary, no markdown fences.",
  "Each edit's `tool` should be one of: apply_patch, write_file, create_file, delete_file, rename_file, replace_range, replace_exact, insert_before, insert_after, run_command.",
  "`intent` is a one-sentence explanation of why this edit is part of the plan.",
  "`args` is the argument bag you intend to pass; use a placeholder summary when full args are too large.",
  "`estimated_risk` is one of low / medium / high based on the blast radius and any risky boundaries hit.",
  "Keep the spec concise — only the edits you have high confidence in.",
  "",
  "Schema:",
  describeSchema(EDIT_SPEC_SCHEMA)
].join("\n");

/**
 * @param {object} args
 * @param {object} args.adapter
 * @param {string} args.userRequest
 * @param {object} args.projectSummary
 * @param {string[]} args.currentPlan
 * @param {object} args.prePatchPlan
 * @param {object} args.activeTask
 */
export async function requestStructuredEditSpec({
  adapter,
  userRequest,
  projectSummary,
  currentPlan = [],
  prePatchPlan = null,
  activeTask
} = {}) {
  if (typeof adapter?.respondJson !== "function") {
    return { ok: false, source: "unsupported", message: "Adapter does not implement respondJson." };
  }
  const result = await adapter.respondJson({
    system: EDIT_SPEC_PROMPT,
    user: {
      user_request: userRequest,
      project_summary: projectSummary,
      current_plan: currentPlan,
      pre_patch_plan: prePatchPlan ? {
        expected_scope: prePatchPlan.expected_scope,
        warnings: prePatchPlan.warnings
      } : null
    },
    schema: EDIT_SPEC_SCHEMA,
    schemaName: "lamp_edit_spec",
    activeTask,
    purpose: "structured_edit_spec"
  });
  if (!result.ok) return { ok: false, source: "request_failed", message: result.message };

  const validation = validate(result.structured, EDIT_SPEC_SCHEMA);
  if (!validation.ok) {
    if (activeTask?.dir) {
      await appendEvent(activeTask.dir, {
        type: "structured_edit_spec_invalid",
        message: "Model edit-spec failed schema validation; ignoring.",
        errors: validation.errors,
        raw_preview: typeof result.raw === "string" ? result.raw.slice(0, 400) : null
      });
    }
    return { ok: false, source: "schema_invalid", errors: validation.errors };
  }

  if (activeTask?.dir) {
    await writeFile(
      path.join(activeTask.dir, "edit-spec.json"),
      `${JSON.stringify(result.structured, null, 2)}\n`
    );
    await appendEvent(activeTask.dir, {
      type: "structured_edit_spec_recorded",
      message: "Persisted edit-spec.json from model output",
      edit_count: result.structured.edits?.length ?? 0,
      estimated_risk: result.structured.estimated_risk || null
    });
  }
  return { ok: true, source: "model", edit_spec: result.structured };
}
