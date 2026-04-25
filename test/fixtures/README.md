# Test Fixtures

These directories are checked in as static fixtures used by the lamp-agent
end-to-end suite (`test/e2e/`). Each fixture is copied to a tmpdir per test
run by `test/e2e/helpers/copy-fixture.js`, so tests never mutate the
checked-in copy.

## Why fixture tests do not use `*.test.js` names

Node's built-in test runner (`node --test`) auto-discovers files matching
`**/*.test.{js,mjs,cjs}` and any `.cjs/.mjs/.js` files inside directories
named `test`, `tests`, or `__tests__`. If a fixture used those names, the
parent project's `npm test` would walk into the fixture and try to run its
tests as part of the lamp-agent suite.

To avoid this, fixtures invoke their tests through explicit file paths
(for example, `node --test specs/main.mjs`). The fixture's `package.json`
test script names the file directly; the parent project's auto-discovery
ignores `specs/main.mjs` because it neither matches the test-file pattern
nor sits in a magic directory.

## Fixtures

- **non-git-plain/**: a directory with no git history, no package.json, and
  no test runner. Exercises the snapshot-diff path and the
  no-package-manager fallback.
- **node-builtin-test-passing/**: a small Node project with a passing
  `node:test` suite invoked through `node --test specs/main.mjs`. Exercises
  the full triage → plan → patch → verify → critique → final_review
  pipeline against a real, passing test runner.
- **node-builtin-test-failing/**: a small Node project whose `node:test`
  suite is deliberately broken. Exercises the verify-and-repair loop's
  failure path, the structured `check-results.json` recording, and the
  critique phase's `needs_attention` status when a real test fails.
- **pytest-failing/**: a tiny Python project with a deliberately failing
  pytest spec. Exercises the harness's pytest detection
  (`detect_test_runner` recognises `pyproject.toml` with
  `[tool.pytest.ini_options]`) and the targeted runner path
  (`run_test_file` invoking `python -m pytest <file>`). The fixture's
  spec lives in `specs_pytest/check_calculator.py` (renamed from the
  more conventional `tests/test_*.py` so Node's parent test runner does
  not auto-discover Python files when walking the repo). The
  `pyproject.toml` configures pytest to recognise `check_*.py` as test
  files. The end-to-end test that uses this fixture is gated on
  `python -m pytest --version` being available; if not, the test is
  skipped with a clear message.
