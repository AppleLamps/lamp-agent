import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { summarizeBeliefs } from "../task/beliefs.js";
import { summarizeProjectMemory } from "../memory/project-memory.js";
import { buildReviewSummary } from "./review-summary.js";

export async function summarizeProject(tools, projectMemory = null) {
  const listed = await tools.listFiles(".");
  const files = listed.ok ? listed.files : [];
  const packageManager = await tools.detectPackageManager();
  const scripts = Object.keys(await tools.packageScripts());
  const testRunner = tools.detectTestRunner ? await tools.detectTestRunner().catch(() => null) : null;
  const gitStatus = await tools.gitStatus();
  const notableFiles = files.filter((file) => {
    const lower = file.toLowerCase();
    return lower === "package.json"
      || lower.endsWith("readme.md")
      || lower.includes("src/")
      || lower.includes("test")
      || lower.includes("config");
  }).slice(0, 20);

  return {
    fileCount: files.length,
    packageManager,
    scripts,
    testRunner: testRunner?.runner && testRunner.runner !== "unknown" ? testRunner.runner : null,
    notableFiles,
    git: gitStatus.summary,
    memory: projectMemory ? summarizeProjectMemory(projectMemory) : null
  };
}

export async function finalReview(activeTask, tools, response, critique = null) {
  const changed = await readJson(path.join(activeTask.dir, "changed-files.json"), []);
  const existingChecks = await readJson(path.join(activeTask.dir, "check-results.json"), null);
  const checks = existingChecks
    ? existingChecks.map((check) => ({
      name: check.check_type,
      ok: check.status === "passed",
      skipped: false,
      message: check.summary,
      parsed: check
    }))
    : await tools.runAvailableChecks(activeTask);
  const diff = await tools.taskDiff(activeTask);
  const beliefs = await summarizeBeliefs(activeTask);
  const summary = await buildReviewSummary({ activeTask, changed, checks, diff, critique, beliefs });
  const checkLines = checks.map((check) => {
    if (check.skipped) return `Skipped ${check.name}: ${check.message}`;
    return `${check.name}: ${check.ok ? "passed" : "failed"}`;
  });

  const lines = buildReviewCard({ changed, checks, checkLines, diff, critique, beliefs, summary });

  const review = lines.join("\n");
  await writeFile(path.join(activeTask.dir, "final-summary.md"), `${response.message}\n\n${review}\n`);
  return review;
}

function buildReviewCard({ changed, checks, checkLines, diff, critique, beliefs, summary }) {
  const warningLines = warningsFrom({ checks, critique, beliefs });
  return [
    "Done.",
    "",
    "Changed:",
    ...(changed.length ? changed.map((file) => `- ${file}`) : ["- No files changed"]),
    "",
    "Changed file reasons:",
    ...formatFileReasons(summary.fileReasons),
    "",
    "Blast radius:",
    `- Risk: ${summary.blastRadius.risk}`,
    `- Scope: ${summary.blastRadius.labels.join(", ")}`,
    `- Verification: ${summary.blastRadius.verification}`,
    "",
    "Diff:",
    `- ${formatDiffSummary(diff)}`,
    "",
    "Checks:",
    ...(checkLines.length ? checkLines.map((line) => `- ${line}`) : ["- No checks run"]),
    ...(summary.checkSnippets.length ? ["", "Check snippets:", ...formatCheckSnippets(summary.checkSnippets)] : []),
    "",
    "Review:",
    `- ${formatCritiqueSummary(critique)}`,
    `- ${beliefs.claims.length} claim${beliefs.claims.length === 1 ? "" : "s"} and ${beliefs.decisions.length} decision${beliefs.decisions.length === 1 ? "" : "s"} recorded in beliefs.json`,
    "",
    "Warnings:",
    ...(warningLines.length ? warningLines.map((line) => `- ${line}`) : ["- None"]),
    "",
    "Warnings by severity:",
    ...formatWarningsBySeverity(summary.warnings),
    "",
    "Timeline:",
    ...formatTimeline(summary.timeline),
    "",
    "Next actions:",
    "- accept",
    "- adjust",
    "- undo",
    "- see diff",
    "- see technical details",
    "- open changed file list",
    "- resolve conflicts",
    "- cancel task"
  ];
}

function formatFileReasons(fileReasons) {
  if (!fileReasons.length) return ["- No changed files"];
  return fileReasons.map((file) => `- ${file.path}: ${file.reasons.join("; ")}`);
}

function formatCheckSnippets(snippets) {
  return snippets.flatMap((snippet) => [
    `- ${snippet.name}: ${snippet.summary || snippet.status}`,
    ...snippet.lines.map((line) => `  ${line}`)
  ]);
}

function formatWarningsBySeverity(warnings) {
  const lines = [];
  for (const severity of ["error", "warning", "info"]) {
    const entries = warnings[severity] || [];
    lines.push(`- ${severity}: ${entries.length ? entries.join("; ") : "none"}`);
  }
  return lines;
}

function formatTimeline(timeline) {
  if (!timeline.length) return ["- No task timeline recorded"];
  return timeline.map((item) => `- ${item.at}: ${item.label}`);
}

function warningsFrom({ checks, critique, beliefs }) {
  const warnings = [];
  const failed = checks.filter((check) => check.ok === false && !check.skipped);
  const skipped = checks.filter((check) => check.skipped);
  if (failed.length) warnings.push(`Failed checks: ${failed.map((check) => check.name).join(", ")}`);
  if (skipped.length) warnings.push(`Skipped checks: ${skipped.map((check) => check.name).join(", ")}`);
  const critiqueFindings = critique?.findings || [];
  for (const finding of critiqueFindings) {
    if (finding.severity === "error" || finding.severity === "warning") {
      warnings.push(finding.text);
    }
  }
  for (const risk of beliefs.risks) warnings.push(risk.text);
  for (const assumption of beliefs.assumptions) warnings.push(`Assumption: ${assumption.text}`);
  return [...new Set(warnings)];
}

function formatCritiqueSummary(critique) {
  if (!critique) return "Critique: not run";
  const issueCount = critique.findings?.length || 0;
  return issueCount
    ? `Critique: ${critique.status}, ${issueCount} finding${issueCount === 1 ? "" : "s"}`
    : `Critique: ${critique.summary}`;
}

function formatDiffSummary(diff) {
  if (!diff?.ok) return diff?.message || "not available";
  if (diff.source === "git") {
    const lineCount = diff.diff ? diff.diff.split(/\r?\n/).filter(Boolean).length : 0;
    return `git diff available (${lineCount} non-empty line${lineCount === 1 ? "" : "s"})`;
  }
  if (!diff.summary?.length) return "no tracked file content changes";
  const parts = diff.summary.map((file) => {
    const count = file.added + file.removed + file.changed;
    return `${file.path} ${file.status}, ${count} changed line${count === 1 ? "" : "s"}`;
  });
  return parts.join("; ");
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}
