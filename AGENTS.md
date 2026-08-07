# Executable Markdown Agents

## Setup

One command prepares a worktree, and nothing else installs:

```bash
deno task setup
```

There are two dependency layouts, not one: `node_modules/` and Deno's global
cache. `deno task deps` owns both — `deno install --frozen`, the cached module
graphs a build and a compile walk, and the one `sideEffects` fact the browser
bundle needs — and `deno task setup` runs it, then `pnpm install`, then records
that fact again (pnpm restores its own copy of that manifest from its store),
then builds the bundle.

The order is load-bearing: `pnpm install` adds its store beside Deno's without
pruning it, and the union resolves for Deno, for `tsc` and the Node suite, for
Bun, for oxlint, and for the site. Run setup again after changing a dependency.

**The lockfile is frozen repository-wide** (`lock.frozen` in the root
`deno.json`), because a task's own resolution rewrites a stale lock before any
flag on its command line applies — `deno task deps` used to exit 0 and leave the
tracked lock rewritten. Adding or changing a dependency is therefore an explicit
act: `deno install --frozen=false`, commit the lock, then `deno task setup`.

**Builds install nothing.** `deno task build:web` and `deno task build` run
under node-modules and cache modes that cannot create, relink, or fetch —
automatic management writes `node_modules/.deno` before a process reaches its
own code, so a runtime check would be too late — and they refuse to run at all
on an unprepared worktree, naming `deno task setup`
(`scripts/preflight.ts`). A check or a build that reinstalls prunes the links
another command is resolving through, which is how the Node typecheck came to
fail after a `deno task build` (#279).

Preparation is host-only. A release compiles five platforms, and
`deno compile --target` resolves the npm packages of the platform it compiles
*for*, so each release job prepares its own target first with
`deno task deps:target <target>` — `deno install --entrypoint
--node-modules-dir=none --frozen` under that target's OS and architecture, which
adds to the Deno cache without touching `node_modules`. The mapping lives in
`scripts/lib/release-targets.ts` and is held to `release.yml`'s matrix by test.

`deno task verify:clean` runs the whole claim end to end: it clones `HEAD`,
prepares the clone against a scratch `DENO_DIR` of its own, prepares the
representative release target and proves the host tree and lock survived it,
then runs every build phase offline — including a release compile for
`x86_64-unknown-linux-gnu`, the same shape `release.yml` uses — fingerprinting
the content and modes of `node_modules`, the cache's dependency roots, and
`deno.lock` after each one. It then changes `site/` in that clone on purpose,
takes the changed tree as its baseline, and runs the battery once with the site
pair applying — all ten commands together, selected by a real change rather
than by a fixture.

Builds and checks are held to different claims there. A build is cache-pure:
nothing it does may move `node_modules`, the cache's dependency content, or the
lockfile, and the comparison around a build walks all three. Verification is
not, and does not pretend to be — the battery resolves modules no build walks,
so it adds to the Deno cache, which the runtime owns. Its comparison therefore
reads only what this repository owns, `node_modules` and `deno.lock`, and never
looks at the cache at all: not filtered out afterwards, never asked for. What
verification may never move is tracked files, `node_modules`, `deno.lock`, and
another invocation's temporary state.

It verifies the commit, so commit before running it. CI runs the same harness in
its `composability` job — **on `main` only**. The battery it runs spends most of
its time on the three runtime suites, which `test-deno`, `test-node`, and
`test-bun` already run in parallel on their own runners, so putting it on every
pull request bought a 50% longer critical path and no new information. Run it
locally before you push anything that could move dependency state; on `main` it
is the post-merge proof, and a failure there opens a `ci-main-red` issue.

## Verification

One command runs everything that applies, concurrently:

```bash
deno task verify          # add --no-site to skip the site pair
```

The `green` check is the aggregate CI check required by the main branch ruleset.
Every new CI job must be added to `green.needs`; the workflow regression test
parses `ci.yml` and enforces that coverage.

**The whole applicable battery is designed to run at once, after one setup.**
That is a repository rule, not a convenience, and it has two halves:

**Builds are cache-pure.** `deno task build:web`, `deno task build`, and the
release compile must leave `node_modules`, the Deno cache's dependency content,
and `deno.lock` byte-identical.

**Verification may populate the runtime cache** — the battery resolves module
graphs no build walks, and that cache belongs to the runtime. What no check may
do is modify tracked files, `node_modules`, `deno.lock`, or another
invocation's temporary state. Temporary state a check needs belongs to that
invocation alone.

A helper that reaches for repository-owned mutable state breaks every other
check running beside it, which is how a `deno task build` came to break the Node
typecheck (#279).

`verify` reports every command in a fixed order however they finish, prints the
first failure's output complete and names the rest, and fails if the battery
moved any tracked file's content, mode, symlink target, or presence — including
when a command failed, because that is when a dirtied tree would otherwise go
unnoticed. **Capture a failure's first output before re-running anything**: the
report is what you paste, and a second run can hide the first.

The site pair applies when `site/` changed, judged from the branch and the
worktree, both sides of a rename included.

Running the checks individually is still fine, and is what `verify` does for
you. After making any changes to source files (`src/`) or test files (`tests/`),
always run all four before committing:

1. **Lint + Format**: `deno task lint` (runs `oxlint` + `oxfmt --check`) — must
   produce 0 errors. Run `deno task fmt` to auto-fix formatting.
2. **Typecheck**: `deno task check` — must produce no errors
3. **Tests**: `deno task test` — all tests must pass with 0 failures
4. **JSR publishability**: `deno task check:jsr` — must end with
   `Success Dry run complete`

Do not commit if any check fails. Fix the issue first, then re-run all four.

Each command derives its own scope, so a new package under `packages/` — and a
new test file under any member's `tests/` — is covered without editing anything
here:

- `check`, `test`, and `check:jsr` follow the `packages/*` workspace glob in the
  root `deno.json`. Its `exclude` list holds the paths that must stay
  unchecked: the deliberately-malformed `scripts/tests/fixtures`; `.xmd-eval`,
  where a running document writes the `.ts` files its eval blocks compile to;
  `**/npm`, the dnt build's output, which a test rewrites while the battery
  runs; ignored local `.claude/worktrees`; ignored generated spike vendor
  builds; and byte-identical vendored TypeScript inputs whose deterministic
  JavaScript and declaration output is checked instead. Generated paths belong
  to whichever command is producing them — type-checking one mid-write fails on
  a partial file, and fails the whole workspace check for a file nobody
  committed. The corresponding generated output is skipped by `lint` and
  `fmt`, for the same reason.
- `test:node` and `test:bun` derive the same corpus through
  `scripts/lib/test-files.ts`, which walks `tests/` beneath each workspace
  member plus `scripts/tests/` — that boundary, and nothing else. A new
  `*.test.ts` there runs under all three runtimes by default.
- `scripts/runtime-test-exclusions.ts` is the one place a test opts out of a
  runtime. Every entry carries a reason and an issue, and
  `scripts/tests/runtime-exclusions.test.ts` checks that each names a file
  discovery finds, appears once per runtime, and is justified. That test
  validates structure only — it cannot show an excluded test has become
  portable, so removing a stale entry stays a manual act.
- Execution and typechecking are separate axes. The exclusion manifest governs
  what runs; `tsconfig.node.json` lists only the portable runtime-test scripts,
  so portable suites under `scripts/tests/` run under Node and Bun without every
  script being statically typechecked.
- `lint` and `fmt` are defined once, as `package.json` scripts that `deno task`
  also exposes, and cover `packages` and `scripts`. Oxfmt skips Markdown
  (`.oxfmtrc.json`): these documents are executable, and reformatting a fenced
  block changes what they do. `packages/*/npm` — the dnt build's output, which
  a test writes while the battery runs — is skipped by both: it is generated,
  gitignored, and carries a `node_modules` of its own that oxlint's `import`
  plugin resolves through, so linting it reports on half-written files nobody
  committed. The fixtures and that output stay out of `.oxlintrc.json`, on the
  lint task's command line instead — the rule tests in `scripts/tests/` lint
  through the repository config, and an `ignorePatterns` entry there stops them
  seeing their own fixtures.

## MUST READ

- https://github.com/thefrontside/effection/blob/v4/AGENTS.md
- `architecture.md` — read fully
- `specs/executable-mdx-spec.md` — read the sections your change touches

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
    (`scripts/oxlint-rules/`), which autofixes with `oxlint --fix`.
11. Prefer expanding Executable.md capabilities over using JavaScript; Do not
    use JavaScript in MD without verifying with the user or planner agent.
12. Use contextual APIs for environment-specific behavior in production code.
    Shared production modules must not access host-specific APIs or detect the
    active runtime. Runtime-named entrypoints and adapters install
    host-specific behavior — `packages/cli/src/{deno,node,bun,compiled}.ts` are
    the CLI's. `packages/test-support` is the same boundary for tests: it
    detects the active runtime to drive `@std/testing/bdd`, `node:test`, or
    `bun:test` from one BDD surface, and is exempt from this rule. The Oxlint
    rule tracked by issue #156 carries the same path exemption.
13. Hand an outcome back as Effection's `Result<T>`. Do not declare a local
    `{ ok: true } | { ok: false }` union — put the success payload under `value`
    and the failure data on an `Error` — and return a narrowed failure rather
    than rebuilding it with `Err(result.error)`. Enforced by the
    `local/prefer-effection-result` Oxlint rule (`scripts/oxlint-rules/`),
    which autofixes the rebuild with `oxlint --fix`.
14. Keep `main` green. Whoever breaks it gets a self-closing `ci-main-red`
    issue; do not merge other work while one is open.
15. State shared across loaded copies uses stable, namespaced names: plain
    structural values for composition data and a contextual Api for operations.
    Security enforcement, durable identity, and reconciliation never trust
    replaceable context state.

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
