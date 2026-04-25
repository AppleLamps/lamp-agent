# Build-Error Golden Fixtures

These files are hand-crafted samples of the human-readable error output
emitted by common JavaScript/TypeScript bundlers, framework compilers,
and native toolchains. The lamp-agent regex parser
(`src/checks/check-parser.js`) reads stdout/stderr in these shapes and
populates the standard `errors[]` and `failed_files[]` records.

## Files

- **esbuild.txt** — esbuild's `✘ [ERROR]` heading followed by an
  indented `path:line:col:` block.
- **vite.txt** — Vite/Rollup's `[plugin:vite:<plugin>]` heading
  followed by `path (line:col)` and a multi-line message.
- **webpack.txt** — Webpack 5's `ERROR in path:line:col` form, plus the
  `Module not found` form without explicit line/col.
- **nextjs.txt** — Next.js compile errors (`./path:line:col` followed
  by a `Type error:` / `Module not found:` line).
- **typescript-pretty.txt** — `tsc` (default pretty) output:
  `path:line:col - error TSxxxx: ...`.
- **cargo.txt** — Rust/Cargo errors with `error[Exxxx]: ...` followed
  by `--> path:line:col`.
- **go.txt** — Go compiler output with simple `path:line:col: ...`
  lines, possibly preceded by a `# package` heading.

These are realistic samples crafted from each tool's documented
format. Running each tool locally and capturing real output is the
preferred way to refresh them, but committing real outputs requires
installing the tool which is heavier than the parsers warrant.

## Conventions

- Each fixture should contain at least two errors so we exercise
  multi-match behavior.
- File paths use forward slashes; the parser normalises both.
- Line and column numbers are 1-indexed across all formats.
- The standard error record produced by `parseCheckOutput` carries
  `{ source, file, line, column, severity, code?, message }` plus
  tool-specific fields (`plugin` for Vite, `kind` for Next.js).
