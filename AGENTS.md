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
pair applying — every command together, selected by a real change rather
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

Verification happens at two boundaries. **Implementation feedback** runs the
smallest evidence that discriminates the change, so a reviewing role receives a
stable commit quickly. **Delivery** runs the exhaustive battery and the required
CI checks before merge. A feedback verdict answers whether one commit satisfies
the settled plan or architecture; it does not answer whether the branch is ready
to merge.

### Test selection

Use one of these forms while implementing:

```bash
# Tests affected by uncommitted changes
deno task test --changed
# Tests affected by the branch and worktree
deno task test --changed=origin/main
# Tests that import one source file
deno task test --related=packages/core/src/expand.ts
# A known regression test
deno task test packages/core/tests/expand.test.ts
```

Choose in this order: a known regression or integration test when the changed
boundary is known; otherwise `deno task test --changed` for uncommitted work;
and `deno task test --changed=origin/main` when branch-level changes belong in
the selection.

Prefer explicit test files when the behavior crosses a boundary the module
graph cannot see, such as a subprocess, fixture, generated file, or dynamic
import. `--related` and `--changed` select transitively through imports; they do
not prove that every black-box consumer has been found. Add each known
integration or regression test explicitly in that case.

### Feedback commits

A **feedback commit** is the stable revision offered to a Planner or Architect
once the smallest relevant affected tests pass. Commit promptly when that
focused evidence passes, and hand over the exact commit SHA together with every
focused command run. The reviewing role inspects that exact commit. When a
focused test fails, fix it and rerun it before creating the feedback commit.

`deno task lint`, `deno task check`, `deno task check:jsr`, the complete local
suite, and CI are not prerequisites for a feedback commit. Waiting for them
withholds the commit the feedback exists to be given against.

The specialized procedures in this document are not ordinary confidence checks,
and each still applies when a change touches what it covers: dependency layout
and mutation, release targets and the release specification, generated
artifacts, cache purity and `deno task verify:clean`, flakes, and `main` health.

### Delivery verification

A **delivery gate** is the verification required before merge. Branch protection
and the required CI checks are authoritative there.

Do not run the full test suite under each runtime merely for confidence: the
`test-deno`, `test-node`, and `test-bun` CI jobs own that exhaustive pass. Run a
full suite locally only when the change affects test discovery, a runtime
adapter, shared test setup, or another boundary that makes affected-test
selection incomplete, or when the user asks for it.

To reproduce the complete applicable battery locally, one command runs it
concurrently:

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

If a check fails but the identical revision passes without a fix, create or
update a dedicated issue labeled `flake`. Include the failing test or command,
runtime, run link, output, and evidence of intermittence. A green re-run restores
health but does not close the issue; close it only after the cause is fixed and
the regression evidence is recorded.

The site pair applies when `site/` changed, judged from the branch and the
worktree, both sides of a rename included.

The complete battery consists of:

1. **Lint + Format**: `deno task lint` (runs `oxlint` + `oxfmt --check`) — must
   produce 0 errors. Run `deno task fmt` to auto-fix formatting.
2. **Typecheck**: `deno task check` — must produce no errors
3. **Tests**: `deno task test` — the full Deno suite; CI also runs the full
   corpus under Node and Bun
4. **JSR publishability**: `deno task check:jsr` — must end with
   `Success Dry run complete`

A failing check in the battery is fixed before the branch is offered for merge:
re-run the failed check and every affected test. CI remains responsible for the
complete battery unless the change meets one of the full-suite conditions above.

Each command derives its own scope, so a new package under `packages/` — and a
new test file under any member's `tests/` — is covered without editing anything
here:

- `check`, `test`, and `check:jsr` follow the `packages/*` workspace glob in the
  root `deno.json`. Its `exclude` list holds the paths that must stay
  unchecked: the deliberately-malformed `scripts/tests/fixtures`; `.xmd-eval`,
  where a running document writes the `.ts` files its eval blocks compile to;
  `**/npm`, the dnt build's output, which a test rewrites while the battery
  runs; and the pinned Cloudflare DOFS TypeScript inputs and declarations whose
  deterministic JavaScript and declaration output is checked instead. Generated
  paths belong to whichever command is producing them — type-checking one
  mid-write fails on a partial file, and fails the whole workspace check for a
  file nobody committed. The exact Cloudflare DOFS snapshot is skipped by
  `lint` and `fmt` because its drift verifier owns byte identity.
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
    use JavaScript in MD without verifying with the user or planner agent. The
    Executable.md Style Guide governs how an executable document is written.
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

## Executable.md Style Guide

An executable document is read twice: as source, by someone deciding whether to
trust what it does, and as output, by the person running it. Both readings are
designed. `scripts/bootstrap-npm-package.md` is the worked example.

1. **Write prose that executes, not a script with comments.** Each step explains
   why it is necessary, performs it, and shows a useful result. The explanation
   is the document's content, not commentary around it.
2. **Explain a term where it first appears.** A document run once a year is run
   by someone who has not learned its vocabulary. Do not assume — educate.
3. **Lead with the practical consequence** rather than the principle, and
   address the reader as `you`.
4. **Report a completed action in the past tense.** A step that writes says that
   it wrote, and what. Announcing an intention beforehand does not replace it.
5. **Explain a refusal before it can happen**, and make it actionable: name the
   command that resolves it, filled in with what the run actually found.
