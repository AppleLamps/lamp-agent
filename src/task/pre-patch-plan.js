// Pre-patch planning.
//
// Before the harness begins the patch phase, we build a forecast of the
// task's likely scope, the danger zones in the project, and any
// warnings that should be surfaced to the user before any byte is
// written. The plan is persisted as `pre-patch-plan.json` under the
// task directory and is available to the model in the patch phase.
//
// The plan is a forecast, not a precise blast radius: the actual
// changed files are not known until the model patches. The blast
// radius computed at review time (`src/review/review-summary.js`) is
// the post-fact view; this module is the pre-fact view.

import { listSymbolImpact } from "../code/code-index.js";

const SECRET_PATH_RE = /(^|[/\\])(\.env(\..*)?|id_rsa|id_ed25519|\.npmrc|\.pypirc|credentials|secrets?)([/\\]|$)/i;
const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "go.sum",
  "Gemfile.lock",
  "composer.lock"
]);
const MANIFEST_NAMES = new Set([
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "setup.cfg",
  "Cargo.toml",
  "go.mod",
  "Gemfile",
  "composer.json"
]);

const DEFAULT_LIMITS = { candidates: 20, warnings: 12 };

/**
 * Build the pre-patch plan for the given task context.
 *
 * @param {object} args
 * @param {string} args.userRequest         - The plain-English request.
 * @param {object} args.projectSummary      - Output of `summarizeProject`.
 * @param {string[]} args.riskyBoundaries   - From `identifyRiskyBoundaries`.
 * @param {object} [args.projectMemory]     - Optional persisted memory.
 * @param {object} [args.codeIndex]         - Optional code intel index.
 * @param {object} [args.limits]            - Override candidate/warning caps.
 * @returns {object} Plan with `expected_scope`, `danger_zones`, `warnings`.
 */
export function buildPrePatchPlan({
  userRequest,
  projectSummary = {},
  riskyBoundaries = [],
  projectMemory = null,
  codeIndex = null,
  limits = DEFAULT_LIMITS
} = {}) {
  const allFiles = listAllFiles(projectSummary, codeIndex);
  const dangerZones = buildDangerZones({ allFiles, projectMemory });
  // Scan the *user request only* for danger-zone hints. The
  // upstream `riskyBoundaries` list is computed against
  // `userRequest + JSON.stringify(projectSummary)`, so it false-positives
  // when the project summary happens to mention strings like
  // `package.json`. Auto-adding manifest/secret files into candidates
  // off that signal would force a blocking warning on every task in a
  // Node project, which is too noisy.
  const requestSignals = scanUserRequestSignals(userRequest);
  const renameImpact = buildRenameImpact({ userRequest, codeIndex });
  const renameAffectedFiles = renameImpact.flatMap((entry) =>
    [...entry.defining_files, ...entry.caller_files]
  );
  const candidates = unique([
    ...keywordCandidates(userRequest, allFiles),
    ...notableCandidates(projectSummary),
    ...renameAffectedFiles,
    ...(requestSignals.secret ? dangerZones.secret_paths : []),
    ...(requestSignals.dependency
      ? [...dangerZones.dependency_manifests, ...dangerZones.lockfiles]
      : [])
  ]).slice(0, limits.candidates);
  const predictedChecks = predictChecks(projectSummary, projectMemory);
  const taskType = inferTaskType(userRequest);
  const warnings = buildWarnings({
    userRequest,
    riskyBoundaries,
    dangerZones,
    candidates,
    projectMemory,
    taskType,
    renameImpact
  }).slice(0, limits.warnings);

  return {
    user_request: userRequest,
    task_type: taskType,
    expected_scope: {
      candidate_files: candidates,
      risk_labels: [...riskyBoundaries],
      predicted_checks: predictedChecks,
      rename_impact: renameImpact
    },
    danger_zones: dangerZones,
    warnings,
    created_at: new Date().toISOString()
  };
}

const RENAME_STOPWORDS = new Set([
  "rename", "the", "to", "and", "but", "from", "into", "with",
  "for", "function", "method", "class", "variable", "var", "let",
  "const", "this", "that", "these", "those", "all", "any", "every",
  "please", "want", "need", "should", "would", "must", "make",
  "fix", "name", "names", "called", "everywhere", "across", "through",
  "throughout", "module", "exports", "exported", "import", "imports",
  "imported", "type", "interface", "alias", "old", "new", "current"
]);

function scanRenameIntent(userRequest) {
  const text = String(userRequest || "");
  if (!/\brename\b/i.test(text)) return [];
  const matches = text.match(/\b[A-Za-z_$][\w$]*\b/g) || [];
  const out = new Set();
  for (const m of matches) {
    if (m.length < 3) continue;
    if (RENAME_STOPWORDS.has(m.toLowerCase())) continue;
    out.add(m);
  }
  return [...out];
}

