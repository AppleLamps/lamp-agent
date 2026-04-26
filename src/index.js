#!/usr/bin/env node
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config/config.js";
import { createTask, updateTaskStatus } from "./task/task-manager.js";
import { appendEvent } from "./log/event-log.js";
import { createToolRuntime } from "./tools/runtime.js";
import { summarizeProject, finalReview } from "./review/review.js";
import { critiqueTask } from "./review/critique.js";
import { createModelAdapter } from "./model/index.js";
import { updateBeliefsFromCritique, updateBeliefsFromResponse, updateBeliefsFromTriage } from "./task/beliefs.js";
import {
  applyShadowWorkspaceChanges,
  cleanupShadowWorkspace,
  createShadowWorkspace,
  resolveApplyBackConflicts,
  summarizeApplyBackConflicts
} from "./workspace/shadow-workspace.js";
import { createTerminalUi } from "./ui/terminal.js";
import { createInteractivePrompts } from "./ui/interactive.js";
import { verifyAndRepair } from "./verify/repair-loop.js";
import { refreshProjectMemory } from "./memory/project-memory.js";
import { buildTaskPlan, identifyRiskyBoundaries, initializePhaseController, TASK_PHASES } from "./task/phase-controller.js";
import { buildPrePatchPlan } from "./task/pre-patch-plan.js";
import { requestStructuredPlan } from "./task/structured-plan.js";
import { requestStructuredEditSpec } from "./task/edit-spec.js";

const VERSION = "0.1.0";

