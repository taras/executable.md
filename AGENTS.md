# Executable Markdown Agents

## Verification

After making any changes to source files (`src/`) or test files (`tests/`),
always run all four checks before committing:

1. **Lint + Format**: `deno task lint` (runs `oxlint` + `oxfmt --check`) — must
   produce 0 errors. Run `pnpm fmt` to auto-fix formatting.
2. **Typecheck**: `deno check core/mod.ts` — must produce no errors
3. **Tests**:
   `deno test --no-check --allow-all core/tests/ durable-streams/tests/` — all
   tests must pass with 0 failures
4. **JSR publishability**: `deno task check:jsr` — must end with
   `Success Dry run complete`. Public API symbols need explicit type
   annotations and no export may be a destructuring.

Do not commit if any check fails. Fix the issue first, then re-run all four.

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
8. Keep the release spec current — changes to the release configuration
   require changes to specs/release-process-spec.md to match.
9. Prefer stateless generators - use a function when calling a function that
   returns an operation; Do not do this function*(arg) { return yield* generator(arg) }
10. Structure source through names and modules. Do not use decorative
    section-divider comments. Enforced by the
    `local/no-section-divider-comments` Oxlint rule
    (`scripts/oxlint-plugin.js`), which autofixes with `oxlint --fix`.
11. Prefer expanding Executable.md capabilities over using JavaScript; Do not
    use JavaScript in MD without verifying with the user or planner agent.

## PR Process

1. Use .github/pull_request_template.md
2. After PR is open, monitor PR for
   1. CI failures
   2. Comments with feedback
   3. Integrate changes feedback appears

## Agent Roles

If you're an Opus model, you're an Implementor agent.
If you're a GPT model, you're an Planner agent.
If you're a Fabel model, you're a Problem solver agent.

### Implementor agent

Writes code following Code Rules.

### Planner agent

##### When reviewing Implementor agent's plans**

**User will ask you**: Review <subject>; verdict; prompt on failure.
**Respond by:**
* Interviewing user to resolve ambiguity; do not ask the Implementor agent to make decisions.
* Writing a feedback prompt that user will handoff to the Implementor agent
