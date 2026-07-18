# Executable Markdown Agents

## Verification

After making any changes to source files (`src/`) or test files (`tests/`),
always run all three checks before committing:

1. **Lint + Format**: `deno task lint` (runs `oxlint` + `oxfmt --check`) — must
   produce 0 errors. Run `pnpm fmt` to auto-fix formatting.
2. **Typecheck**: `deno check core/mod.ts` — must produce no errors
3. **Tests**:
   `deno test --no-check --allow-all core/tests/ durable-streams/tests/` — all
   tests must pass with 0 failures

Do not commit if any check fails. Fix the issue first, then re-run all three.

## MUST READ

- https://github.com/thefrontside/effection/blob/v4/AGENTS.md

## Code Rules

1. Use Effection `function*` generators with `yield*`; Do not use
   `Promises/async/await`
2. Use `@effectionx/fs`, do not use `node:fs` operations directly unless
   `@effectionx/fs` doesn't have appropriate package
3. To convert a promise into an operation use `until` instead of `call`
4. Only use comments to describe suprising behavior; Do not add code comments
   that explain what code does
5. Describe implemented behavior in the present tense; Don't use roadmap
   language in specifications or source code.
6. Parse to infer type; Do not type cast with `as`.
7. Do not use braceless `if` statements.

## PR Process

1. Use .github/pull_request_template.md
2. After PR is open, monitor PR for 
   1. CI failures
   2. Comments with feedback
   3. Integrate changes feedback appears