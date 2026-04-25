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
> /status
> /diff
> /details
> /files
> /undo
> /exit
```

The CLI renders a styled chat shell with:

- a compact banner and `agent >` prompt
- visible user turns
- progress lines while the harness works
- boxed assistant responses
- boxed review cards
- direct review actions: `accept`, `adjust <request>`, `undo`, and `see diff`
- selectable review and approval menus in interactive terminals

## Current Handoff Status

Core MVP and Phase 2 are implemented and tested. Phase 3 items 1
through 6 are in progress. Items 1–5 (e2e coverage, parsers,
pre-patch plan, streaming, multi-provider adapters) are described
below; item 6 (structured outputs beyond critique) lands plan and
edit-spec this round, with `plan.json` and `edit-spec.json`
persisted alongside the existing critique artifact when the model
supports JSON output. Latest verified baseline: `npm test` passes
with 184 tests; `npm run test:e2e` runs 13 end-to-end tests that
drive the CLI binary against four fixture repositories. Latest
pushed commit at this handoff: `a321bb0 Add OpenAI, local, and
Anthropic adapters (Phase 3 item 5)` on `main`.

Most recent completed work:

- Phase 3 roadmap drafted in `phase 3.txt`, organized into ten items grounded
  in the seven Phase 3 candidate areas left at the end of Phase 2.
- Phase 3 item 1:
  - End-to-end CLI driver and fixture-copy helpers under
    `test/e2e/helpers/`. Driver spawns `node ./src/index.js` with piped
    stdio, supports `expect()`/`sendLine()`/`exit()`/
    `respondToApproval()`, fails fast if the harness exits mid-expect,
    and strips `NODE_TEST_*` env vars so child `node --test` runs report
    real exit codes instead of attaching to the parent test runner.
  - Four checked-in fixtures under `test/fixtures/`: `non-git-plain`,
    `node-builtin-test-passing`, `node-builtin-test-failing`, and
    `pytest-failing`. Node-runner fixtures invoke their tests through
    explicit file paths (`specs/main.mjs`) so Node's auto-discovery does
    not load them as part of the parent suite; the pytest fixture
    configures `pyproject.toml` to recognise `check_*.py` so its specs
    aren't auto-discovered either.
  - Pluggable model adapter via `src/model/index.js`'s
    `createModelAdapter(config)` factory. When `LAMP_MODEL_ADAPTER` points
    at an ESM module exporting `createAdapter(config)`, that adapter is
    used; otherwise OpenRouter is returned. This is also the seam Phase 3
    item 5 (multi-provider adapters) will plug into.
  - Stub model adapter (`test/e2e/helpers/stub-adapter.js`) loaded by the
    spawned CLI; reads a JSON script from `LAMP_STUB_SCRIPT` and runs
    listed tool calls against the harness's `tools` object. The
    test-side helper (`stub-script.js`) writes the script to a tmp file.
  - 13 e2e tests in `test/e2e/cli.test.js`:
    - banner + clean `/exit`
    - full lifecycle on a Node fixture (asserts every phase, plan, memory,
      check-results, events, final-summary, checkpoint)
    - failing-verify path on a broken Node fixture
    - non-git workspace lifecycle
    - destructive command blocked by the permission engine
    - malformed unified diff rejected with no changes
    - stub-driven `create_file` completes with verify still passing
    - dependency-change approval triggered and denied
    - secret-file (`.env`) approval triggered and denied
    - external-publish (`git push`) approval triggered and denied
    - `model.respond` throwing → harness records a `model_error` event,
      surfaces a warning, and the lifecycle still reaches `final_review`
    - shadow apply-back conflict: real workspace edited during a
      shadow-mode task → `accept` is blocked and
      `apply-back-conflicts.json` is written with the affected files
    - pytest runner: stub invokes `run_test_file` against a failing
      Python spec; check-results.json records the failure (gated on
      `python -m pytest --version`)
  - `scripts/run-tests.mjs` enumerator that explicitly lists
    `*.test.{js,mjs,cjs}` files and skips `helpers/`/`fixtures/` so the
    fast and end-to-end suites both run cleanly under Node 24.
  - `npm test` (full suite) and `npm run test:e2e` (e2e only) scripts.
- Phase 3 item 2 progress:
  - `src/checks/structured-reporter.js` has parsers for TAP v13 (Node
    `--test`), Vitest JSON, Jest JSON, pytest JUnit XML, and ESLint
    JSON. Each returns the same shape as `parseCheckOutput`, returning
    `null` on non-matching input so callers can fall back to the regex
    parser.
  - The test-runner descriptors in
    `src/checks/test-runner-detector.js` now expose a
    `structuredReporter` object on Vitest, Jest, and Node `--test`,
    with the format name and reporter-flagged command builders.
  - `runCheckCommand` accepts a `structuredFormat` option and tries
    the structured parser first; it falls back to the regex parser
    when the structured form returns null. Records carry a
    `parsed_source` tag (`structured:<format>` or `regex`).
  - `runTestFile`, `runTestName`, and `runRelatedTests` automatically
    pick the structured-reporter command builder when the runner
    exposes one.
  - Six golden-output fixtures live under
    `test/fixtures/check-output/` (TAP captures from local Node and
    pytest plus hand-crafted Vitest/Jest/ESLint samples), and
    `test/structured-reporter.test.js` plus new wiring tests in
    `test/test-runner-detector.test.js` and
    `test/targeted-check-tools.test.js` lock the behavior in.
  - `src/checks/check-parser.js` now has collectors for all seven
    targeted build tools (esbuild, Vite/Rollup, webpack, Next.js,
    TypeScript pretty mode, Cargo, Go) producing the standard
    `errors[]` record with `{source, file, line, column, severity,
    code?, message}` plus tool-specific fields. Locked in by
    hand-crafted golden fixtures under
    `test/fixtures/check-output/build-errors/` and a per-tool test
    suite that also verifies parsers compose cleanly when multiple
    tools' output appears in the same run.
  - `src/checks/relevant-files.js` walks each failing test file's
    imports through the code index, resolves relative paths against
    the workspace file list (with common extensions and `index.<ext>`
    fallback), applies a co-location heuristic, and treats files
    inside `test/`/`tests/`/`__tests__/`/`spec/`/`specs/` as test
    files even without the `.test.`/`.spec.` suffix. `runCheckCommand`
    calls the mapper after parsing so every check record carries both
    a re-ranked `likely_relevant_files` (import-graph > co-located
    > stack) and a `likely_relevant_files_provenance` map.
  - `src/checks/failure-summary.js` reduces a parsed check record to
    a compact, model-friendly shape (status, errors[], failed_tests,
    expected/actual, parsed source, likely_relevant_files zipped with
    provenance, plus the invoking command). The repair loop calls
    this summariser before passing failures to `model.repair`, so the
    model sees structured evidence instead of the full audit record
    (with raw-output paths, IDs, timestamps, etc.).
  - Still TBD for item 2: pytest JUnit wiring (needs tmp-file
    capture) and ESLint structured wiring.
- Phase 3 item 3 progress:
  - `src/task/pre-patch-plan.js` builds an `expected_scope` (candidate
    files, risk labels, predicted checks), `danger_zones`
    (avoid_touching, secret paths, lockfiles, dependency manifests),
    and a `warnings` array. Warnings that the planner can prove cross
    a danger-zone path are tagged `blocking: true`.
  - The CLI's plan phase builds the plan, persists it as
    `pre-patch-plan.json` under the task directory, prints a
    `pre-patch warnings` card, and prompts the user before patch
    begins when any warning is blocking. A `/plan` shortcut prints
    the persisted plan; the phase controller now requires
    `pre_patch_plan` as a plan-phase output.
  - The runtime exposes `previewPatch(patch)` (a dry-run apply),
    surfaced as the `preview_patch` model tool so the model can
    validate a patch before committing it.
  - The CLI driver's `respondToApproval` now tracks an offset
    internally so consecutive prompts can be answered cleanly when
    two boundaries fire in sequence (pre-patch warning + actual
    operation).
- Phase 3 item 4 progress:
  - `streamOpenRouterChat` in `src/model/openrouter.js` handles the
    SSE stream: text deltas are forwarded through `onToken`,
    tool-call deltas are accumulated by index, and the helper
    returns the same `{ choices, usage }` shape as the non-streaming
    call so the rest of the `respond` loop is unchanged.
  - `respond` now accepts an `AbortSignal`; the CLI creates a
    per-task `AbortController` and `cancel task` aborts it.
    `AbortError` is detected and bypasses the retry loop. Aborted
    requests resolve as `{ cancelled: true, ... }` with a
    `model_aborted` event recorded so the rest of the lifecycle can
    finish cleanly.
  - The streaming path passes `stream_options.include_usage` so
    OpenRouter still returns token / cost data in the final SSE
    chunk; `model-usage.jsonl` tags the entry with `streaming: true`.
  - The CLI prints tokens to stdout as they arrive with a one-line
    "Streaming model response" progress indicator on the first token.
- Phase 3 item 5 progress (multi-provider adapters):
  - `src/model/openai.js` — OpenAI Chat Completions adapter (also
    works against Azure OpenAI by overriding `endpoint`).
  - `src/model/local.js` — OpenAI-compatible local-server adapter
    (Ollama, LM Studio, vLLM, llama.cpp `--api-server`). Requires
    `endpoint` or `baseUrl` to be set.
  - `src/model/anthropic.js` — direct Anthropic Messages API
    adapter (no SDK dependency). Translates the harness's
    `TOOL_DEFINITIONS` into Anthropic `input_schema`, supports
    tool-calling chat plus text-only streaming via `streamText`,
    and structured-JSON critique.
  - `createModelAdapter` in `src/model/index.js` now dispatches by
    `modelConfig.provider` (`openrouter` | `openai` | `anthropic`
    | `local`); defaults to OpenRouter for backward compat. The
    existing `LAMP_MODEL_ADAPTER` test-stub override still wins.
  - Per-provider env var defaults: `OPENROUTER_API_KEY`,
    `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `LAMP_LOCAL_API_KEY`.
