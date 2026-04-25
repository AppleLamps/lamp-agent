# Check-Output Golden Fixtures

These files are realistic samples of structured output from common test
runners and linters. The lamp-agent structured-reporter parsers
(`src/checks/structured-reporter.js`) read inputs in these shapes and
produce the same `parseCheckOutput`-compatible record that the rest of
the harness consumes.

## Sources

- **node-tap-passing.txt / node-tap-failing.txt** — captured directly
  from `node --test --test-reporter=tap` against the repo's existing
  `node-builtin-test-passing` and `node-builtin-test-failing` fixtures.
  Real Node 24 output. Header line currently reads `TAP version 13`
  even though the YAML diagnostic block uses TAP v14 conventions.
- **pytest-junit-failing.xml** — captured from
  `python -m pytest --junit-xml=…` against the repo's `pytest-failing`
  fixture. Real pytest 8 output.
- **vitest-failing.json** — hand-crafted from the documented
  `--reporter=json` schema. Two test files (one passing, one mixed)
  with one failed assertion that includes a stack frame in
  `failureMessages`.
- **jest-failing.json** — hand-crafted from `jest --json` schema.
  Single file with one passing and one failing assertion using Jest's
  `expect(received).toBe(expected)` failure message format.
- **eslint-failing.json / eslint-passing.json** — hand-crafted from
  `eslint --format=json` schema. Mix of error and warning severities
  plus a clean-file entry.

## Updating

Re-run the captures from the parent fixture directories:

```sh
cd test/fixtures/node-builtin-test-failing && \
  node --test --test-reporter=tap specs/main.mjs \
  > ../check-output/node-tap-failing.txt 2>&1

cd test/fixtures/node-builtin-test-passing && \
  node --test --test-reporter=tap specs/main.mjs \
  > ../check-output/node-tap-passing.txt 2>&1

cd test/fixtures/pytest-failing && \
  python -m pytest specs_pytest/check_calculator.py \
    --junit-xml=../check-output/pytest-junit-failing.xml \
    -p no:cacheprovider --rootdir=. > /dev/null 2>&1
```

Hand-crafted JSON fixtures (`vitest-*.json`, `jest-*.json`,
`eslint-*.json`) live as-is; update them by hand if the upstream tools'
schemas change.
