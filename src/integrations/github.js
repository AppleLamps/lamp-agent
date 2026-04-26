// Thin wrapper around the `gh` CLI. The functions here build shell
// commands and route them through the caller-supplied `runCommand`
// (the harness's permission-aware command runner) so every gh
// invocation goes through the same approval engine as any other
// external command.
//
// Each helper returns a small structured record:
//   { ok: boolean, message?: string, ...data }
//
// `runCommand` is expected to behave like the runtime's tool — it
// returns `{ ok, code, stdout, stderr, denied?, decision? }`. When a
// caller denies the approval, we propagate the denial verbatim.

/**
 * Returns whether `gh` is installed and reachable on PATH.
 *
 * @param {object} args
 * @param {function} args.runCommand
 * @returns {Promise<{ok, available, version?, message?}>}
 */
export async function detectGh({ runCommand }) {
  if (typeof runCommand !== "function") return { ok: false, available: false, message: "runCommand not provided." };
  const result = await runCommand("gh --version", "Detect gh CLI");
  if (!result?.ok) {
    return {
      ok: false,
      available: false,
      message: result?.denied ? "gh detection denied." : (result?.message || "gh CLI not detected."),
      stderr: result?.stderr || ""
    };
  }
  const firstLine = String(result.stdout || "").split(/\r?\n/)[0] || "";
  const versionMatch = firstLine.match(/gh\s+version\s+(\S+)/i);
  return { ok: true, available: true, version: versionMatch?.[1] || null };
}

/**
 * Create a branch from the current HEAD using `git checkout -b`.
 *
 * @param {object} args
 * @param {function} args.runCommand
 * @param {string}   args.name        Branch name (e.g. `lamp/fix-login-test`)
 * @returns {Promise<{ok, name?, sha?, message?}>}
 */
export async function branchCreate({ runCommand, name }) {
  if (!isValidBranchName(name)) {
    return { ok: false, message: `Invalid branch name: ${JSON.stringify(name)}` };
  }
  const escaped = quoteShell(name);
  const create = await runCommand(`git checkout -b ${escaped}`, `Create branch ${name}`);
  if (!create?.ok) {
    return {
      ok: false,
      name,
      message: create?.denied
        ? "Branch creation denied at approval time."
        : (create?.stderr || create?.message || `git checkout -b failed (${create?.code ?? "?"})`)
    };
  }
  const headRev = await runCommand("git rev-parse HEAD", `Read HEAD after branching to ${name}`);
  return {
    ok: true,
    name,
    sha: headRev?.ok ? String(headRev.stdout || "").trim() : null
  };
}

/**
 * Open a PR with `gh pr create`. Title and body are passed through
 * `--title`/`--body` flags. Returns the PR URL and number when
 * present in the output.
 *
 * @param {object} args
 * @param {function} args.runCommand
 * @param {string}   args.title
 * @param {string}   args.body
 * @param {string}   [args.base]  Optional base branch.
 * @returns {Promise<{ok, url?, number?, message?}>}
 */
export async function prCreate({ runCommand, title, body, base = null }) {
  if (!title || typeof title !== "string") {
    return { ok: false, message: "PR title is required." };
  }
  const args = ["gh", "pr", "create", "--title", quoteShell(title), "--body", quoteShell(body || "")];
  if (base) args.push("--base", quoteShell(base));
  const command = args.join(" ");
  const result = await runCommand(command, "Open pull request");
  if (!result?.ok) {
    return {
      ok: false,
      message: result?.denied
        ? "Pull-request creation denied at approval time."
        : (result?.stderr || result?.message || `gh pr create failed (${result?.code ?? "?"})`)
    };
  }
  const url = (String(result.stdout || "").match(/https?:\/\/\S+/) || [null])[0];
  const numberMatch = url?.match(/\/pull\/(\d+)/);
  return {
    ok: true,
    url,
    number: numberMatch ? Number(numberMatch[1]) : null
  };
}

/**
 * Fetch the check-status table for the active (or specified) PR.
 *
 * @param {object} args
 * @param {function} args.runCommand
 * @param {number|string} [args.number]
 * @returns {Promise<{ok, checks?, raw?, message?}>}
 */
export async function prStatus({ runCommand, number = null }) {
  const target = number ? ` ${quoteShell(String(number))}` : "";
  const command = `gh pr checks${target}`;
  const result = await runCommand(command, "Read PR checks");
  if (!result?.ok) {
    return {
      ok: false,
      message: result?.denied
        ? "PR-status read denied at approval time."
        : (result?.stderr || result?.message || `gh pr checks failed (${result?.code ?? "?"})`)
    };
  }
  return { ok: true, checks: parsePrChecks(result.stdout || ""), raw: result.stdout || "" };
}

/**
 * Stream a CI run's logs (or a specific job's logs).
 *
 * @param {object} args
 * @param {function} args.runCommand
 * @param {string|number} args.runId
 * @param {string} [args.job]
 * @returns {Promise<{ok, log?, message?}>}
 */
export async function ciLog({ runCommand, runId, job = null }) {
  if (!runId) return { ok: false, message: "runId is required." };
  const parts = ["gh", "run", "view", quoteShell(String(runId)), "--log"];
  if (job) parts.push("--job", quoteShell(String(job)));
  const command = parts.join(" ");
  const result = await runCommand(command, "Read CI log");
  if (!result?.ok) {
    return {
      ok: false,
      message: result?.denied
        ? "CI-log read denied at approval time."
        : (result?.stderr || result?.message || `gh run view failed (${result?.code ?? "?"})`)
    };
  }
  return { ok: true, log: String(result.stdout || "") };
}

function isValidBranchName(name) {
  if (typeof name !== "string" || !name) return false;
  if (name.length > 200) return false;
  // Forbid the obvious bad characters; align with git's refname rules
  // without re-implementing them in full.
  if (/[\s~^:?*\[\]\\]/.test(name)) return false;
  if (/\.\./.test(name)) return false;
  if (/^[\-/]/.test(name) || /\/$/.test(name)) return false;
  return true;
}

function quoteShell(value) {
  const str = String(value ?? "");
  if (!/[\s"'$`\\!*?<>|&;()#]/.test(str) && str.length > 0) return str;
  // Use double quotes and escape only the chars that are special inside
  // them. Hereby supports both bash-style and Windows cmd parsing for
  // the cases the harness runs.
  return `"${str.replace(/(["\\$`])/g, "\\$1")}"`;
}

function parsePrChecks(output) {
  const checks = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // gh pr checks emits TSV-like rows: <name> <status> <elapsed> <url>
    const cols = trimmed.split(/\t|\s{2,}/).filter(Boolean);
    if (cols.length < 2) continue;
    const [name, status, elapsed, url] = cols;
    checks.push({ name, status, elapsed: elapsed || null, url: url || null });
  }
  return checks;
}