- Phase 3 item 6 progress (structured outputs beyond critique):
  - `src/model/structured-output.js` defines `PLAN_SCHEMA`,
    `EDIT_SPEC_SCHEMA`, and `REPAIR_FINDINGS_SCHEMA` plus a small
    JSON-Schema-shaped validator and a system-prompt formatter.
  - Each adapter (OpenAI-compatible and Anthropic) gained a
    `respondJson({ system, user })` method that returns
    `{ ok, structured?, raw }`.
  - `src/task/structured-plan.js` and `src/task/edit-spec.js`
    orchestrate the requests, validate, and persist `plan.json`
    and `edit-spec.json` under the task directory. Failures fall
    back silently (the heuristic plan and the existing patch flow
    are unchanged).
  - The CLI invokes both during the plan and patch phases when
    `model.allowNetwork` is enabled.
- Two bug fixes surfaced by the new e2e coverage:
  - the permission engine's destructive-command regex used a trailing
    `\b` that failed at end-of-string and let `rm -rf /` and
    `chmod -R 777 /` slip through (fixed in
    `src/permissions/permission-engine.js`, locked in by new unit tests).
  - `src/index.js` didn't catch errors from `model.respond`, so an
    adapter throwing (provider 5xx, transient blip) tore down the task
    by leaving the process hanging via readline. Fixed by wrapping the
    call in a try/catch that logs a `model_error` event, warns the
    user, and synthesises a fallback assistant response so the
    lifecycle continues.

