# Plain-English AI Coding Harness

Local CLI prototype for a plain-English AI coding assistant with structured task state,
permission boundaries, reversible edits, and review summaries.

## Project Goal

This project is a plain-English coding harness around an AI model. The user should
be able to type product-level requests like "fix the failing login test" or
"add a profile page" without managing shell commands, git internals, approval
spam, or raw tool execution.

The harness is responsible for structure and safety:

- task state is persisted under `.agent/tasks`
- risky actions are classified by the permission engine
- edits are tracked with snapshots and undo support
- optional shadow workspaces isolate changes before accept
- checks, critique, review, and apply-back are logged as artifacts

## Run

```sh
npm start
```

or:

```sh
node ./src/index.js
```

Inside the CLI:

```txt
> What kind of project is this?
> /status              # workspace status + tracked task changes
> /diff                # active task diff summary
> /details             # task artifacts, checks, model usage, phases
> /files               # changed files for the active task
> /plan                # pre-patch plan recorded for the active task
> /tasks               # list recent tasks (status, last phase, resumable flag)
> /show <task-id>      # full per-task summary card
> /undo                # restore tracked files from snapshots
> /exit                # quit (Ctrl-C captures partial state and exits 130)
```

The CLI renders a styled chat shell with:

- a compact banner and `agent >` prompt
- visible user turns
- progress lines while the harness works
- streamed model tokens when the configured provider supports streaming
- boxed assistant responses
- boxed review cards
- direct review actions: `accept`, `adjust <request>`, `undo`, and `see diff`
- selectable review and approval menus in interactive terminals

## Current Handoff Status

Core MVP, Phase 2, and Phase 3 items 1–8 are complete. Item 10
(GitHub/CI integration) has its foundation in place — the gh
wrapper, four model tools (branch_create / pr_create / pr_status /
ci_log), permission classification (gh pr create as
external_publish; force-push blocked) all land — but the CI repair
flow that pipes pr_status failures through the existing parsers
into model.repair, and a one-click "open PR" review action, are
still open. Item 9 (real LSP integration, optional per the spec)
is not started.

Most recent change closed the remaining Phase 3 stragglers:
aliased re-export tracing, structured repair-findings on the
review card, a "preview pending changes" review action, pytest
JUnit / ESLint structured wiring, streaming-aware assistant token
rendering and streaming repair calls, Anthropic prompt caching,
the GitHub/CI integration foundation, and a skipped-by-default
live-network smoke harness.

Latest verified baseline: `npm test` passes with 261 tests
(257 passing, 4 skipped — 3 live-network smoke tests gated on
`LAMP_LIVE_NETWORK_SMOKE=1`, plus the existing pytest skip).
`npm run test:e2e` runs 15 end-to-end tests with 15 passing.

### Lifecycle shape

For routine tasks the lifecycle is intentionally lightweight: an
explain-style question (`why…`, `where…`, `what kind of…`,
`how does…`) takes the short path of triage → plan → patch → answer
and skips verify, critique, and the review card. Only tasks that
actually edit files run the full pipeline (verify-and-repair, model
critique, boxed review with `accept` / `adjust` / `undo` actions).
Tasks that touch a risky boundary (dependencies, network, secrets,
deletions, push/deploy) additionally request a structured plan and
edit-spec from the model and persist them as `plan.json` and
`edit-spec.json`.

### What landed in Phase 3 (per item)

- **Item 1 — Real-repo fixtures and e2e CLI coverage.** E2e driver
  and fixture-copy helpers under `test/e2e/helpers/`; four fixtures
  (`non-git-plain`, `node-builtin-test-passing`,
  `node-builtin-test-failing`, `pytest-failing`); 15 e2e tests
  covering banner+exit, full lifecycle, failing verify, non-git
  workspace, destructive-command block, malformed-patch reject,
  stub-driven file create, dependency / secret / push approval flows
  (all denied), `model.respond` throw → graceful fallback, shadow
  apply-back conflict, pytest runner, and `/tasks` + `/show`. Stub
  model adapter in `test/e2e/helpers/stub-adapter.js` swappable via
  `LAMP_MODEL_ADAPTER`. **Open**: Vitest / Express+typecheck /
  Next.js+build fixtures and a fake-fetch test for OpenRouter
  transient retry.