async function main() {
  const cwd = process.cwd();
  const config = await loadConfig(cwd);

  const rl = readline.createInterface({ input, output });
  const approvals = new Map();
  const ui = createTerminalUi({ output, input });
  const prompts = createInteractivePrompts({ input, output });
  const requestApproval = createApprovalPrompt(rl, approvals, ui, prompts);
  const tools = createToolRuntime({ cwd, config, requestApproval });
  const model = await createModelAdapter(config.model);

  output.write(`${ui.banner(VERSION)}\n`);

  let activeTask = null;
  let activeTools = tools;

  // Graceful Ctrl-C: capture partial state, mark the active phase as
  // interrupted, and let the user see exactly where the task stopped.
  // After the first SIGINT we close the readline so a second Ctrl-C
  // exits the process immediately.
  let sigintHandlerActive = true;
  process.on("SIGINT", async () => {
    if (!sigintHandlerActive) return;
    sigintHandlerActive = false;
    try {
      if (activeTask) {
        await cancelTask(activeTask, ui, {
          reason: "Process received SIGINT.",
          interrupted: true
        });
      }
    } finally {
      try { rl.close(); } catch { /* ignore */ }
      process.exit(130);
    }
  });

  while (true) {
    let answer;
    try {
      answer = await rl.question(ui.prompt());
    } catch (error) {
      if (error?.code === "ERR_USE_AFTER_CLOSE") break;
      throw error;
    }
    const line = answer.trim();
    if (!line) continue;
    if (line === "/exit" || line === "/quit") break;
    if (line === "/help") {
      printHelp(ui);
      continue;
    }
    if (line === "/status") {
      await printStatus(activeTools, activeTask, ui);
      continue;
    }
    if (line === "/diff" || line.toLowerCase() === "see diff") {
      await printDiff(activeTools, activeTask, ui);
      continue;
    }
    if (line === "/details" || line.toLowerCase() === "see technical details" || line.toLowerCase() === "technical details") {
      await printTechnicalDetails(activeTask, ui);
      continue;
    }
    if (line === "/files" || line.toLowerCase() === "open changed file list" || line.toLowerCase() === "changed files") {
      await printChangedFiles(activeTask, ui);
      continue;
    }
    if (line === "/plan" || line.toLowerCase() === "see plan") {
      await printPrePatchPlan(activeTask, ui);
      continue;
    }
    if (line === "/tasks" || line.toLowerCase() === "list tasks") {
      await printTasksList(cwd, ui);
      continue;
    }
    if (line.toLowerCase().startsWith("/show ") || line.toLowerCase().startsWith("show task ")) {
      const taskId = line.replace(/^\/show\s+|^show\s+task\s+/i, "").trim();
      await printTaskShow(cwd, taskId, ui);
      continue;
    }
    if (line === "/undo") {
      await handleUndo(activeTask, activeTools, ui);
      continue;
    }
    if (line.toLowerCase() === "undo") {
      await handleUndo(activeTask, activeTools, ui);
      continue;
    }
    if (line.toLowerCase() === "accept") {
      await acceptTask({ activeTask, rootTools: tools, prompts, setActiveTools: (next) => { activeTools = next; }, ui, cwd });
      continue;
    }
    if (line.toLowerCase() === "resolve conflicts") {
      await resolvePendingConflicts({ activeTask, rootTools: tools, prompts, setActiveTools: (next) => { activeTools = next; }, ui, cwd });
      continue;
    }
    if (line.toLowerCase() === "cancel task") {
      await cancelTask(activeTask, ui);
      continue;
    }
    if (line.toLowerCase().startsWith("adjust")) {
      output.write(`${ui.progress("Tell me the adjustment as a new plain-English request.")}\n`);
      continue;
    }

    output.write(`${ui.user(line)}\n`);
    activeTask = await createTask(cwd, line);
    const phaseController = await initializePhaseController(activeTask);
    activeTask.phaseController = phaseController;
    activeTools = tools;
    await appendEvent(activeTask.dir, {
      type: "task_created",
      message: "User request captured",
      user_request: line
    });
    if (config.workspace.shadowMode !== "off") {
      const shadow = await createShadowWorkspace(cwd, activeTask);
      activeTask.shadow = shadow;
      activeTools = createToolRuntime({ cwd: shadow.path, config, requestApproval });
      await appendEvent(activeTask.dir, {
        type: "shadow_workspace_created",
        message: `Created ${shadow.type} shadow workspace`,
        shadow
      });
    }

    output.write(`${ui.progress("Understanding the project")}\n`);
    await phaseController.begin("triage");
    const memoryResult = await refreshProjectMemory({ cwd: activeTools.cwd, tools: activeTools });
    const projectSummary = await summarizeProject(activeTools, memoryResult.memory);
    await appendEvent(activeTask.dir, {
      type: "project_summary",
      message: "Project triage completed",
      summary: projectSummary,
      memory_refreshed: memoryResult.refreshed,
      memory_reason: memoryResult.reason
    });
    await updateBeliefsFromTriage(activeTask, projectSummary);
    await phaseController.complete("triage", { project_summary: projectSummary });

    await phaseController.begin("plan");
    const currentPlan = buildTaskPlan({ userRequest: line, projectSummary });
    const riskyBoundaries = identifyRiskyBoundaries({ userRequest: line, projectSummary });
    // Pull the full workspace file list so the planner sees danger
    // zones outside `notableFiles` (for example, a `.env` at the root
    // is filtered out of `notableFiles` but is still relevant for the
    // secret-file blocking check).
    const fullFileList = await activeTools.listFiles(".");
    const prePatchPlan = buildPrePatchPlan({
      userRequest: line,
      projectSummary,
      riskyBoundaries,
      projectMemory: memoryResult.memory,
      codeIndex: fullFileList?.ok ? { files: fullFileList.files } : null
    });
    await writeFile(
      path.join(activeTask.dir, "pre-patch-plan.json"),
      `${JSON.stringify(prePatchPlan, null, 2)}\n`
    );

    // Optionally enrich the heuristic plan with a model-generated
    // structured plan. The CLI keeps the heuristic plan as the
    // authoritative `current_plan` (it works offline and is fast); the
    // structured plan is persisted as `plan.json` for review.
    let modelPlan = null;
    if (config.model.allowNetwork) {
      const planResult = await requestStructuredPlan({
        adapter: model,
        userRequest: line,
        projectSummary,
        riskyBoundaries,
        heuristicPlan: currentPlan,
        activeTask
      });
      if (planResult.ok) modelPlan = planResult.plan;
    }

    await updateTaskStatus(activeTask, "planning", {
      current_plan: currentPlan,
      risk_level: riskyBoundaries.length ? "elevated" : "normal",
      risky_boundaries: riskyBoundaries
    });
    await appendEvent(activeTask.dir, {
      type: "task_plan",
      message: "Task plan recorded before patch phase",
      current_plan: currentPlan,
      risky_boundaries: riskyBoundaries,
      pre_patch_plan_summary: summarizePrePatchPlan(prePatchPlan),
      model_plan_summary: modelPlan ? {
        summary: modelPlan.summary,
        step_count: modelPlan.steps?.length ?? 0,
        risky_boundaries: modelPlan.risky_boundaries || []
      } : null
    });
    if (prePatchPlan.warnings?.length) {
      // Always show the warnings to the user as informational context.
      output.write(`${ui.card("pre-patch warnings", formatPrePatchWarnings(prePatchPlan))}\n`);
      // Only block the patch phase for warnings the planner explicitly
      // marked `blocking: true` — those are the cases where the
      // candidate file set genuinely crosses a danger-zone path
      // (avoid_touching, secret paths, dependency manifests,
      // lockfiles). Generic risky-boundary tiers describe *operations*
      // that the harness prompts on later when they run.
      const blockingWarnings = prePatchPlan.warnings.filter((entry) => entry.blocking === true);
      if (blockingWarnings.length) {
        const proceed = await requestApproval(
          { action: "ask", tier: "pre_patch_warning", reason: prePatchWarningReason(blockingWarnings) },
          { taskId: activeTask.id }
        );
        if (!proceed.approved) {
          await appendEvent(activeTask.dir, {
            type: "pre_patch_plan_denied",
            message: proceed.cancelled
              ? "User cancelled the task at the pre-patch warning."
              : proceed.alternative
                ? "User asked for an alternative approach at the pre-patch warning."
                : "User denied the pre-patch plan; task halted before patch.",
            warnings: blockingWarnings
          });
          await updateTaskStatus(activeTask, proceed.cancelled ? "cancelled" : "halted_pre_patch");
          output.write(`${ui.warning("Task halted before any files were touched.")}\n`);
          continue;
        }
      }
    }
    await phaseController.complete("plan", {
      current_plan: currentPlan,
      risky_boundaries: riskyBoundaries,
      pre_patch_plan: prePatchPlan
    });

    await phaseController.begin("patch", {
      task_type: activeTask.task.task_type,
      project_summary: projectSummary,
      inspected_files: projectSummary.notableFiles,
      current_plan: currentPlan,
      risky_boundaries: riskyBoundaries
    });

    // Optionally request a structured edit-spec from the model
    // BEFORE any patching happens. The spec is informational at this
    // stage (the model may diverge during respond) but it's a useful
    // preview and audit artifact — see `edit-spec.json` under the
    // task dir.
    if (config.model.allowNetwork) {
      const specResult = await requestStructuredEditSpec({
        adapter: model,
        userRequest: line,
        projectSummary,
        currentPlan: modelPlan?.steps || currentPlan,
        prePatchPlan,
        activeTask
      });
      if (specResult.ok) {
        output.write(`${ui.progress(`Model edit-spec recorded (${specResult.edit_spec.edits?.length || 0} planned edits, ${specResult.edit_spec.estimated_risk || "?"} risk)`)}\n`);
      }
    }

    let response;
    // An AbortController scoped to this task so `cancel task` (or
    // Ctrl-C) can interrupt an in-flight model request without
    // tearing down the whole CLI loop.
    const taskAbort = new AbortController();
    activeTask.abortController = taskAbort;
    let streamingActive = false;
    try {
      response = await model.respond({
        userRequest: line,
        projectSummary,
        tools: activeTools,
        activeTask,
        allowedTools: TASK_PHASES.patch.allowedTools,
        onProgress(message) {
          output.write(`${ui.progress(message)}\n`);
        },
        onToken(token) {
          if (!streamingActive) {
            output.write(`${ui.progress("Streaming model response")}\n`);
            streamingActive = true;
          }
          output.write(token);
        },
        signal: taskAbort.signal
      });
      // Close out the streaming line if any tokens were written.
      if (streamingActive) output.write("\n");
    } catch (error) {
      const errorMessage = error?.message || String(error);
      output.write(`${ui.warning(`Model error: ${errorMessage}. Continuing with a fallback response so the task can finish cleanly.`)}\n`);
      await appendEvent(activeTask.dir, {
        type: "model_error",
        phase: "patch",
        message: errorMessage
      });
      response = {
        message: `The model adapter failed during the patch phase: ${errorMessage}. The harness recorded the error and continued without applying any model-driven changes.`,
        taskPatch: {
          assumptions: [`Model adapter raised an error: ${errorMessage}`]
        },
        error: { phase: "patch", message: errorMessage }
      };
    }

    await updateTaskStatus(activeTask, "patching", {
      ...response.taskPatch,
      current_plan: response.taskPatch?.current_plan?.length ? response.taskPatch.current_plan : currentPlan,
      risky_boundaries: riskyBoundaries
    });
    await updateBeliefsFromResponse(activeTask, response);
    await appendEvent(activeTask.dir, {
      type: "assistant_response",
      message: response.message
    });
    await phaseController.complete("patch", { assistant_response: response });

    output.write(`${ui.progress("Verifying the result")}\n`);
    await phaseController.begin("verify");
    const verification = await verifyAndRepair({
      activeTask,
      tools: activeTools,
      model,
      userRequest: line,
      projectSummary,
      allowedRepairTools: [...new Set([...TASK_PHASES.patch.allowedTools, ...TASK_PHASES.verify.allowedTools])],
      onProgress(message) {
        output.write(`${ui.progress(message)}\n`);
      }
    });
    await phaseController.complete("verify", { verification_result: verification || { ok: true } });

    output.write(`${ui.progress("Reviewing the result")}\n`);
    await phaseController.begin("critique");
    const critique = await critiqueTask({ activeTask, tools: activeTools, response, model, projectSummary });
    await updateBeliefsFromCritique(activeTask, critique);
    await appendEvent(activeTask.dir, {
      type: "critique",
      message: critique.summary,
      status: critique.status,
      source: critique.source,
      findings: critique.findings
    });
    await phaseController.complete("critique", { critique });

    output.write(`\n${ui.assistant(response.message)}\n`);
    const diffBeforeReview = await activeTools.taskDiff(activeTask);
    await phaseController.begin("final_review", {
      diff_available: Boolean(diffBeforeReview),
      checks_recorded: true,
      critique_complete: true
    });
    const review = await finalReview(activeTask, activeTools, response, critique);
    await phaseController.complete("final_review", { final_review: review });
    output.write(`\n${ui.card("review", review)}\n\n`);
    await handleReviewAction({
      prompts,
      tools: activeTools,
      rootTools: tools,
      activeTask,
      ui,
      cwd,
      setActiveTools: (next) => { activeTools = next; }
    });
  }

  rl.close();
}

