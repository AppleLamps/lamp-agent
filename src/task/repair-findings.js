// Request a structured diagnosis from the model after the bounded
// repair loop finishes. The findings give the user a one-paragraph
// reason for the failure, severity, blockers, and a proposed fix
// shape — distinct from the verbose conversation the model has
// during repair attempts. Persisted as
// `.agent/tasks/<id>/repair-findings.json` and surfaced on the
// review card. Falls back silently when the adapter has no JSON
// support, when the loop finished green (nothing to diagnose), or
// when the response fails schema validation.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { appendEvent } from "../log/event-log.js";
import {
  describeSchema,
  REPAIR_FINDINGS_SCHEMA,
  validate
} from "../model/structured-output.js";

const REPAIR_FINDINGS_PROMPT = [
  "You are an AI coding agent producing structured findings after",
  "the bounded verify-and-repair loop has finished.",
  "Return ONLY a JSON object that matches the schema below — no",
  "commentary, no markdown fences.",
  "`diagnosis` is a one-sentence root-cause explanation.",
  "`summary` is a one-sentence outcome description (what's still broken or what got fixed).",
  "`severity` is one of: low, medium, high.",
  "`blockers` lists any external constraints preventing a fix",
  "(missing dependency, network access required, permission denial, etc.). Empty array when none.",
  "`proposed_fix.summary` describes the next concrete step.",
  "`proposed_fix.steps` is 1-5 short imperative phrases.",
  "",
  "Schema:",
  describeSchema(REPAIR_FINDINGS_SCHEMA)
].join("\n");

/**
 * @param {object} args
 * @param {object} args.adapter        - Model adapter (must expose respondJson).
 * @param {string} args.userRequest
 * @param {object} args.projectSummary
 * @param {string} args.status         - "passed" | "failed" — the outcome of verifyAndRepair.
 * @param {object[]} args.failedChecks - Compact failure summaries (post-summarizer shape).
 * @param {object[]} args.attempts     - Repair attempts recorded by the loop.
 * @param {object} args.activeTask
 * @returns {Promise<{ok, findings?, source, errors?, message?}>}
 */
export async function requestRepairFindings({
  adapter,
  userRequest,
  projectSummary,
  status,
  failedChecks = [],
  attempts = [],
  activeTask
} = {}) {
  if (typeof adapter?.respondJson !== "function") {
    return { ok: false, source: "unsupported", message: "Adapter does not implement respondJson." };
  }
  // Don't bill a round-trip when there's nothing to diagnose.
  if (status !== "failed" && !failedChecks.length) {
    return { ok: false, source: "skipped", message: "No failures to diagnose." };
  }

  const result = await adapter.respondJson({
    system: REPAIR_FINDINGS_PROMPT,
    user: {
      user_request: userRequest,
      project_summary: projectSummary,
      verification_status: status,
      failed_checks: failedChecks,
      repair_attempts: attempts.map((entry) => ({
        attempt: entry.attempt,
        ok: entry.repair?.ok,
        message: entry.repair?.message,
        noop: entry.repair?.noop
      }))
    },
    schema: REPAIR_FINDINGS_SCHEMA,
    schemaName: "lamp_repair_findings",
    activeTask,
    purpose: "repair_findings"
  });
  if (!result.ok) return { ok: false, source: "request_failed", message: result.message };

  const validation = validate(result.structured, REPAIR_FINDINGS_SCHEMA);
  if (!validation.ok) {
    if (activeTask?.dir) {
      await appendEvent(activeTask.dir, {
        type: "repair_findings_invalid",
        message: "Model repair findings failed schema validation; review will fall back to existing critique.",
        errors: validation.errors,
        raw_preview: typeof result.raw === "string" ? result.raw.slice(0, 400) : null
      });
    }
    return { ok: false, source: "schema_invalid", errors: validation.errors };
  }

  if (activeTask?.dir) {
    await writeFile(
      path.join(activeTask.dir, "repair-findings.json"),
      `${JSON.stringify(result.structured, null, 2)}\n`
    );
    await appendEvent(activeTask.dir, {
      type: "repair_findings_recorded",
      message: "Persisted repair-findings.json from model output",
      severity: result.structured.severity || null,
      summary: result.structured.summary
    });
  }
  return { ok: true, source: "model", findings: result.structured };
}