6. **Keep machinery out of the output.** Captures, schemas, classifiers and
   bindings render nothing. A command whose own chatter reads worse than the
   document's sentence runs `silent`, and a command's raw output appears only
   where that output is the evidence.
7. **Put in `<Output>` only what the reader of a run can still act on.** How to
   invoke the document is read before it runs, so it belongs outside the region.

### Markdown > JavaScript/TypeScript > Bash/SH

Express each step at the highest level that can carry it, and say why when
dropping a level:

- **Markdown** for control flow, I/O and composition — `<If>`, `<Each>`,
  `<File>`, `<Parse>`, `<Capture>`, `<TempDir>`, and components. It is the layer
  a reader can audit and the engine can journal and replay.
- **TypeScript** in `eval` blocks for comparison, classification and formatting.
  Typed, testable, and visible to the reader as a value rather than as text.
- **Shell** to invoke a program, and for little else. Parsing, branching and
  string assembly in shell are quoting hazards a reader cannot audit and a test
  cannot reach.

A document that needs a value from a command captures the command's output and
decides in TypeScript; it does not decide in the shell and report the verdict.

### Verifying a document

Render the output and read it as the person running it before calling the
document done. In a test, install `useNormalizedOutput()` — the CLI installs it
and `execute()` does not, so a raw capture shows whitespace the operator never
sees.

## PR Process

1. Use .github/pull_request_template.md
2. Feedback review runs against one exact commit SHA and is independent of CI.
   Neither requesting a verdict nor returning one waits for a check to finish.
3. After the PR is open, delivery belongs to the Implementor or maintainer:
   required checks, CI failures, and review comments. Integrate feedback as it
   appears.

## Agent Roles

An explicit role assignment in the task wins. Otherwise:

- An Opus model is an Implementor.
- A GPT model is a Planner. When the task asks for system or software
  architecture, issue or milestone reconciliation, stack sequencing, or an
  architecture review of an implementation, it acts as the Architect.
- A Fabel model is a Problem solver.

Before acting in one of the three delivery roles, read its contract completely:

- [Architect](.agents/architect.md)
- [Planner](.agents/planner.md)
- [Implementor](.agents/implementor.md)

One agent may cross roles only when the user explicitly asks. Independent
architecture, planning, and implementation reviews are otherwise preserved.

Every handoff records enough durable state for another agent to continue:

- repository, issue or PR, exact head and base;
- settled decisions and their authoritative sources;
- work completed and verification performed;
- unresolved decisions, blockers and dependencies;
- artifacts produced; and
- the next role and concrete action.

Conversation memory is not an authoritative project record. Consequential
decisions belong in architecture, specifications, issues, PR comments or named
handoff artifacts, as authorized by the user.

## Review boundaries

An ordinary implementation verdict reviews one exact feedback-commit SHA against
the settled contract, the patch, the implementation and the focused evidence
reported with it. It does not inspect, monitor or wait for CI, and CI status is
neither positive nor negative evidence for it. A passing verdict is `PASS` —
never `PASS pending CI`, `mark ready after CI`, or an equivalent condition. CI
is inspected only when the user explicitly assigns CI troubleshooting.

### Structural consequences

An architecture finding has a **structural consequence** only when it changes
one or more of:

- what is authorized to execute;
- which durable identity or retained history is accepted;
- what durable state is committed, published, or journaled;
- whether replay can resume the intended run;
- ownership of a transaction, resource, invocation, or lifecycle;
- concurrency or cancellation behavior that violates that ownership;
- which authoritative outcome wins after a fatal failure; or
- a public persistence or compatibility boundary.

The Architect returns `REQUEST CHANGES` only when all five of these hold:

1. The finding is reproduced or directly traced against the exact reviewed
   commit.
2. It violates a previously settled structural invariant.
3. It uses an in-scope supported surface.
4. It produces a structural consequence from the list above.
5. Its correction belongs within the current PR's purpose.

The verdict names every one of them: the reviewed SHA, the settled invariant,
the reproducer or direct trace, the supported surface, the structural
consequence, and why the correction belongs in this PR. A hypothetical risk, a
plausible concern, or an adjacent invariant cannot fail architecture review.

The structural checklist is frozen before implementation. A distinct structural
invariant added afterwards takes an explicit architecture amendment naming its
consequence, not an implicit review expansion.

### Finite evidence

The Planner owns the evidence sufficient to prove the settled acceptance
criteria: how much implementation detail each criterion needs, the
representative scenarios, the focused tests, and when one regression proves a
criterion. That acceptance and evidence matrix is frozen before implementation.

The Implementor executes the frozen matrix. When implementation evidence shows
the matrix cannot prove a criterion, the Implementor returns that evidence
rather than expanding acceptance independently. The Architect may restore a
structural invariant the plan omits, but does not expand a sufficient matrix
with permutations that carry no distinct structural consequence.

Once implementation begins, a newly imagined edge case blocks only when it
proves an existing criterion unmet, or carries a distinct structural consequence
requiring an explicit architecture amendment.

### Follow-ups and closure

A non-blocking observation does not automatically become an issue. The Planner
decides whether recurrence likelihood, user impact, or expected remediation
value makes it worth tracking; otherwise the behavior stays for reactive
maintenance.

Architect review closes when the frozen structural checklist passes. Planner
review closes when the frozen acceptance criteria and the selected evidence
pass. Neither role reopens review for CI, diagnostic hardening, speculative
permutations, unrelated correctness polish, or an incidental non-structural
observation. A later correction returns to a role only when it materially
changes that role's reviewed contract.