function printHelp(ui) {
  output.write(`${ui.card("help", `
Commands:
  /status  Show workspace status and changed files
  /diff    Show the active task diff summary
  /details Show task artifacts and technical details
  /files   Show changed files for the active task
  /plan    Show the pre-patch plan recorded for the active task
  /tasks   List recent tasks (status, last phase, resumable flag)
  /show    Show details for one task by id (e.g. /show task-20260425-200000)
  /undo    Undo files changed by the last task, when snapshots exist
  /exit    Quit

Review actions:
  accept
  resolve conflicts
  see technical details
  open changed file list
  cancel task
  adjust <request>
  undo
  see diff

Ask in plain English, for example:
  Explain what kind of project this is
  Find where authentication is implemented
  Run the available checks

This MVP can inspect files, create task records, run safe local checks, and undo
tracked file edits. Model-backed code editing is scaffolded behind the adapter.
`)}\n`);
}

async function printStatus(tools, activeTask, ui) {
  const status = await tools.gitStatus();
  const lines = [status.summary];
  if (activeTask) {
    const diff = await tools.taskDiff(activeTask);
    lines.push(formatStatusDiff(diff));
  }
  output.write(`${ui.card("status", lines.join("\n"))}\n`);
}

async function printDiff(tools, activeTask, ui) {
  if (!activeTask) {
    output.write(`${ui.warning("There is no active task diff yet.")}\n`);
    return;
  }
  const diff = await tools.taskDiff(activeTask);
  output.write(`${ui.card("diff", formatDetailedDiff(diff))}\n`);
}

