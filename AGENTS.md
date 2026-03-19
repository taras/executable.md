# Executable Markdown Agents

## Verification

After making any changes to source files (`src/`) or test files (`tests/`), always run all three checks before committing:

1. **Lint + Format**: `deno task lint` (runs `oxlint` + `oxfmt --check`) — must produce 0 errors. Run `pnpm fmt` to auto-fix formatting.
2. **Typecheck**: `deno check core/mod.ts` — must produce no errors
3. **Tests**: `deno test --no-check --allow-all core/tests/ durable-streams/tests/ durable-effects/tests/` — all tests must pass with 0 failures

Do not commit if any check fails. Fix the issue first, then re-run all three.