- **Item 2 — Stronger targeted checks and parsers.** Reporter-aware
  parsing for TAP, Vitest JSON, Jest JSON, pytest JUnit XML, and
  ESLint JSON in `src/checks/structured-reporter.js`; build-error
  parsers for esbuild, Vite/Rollup, webpack, Next.js, TypeScript
  pretty mode, Cargo, and Go in `src/checks/check-parser.js`.
  Failed-test → source mapping in `src/checks/relevant-files.js`
  (re-ranked `likely_relevant_files` plus a `_provenance` map).
  Repair loop hands `model.repair` a compact summary via
  `src/checks/failure-summary.js`. Pytest JUnit XML now writes via a
  tmp-file capture path (`pickRunnerCommand` generates the path,
  the runner emits with `--junit-xml=<path>`, `runCheckCommand`
  reads it back). ESLint JSON gets a dedicated
  `tools.runLintStructured` that bypasses the user's lint script
  and runs eslint directly with `--format=json`.
- **Item 3 — Pre-patch blast radius and edit preview.** The plan
  phase builds and persists `pre-patch-plan.json` (expected scope,
  danger zones, blocking warnings); the phase controller gates patch
  on it. `tools.previewPatch()` is a dry-run apply, surfaced as the
  `preview_patch` model tool. `/plan` and `/preview` CLI shortcuts
  are wired; "Preview pending changes" is a review-action choice
  that shows the unified diff (or per-file summary on non-git
  workspaces) before accept. Rename and signature-change impact
  analyses (covered in item 8) feed
  `expected_scope.rename_impact` / `signature_impact` and emit
  `rename_impact` / `signature_impact` warnings.
- **Item 4 — Streaming wired into the CLI.** SSE plumbing in
  `src/model/openrouter.js`'s `streamOpenRouterChat` handles text
  deltas + tool-call deltas by index. `respond` accepts an
  `AbortSignal`; the CLI runs a per-task `AbortController` and
  `cancel task` aborts the in-flight request (surfaces as
  `{ cancelled: true }` with a `model_aborted` event). Streamed-usage
  is recorded via `stream_options.include_usage`. The repair loop
  now streams too: `verifyAndRepair` accepts `onToken` and threads
  it through `model.repair`. Token rendering uses
  `ui.assistantStreamHeader` / `assistantStreamFooter` so streamed
  output flows directly to stdout without re-boxing per token.
