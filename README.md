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

Core MVP and Phase 2 are implemented and tested. Phase 3 items 1–8
are in flight; items 9–10 are not started. The harness can drive a
real repository through the full lifecycle, swap providers, stream
responses, cancel mid-flight, persist structured plan / edit-spec
artifacts, and answer cross-file binding questions ("who imports
this symbol?", "which workspace files does this file depend on?")
through the regex import graph.

Most recent change is an alignment pass that trims phase-3 ceremony
back toward the Codex / Claude Code shape: the lifecycle is now
adaptive (explain-style requests skip verify / critique / review),
the structured plan and edit-spec only fire when the task crosses a
risky boundary, the pre-patch warnings card only prints on a
genuinely blocking finding, and the system prompt reads as "you're a
coding assistant; here are your tools" rather than "you operate
inside a permissioned harness".

Latest verified baseline: `npm test` passes with 205 unit tests
(1 skipped, 0 failing); `npm run test:e2e` runs 14 end-to-end tests
against four fixture repositories. Latest pushed commit:
`957efa5 Update handoff documentation` on `main`.

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
  `node-builtin-test-failing`, `pytest-failing`); 14 e2e tests
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
  Repair loop now hands `model.repair` a compact summary via
  `src/checks/failure-summary.js`. **Open**: pytest JUnit wiring
  (needs tmp-file capture) and ESLint structured wiring.
- **Item 3 — Pre-patch blast radius and edit preview.** The plan
  phase builds and persists `pre-patch-plan.json` (expected scope,
  danger zones, blocking warnings); the phase controller gates patch
  on it. `tools.previewPatch()` is a dry-run apply, surfaced as the
  `preview_patch` model tool. `/plan` CLI shortcut. **Open**:
  "preview" review action and rename / signature impact analysis.
- **Item 4 — Streaming wired into the CLI.** SSE plumbing in
  `src/model/openrouter.js`'s `streamOpenRouterChat` handles text
  deltas + tool-call deltas by index. `respond` accepts an
  `AbortSignal`; the CLI runs a per-task `AbortController` and
  `cancel task` aborts the in-flight request (surfaces as
  `{ cancelled: true }` with a `model_aborted` event). Streamed-usage
  is recorded via `stream_options.include_usage`. **Open**: a
  streaming-aware `ui.assistant` block, streaming the repair loop.
- **Item 5 — Multi-provider model adapters.** `createModelAdapter`
  dispatches by `modelConfig.provider` to one of: `openrouter`
  (default), `openai` (`src/model/openai.js`), `local`
  (`src/model/local.js`, OpenAI-compatible local server), or
  `anthropic` (`src/model/anthropic.js`, direct Messages-API,
  no SDK dep). Per-provider env var defaults: `OPENROUTER_API_KEY`,
  `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `LAMP_LOCAL_API_KEY`.
  **Open**: Anthropic prompt caching, Anthropic streaming inside
  `respond`/`repair`, live-network smoke tests.
- **Item 6 — Structured outputs beyond critique.**
  `src/model/structured-output.js` defines `PLAN_SCHEMA`,
  `EDIT_SPEC_SCHEMA`, `REPAIR_FINDINGS_SCHEMA` plus a small
  JSON-Schema-shaped validator. Each adapter exposes `respondJson({
  system, user })`. The CLI requests these only when the task crosses
  a risky boundary (`riskyBoundaries.length > 0`); on success they
  persist as `plan.json` / `edit-spec.json` under the task dir. No
  risk and no model round-trip. **Open**: wire `repair_findings`
  (schema is defined) into `verifyAndRepair` and the review surface.
- **Item 7 — Resumable tasks and cancel-in-flight.** Phase
  controller gained `markCancelled` / `markInterrupted`; `cancelTask`
  flips the in-progress phase before flipping the task status. SIGINT
  handler captures partial state on Ctrl-C and exits 130. New
  `/tasks` and `/show <task-id>` CLI commands. Approval denials with
  "another approach" record a `constraint`-typed belief.
  **Open**: `/resume <task-id>` itself — needs the main-loop body
  in `src/index.js` extracted into a `runTaskLifecycle({...})`
  function.
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
  shared resolver. Locked in by `test/import-resolver.test.js` (7
  tests) and `test/symbol-callers.test.js` (7 tests). **Open**:
  `dependency_graph` aggregator, `component_map` tool, pre-patch
  rename / signature impact analysis, repair-loop integration that
  hands the import graph of the failing test to `model.repair`,
  tsconfig-paths alias resolution, and Python `from x import y`
  resolution.

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
- Phase 3 items 1–8 in flight (see per-item status above and
  `phase 3.txt`); items 9–10 not started.
- `.agent/` is runtime state and is gitignored. Project memory and
  task artifacts can be regenerated by the harness.

### Next recommended work

1. Item 7 leftover — implement `/resume <task-id>`. Extract the
   main-loop task body in `src/index.js` into a
   `runTaskLifecycle({...})` function so a partially-completed task
   picks up at the next not-completed phase using artifacts already
   on disk.
2. Item 8 leftovers — pre-patch impact analysis on rename /
   signature changes, repair-loop integration that passes the
   import graph of the failing test into `model.repair`, the
   `dependency_graph` aggregator, the `component_map` tool,
   tsconfig-paths alias resolution, and Python resolution.
3. Stragglers (in priority order): repair-findings wiring (item 6);
   Anthropic caching + streaming + smoke tests (item 5);
   streaming-aware `ui.assistant` (item 4); preview review action +
   rename impact (item 3); pytest JUnit + ESLint structured wiring
   (item 2).

Phase 3 full roadmap (10 items) lives in `phase 3.txt`.

Useful commands for the next session:

```sh
npm test
npm run test:e2e
npm start
```

## Current Scope

Implemented (Phase 1–2 baseline plus Phase 3 items 1–8 in flight):

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
  `symbol_callers`, `symbol_dependencies`.
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
- `/resume <task-id>` is the missing piece of item 7 (the rest is
  done).
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