function buildRenameImpact({ userRequest, codeIndex }) {
  if (!codeIndex || !codeIndex.defsByName) return [];
  const candidates = scanRenameIntent(userRequest);
  if (!candidates.length) return [];
  const out = [];
  for (const candidate of candidates) {
    const impact = listSymbolImpact({ codeIndex, symbol: candidate });
    if (!impact) continue;
    out.push(impact);
  }
  return out;
}

function scanUserRequestSignals(userRequest) {
  const text = String(userRequest || "").toLowerCase();
  return {
    dependency: /\b(install|installs|installing|dependency|dependencies|package(?:s|\.json)?|npm\s+install|pnpm\s+add|yarn\s+add|bun\s+add|pip\s+install|cargo\s+add)\b/.test(text),
    // Two patterns OR'd together: a `\b`-bounded keyword set, plus a
    // dedicated check for `.env` (which can't sit inside the same `\b`
    // group because `\b` does not match between two non-word characters
    // like the space-then-dot in ` .env`).
    secret:
      /\b(secret|secrets|credential|credentials|token|tokens|password|passwords|api[-_]?key)\b/.test(text)
      || /(?:^|[^\w])\.env(?:[\W.]|$)/.test(text)
  };
}

function listAllFiles(projectSummary, codeIndex) {
  if (Array.isArray(codeIndex?.files)) return codeIndex.files;
  if (Array.isArray(projectSummary?.files)) return projectSummary.files;
  if (Array.isArray(projectSummary?.notableFiles)) return projectSummary.notableFiles;
  return [];
}

function keywordCandidates(userRequest, allFiles) {
  const tokens = extractTokens(userRequest);
  if (!tokens.length) return [];
  const hits = [];
  for (const file of allFiles) {
    const lower = file.toLowerCase();
    for (const token of tokens) {
      if (lower.includes(token)) {
        hits.push(file);
        break;
      }
    }
  }
  return hits;
}

function extractTokens(userRequest) {
  return String(userRequest || "")
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((token) => token.length >= 4 && !STOPWORDS.has(token))
    .slice(0, 8);
}

const STOPWORDS = new Set([
  "explain", "where", "what", "kind", "project", "this", "that", "with",
  "from", "into", "when", "what", "find", "show", "fix", "make", "have",
  "should", "would", "could", "build", "add", "test", "tests", "spec",
  "specs", "code", "file", "files", "function", "functions", "implementation",
  "currently", "exactly", "feature", "features", "thing", "things", "want",
  "going", "look", "looking", "needs", "need", "needed", "really", "thing"
]);

function notableCandidates(projectSummary) {
  const list = projectSummary?.notableFiles;
  if (!Array.isArray(list)) return [];
  return list.filter((file) => /\.[cm]?[jt]sx?$|\.py$|\.go$|\.rs$/.test(String(file || "")));
}

function buildDangerZones({ allFiles, projectMemory }) {
  const avoidTouching = Array.isArray(projectMemory?.avoid_touching) ? [...projectMemory.avoid_touching] : [];
  const secretPaths = [];
  const lockfiles = [];
  const dependencyManifests = [];
  for (const file of allFiles) {
    const norm = normalize(file);
    const base = baseName(norm);
    if (SECRET_PATH_RE.test(norm)) secretPaths.push(norm);
    if (LOCKFILE_NAMES.has(base)) lockfiles.push(norm);
    if (MANIFEST_NAMES.has(base)) dependencyManifests.push(norm);
  }
  return {
    avoid_touching: unique(avoidTouching),
    secret_paths: unique(secretPaths),
    lockfiles: unique(lockfiles),
    dependency_manifests: unique(dependencyManifests)
  };
}

function predictChecks(projectSummary, projectMemory) {
  const scripts = new Set([
    ...((projectSummary && Array.isArray(projectSummary.scripts)) ? projectSummary.scripts : []),
    ...(projectMemory?.scripts ? Object.keys(projectMemory.scripts) : [])
  ]);
  const ordered = ["test", "lint", "typecheck", "build"];
  return ordered.filter((name) => scripts.has(name));
}

function inferTaskType(userRequest) {
  const lower = String(userRequest || "").toLowerCase();
  if (/\b(why|explain|where|what kind|how does)\b/.test(lower)) return "explain";
  if (/\b(fix|bug|failing|broken|error)\b/.test(lower)) return "fix";
  if (/\b(refactor|cleanup|clean up)\b/.test(lower)) return "refactor";
  if (/\b(add|create|build|implement)\b/.test(lower)) return "build";
  return "change";
}