Where we left off:

- Phase 2 roadmap items are complete; there are no remaining Phase 2
  implementation tasks.
- Phase 3 roadmap exists in `phase 3.txt`. Item 1 is largely done; items
  2–10 are not started.
- `.agent/` is runtime state and is intentionally gitignored. Project memory
  and task artifacts can be regenerated by the harness.

Next recommended work:

1. Item 7 (resumable tasks and cancel-in-flight). `cancel task` is
   already wired (item 4); the next pieces are `/resume <task-id>`,
   graceful Ctrl-C handling that captures partial state, the
   alternate-approach re-entry from approval prompts, and a
   `/tasks` listing.
2. Item 6 leftovers: wire `repair_findings` so each repair attempt
   produces a structured diagnosis the review surface can render.
3. Item 5 leftovers: Anthropic prompt caching, Anthropic streaming
   inside `respond`/`repair`, and a live-network smoke test gated
   on per-provider env vars.
4. Item 4 leftovers: a streaming-aware `ui.assistant` variant and
   streaming the repair loop's model calls.
5. Item 3 leftovers: a "preview" review action and richer
   pre-patch impact analysis.
6. Item 2 stragglers (pytest JUnit wiring, ESLint structured wiring).

Phase 3 roadmap items (see `phase 3.txt` for full detail):

1. Real-repo fixtures and end-to-end CLI coverage.
2. Stronger targeted checks and parsers (framework-specific failure parsing,
   build parser depth, failed-test-to-source mapping).
3. Pre-patch blast radius and edit preview.
4. Streaming wired into the CLI.
5. Multi-provider model adapters (Anthropic, OpenAI, local, plus the
   existing OpenRouter adapter).
6. Structured outputs beyond critique (plan, edit-spec, repair findings).
7. Resumable tasks and cancel-in-flight.
8. Dependency-aware edits and cross-file binding.
9. Real language-server integration, TypeScript first.
10. GitHub/CI integration (PR creation, check status, CI log repair).

Useful commands for the next session:

```sh
npm test
npm start
```

## Current Scope

Implemented:

