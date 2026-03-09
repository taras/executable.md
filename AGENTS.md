# Executable Markdown Agents

## Verification

After making any changes to source files (`src/`) or test files (`tests/`), always run all three checks before committing:

1. **Lint**: `npm run lint` — oxlint on `src/`, must produce 0 warnings and 0 errors
2. **Typecheck**: `npm run typecheck` — `tsc --noEmit`, must produce no errors
3. **Tests**: `npm test` — all tests must pass with 0 failures

Do not commit if any check fails. Fix the issue first, then re-run all three.