function buildWarnings({ userRequest, riskyBoundaries, dangerZones, candidates, projectMemory, taskType, renameImpact = [] }) {
  const warnings = [];
  const lower = String(userRequest || "").toLowerCase();
  const candidateSet = new Set((candidates || []).map(normalize));

  // Risky boundaries are *informational* at this stage — the harness
  // prompts before the actual operation runs. Emit them so reviewers
  // see the surface, but do not mark them as blocking.
  for (const tier of riskyBoundaries) {
    warnings.push({
      tier,
      severity: tier === "external_publish" || tier === "secret" ? "error" : "warning",
      message: riskyBoundaryMessage(tier)
    });
  }

  // Blocking warnings: the candidate file set genuinely crosses a
  // danger-zone path. These are the warnings the CLI prompts on.
  const lockfileCrosses = dangerZones.lockfiles.filter((file) => candidateSet.has(file));
  if (lockfileCrosses.length) {
    warnings.push({
      tier: "lockfile",
      severity: "warning",
      blocking: true,
      message: `Candidate files include a lockfile (${lockfileCrosses.join(", ")}).`
    });
  }

  const manifestCrosses = dangerZones.dependency_manifests.filter((file) => candidateSet.has(file));
  if (manifestCrosses.length) {
    warnings.push({
      tier: "dependency_manifest",
      severity: "warning",
      blocking: true,
      message: `Candidate files include a dependency manifest (${manifestCrosses.join(", ")}).`
    });
  }

  const secretCrosses = dangerZones.secret_paths.filter((file) => candidateSet.has(file));
  if (secretCrosses.length) {
    warnings.push({
      tier: "secret_file",
      severity: "error",
      blocking: true,
      message: `Candidate files include a secret-bearing path (${secretCrosses.join(", ")}).`
    });
  }

  const avoidTouchingHits = (candidates || []).filter((file) =>
    (projectMemory?.avoid_touching || []).some((entry) => fileMatches(entry, file))
  );
  if (avoidTouchingHits.length) {
    warnings.push({
      tier: "avoid_touching",
      severity: "warning",
      blocking: true,
      message: `Candidate files match avoid_touching entries: ${avoidTouchingHits.join(", ")}.`
    });
  }

  // Rename-impact: blocking when the symbol has cross-file callers, so
  // the user sees the ripple before the patch lands. Definition-only
  // matches (no callers) stay informational — renaming a private
  // helper is a normal local edit.
  for (const impact of renameImpact) {
    const totalFiles = impact.defining_files.length + impact.caller_files.length;
    const sample = [...impact.defining_files, ...impact.caller_files].slice(0, 5);
    if (impact.caller_files.length === 0) {
      warnings.push({
        tier: "rename_impact",
        severity: "info",
        symbol: impact.symbol,
        affected_files: [...impact.defining_files],
        message: `Renaming ${impact.symbol} affects 1 file (${impact.defining_files.join(", ")}); no cross-file callers.`
      });
      continue;
    }
    warnings.push({
      tier: "rename_impact",
      severity: "warning",
      blocking: true,
      symbol: impact.symbol,
      affected_files: [...impact.defining_files, ...impact.caller_files],
      message: `Renaming ${impact.symbol} will affect ${totalFiles} file(s): ${sample.join(", ")}${totalFiles > sample.length ? ", …" : ""}.`
    });
  }

  // Schema/migration heuristic: informational, not blocking.
  if (/\b(schema|migration|migrate|database|db)\b/.test(lower) && taskType !== "explain") {
    warnings.push({
      tier: "schema",
      severity: "warning",
      message: "The request mentions database / schema work; review migrations carefully before accepting."
    });
  }

  return warnings;
}

function riskyBoundaryMessage(tier) {
  switch (tier) {
    case "dependency_change":
      return "The task may change project dependencies; the harness will prompt before any install command runs.";
    case "network":
      return "The task may use the network; the harness will prompt before any network command runs.";
    case "secret":
      return "The task mentions secrets; secret-like file access will require approval.";
    case "delete":
      return "The task mentions deletions; destructive deletes will require approval.";
    case "external_publish":
      return "The task mentions publish/deploy/push; external publishing always requires approval.";
    default:
      return `Risky boundary: ${tier}.`;
  }
}

function fileMatches(pattern, file) {
  const normalizedPattern = normalize(pattern);
  const normalizedFile = normalize(file);
  if (!normalizedPattern || !normalizedFile) return false;
  if (normalizedPattern === normalizedFile) return true;
  if (normalizedFile.endsWith(`/${normalizedPattern}`)) return true;
  if (normalizedFile.startsWith(`${normalizedPattern}/`)) return true;
  return false;
}

function normalize(file) {
  return String(file || "").replaceAll("\\", "/").replace(/^\.\//, "");
}

function baseName(file) {
  const norm = normalize(file);
  const idx = norm.lastIndexOf("/");
  return idx === -1 ? norm : norm.slice(idx + 1);
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}
