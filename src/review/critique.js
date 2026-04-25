import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function critiqueTask({ activeTask, tools, response, model, projectSummary }) {
  const task = await readJson(path.join(activeTask.dir, "task.json"), {});
  const changed = await readJson(path.join(activeTask.dir, "changed-files.json"), []);
  const commands = await readJsonLines(path.join(activeTask.dir, "commands.jsonl"));
  const checkResults = await readJson(path.join(activeTask.dir, "check-results.json"), []);
  const diff = await tools.taskDiff(activeTask);
  const context = {
    activeTask,
    task,
    changed_files: changed,
    command_results: summarizeCommands(commands),
    check_results: summarizeCheckResults(checkResults),
    diff_summary: summarizeDiff(diff),
    assumptions: response.taskPatch?.assumptions || [],
    assistant_message: response.message,
    project_summary: projectSummary
  };

  const modelCritique = model?.critique
    ? await model.critique(context)
    : null;
  const critique = modelCritique?.ok
    ? normalizeModelCritique(modelCritique.structured || modelCritique.message)
    : localCritique(context, modelCritique?.message);

  const markdown = formatCritiqueMarkdown(critique);
  await writeFile(path.join(activeTask.dir, "review.md"), markdown);
  return critique;
}

function localCritique(context, modelNote) {
  const findings = [];
  const request = context.task.user_request || "";
  const taskType = context.task.task_type || "change";
  const changed = context.changed_files;
  const commands = context.command_results;
  const failedChecks = (context.check_results || []).filter((check) => check.status === "failed");

  if (["build", "change", "fix", "refactor", "test"].includes(taskType) && changed.length === 0) {
    findings.push({
      severity: "warning",
      text: "No files changed for a task type that usually requires an implementation change."
    });
  }

  const failed = commands.filter((command) => command.status === "failed");
  if (failed.length) {
    findings.push({
      severity: "error",
      text: `One or more verification commands failed: ${failed.map((command) => command.command).join(", ")}.`
    });
  }

  for (const check of failedChecks) {
    const relevant = check.likely_relevant_files?.length
      ? ` Likely relevant files: ${check.likely_relevant_files.join(", ")}.`
      : "";
    findings.push({
      severity: "error",
      text: `${check.check_type} failed: ${check.summary}${relevant}`
    });
  }

  const skippedOrBlocked = commands.filter((command) => command.status === "skipped");
  if (skippedOrBlocked.length) {
    findings.push({
      severity: "warning",
      text: `Some requested commands were skipped or blocked: ${skippedOrBlocked.map((command) => command.command).join(", ")}.`
    });
  }

  if (context.assumptions.length) {
    findings.push({
      severity: "info",
      text: `Unverified assumptions remain: ${context.assumptions.join("; ")}.`
    });
  }

  if (!context.diff_summary.available) {
    findings.push({
      severity: "warning",
      text: `Diff summary is unavailable: ${context.diff_summary.message || "unknown reason"}.`
    });
  }

  if (request && /\b(secret|env|deploy|push|payment|production)\b/i.test(request)) {
    findings.push({
      severity: "warning",
      text: "The request mentions a sensitive boundary; confirm approvals and logs before accepting the task."
    });
  }

  if (modelNote) {
    findings.push({
      severity: "info",
      text: modelNote
    });
  }

  return {
    source: "local",
    status: findings.some((finding) => finding.severity === "error") ? "needs_attention" : "reviewed",
    findings,
    questions: [],
    summary: findings.length
      ? "Local critique found items to review before accepting the task."
      : "Local critique found no obvious issues."
  };
}

function normalizeModelCritique(message) {
  if (message && typeof message === "object") {
    return {
      source: "model",
      status: message.status || "reviewed",
      findings: Array.isArray(message.findings) ? message.findings : [],
      questions: Array.isArray(message.questions) ? message.questions : [],
      summary: message.summary || "Model critique completed."
    };
  }
  return {
    source: "model",
    status: "reviewed",
    findings: [],
    questions: [],
    summary: message || "Model critique completed."
  };
}

function formatCritiqueMarkdown(critique) {
  const lines = [
    "# Review",
    "",
    `Source: ${critique.source}`,
    `Status: ${critique.status}`,
    "",
    critique.summary,
    ""
  ];

  if (critique.findings.length) {
    lines.push("## Findings", "");
    for (const finding of critique.findings) {
      lines.push(`- ${finding.severity}: ${finding.text}`);
    }
    lines.push("");
  }

  if (critique.questions.length) {
    lines.push("## Open Questions", "");
    for (const question of critique.questions) {
      lines.push(`- ${question}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function summarizeCommands(commands) {
  return commands.map((command) => ({
    command: command.command,
    purpose: command.purpose,
    status: command.status,
    exit_code: command.exit_code,
    message: command.message
  }));
}

function summarizeCheckResults(checkResults) {
  return checkResults.map((check) => ({
    id: check.id,
    command: check.command,
    check_type: check.check_type,
    status: check.status,
    exit_code: check.exit_code,
    summary: check.summary,
    failed_files: check.failed_files || [],
    failed_tests: check.failed_tests || [],
    errors: check.errors || [],
    likely_relevant_files: check.likely_relevant_files || []
  }));
}

function summarizeDiff(diff) {
  if (!diff?.ok) {
    return { available: false, message: diff?.message };
  }
  if (diff.source === "git") {
    return {
      available: true,
      source: "git",
      line_count: diff.diff ? diff.diff.split(/\r?\n/).filter(Boolean).length : 0
    };
  }
  return {
    available: true,
    source: "snapshots",
    files: diff.summary || []
  };
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
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