async function handleReviewAction({ prompts, tools, rootTools, activeTask, ui, cwd, setActiveTools }) {
  const action = await prompts.reviewAction();
  if (!action.handled) return;
  if (action.choice === "accept") {
    await acceptTask({ activeTask, rootTools, prompts, setActiveTools, ui, cwd });
    return;
  }
  if (action.choice === "adjust") {
    output.write(`${ui.progress("Type the adjustment as your next message.")}\n`);
    return;
  }
  if (action.choice === "diff") {
    await printDiff(tools, activeTask, ui);
    return;
  }
  if (action.choice === "details") {
    await printTechnicalDetails(activeTask, ui);
    return;
  }
  if (action.choice === "changed_files") {
    await printChangedFiles(activeTask, ui);
    return;
  }
  if (action.choice === "resolve_conflicts") {
    await resolvePendingConflicts({ activeTask, rootTools, prompts, setActiveTools, ui, cwd });
    return;
  }
  if (action.choice === "undo") {
    await handleUndo(activeTask, tools, ui);
    return;
  }
  if (action.choice === "cancel_task") {
    await cancelTask(activeTask, ui);
  }
}

async function acceptTask({ activeTask, rootTools, prompts, setActiveTools, ui, cwd }) {
  if (!activeTask) {
    output.write(`${ui.warning("There is no task to accept yet.")}\n`);
    return;
  }
  if (activeTask.shadow && !activeTask.shadowApplied) {
    const result = await applyShadowWorkspaceChanges({ activeTask, shadow: activeTask.shadow, targetRoot: cwd });
    if (!result.ok) {
      activeTask.pendingApplyBackConflicts = result.conflicts || [];
      const conflictList = result.conflicts?.length
        ? ` Conflicts: ${result.conflicts.map((conflict) => conflict.path).join(", ")}.`
        : "";
      output.write(`${ui.warning(`${result.message}${conflictList}`)}\n`);
      await resolvePendingConflicts({ activeTask, rootTools, prompts, setActiveTools, ui, cwd });
      return;
    }
    await finishShadowApply({ activeTask, rootTools, result, setActiveTools, ui });
    return;
  }
  output.write(`${ui.success("Task accepted locally. No push or deploy was performed.")}\n`);
}

