import { access, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { appendEvent } from "../log/event-log.js";
import { updateTaskStatus } from "./task-manager.js";

export const TASK_PHASES = {
  intake: {
    status: "intake",
    requiredOutputs: ["task_json"],
    allowedTools: [],
    next: "triage"
  },
  triage: {
    status: "triage",
    requiredOutputs: ["project_summary"],
    allowedTools: ["list_files", "read_file", "search_files", "find_symbols", "find_definition", "find_references", "find_imports", "find_exports", "symbol_callers", "symbol_dependencies", "route_map", "detect_test_runner", "git_status"],
    next: "plan"
  },
  plan: {
    status: "planning",
    requiredOutputs: ["current_plan", "risky_boundaries", "pre_patch_plan"],
    allowedTools: [],
    next: "patch"
  },
  patch: {
    status: "patching",
    requiredOutputs: ["assistant_response"],
    allowedTools: ["read_file", "search_files", "find_symbols", "find_definition", "find_references", "find_imports", "find_exports", "symbol_callers", "symbol_dependencies", "route_map", "apply_patch", "preview_patch", "write_file", "create_file", "delete_file", "rename_file", "replace_range", "replace_exact", "insert_before", "insert_after", "run_command"],
    next: "verify"
  },
  verify: {
    status: "verifying",
    requiredOutputs: ["verification_result"],
    allowedTools: ["run_available_checks", "run_tests", "run_lint", "run_typecheck", "run_build", "run_test_file", "run_test_name", "run_related_tests", "run_command"],
    next: "critique"
  },
  critique: {
    status: "critiquing",
    requiredOutputs: ["critique"],
    allowedTools: ["read_file", "git_diff"],
    next: "final_review"
  },
  final_review: {
    status: "ready_to_review",
    requiredOutputs: ["final_review"],
    allowedTools: ["run_available_checks", "git_diff"],
    next: null
  }
};

export function createPhaseController(activeTask) {
  return {
    async begin(phase, context = {}) {
      assertKnownPhase(phase);
      const phases = await readPhaseState(activeTask);
      validateCanBegin(phases, phase, context);
      const entry = {
        ...phaseEntry(phase, "in_progress", context),
        allowed_tools: TASK_PHASES[phase].allowedTools
      };
      phases[phase] = entry;
      await writePhaseState(activeTask, phases);
      await updateTaskStatus(activeTask, TASK_PHASES[phase].status);
      await appendEvent(activeTask.dir, {
        type: "phase_started",
        phase,
        status: TASK_PHASES[phase].status,
        allowed_tools: TASK_PHASES[phase].allowedTools,
        required_outputs: TASK_PHASES[phase].requiredOutputs
      });
      return entry;
    },

    async complete(phase, outputs = {}) {
      assertKnownPhase(phase);
      const phases = await readPhaseState(activeTask);
      if (!phases[phase] || phases[phase].state !== "in_progress") {
        throw new Error(`Cannot complete phase ${phase}: it is not in progress.`);
      }
      const missing = missingRequiredOutputs(phase, outputs);
      if (missing.length) {
        await appendEvent(activeTask.dir, {
          type: "phase_failed",
          phase,
          message: `Missing required output(s): ${missing.join(", ")}`,
          missing
        });
        throw new Error(`Cannot complete phase ${phase}: missing required output(s): ${missing.join(", ")}.`);
      }
      const entry = {
        ...phases[phase],
        state: "completed",
        completed_at: new Date().toISOString(),
        outputs: summarizeOutputs(outputs)
      };
      phases[phase] = entry;
      await writePhaseState(activeTask, phases);
      await appendEvent(activeTask.dir, {
        type: "phase_completed",
        phase,
        outputs: entry.outputs
      });
      return entry;
    },

    async fail(phase, error) {
      assertKnownPhase(phase);
      const phases = await readPhaseState(activeTask);
      phases[phase] = {
        ...(phases[phase] || phaseEntry(phase, "failed")),
        state: "failed",
        failed_at: new Date().toISOString(),
        message: error?.message || String(error)
      };
      await writePhaseState(activeTask, phases);
      await appendEvent(activeTask.dir, {
        type: "phase_failed",
        phase,
        message: phases[phase].message
      });
      throw error;
    },

    /**
     * Mark a phase as `skipped` because it does not apply to this task
     * (for example, an explain-style request has nothing to verify).
     * Skipped is treated as a valid predecessor state by the next
     * phase's `begin`, so the lifecycle can collapse without forcing
     * every task through every phase.
     */
    async skip(phase, reason = "Phase skipped because it does not apply to this task.") {
      assertKnownPhase(phase);
      const phases = await readPhaseState(activeTask);
      phases[phase] = {
        phase,
        state: "skipped",
        skipped_at: new Date().toISOString(),
        status: TASK_PHASES[phase].status,
        message: reason
      };
      await writePhaseState(activeTask, phases);
      await appendEvent(activeTask.dir, {
        type: "phase_skipped",
        phase,
        message: reason
      });
      return phase;
    },

    /**
     * Mark whichever phase is currently `in_progress` as `cancelled`
     * (no error is thrown). Callers use this when the user explicitly
     * cancels the task. Returns the cancelled phase name or null when
     * no phase was in progress.
     */
    async markCancelled(reason = "User cancelled the task.") {
      const phases = await readPhaseState(activeTask);
      const inProgress = Object.entries(phases).find(([, entry]) => entry?.state === "in_progress");
      if (!inProgress) return null;
      const [name, entry] = inProgress;
      phases[name] = {
        ...entry,
        state: "cancelled",
        cancelled_at: new Date().toISOString(),
        message: reason
      };
      await writePhaseState(activeTask, phases);
      await appendEvent(activeTask.dir, {
        type: "phase_cancelled",
        phase: name,
        message: reason
      });
      return name;
    },

    /**
     * Like `markCancelled` but reserved for non-graceful exits
     * (Ctrl-C, hangups). The active phase becomes `interrupted` so
     * a future `/resume` can tell the difference between a user
     * cancellation and an external interruption.
     */
    async markInterrupted(reason = "Process interrupted before the phase could complete.") {
      const phases = await readPhaseState(activeTask);
      const inProgress = Object.entries(phases).find(([, entry]) => entry?.state === "in_progress");
      if (!inProgress) return null;
      const [name, entry] = inProgress;
      phases[name] = {
        ...entry,
        state: "interrupted",
        interrupted_at: new Date().toISOString(),
        message: reason
      };
      await writePhaseState(activeTask, phases);
      await appendEvent(activeTask.dir, {
        type: "phase_interrupted",
        phase: name,
        message: reason
      });
      return name;
    },

    async read() {
      return readPhaseState(activeTask);
    }
  };
}

export async function initializePhaseController(activeTask) {
  const phases = await readPhaseState(activeTask);
  if (!phases.intake) {
    phases.intake = {
      ...phaseEntry("intake", "completed"),
      completed_at: new Date().toISOString(),
      outputs: { task_json: true }
    };
    await writePhaseState(activeTask, phases);
    await appendEvent(activeTask.dir, {
      type: "phase_completed",
      phase: "intake",
      outputs: phases.intake.outputs
    });
  }
  return createPhaseController(activeTask);
}

export function buildTaskPlan({ userRequest, projectSummary }) {
  const plan = ["Use persisted project memory and current triage summary"];
  const lower = userRequest.toLowerCase();
  if (/\b(explain|where|what|why|how)\b/.test(lower)) {
    plan.push("Inspect relevant project evidence before answering");
    plan.push("Separate confirmed facts from assumptions");
  } else {
    plan.push("Inspect likely implementation files before editing");
    plan.push("Make minimal reversible edits");
    if (projectSummary?.scripts?.length || projectSummary?.memory?.scripts?.length) {
      plan.push("Run the narrowest relevant check available");
    } else {
      plan.push("Record why checks are skipped if none are available");
    }
    plan.push("Summarize changed files, verification, and risks");
  }
  return plan;
}

export function identifyRiskyBoundaries({ userRequest, projectSummary }) {
  const text = `${userRequest}\n${JSON.stringify(projectSummary || {})}`.toLowerCase();
  const risks = [];
  if (/\b(install|dependency|package|npm install|pnpm add|yarn add)\b/.test(text)) risks.push("dependency_change");
  if (/\b(api|http|fetch|download|network|openrouter|deploy)\b/.test(text)) risks.push("network");
  if (/\b(env|secret|token|key|password)\b/.test(text)) risks.push("secret");
  if (/\b(delete|remove|rm\s)\b/.test(text)) risks.push("delete");
  if (/\b(push|deploy|publish|production)\b/.test(text)) risks.push("external_publish");
  return [...new Set(risks)];
}

async function readPhaseState(activeTask) {
  const phasesPath = phaseStatePath(activeTask);
  try {
    return JSON.parse(await readFile(phasesPath, "utf8"));
  } catch {
    return {};
  }
}

async function writePhaseState(activeTask, phases) {
  await writeFile(phaseStatePath(activeTask), `${JSON.stringify(phases, null, 2)}\n`);
}

function phaseStatePath(activeTask) {
  return path.join(activeTask.dir, "phases.json");
}

function assertKnownPhase(phase) {
  if (!TASK_PHASES[phase]) throw new Error(`Unknown task phase: ${phase}`);
}

function validateCanBegin(phases, phase, context) {
  const previous = previousPhase(phase);
  if (previous) {
    const previousState = phases[previous]?.state;
    // `skipped` is a valid predecessor state — the lifecycle is allowed
    // to collapse over phases that do not apply to a given task.
    if (previousState !== "completed" && previousState !== "skipped") {
      throw new Error(`Cannot begin phase ${phase}: previous phase ${previous} is not complete.`);
    }
  }
  if (phase === "patch") validatePatchReadiness(context);
  if (phase === "final_review") validateFinalReviewReadiness(context);
}

function validatePatchReadiness(context) {
  const inspected = context.inspected_files || context.project_summary?.notableFiles || [];
  const taskType = context.task_type || "";
  const isDocsOrSetup = /docs?|setup|explain/.test(taskType);
  if (!isDocsOrSetup && !inspected.length) {
    throw new Error("Cannot begin patch: no relevant files were recorded during triage.");
  }
  if (!context.current_plan?.length) {
    throw new Error("Cannot begin patch: no current plan is recorded.");
  }
  if (!Array.isArray(context.risky_boundaries)) {
    throw new Error("Cannot begin patch: risky boundaries were not recorded.");
  }
}

function validateFinalReviewReadiness(context) {
  if (!context.diff_available) {
    throw new Error("Cannot begin final_review: diff availability has not been recorded.");
  }
  if (!context.checks_recorded) {
    throw new Error("Cannot begin final_review: checks have not been run or skipped with a reason.");
  }
  if (!context.critique_complete) {
    throw new Error("Cannot begin final_review: critique is not complete.");
  }
}

function previousPhase(phase) {
  const entries = Object.entries(TASK_PHASES);
  const index = entries.findIndex(([name]) => name === phase);
  if (index <= 0) return null;
  return entries[index - 1][0];
}

function missingRequiredOutputs(phase, outputs) {
  return TASK_PHASES[phase].requiredOutputs.filter((name) => !hasOutput(outputs, name));
}

function hasOutput(outputs, name) {
  if (name === "task_json") return Boolean(outputs.task_json || outputs.task);
  if (name === "project_summary") return Boolean(outputs.project_summary);
  if (name === "current_plan") return Array.isArray(outputs.current_plan) && outputs.current_plan.length > 0;
  if (name === "risky_boundaries") return Array.isArray(outputs.risky_boundaries);
  if (name === "pre_patch_plan") {
    const plan = outputs.pre_patch_plan;
    return Boolean(plan && typeof plan === "object" && plan.expected_scope);
  }
  if (name === "assistant_response") return Boolean(outputs.assistant_response);
  if (name === "verification_result") return Boolean(outputs.verification_result);
  if (name === "critique") return Boolean(outputs.critique);
  if (name === "final_review") return Boolean(outputs.final_review);
  return Boolean(outputs[name]);
}

function summarizeOutputs(outputs) {
  return Object.fromEntries(Object.entries(outputs).map(([key, value]) => [key, summarizeOutputValue(value)]));
}

function summarizeOutputValue(value) {
  if (Array.isArray(value)) return { type: "array", count: value.length };
  if (value && typeof value === "object") {
    return {
      type: "object",
      keys: Object.keys(value).slice(0, 20)
    };
  }
  return value;
}

function phaseEntry(phase, state, context = {}) {
  return {
    phase,
    state,
    started_at: new Date().toISOString(),
    status: TASK_PHASES[phase].status,
    required_outputs: TASK_PHASES[phase].requiredOutputs,
    context: summarizeOutputs(context)
  };
}

export async function phaseStateExists(activeTask) {
  try {
    await access(phaseStatePath(activeTask), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