- **Item 5 — Multi-provider model adapters.** `createModelAdapter`
  dispatches by `modelConfig.provider` to one of: `openrouter`
  (default), `openai` (`src/model/openai.js`), `local`
  (`src/model/local.js`, OpenAI-compatible local server), or
  `anthropic` (`src/model/anthropic.js`, direct Messages-API,
  no SDK dep). Per-provider env var defaults: `OPENROUTER_API_KEY`,
  `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `LAMP_LOCAL_API_KEY`.
  Anthropic prompt caching is opt-in via
  `model.promptCaching = true` — when enabled, the adapter sends
  `anthropic-beta: prompt-caching-2024-07-31` and marks the system
  prompt with `cache_control: { type: "ephemeral" }`. A
  skipped-by-default live-network smoke test
  (`test/live-network-smoke.test.js`) runs one tiny streamText
  round-trip per provider when `LAMP_LIVE_NETWORK_SMOKE=1` and the
  matching API key are set. **Open**: Anthropic streaming inside
  `respond`/`repair` (text + tool_use blocks together — non-trivial
  protocol).
- **Item 6 — Structured outputs beyond critique.**
  `src/model/structured-output.js` defines `PLAN_SCHEMA`,
  `EDIT_SPEC_SCHEMA`, `REPAIR_FINDINGS_SCHEMA` plus a small
  JSON-Schema-shaped validator. Each adapter exposes `respondJson({
  system, user })`. Plan and edit-spec fire on risky-boundary
  tasks and persist as `plan.json` / `edit-spec.json`.
  `requestRepairFindings` (in `src/task/repair-findings.js`) runs
  after the bounded repair loop when checks are still failing,
  validates against `REPAIR_FINDINGS_SCHEMA`, persists
  `repair-findings.json`, and the review card lifts the diagnosis,
  severity, blockers, and proposed-fix steps into the warnings and
  a dedicated "Repair diagnosis:" section.
- **Item 7 — Resumable tasks and cancel-in-flight.** Phase
  controller gained `markCancelled` / `markInterrupted`; `cancelTask`
  flips the in-progress phase before flipping the task status. SIGINT
  handler captures partial state on Ctrl-C and exits 130. New
  `/tasks` and `/show <task-id>` CLI commands. Approval denials with
  "another approach" record a `constraint`-typed belief. `/resume
  <task-id>` loads a recorded task, reuses completed/skipped phase
  state, and continues at the next incomplete phase using persisted
  task artifacts.
- **Item 8 — Dependency-aware edits and cross-file binding.** Shared
  `src/code/import-resolver.js` resolves relative ESM sources against
  the workspace file set with the standard
  `.ts/.tsx/.js/.jsx/.mjs/.cjs` extension list and a
  `<dir>/index.<ext>` fallback. `findSymbolCallers` /
  `findSymbolDependencies` in `src/code/code-index.js` walk the
  imports map: callers respect named, aliased
  (`import { foo as bar }`), default, and namespace imports, and only
  return files that import the symbol from one of its actual defining
  files. Reference scanning uses the local alias, not the exported
  name. Both functions are surfaced as `tools.findSymbolCallers` /
  `tools.findSymbolDependencies` and as the `symbol_callers` /
  `symbol_dependencies` model tools (triage and patch `allowedTools`
  updated). `src/checks/relevant-files.js` was migrated to call the
  shared resolver. The pre-patch plan now uses a sync
  `listSymbolImpact` helper to detect rename intent in the user
  request (`/\brename\b/`-anchored), enumerate the symbol's defining
  and caller files via the import graph, and surface a
  `rename_impact` warning in the plan — blocking when the symbol has
  cross-file callers, informational when only the definition is
  affected. Affected files are added to
  `expected_scope.candidate_files` so they participate in the same
  danger-zone crosses (lockfile / manifest / secret /
  avoid_touching) as keyword candidates. The resolver also handles
  tsconfig / jsconfig path aliases (`compilerOptions.paths` +
  `baseUrl`, comment- and trailing-comma-tolerant JSON parsing via
  `loadTsconfigAliases`), Python `from x.y import z` against the
  workspace (relative dot-prefixes, package `__init__.py`, `.py`
  modules), re-export traversal so `export { foo } from "./real"`,
  `export *`, and aliased `export { foo as bar } from "./real"`
  barrels are all transparent for caller tracing (the parser now
  preserves the original name on re-export entries; an
  `exposesSymbol` walk follows the chain through aliases), and a
  `.json` resource fallback so `require("./config")` resolves to a
  workspace `config.json` when no JS/TS sibling exists.
  `dependency_graph` and `component_map` are runtime + model
  tools. Signature-change impact records
  `expected_scope.signature_impact` and blocks before patch when
  the target symbol has cross-file callers. The repair loop passes
  `summarizeFailureForRepair` the runtime code index and attaches
  each failed test file's resolved internal imports as
  `import_graph` before calling `model.repair`.
- **Item 10 — GitHub/CI integration (foundation).**
  `src/integrations/github.js` exposes `detectGh`, `branchCreate`,
  `prCreate`, `prStatus`, `ciLog`. Each function builds a `gh` /
  `git` command and routes it through the runtime's
  permission-aware `runCommand`. New runtime methods mirror those
  helpers; new model tools (`branch_create`, `pr_create`,
  `pr_status`, `ci_log`) are wired in `openrouter.js` and added to
  `phase-controller.js` allowedTools. The permission engine now
  classifies `gh pr create` / `gh pr merge` as `external_publish`
  (always asks) and blocks force-push variants outright (`git push
  --force`, `-f`, `--force-with-lease`, `--mirror`). 11 unit tests
  in `test/github-integration.test.js` lock the command shapes and
  output parsing. **Open**: a one-click "open PR" review action,
  CI-repair flow that pipes `pr_status` failures through the
  existing parsers into `model.repair`, and an e2e fixture under
  `test/fixtures/github/` with a mocked `gh` shim.

### Bugs caught while building Phase 3

- The permission engine's destructive-command regex used a trailing
  `\b` that failed at end-of-string and let `rm -rf /` /
  `chmod -R 777 /` slip through. Fixed in
  `src/permissions/permission-engine.js`.
- `model.respond` errors used to tear down the task (readline kept the
  process alive after `main` rejected). Fixed by wrapping the call in
  a try/catch that logs a `model_error` event and synthesises a
  fallback assistant response so the lifecycle continues.

### Where we left off

- Phase 2 roadmap items are complete.
- Phase 3 items 1–8 are complete. Item 10 has its foundation
  (gh wrapper + four model tools + permissions) in place; the
  CI-repair flow and the one-click "open PR" review action are
  the remaining open pieces. Item 9 (LSP integration, optional
  per the spec) is not started.
- Most recent slice: **Phase 3 stragglers bundle** (commit
  `5d54686`). Closed in one push: aliased re-export tracing
  (parser preserves `original` on re-exports; new
  `exposesSymbol` walks barrels including
  `export { foo as bar }`), repair-findings persisted as
  `repair-findings.json` after a failed verify and surfaced on
  the review card via `requestRepairFindings`, a "Preview pending
  changes" review action and `/preview` slash command, pytest
  JUnit XML wired through tmp-file capture
  (`pickRunnerCommand` generates the path; `runCheckCommand`
  reads it back), `runLintStructured` runs eslint directly with
  `--format=json`, streaming-aware `ui.assistantStreamHeader` /
  `Footer` plus repair-loop streaming via `onToken` threaded
  through `verifyAndRepair` → `model.repair`, Anthropic prompt
  caching opt-in (`model.promptCaching` → beta header +
  `cache_control` on the system prompt), and a skipped-by-default
  `LAMP_LIVE_NETWORK_SMOKE=1` smoke test for the three remote
  providers.
- Same commit landed item-10 foundation:
  `src/integrations/github.js` wrappers, runtime methods
  (`detectGh`, `branchCreate`, `prCreate`, `prStatus`, `ciLog`),
  model tools (`branch_create`, `pr_create`, `pr_status`,
  `ci_log`), phase-controller allowedTools entries, and
  permission-engine updates classifying `gh pr create / merge` as
  `external_publish` and blocking force-push variants.
- `.agent/` is runtime state and is gitignored. Project memory and
  task artifacts can be regenerated by the harness.

### Next slice — close item 10 and (optionally) start item 9

The recommended next slice is **wiring item 10's CI-repair
flow**: when a `pr_status` shows failures, fetch each failed
job's `ci_log`, run the existing parsers from item 2 against
the log content (the same `parseCheckOutput` /
`parseStructuredOutput` flow used for local checks), and feed
the resulting structured failures into `model.repair`. Pair this
with a one-click "open PR" review action that runs
`branchCreate` → `git push` → `prCreate` behind a single
approval prompt. Add a `test/fixtures/github/` mocked `gh` shim
so the flow can be exercised without contacting GitHub.

After that:

1. Stragglers (lower priority):
   - Anthropic streaming inside `respond`/`repair` (text +
     tool_use blocks together — non-trivial protocol).
2. Item 9 (real LSP integration, TypeScript first) — explicitly
   optional in the Phase 3 spec; sized as its own future round.

Phase 3 full roadmap (10 items) lives in `phase 3.txt`.

Useful commands for the next session:

```sh
npm test
npm run test:e2e
npm start
```

## Current Scope

Implemented (Phase 1–2 baseline plus Phase 3 items 1–8 complete and item 10 foundation):

**Lifecycle and state**

- CLI chat loop with banner, prompt, progress lines, boxed assistant
  responses, review cards, and SIGINT-aware Ctrl-C handling.
- Per-task state under `.agent/tasks/<id>/`: `task.json`, `beliefs.json`,
  `phases.json`, `changed-files.json`, `events.jsonl`,
  `commands.jsonl`, `model-usage.jsonl`, `check-results.json`,
  `checks/*`, `snapshots/*`, `conflicts/*`, `verification.json`,
  `apply-back.json`, `apply-back-conflicts.json`, `review.md`,
  `final-summary.md`, `pre-patch-plan.json`, `plan.json`,
  `edit-spec.json`.
- Task-start checkpoint under `.agent/checkpoints`.
- Project memory at `.agent/memory/project.json` with stale-source
  refresh.
- Explicit phase controller (intake → triage → plan → patch → verify →
  critique → final_review) with phase-scoped allowed tools and
  artifact gates. `markCancelled` / `markInterrupted` capture
  partial state.

**Tools and editing**

- File listing, reading, search; tracked snapshots for undo.
- Edit primitives: `apply_patch`, `preview_patch` (dry-run),
  `write_file`, `create_file`, `delete_file`, `rename_file`,
  `replace_range`, `replace_exact`, `insert_before`, `insert_after`.
- Code intelligence (regex-based): `find_symbols`, `find_definition`,
  `find_references`, `find_imports`, `find_exports`, `route_map`,
  `symbol_callers`, `symbol_dependencies`, `dependency_graph`,
  `component_map`.
- Targeted test runners: `detect_test_runner`, `run_test_file`,
  `run_test_name`, `run_related_tests` with reporter-aware command
  builders for Vitest / Jest / Node `--test`.
- Broad checks: `run_tests`, `run_lint`, `run_typecheck`, `run_build`,
  `run_available_checks`.
- `git_status`, `git_diff`, `run_command` (classified, audit-logged).

**Permissions and review**

- Path and command permission classification with allow / ask /
  blocked tiers and explicit handling for dependency, network, secret,
  outside-workspace, push/deploy, and destructive forms.
- Pre-patch planner that builds an `expected_scope` + `danger_zones`
  + blocking warnings, and prompts before patch when the candidate
  set crosses a danger path.
- Bounded verify-and-repair loop (3 attempts) that prefers targeted
  runs when failed files are known. Failures handed to `model.repair`
  in a compact structured shape.
- Critique pass (model JSON when available, local fallback otherwise),
  then final review card with changed-file reasons, blast radius,
  check snippets, severity-grouped warnings, and task timeline.
- Approval prompts via interactive menu or typed fallback. Denials
  with "another approach" record a `constraint`-typed belief.

**Workspace isolation**

- Opt-in shadow workspace via git worktree or filtered temp copy.
- Shadow apply-back with hash-based conflict detection and per-file
  keep/apply/save resolution under `.agent/conflicts`.

**Model adapters**

- Pluggable adapter factory in `src/model/index.js` dispatched by
  `model.provider`: `openrouter` (default), `openai`, `anthropic`,
  `local`.
- OpenAI-compatible transport supports tool calling, JSON mode,
  streaming with tool-call delta reassembly, transient retry,
  fallback models, abortable requests, usage/cost recording.
- Anthropic adapter implements the Messages API directly (no SDK)
  with tool-call translation and text streaming.
- `respondJson({ system, user })` available on every adapter for
  structured outputs (plan, edit-spec, repair-findings schemas in
  `src/model/structured-output.js`).
- `LAMP_MODEL_ADAPTER` env var lets tests inject a stub adapter.

**Parsers and reporters**

- Reporter-aware structured parsers (TAP, Vitest JSON, Jest JSON,
  pytest JUnit XML, ESLint JSON) plus regex collectors for esbuild,
  Vite/Rollup, webpack, Next.js, TypeScript pretty mode, Cargo, Go,
  ESLint, and the test-runner formats. Failed-test → source mapping
  via the code index.

### Known gaps

- Code intelligence is still regex-based (no real language-server depth).
  Cross-file binding (item 8) resolves relative ESM imports against
  the workspace; tsconfig path aliases, CommonJS `require()`, and
  Python imports are not yet resolved.
- `/resume <task-id>` exists for artifact-backed task continuation.
  It does not yet restore a deleted temp shadow workspace after a
  process restart; shadow work should still be accepted or resolved
  before exiting when possible.
- Several Phase 3 items have explicit "Open" sub-bullets above; see
  also `phase 3.txt` for the full per-item picture.

## Shadow Workspace

Shadow workspaces are off by default. To create one at task start, edit
`.agent/config.json`:

```json
{
  "workspace": {
    "shadowMode": "on"
  }
}
```

When enabled, the harness tries to create a git worktree for git repositories.
For plain directories, it creates a filtered temporary copy that excludes `.git`,
`.agent`, `node_modules`, and common build output directories.

While shadow mode is enabled, task edits and checks run against the shadow
workspace. Choosing `Accept` after review copies tracked changed files back into
the real workspace, writes `apply-back.json` into the task directory, and removes
the shadow workspace. `Undo` before accepting restores the shadow copy only.
If the real workspace changed after the task started, apply-back is blocked and
the task writes `apply-back-conflicts.json` with the affected files.

## OpenRouter

Set `OPENROUTER_API_KEY` and edit `.agent/config.json`:

```json
{
  "model": {
    "allowNetwork": true
  }
}
```

Network model calls are disabled by default so the first run does not cross that
permission boundary unexpectedly.

When enabled, the model can call these harness tools:

- list files
- read files
- search files
- write tracked files
- apply unified diff patches
- run classified local commands
- run available checks
- inspect git status and diff

Risky operations are still classified by the harness. Dependency changes, network
commands, secret-like files, outside-workspace paths, pushes, and deploys prompt
before execution. Destructive command patterns are blocked.

## Important Files

**CLI and orchestration**

- `src/index.js` — CLI loop, slash commands, SIGINT handler, task
  lifecycle wiring.
- `src/tools/runtime.js` — permissioned tools (file ops, edit
  primitives, `apply_patch` / `previewPatch`, command running, checks,
  diff, undo, code-intel passthroughs).
- `src/permissions/permission-engine.js` — path / command tier
  classification.
- `src/ui/terminal.js`, `src/ui/interactive.js` — styled output and
  inquirer prompts.

**Task state**

- `src/task/task-manager.js` — task creation, status updates.
- `src/task/phase-controller.js` — phase ordering, required outputs,
  `markCancelled` / `markInterrupted`.
- `src/task/beliefs.js` — per-task belief ledger.
- `src/task/pre-patch-plan.js` — expected scope, danger zones,
  blocking warnings; persists `pre-patch-plan.json`.
- `src/task/structured-plan.js` / `src/task/edit-spec.js` —
  request structured plan / edit-spec from the model and persist
  `plan.json` / `edit-spec.json`.
- `src/memory/project-memory.js` — `.agent/memory/project.json`
  refresh and model-context facts.
- `src/workspace/shadow-workspace.js` — shadow worktree / temp-copy,
  apply-back, conflict detection and resolution.
- `src/workspace/checkpoint.js` — task-start checkpoint and
  snapshot-diff.

**Model adapters**

- `src/model/index.js` — `createModelAdapter` factory (dispatch by
  `model.provider`; honors `LAMP_MODEL_ADAPTER` for stub injection).
- `src/model/adapter-contract.js` — adapter contract surface and
  capability defaults.
- `src/model/openrouter.js` — OpenAI-compatible transport (shared
  base for OpenRouter / OpenAI / local). Includes
  `streamOpenRouterChat` and the canonical `TOOL_DEFINITIONS`.
- `src/model/openai.js`, `src/model/local.js`, `src/model/anthropic.js`
  — per-provider adapters.
- `src/model/structured-output.js` — schemas + JSON-Schema-shaped
  validator for plan / edit-spec / repair-findings outputs.

**Code intelligence**

- `src/code/code-index.js` — regex symbol index plus
  `findSymbolCallers` / `findSymbolDependencies` cross-file binding.
- `src/code/import-resolver.js` — shared relative-import resolver
  (workspace file set, JS/TS extensions, `index.<ext>` fallback).

**Checks, parsers, and review**

- `src/checks/check-parser.js` — regex collectors for TS, ESLint,
  test runners, esbuild, Vite/Rollup, webpack, Next.js, Cargo, Go.
- `src/checks/structured-reporter.js` — reporter-aware parsers (TAP,
  Vitest JSON, Jest JSON, pytest JUnit, ESLint JSON).
- `src/checks/test-runner-detector.js` — runner detection +
  reporter-flagged command builders.
- `src/checks/relevant-files.js` — failed-test → source mapping with
  provenance tags.
- `src/checks/failure-summary.js` — compact failure shape for
  `model.repair`.
- `src/verify/repair-loop.js` — bounded verify-and-repair.
- `src/review/review.js`, `src/review/review-summary.js`,
  `src/review/critique.js` — final review card and critique pass.

**Tests and fixtures**

- `test/e2e/cli.test.js` — 14 end-to-end CLI tests.
- `test/e2e/helpers/` — driver, fixture-copy helper, stub adapter,
  stub-script helper.
- `test/fixtures/` — fixture repos (see `test/fixtures/README.md`).
- `test/fixtures/check-output/` — golden parser inputs.
- `scripts/run-tests.mjs` — explicit test-file enumerator (skips
  helpers / fixtures so Node 24 auto-discovery can't pick them up).

**Roadmap docs**

- `phase 2.txt` — completed Phase 2 roadmap and handoff record.
- `phase 3.txt` — Phase 3 roadmap (10 items, recommended build
  order, Definition of Done) with current-status checklist.