async function resolvePendingConflicts({ activeTask, rootTools, prompts, setActiveTools, ui, cwd }) {
  if (!activeTask?.shadow || activeTask.shadowApplied) {
    output.write(`${ui.warning("There are no pending shadow apply-back conflicts.")}\n`);
    return;
  }
  const summary = await summarizeApplyBackConflicts({ activeTask, shadow: activeTask.shadow, targetRoot: cwd });
  if (!summary.conflicts.length) {
    output.write(`${ui.warning("No apply-back conflicts were found. Try accept again.")}\n`);
    return;
  }

  const resolutions = {};
  for (const conflict of summary.conflicts) {
    output.write(`${ui.card("apply-back conflict", formatConflictSummary(conflict))}\n`);
    const action = await prompts.conflictResolution(conflict);
    if (!action.handled) {
      output.write(`${ui.warning("Apply-back is still blocked. Run 'resolve conflicts' in an interactive terminal, or edit the real workspace manually. Choices are keep real, apply shadow, or save shadow aside.")}\n`);
      return;
    }
    if (action.choice === "cancel") {
      output.write(`${ui.warning("Apply-back conflict resolution canceled. No files were overwritten.")}\n`);
      return;
    }
    resolutions[conflict.path] = action.choice;
  }

  const resolved = await resolveApplyBackConflicts({
    activeTask,
    shadow: activeTask.shadow,
    targetRoot: cwd,
    resolutions
  });
  if (!resolved.ok) {
    output.write(`${ui.warning(resolved.message)}\n`);
    return;
  }
  await finishShadowApply({ activeTask, rootTools, result: resolved, setActiveTools, ui });
}

async function finishShadowApply({ activeTask, rootTools, result, setActiveTools, ui }) {
  await appendEvent(activeTask.dir, {
    type: "shadow_workspace_applied",
    message: "Applied shadow workspace changes to the real workspace",
    result
  });
  await cleanupShadowWorkspace(activeTask.shadow);
  activeTask.shadowApplied = true;
  activeTask.pendingApplyBackConflicts = [];
  setActiveTools(rootTools);
  const kept = result.kept_real?.length ? ` Kept real version for ${result.kept_real.length} conflicted file(s).` : "";
  const saved = result.saved_shadow?.length ? ` Saved ${result.saved_shadow.length} shadow file(s) under .agent/conflicts.` : "";
  output.write(`${ui.success(`Applied ${result.applied.length} changed file(s) to the real workspace.${kept}${saved} No push or deploy was performed.`)}\n`);
}

function formatConflictSummary(conflict) {
  const real = conflict.real?.exists
    ? `real workspace: ${conflict.real.size} bytes, ${conflict.real.hash.slice(0, 12)}\n${conflict.real.preview || ""}`
    : "real workspace: missing";
  const shadow = conflict.shadow?.exists
    ? `shadow result: ${conflict.shadow.size} bytes, ${conflict.shadow.hash.slice(0, 12)}\n${conflict.shadow.preview || ""}`
    : "shadow result: missing";
  return [
    conflict.path,
    conflict.reason,
    "",
    real,
    "",
    shadow
  ].join("\n");
}

async function handleUndo(activeTask, tools, ui) {
  if (!activeTask) {
    output.write(`${ui.warning("There is no task to undo yet.")}\n`);
    return;
  }
  const result = await tools.undoTask(activeTask);
  output.write(`${result.ok ? ui.success(result.message) : ui.warning(result.message)}\n`);
}

async function printTasksList(cwd, ui) {
  const tasksDir = path.join(cwd, ".agent", "tasks");
  let entries;
  try {
    entries = await readdir(tasksDir);
  } catch (error) {
    if (error.code === "ENOENT") {
      output.write(`${ui.warning("No tasks recorded yet (.agent/tasks does not exist).")}\n`);
      return;
    }
    throw error;
  }
  if (!entries.length) {
    output.write(`${ui.warning("No tasks recorded yet.")}\n`);
    return;
  }
  const recent = entries.sort().slice(-15).reverse();
  const rows = [];
  for (const id of recent) {
    const taskPath = path.join(tasksDir, id, "task.json");
    const phasesPath = path.join(tasksDir, id, "phases.json");
    const task = await readJson(taskPath, null);
    const phases = await readJson(phasesPath, {});
    const lastPhase = describeLastPhase(phases);
    const resumable = isResumable(phases);
    const taskType = task?.task_type || "?";
    const summary = (task?.user_request || "").slice(0, 60);
    rows.push(`${id}  [${task?.status || "unknown"}]  type=${taskType}  phase=${lastPhase}${resumable ? "  resumable" : ""}\n  ${summary}`);
  }
  output.write(`${ui.card("recent tasks", rows.join("\n\n"))}\n`);
}

