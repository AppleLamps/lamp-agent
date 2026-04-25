#!/usr/bin/env node
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig } from "./config/config.js";
import { createTask, updateTaskStatus } from "./task/task-manager.js";
import { appendEvent } from "./log/event-log.js";
import { createToolRuntime } from "./tools/runtime.js";
import { summarizeProject, finalReview } from "./review/review.js";
import { critiqueTask } from "./review/critique.js";
import { createOpenRouterAdapter } from "./model/openrouter.js";
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
  const model = createOpenRouterAdapter(config.model);

  output.write(`${ui.banner(VERSION)}\n`);

  let activeTask = null;
  let activeTools = tools;

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
    if (line.toLowerCase().startsWith("adjust")) {
      output.write(`${ui.progress("Tell me the adjustment as a new plain-English request.")}\n`);
      continue;
    }

    output.write(`${ui.user(line)}\n`);
    activeTask = await createTask(cwd, line);
    const phaseController = await initializePhaseController(activeTask);
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
    await updateTaskStatus(activeTask, "planning", {
      current_plan: currentPlan,
      risk_level: riskyBoundaries.length ? "elevated" : "normal",
      risky_boundaries: riskyBoundaries
    });
    await appendEvent(activeTask.dir, {
      type: "task_plan",
      message: "Task plan recorded before patch phase",
      current_plan: currentPlan,
      risky_boundaries: riskyBoundaries
    });
    await phaseController.complete("plan", {
      current_plan: currentPlan,
      risky_boundaries: riskyBoundaries
    });

    await phaseController.begin("patch", {
      task_type: activeTask.task.task_type,
      project_summary: projectSummary,
      inspected_files: projectSummary.notableFiles,
      current_plan: currentPlan,
      risky_boundaries: riskyBoundaries
    });
    const response = await model.respond({
      userRequest: line,
      projectSummary,
      tools: activeTools,
      activeTask,
      allowedTools: TASK_PHASES.patch.allowedTools,
      onProgress(message) {
        output.write(`${ui.progress(message)}\n`);
      }
    });

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
  /undo    Undo files changed by the last task, when snapshots exist
  /exit    Quit

Review actions:
  accept
  resolve conflicts
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
  if (action.choice === "undo") {
    await handleUndo(activeTask, tools, ui);
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
        const approvedAfterExplain = secondChoice.choice === "allow";
        if (approvedAfterExplain && !askEveryTime) approvals.set(approvalKey, true);
        return { approved: approvedAfterExplain };
      }
      const approvedChoice = interactive.choice === "allow";
      if (approvedChoice && !askEveryTime) approvals.set(approvalKey, true);
      return { approved: approvedChoice };
    }

    const answer = (await rl.question(`${ui.approval(plain)}\napproval > `)).trim().toLowerCase();
    if (answer === "explain") {
      const explanation = approvalExplanation(plain);
      const secondAnswer = (await rl.question(`${ui.card("why this needs approval", explanation)}\napproval > `)).trim().toLowerCase();
      const approvedAfterExplain = secondAnswer === "y" || secondAnswer === "yes";
      if (approvedAfterExplain && !askEveryTime) approvals.set(approvalKey, true);
      return { approved: approvedAfterExplain };
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

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