- CLI chat loop
- `.agent/` task directories and task JSON
- event logging
- structured `check-results.json` with raw check output files under each task
- bounded verify-and-repair loop with `verification.json`
- project file listing and search runtime
- path and command permission classification
- local package script detection
- check runner for `test`, `lint`, `typecheck`, and `build`
- tracked file snapshots for undo
- task-start checkpoint metadata in `.agent/checkpoints`
- snapshot-based diff summaries for non-git workspaces
- unified-diff `apply_patch` tool
- `commands.jsonl` audit logging for command runs
- post-task critique pass with `review.md` output
- belief ledger updates for project facts, assumptions, decisions, and critique risks
- review card with changed files, diff summary, checks, warnings, and next actions
- dedicated `run_tests`, `run_lint`, `run_typecheck`, and `run_build` tools
- safer edit primitives: `create_file`, `delete_file`, `rename_file`, `replace_range`, `replace_exact`, `insert_before`, `insert_after`
- code intelligence: `find_symbols`, `find_definition`, `find_references`, `find_imports`, `find_exports`, `route_map`
- project memory: `.agent/memory/project.json`, stale-source refresh, and model-context integration
- explicit phase controller: per-task `phases.json`, phase events, artifact gates, and phase-scoped model tools
- opt-in shadow workspace foundation using git worktree or a filtered temporary copy
- shadow workspace apply-back on accept for tracked changed files
- shadow apply-back conflict detection when real files changed during a task
- shadow apply-back conflict resolution with keep/apply/save choices and `.agent/conflicts` artifacts
- better approval/review actions with richer menus, typed fallbacks, technical details, changed-file lists, and task cancellation
- styled CLI shell with boxed assistant responses, review cards, `/diff`, review actions, and interactive menus
- OpenRouter tool-calling loop with network disabled by default
- model adapter contract, capability flags, transient retry, fallback models, structured critique output, streaming text, and usage/cost artifacts
- better diff/review UX with changed-file reasons, blast radius, check snippets, severity-grouped warnings, and task timeline
- approval prompts for risky path and command boundaries
- local fallback response when model network calls are disabled

Known gaps:

- targeted check runner is still basic
- code intelligence is regex-based; no language-server depth (e.g. cross-file binding resolution)
- Phase 2 roadmap is complete; future work should be planned as Phase 3

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

- `src/index.js`: CLI loop and task orchestration.
- `src/tools/runtime.js`: permissioned file, patch, command, check, diff, and undo tools.
- `src/model/openrouter.js`: model adapter, tool loop, critique, and repair methods.
- `src/model/adapter-contract.js`: formal model adapter contract and capability defaults.
- `src/verify/repair-loop.js`: bounded verify-and-repair phase.
- `src/checks/check-parser.js`: structured parsing of check failures.
- `src/checks/test-runner-detector.js`: detect test runner and build targeted check commands.
- `src/code/code-index.js`: lightweight code intelligence index, references, and route detection.
- `src/workspace/shadow-workspace.js`: shadow workspace creation, apply-back, and conflict detection.
- `src/task/phase-controller.js`: explicit task phase state, gates, allowed tools, and artifacts.
- `src/memory/project-memory.js`: project memory creation, stale refresh, and model-context facts.
- `src/task/beliefs.js`: per-task belief ledger updates.
- `src/review/review.js`: final review card.
- `src/review/review-summary.js`: changed-file reasons, blast radius, check snippets, warnings, and timeline helpers.
- `src/review/critique.js`: local/model critique pass.
- `phase 2.txt`: completed Phase 2 roadmap, handoff status, and Phase 3 candidate list.
- `phase 3.txt`: Phase 3 roadmap, with ten items, recommended build order, and Definition of Done.
- `src/model/index.js`: pluggable model adapter factory (`createModelAdapter`); dispatches by `model.provider` (openrouter | openai | anthropic | local) and honors `LAMP_MODEL_ADAPTER` for test stubs.
- `src/model/openrouter.js`: OpenAI-compatible transport (the shared base for OpenRouter, OpenAI, and local providers).
- `src/model/openai.js` / `src/model/local.js` / `src/model/anthropic.js`: per-provider adapters.
- `src/checks/structured-reporter.js`: reporter-aware parsers (TAP, Vitest JSON, Jest JSON, pytest JUnit XML, ESLint JSON) that produce the same record shape as `parseCheckOutput` and return null on mismatched input.
- `src/task/pre-patch-plan.js`: pre-patch planner that produces expected scope, danger zones, and blocking warnings before the patch phase begins.
- `test/fixtures/check-output/`: golden-output fixtures for the structured-reporter parsers (real captures and hand-crafted samples).
- `scripts/run-tests.mjs`: explicit test-file enumerator used by `npm test` and `npm run test:e2e` (avoids Node 24 auto-discovery picking up helpers/fixtures).
- `test/e2e/cli.test.js`: end-to-end CLI tests driving the binary against fixture repos.
- `test/e2e/helpers/`: e2e CLI driver, fixture-copy helper, stub model adapter, and stub-script helper.
- `test/fixtures/`: checked-in fixture repos used by the e2e suite (see `test/fixtures/README.md`).