async function printTaskShow(cwd, taskId, ui) {
  if (!taskId) {
    output.write(`${ui.warning("Pass a task id, e.g. /show task-20260425-200000")}\n`);
    return;
  }
  const taskDir = path.join(cwd, ".agent", "tasks", taskId);
  const task = await readJson(path.join(taskDir, "task.json"), null);
  if (!task) {
    output.write(`${ui.warning(`Task ${taskId} not found under .agent/tasks.`)}\n`);
    return;
  }
  const phases = await readJson(path.join(taskDir, "phases.json"), {});
  const changed = await readJson(path.join(taskDir, "changed-files.json"), []);
  const verification = await readJson(path.join(taskDir, "verification.json"), null);
  const prePatch = await readJson(path.join(taskDir, "pre-patch-plan.json"), null);

  const phaseLines = ["intake", "triage", "plan", "patch", "verify", "critique", "final_review"]
    .map((name) => `- ${name}: ${phases[name]?.state || "not started"}`);
  const lines = [
    `task: ${task.id}`,
    `status: ${task.status}`,
    `type: ${task.task_type}`,
    `risk: ${task.risk_level || "normal"}`,
    `request: ${task.user_request}`,
    "",
    "Phases:",
    ...phaseLines,
    "",
    `changed files: ${changed.length}`,
    `verification: ${verification?.status || "not recorded"}`,
    `resumable: ${isResumable(phases) ? "yes" : "no"}`
  ];
  if (prePatch?.warnings?.length) {
    lines.push("", "Pre-patch warnings:");
    for (const warning of prePatch.warnings) {
      lines.push(`- [${warning.severity}] ${warning.tier}: ${warning.message}`);
    }
  }
  output.write(`${ui.card(`task ${taskId}`, lines.join("\n"))}\n`);
}

const PHASE_ORDER = ["intake", "triage", "plan", "patch", "verify", "critique", "final_review"];

function describeLastPhase(phases) {
  if (!phases || typeof phases !== "object") return "(no phase state)";
  let last = null;
  for (const name of PHASE_ORDER) {
    if (phases[name]) last = `${name}:${phases[name].state}`;
  }
  return last || "(no phase state)";
}

function isResumable(phases) {
  if (!phases || typeof phases !== "object") return false;
  // A task is resumable when at least one phase is recorded and the
  // pipeline did not finish cleanly — i.e. final_review is not yet
  // completed and the last touched phase is not in a terminal failure.
  if (phases.final_review?.state === "completed") return false;
  for (const name of PHASE_ORDER) {
    const entry = phases[name];
    if (!entry) continue;
    if (entry.state === "interrupted" || entry.state === "cancelled" || entry.state === "in_progress") {
      return true;
    }
  }
  // All recorded phases completed but final_review is missing.
  return Object.values(phases).some((entry) => entry?.state === "completed");
}

async function printPrePatchPlan(activeTask, ui) {
  if (!activeTask) {
    output.write(`${ui.warning("There is no active task yet.")}\n`);
    return;
  }
  const plan = await readJson(path.join(activeTask.dir, "pre-patch-plan.json"), null);
  if (!plan) {
    output.write(`${ui.warning("No pre-patch plan has been recorded for this task.")}\n`);
    return;
  }
  output.write(`${ui.card("pre-patch plan", formatPrePatchPlan(plan))}\n`);
}

function formatPrePatchPlan(plan) {
  const lines = [
    `Task type: ${plan.task_type || "unknown"}`,
    `Risk labels: ${(plan.expected_scope?.risk_labels || []).join(", ") || "none"}`,
    `Predicted checks: ${(plan.expected_scope?.predicted_checks || []).join(", ") || "none"}`,
    "",
    "Candidate files:",
    ...((plan.expected_scope?.candidate_files || []).length
      ? plan.expected_scope.candidate_files.map((file) => `- ${file}`)
      : ["- (none inferred)"]),
    "",
    "Danger zones:",
    `- avoid_touching: ${(plan.danger_zones?.avoid_touching || []).join(", ") || "none"}`,
    `- secret paths: ${(plan.danger_zones?.secret_paths || []).join(", ") || "none"}`,
    `- lockfiles: ${(plan.danger_zones?.lockfiles || []).join(", ") || "none"}`,
    `- dependency manifests: ${(plan.danger_zones?.dependency_manifests || []).join(", ") || "none"}`,
    "",
    "Warnings:",
    ...((plan.warnings || []).length
      ? plan.warnings.map((entry) => `- [${entry.severity}] ${entry.tier}: ${entry.message}`)
      : ["- none"])
  ];
  return lines.join("\n");
}

function formatPrePatchWarnings(plan) {
  if (!plan?.warnings?.length) return "No warnings.";
  return plan.warnings.map((entry) => `- [${entry.severity}] ${entry.tier}: ${entry.message}`).join("\n");
}

