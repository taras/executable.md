# Executable Markdown Agents

## Verification

After making any changes to source files (`src/`) or test files (`tests/`),
always run all four checks before committing:

1. **Lint + Format**: `deno task lint` (runs `oxlint` + `oxfmt --check`) — must
   produce 0 errors. Run `pnpm fmt` to auto-fix formatting.
2. **Typecheck**: `deno check packages/core/mod.ts` — must produce no errors
3. **Tests**:
   `deno test --no-check --allow-all packages/core/tests/ packages/durable-streams/tests/` — all
   tests must pass with 0 failures
4. **JSR publishability**: `deno task check:jsr` — must end with
   `Success Dry run complete`

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

## Writing Guide

1. Write for the reader's understanding, not as a transcript of the reasoning
   that produced the design. Preserve conclusions, contracts, and consequential
   constraints. Include rationale only when a surprising decision would
   otherwise be easy to undo.
2. Organize documents in comprehension order. Lead from purpose and the
   smallest concrete example to observable behavior, concepts and invariants,
   architecture, failures, and reference details.
3. Give the document a learning arc. Each section should build on what the
   reader already understands and prepare them for what follows. Introduce a
   concept when the reader needs it, not when the author discovered it.
4. Prefer motivation before machinery, concrete before abstract, common paths
   before exceptions, contracts before implementation, and consequences before
   details.
5. Revise for flow and hierarchy. Remove repeated explanations, discarded
   alternatives, defensive qualifications, and exhaustive detail that does not
   help a reader understand or use the design.

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
