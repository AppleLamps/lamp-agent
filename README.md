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

Core MVP is implemented and tested. Phase 2 has started.

Most recent completed work:

- apply-back conflict resolution in `src/workspace/shadow-workspace.js`:
  - shadow apply-back still blocks automatically if real workspace files changed
  - conflicts include real and shadow summaries with metadata and previews
  - each conflicted file can keep the real version, apply the shadow version, or save
    the shadow version under `.agent/conflicts`
  - clean changed files are applied while conflicted files follow explicit choices
  - resolution artifacts are written to `apply-back-resolution.json` and `apply-back.json`
  - interactive accept flow offers per-file conflict choices

Next recommended work:

1. Better approval and review actions

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
- styled CLI shell with boxed assistant responses, review cards, `/diff`, review actions, and interactive menus
- OpenRouter tool-calling loop with network disabled by default
- approval prompts for risky path and command boundaries
- local fallback response when model network calls are disabled

Known gaps:

- targeted check runner is still basic
- code intelligence is regex-based; no language-server depth (e.g. cross-file binding resolution)
- approval/review actions still need `Choose another approach`, `Cancel task`, technical details, and changed-file list shortcuts
- diff/review UX is still basic for nontechnical summaries and blast-radius detail

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
- `src/verify/repair-loop.js`: bounded verify-and-repair phase.
- `src/checks/check-parser.js`: structured parsing of check failures.
- `src/checks/test-runner-detector.js`: detect test runner and build targeted check commands.
- `src/code/code-index.js`: lightweight code intelligence index, references, and route detection.
- `src/workspace/shadow-workspace.js`: shadow workspace creation, apply-back, and conflict detection.
- `src/task/beliefs.js`: per-task belief ledger updates.
- `src/review/review.js`: final review card.
- `src/review/critique.js`: local/model critique pass.
- `phase 2.txt`: next capability roadmap and current Phase 2 status.