function prePatchWarningReason(blockingWarnings) {
  const tiers = (blockingWarnings || []).map((entry) => entry.tier);
  return `The pre-patch plan flagged ${tiers.length} blocking warning${tiers.length === 1 ? "" : "s"} (${tiers.join(", ")}). Approve to proceed with the patch phase, or deny to halt before any files are touched.`;
}

function summarizePrePatchPlan(plan) {
  return {
    task_type: plan.task_type,
    candidate_count: (plan.expected_scope?.candidate_files || []).length,
    risk_labels: plan.expected_scope?.risk_labels || [],
    warning_count: (plan.warnings || []).length,
    warning_tiers: (plan.warnings || []).map((entry) => entry.tier)
  };
}

async function printChangedFiles(activeTask, ui) {
  if (!activeTask) {
    output.write(`${ui.warning("There is no active task yet.")}\n`);
    return;
  }
  const changed = await readJson(path.join(activeTask.dir, "changed-files.json"), []);
  output.write(`${ui.card("changed files", changed.length ? changed.map((file) => `- ${file}`).join("\n") : "No changed files are tracked for this task.")}\n`);
}

async function printTechnicalDetails(activeTask, ui) {
  if (!activeTask) {
    output.write(`${ui.warning("There is no active task yet.")}\n`);
    return;
  }
  const task = await readJson(path.join(activeTask.dir, "task.json"), {});
  const changed = await readJson(path.join(activeTask.dir, "changed-files.json"), []);
  const checks = await readJson(path.join(activeTask.dir, "check-results.json"), []);
  const phases = await readJson(path.join(activeTask.dir, "phases.json"), {});
  const verification = await readJson(path.join(activeTask.dir, "verification.json"), null);
  const applyBack = await readJson(path.join(activeTask.dir, "apply-back.json"), null);
  const conflicts = await readJson(path.join(activeTask.dir, "apply-back-conflicts.json"), null);
  const commandLog = await readText(path.join(activeTask.dir, "commands.jsonl"), "");
  const modelUsage = await readJsonLines(path.join(activeTask.dir, "model-usage.jsonl"));
  const commandCount = commandLog.split(/\r?\n/).filter(Boolean).length;
  const modelCost = modelUsage.reduce((sum, entry) => sum + (Number(entry.usage?.cost) || 0), 0);
  const completedPhases = Object.values(phases).filter((phase) => phase.state === "completed").map((phase) => phase.phase);

  const lines = [
    `task: ${activeTask.id}`,
    `status: ${task.status || "unknown"}`,
    `type: ${task.task_type || "unknown"}`,
    `risk: ${task.risk_level || "unknown"}`,
    `changed files: ${changed.length}`,
    `checks recorded: ${checks.length}`,
    `commands recorded: ${commandCount}`,
    `model calls recorded: ${modelUsage.length}`,
    `model cost recorded: ${modelCost ? modelCost.toFixed(6) : "0"}`,
    `completed phases: ${completedPhases.length ? completedPhases.join(", ") : "none"}`,
    `verification: ${verification?.status || "not recorded"}`,
    `apply-back: ${applyBack?.ok === true ? "applied" : conflicts?.conflicts?.length ? "blocked by conflicts" : "not applied"}`,
    `task dir: ${activeTask.dir}`
  ];
  output.write(`${ui.card("technical details", lines.join("\n"))}\n`);
}

async function cancelTask(activeTask, ui, { reason = "Task cancelled by user action.", interrupted = false } = {}) {
  if (!activeTask) {
    output.write(`${ui.warning("There is no active task to cancel.")}\n`);
    return;
  }
  // If a model request is mid-flight, abort it. The AbortSignal will
  // reach the streaming reader (or fetch) and the respond loop will
  // surface a `cancelled: true` response.
  if (activeTask.abortController && !activeTask.abortController.signal.aborted) {
    try { activeTask.abortController.abort(); } catch { /* ignore */ }
  }
  // Mark whichever phase is currently in_progress so /tasks and the
  // future /resume can tell where the run stopped.
  if (activeTask.phaseController) {
    try {
      if (interrupted) await activeTask.phaseController.markInterrupted(reason);
      else await activeTask.phaseController.markCancelled(reason);
    } catch { /* phase state may be missing; ignore */ }
  }
  await updateTaskStatus(activeTask, interrupted ? "interrupted" : "cancelled");
  await appendEvent(activeTask.dir, {
    type: interrupted ? "task_interrupted" : "task_cancelled",
    message: reason
  });
  output.write(`${ui.warning(`${interrupted ? "Task interrupted" : "Task cancelled"}. No push or deploy was performed.`)}\n`);
}

