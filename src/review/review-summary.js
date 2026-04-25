import { readFile } from "node:fs/promises";
import path from "node:path";

export async function buildReviewSummary({ activeTask, changed, checks, diff, critique, beliefs }) {
  const events = await readJsonLines(path.join(activeTask.dir, "events.jsonl"));
  const phases = await readJson(path.join(activeTask.dir, "phases.json"), {});
  const fileReasons = groupChangedFileReasons({ changed, diff, events });
  const blastRadius = summarizeBlastRadius({ changed, checks, critique });
  const snippets = await checkOutputSnippets({ activeTask, checks });
  const warnings = groupWarningsBySeverity({ checks, critique, beliefs });
  const timeline = summarizeTimeline({ events, phases });

  return {
    fileReasons,
    blastRadius,
    checkSnippets: snippets,
    warnings,
    timeline
  };
}

export function groupChangedFileReasons({ changed, diff, events }) {
  const changedSet = new Set(changed);
  const editEvents = events.filter((event) => event.type === "edit");
  const diffByPath = new Map((diff?.summary || []).map((entry) => [entry.path, entry]));

  return changed.map((file) => {
    const tools = editEvents
      .filter((event) => event.path === file || event.from === file || event.to === file)
      .map((event) => event.tool)
      .filter(Boolean);
    const reasons = [];
    if (tools.length) reasons.push(`edited via ${[...new Set(tools)].join(", ")}`);
    const entry = diffByPath.get(file);
    if (entry) reasons.push(`${entry.status}, ${entry.added + entry.removed + entry.changed} changed line(s)`);
    if (!reasons.length) reasons.push("tracked as changed by task");
    return {
      path: file,
      reasons,
      diff: entry || null
    };
  }).filter((entry) => changedSet.has(entry.path));
}

export function summarizeBlastRadius({ changed, checks, critique }) {
  const sourceFiles = changed.filter((file) => /^src\//.test(file));
  const testFiles = changed.filter((file) => /(^test\/|\.test\.|\.spec\.)/.test(file));
  const configFiles = changed.filter((file) => /(^package(-lock)?\.json$|config|\.json$|\.toml$|\.yaml$|\.yml$)/i.test(file));
  const docsFiles = changed.filter((file) => /\.(md|txt)$/i.test(file));
  const failedChecks = checks.filter((check) => check.ok === false && !check.skipped);
  const skippedChecks = checks.filter((check) => check.skipped);
  const warningCount = (critique?.findings || []).filter((finding) => finding.severity === "warning" || finding.severity === "error").length;

  const labels = [];
  if (sourceFiles.length) labels.push(`${sourceFiles.length} source file(s)`);
  if (testFiles.length) labels.push(`${testFiles.length} test file(s)`);
  if (configFiles.length) labels.push(`${configFiles.length} config/package file(s)`);
  if (docsFiles.length) labels.push(`${docsFiles.length} docs file(s)`);
  if (!labels.length) labels.push(changed.length ? `${changed.length} other file(s)` : "no changed files");

  const risk = failedChecks.length || warningCount ? "higher" : configFiles.length ? "medium" : changed.length > 5 ? "medium" : "low";
  const verification = failedChecks.length
    ? `failed checks: ${failedChecks.map((check) => check.name).join(", ")}`
    : skippedChecks.length
      ? `skipped checks: ${skippedChecks.map((check) => check.name).join(", ")}`
      : "checks passed or no failures recorded";

  return {
    risk,
    labels,
    verification
  };
}

export async function checkOutputSnippets({ activeTask, checks, maxSnippets = 3 }) {
  const snippets = [];
  for (const check of checks) {
    if (snippets.length >= maxSnippets) break;
    const parsed = check.parsed;
    if (!parsed || parsed.status === "passed") continue;
    const rawPath = parsed.raw_stderr_path || parsed.raw_stdout_path;
    if (!rawPath) continue;
    const raw = await readText(path.join(activeTask.dir, rawPath), "");
    const lines = raw.split(/\r?\n/).filter(Boolean).slice(0, 4);
    snippets.push({
      name: check.name,
      status: parsed.status,
      summary: parsed.summary || check.message,
      lines
    });
  }
  return snippets;
}

export function groupWarningsBySeverity({ checks, critique, beliefs }) {
  const grouped = { error: [], warning: [], info: [] };
  for (const check of checks) {
    if (check.ok === false && !check.skipped) grouped.error.push(`Failed ${check.name}: ${check.message || check.parsed?.summary || "check failed"}`);
    if (check.skipped) grouped.warning.push(`Skipped ${check.name}: ${check.message}`);
  }
  for (const finding of critique?.findings || []) {
    const severity = grouped[finding.severity] ? finding.severity : "info";
    grouped[severity].push(finding.text);
  }
  for (const risk of beliefs.risks || []) grouped.warning.push(risk.text);
  for (const assumption of beliefs.assumptions || []) grouped.info.push(`Assumption: ${assumption.text}`);

  return {
    error: [...new Set(grouped.error)],
    warning: [...new Set(grouped.warning)],
    info: [...new Set(grouped.info)]
  };
}

export function summarizeTimeline({ events, phases }) {
  const phaseEntries = Object.values(phases || {})
    .filter((phase) => phase.started_at || phase.completed_at)
    .map((phase) => ({
      label: `${phase.phase}: ${phase.state}`,
      at: phase.completed_at || phase.started_at
    }));
  const importantEvents = events
    .filter((event) => ["task_created", "project_summary", "task_plan", "assistant_response", "verify_started", "critique", "shadow_workspace_applied"].includes(event.type))
    .map((event) => ({
      label: event.type,
      at: event.timestamp
    }));
  return [...phaseEntries, ...importantEvents]
    .filter((item) => item.at)
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-10);
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

async function readText(filePath, fallback) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return fallback;
  }
}