function createApprovalPrompt(rl, approvals, ui, prompts) {
  return async function requestApproval(decision, details = {}) {
    const approvalKey = `${details.taskId || "global"}:${decision.tier}`;
    const askEveryTime = ["secret", "outside_workspace", "external_publish"].includes(decision.tier);
    if (!askEveryTime && approvals.get(approvalKey)) {
      return { approved: true, remembered: true };
    }

    const plain = describeApproval(decision, details);
    const interactive = await prompts.approval({ message: plain, askEveryTime });
    if (interactive.handled) {
      if (interactive.choice === "explain") {
        output.write(`${ui.card("why this needs approval", approvalExplanation(plain))}\n`);
        const secondChoice = await prompts.approval({ message: plain, askEveryTime });
        if (secondChoice.choice === "alternative") {
          return { approved: false, alternative: true, message: "User requested another approach." };
        }
        if (secondChoice.choice === "cancel") {
          return { approved: false, cancelled: true, message: "User cancelled the task." };
        }
        const approvedAfterExplain = secondChoice.choice === "allow";
        if (approvedAfterExplain && !askEveryTime) approvals.set(approvalKey, true);
        return { approved: approvedAfterExplain };
      }
      if (interactive.choice === "alternative") {
        return { approved: false, alternative: true, message: "User requested another approach." };
      }
      if (interactive.choice === "cancel") {
        return { approved: false, cancelled: true, message: "User cancelled the task." };
      }
      const approvedChoice = interactive.choice === "allow";
      if (approvedChoice && !askEveryTime) approvals.set(approvalKey, true);
      return { approved: approvedChoice };
    }

    const answer = (await rl.question(`${ui.approval(plain)}\napproval > `)).trim().toLowerCase();
    if (answer === "explain") {
      const explanation = approvalExplanation(plain);
      const secondAnswer = (await rl.question(`${ui.card("why this needs approval", explanation)}\napproval > `)).trim().toLowerCase();
      if (isAlternativeAnswer(secondAnswer)) {
        return { approved: false, alternative: true, message: "User requested another approach." };
      }
      if (isCancelAnswer(secondAnswer)) {
        return { approved: false, cancelled: true, message: "User cancelled the task." };
      }
      const approvedAfterExplain = secondAnswer === "y" || secondAnswer === "yes";
      if (approvedAfterExplain && !askEveryTime) approvals.set(approvalKey, true);
      return { approved: approvedAfterExplain };
    }
    if (isAlternativeAnswer(answer)) {
      return { approved: false, alternative: true, message: "User requested another approach." };
    }
    if (isCancelAnswer(answer)) {
      return { approved: false, cancelled: true, message: "User cancelled the task." };
    }
    const approved = answer === "y" || answer === "yes";
    if (approved && !askEveryTime) approvals.set(approvalKey, true);
    return { approved };
  };
}

function approvalExplanation(plain) {
  return `${plain}\n\nThe harness will only proceed if you approve this boundary for the current task. Denying leaves the operation skipped.`;
}

function describeApproval(decision, details) {
  if (decision.tier === "dependency_change") {
    return `This task wants to change project dependencies by running: ${details.command}`;
  }
  if (decision.tier === "network") {
    return `This task wants to use the network by running: ${details.command}`;
  }
  if (decision.tier === "secret") {
    return `This task wants to access a file that may contain secrets: ${details.path}`;
  }
  if (decision.tier === "outside_workspace") {
    return `This task wants to access a path outside this project: ${details.path}`;
  }
  if (decision.tier === "external_publish") {
    return `This task wants to publish or push outside your local project by running: ${details.command}`;
  }
  if (decision.tier === "pre_patch_warning") {
    return decision.reason;
  }
  return `${decision.reason}${details.command ? ` Command: ${details.command}` : ""}`;
}

function formatStatusDiff(diff) {
  if (!diff?.ok) return `Task diff: ${diff?.message || "not available"}`;
  if (diff.source === "git") return "Task diff: available through git diff.";
  if (!diff.summary?.length) return "Task diff: no tracked file changes.";
  return `Task diff: ${diff.summary.map((file) => `${file.path} ${file.status}`).join(", ")}`;
}

function formatDetailedDiff(diff) {
  if (!diff?.ok) return diff?.message || "Diff is not available.";
  if (diff.source === "git") return diff.diff || "No git diff output.";
  if (!diff.summary?.length) return "No tracked file changes.";
  return diff.summary.map((file) => {
    const preview = file.preview?.length ? `\n${file.preview.join("\n")}` : "";
    return `${file.path} (${file.status})\nadded: ${file.added}, removed: ${file.removed}, changed: ${file.changed}${preview}`;
  }).join("\n\n");
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function readText(filePath, fallback) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return fallback;
  }
}

async function readJsonLines(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function isAlternativeAnswer(answer) {
  return answer === "alternative" || answer === "another" || answer === "choose another approach";
}

function isCancelAnswer(answer) {
  return answer === "cancel" || answer === "cancel task";
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
