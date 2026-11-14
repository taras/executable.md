# Executable Markdown Agents

Specifications describe the expected behavior of the system completely enough
to reimplement it in another language. Code is not authoritative: when code and
a spec disagree, the spec is the contract, and changing the contract is a
decision, not an edit.

## Where rules live

| Question | Authoritative home |
| --- | --- |
| What must an agent do or never do? | AGENTS.md (this file) |
| How is the system meant to work; which invariants are shared? | [architecture.md](architecture.md), starting at "Reading this architecture" |
| What exact behavior must an implementation preserve? | [specs/](specs/README.md) |
| What was decided, why, and what was learned? | [specs/decisions.md](specs/decisions.md) |
| Which implementation patterns do features reuse? | [.agents/code-rules.md](.agents/code-rules.md) and [.agents/architecture-rules.md](.agents/architecture-rules.md) |
| How does a role act? | [.agents/](.agents/) role briefs |

Each rule has exactly one home; other documents link to it. When two documents
disagree, the home above wins — fix the stale copy in the same change.
Read what the task touches, starting from the
[architecture reading map](architecture.md#reading-this-architecture) and the
owning spec sections; unrelated reading is never a delivery gate.

For Effection-based code, consult the
[Effection guidance](https://github.com/thefrontside/effection/blob/v4/AGENTS.md).

## Setup

- `deno task setup` prepares a worktree; nothing else installs. Run it again
  after any dependency change, and after changing pinned producer recipe
  inputs — changed recipe inputs require preparation again.
- Builds install nothing, and refuse to run on an unprepared worktree.
- The lockfile is frozen repository-wide. Adding or changing a dependency is an
  explicit act: `deno install --frozen=false`, commit the lock, then
  `deno task setup`.
- Every check is designed to run beside every other after one setup. No check
  may modify tracked files, `node_modules`, `deno.lock`, or another
  invocation's temporary state. Builds are cache-pure: they also leave the Deno
  cache's dependency content byte-identical.
- Run `deno task verify:clean` locally before pushing anything that could move
  dependency state. It verifies the commit, so commit before running it.
- Dependency-layout mechanics, release-target preparation
  (`deno task deps:target`), Claude producer preparation and the reasons behind
  these rules: [architecture.md](architecture.md), [the testing
  spec](specs/testing-spec.md) and [specs/decisions.md](specs/decisions.md).

## Verification

### Test design

- Prefer test doubles over stubs. Use controlled test doubles at dependency
  boundaries such as ACP, HTTP, or subprocesses.
- Exercise black boxes through realistic code paths.
- Use unit tests only for simple input/output cases where type safety or
  schemas are insufficient.

### Running checks

Verification happens at two boundaries. A **feedback commit** proves one exact
commit against the settled plan or architecture with the smallest
discriminating evidence. The **delivery gate** is merge readiness: the required
CI checks are authoritative.

Feedback:

- Commit promptly once the smallest relevant affected tests pass; hand over the
  exact SHA and every focused command run. Fix and rerun a failing focused test
  before creating the feedback commit.
- `deno task lint`, `deno task check`, `deno task check:jsr`, the complete
  local suite, and CI are not prerequisites for a feedback commit.
- The specialized procedures in this document are not waived by that rule.
  Each still applies when a change touches what it covers: dependency layout
  and mutation, release targets and the release specification, generated
  artifacts, cache purity and `deno task verify:clean`, flakes, and `main`
  health.
- Assign independent reviewers the [Reviewer guide](.agents/reviewer.md):
  correctness, minimalism and performance when UI or performance-sensitive
  paths are affected, including checking existing APIs before accepting a new
  one. The workflow or coordinator owns mechanical validation and review
  bookkeeping.
- Start Fable reviews without waiting for CI on `main` or the reviewed branch.
  Main health and required checks remain merge gates; a review pass waives
  neither.
- When a required Fable review is unavailable (including exhausted quota), use
  Codex Astra (`gpt-6-astra`) with the same independence from the Implementor,
  scope, reasoning-effort policy and correction limits. Reconcile any in-flight
  review first, preserve its findings and session records, and record the
  provider and model. The fallback replaces the required review; it adds no
  extra stage.

Test selection, in order of preference — a known regression or integration test
when the changed boundary is known, then `--changed` for uncommitted work, then
`--changed=origin/main` for branch-level selection:

```bash
deno task test packages/core/tests/expand.test.ts     # a known regression test
deno task test --changed                              # affected by uncommitted changes
deno task test --changed=origin/main                  # affected by branch and worktree
deno task test --related=packages/core/src/expand.ts  # tests importing one source file
```

For a REPL UI verification handoff, follow the
[REPL bench guide](.agents/repl-bench.md#ui-handoff) in the assigned worktree.

Selection is transitive through imports only. When behavior crosses a boundary
the module graph cannot see — a subprocess, fixture, generated file or dynamic
import — add each known integration and regression test explicitly.

Delivery:

- Do not run the full suite under each runtime for confidence: the `test-deno`,
  `test-node` and `test-bun` CI jobs own the exhaustive pass. Run a full local
  suite only when affected-test selection is incomplete (test discovery, a
  runtime adapter, shared test setup) or when the user asks.
- A failing check in the battery is fixed before the branch is offered for
  merge: re-run the failed check and every affected test.
- Every new CI job must be added to `green.needs`; the workflow regression test
  parses `ci.yml` and enforces that coverage.
- Keep `main` green. Whoever breaks it gets a self-closing `ci-main-red` issue
  and no other work merges while `main` is red. The repair is a single pull
  request a maintainer labels `ci-main-red-fix`; nothing else grants the
  exception.
- A check that fails and then passes on the identical revision without a fix is
  a flake: create or update a dedicated issue labeled `flake` with the failing
  command, runtime, run link, output and evidence of intermittence. A green
  re-run restores health; close the issue only after the cause is fixed and the
  regression evidence is recorded.
- Capture a failure's first output before re-running anything; a second run can
  hide the first.
- Never promote an implementation module to an entry point to silence a
  dead-code finding. A runtime-exclusion entry carries a reason and an issue,
  and removing a stale entry is a manual act.
- CI topology — the `green` aggregate, `main-green` gate, shard matrices,
  weights measurement and `composability` — is specified in
  [the testing spec](specs/testing-spec.md). `deno task verify` and
  `verify:clean` prove check ownership and non-interference; they are not
  correctness checks.

The battery, by task name:

```bash
deno task lint         # oxlint + oxfmt --check + dead code (knip); must produce 0 errors
deno task check        # typecheck; must produce no errors
deno task test         # complete Deno suite
pnpm test:node         # complete suite under Node
bun run test:bun       # complete suite under Bun
deno task check:jsr    # JSR publishability; must end with "Success Dry run complete"
deno task verify       # shared-state interference proof
deno task verify:clean # the same, from a clean checkout; commit first
deno task fmt          # auto-fix formatting
deno task lint:dead-code # the dead-code check alone
```

## Code rules

Before writing or changing code, read
[.agents/code-rules.md](.agents/code-rules.md) — the authoritative numbered code rules for any code change, each citing its lint enforcement.
Keeping `main` green is a process rule and is stated in this document under
Verification.

## Writing

The writing principles in [.agents/agent-writing.md](.agents/agent-writing.md)
govern all repository documents — specs, architecture, guides and issues: write
for the reader's understanding, in comprehension order, with a learning arc;
remove repeated explanations, discarded alternatives and defensive
qualifications.

- Avoid the [banned-words list](scripts/banned-words.js) in architecture prose
  and JSDoc; choose wording for the specific meaning and keep literal code
  references intact. `deno task lint` enforces the list.
- Agent-facing guides: read [.agents/agent-writing.md](.agents/agent-writing.md) first.
- Component descriptions: read [.agents/component-descriptions.md](.agents/component-descriptions.md) first.
- Issues, Stories and Quests: read [.agents/issue-writing.md](.agents/issue-writing.md)
  first — this applies to one-off issue creation as well as corpus work.
- Executable documents: read [.agents/executable-style.md](.agents/executable-style.md) first.
- In Codex, use ASCII diagrams in fenced text blocks; Mermaid is unreadable in
  the user's client.

## Roles

| Role | Delivers | Default model | Brief |
| --- | --- | --- | --- |
| Implementor | an accepted plan as a focused, verified change | Opus | [.agents/implementor.md](.agents/implementor.md) |
| Planner | a decision-complete plan and self-contained handoff | GPT | [.agents/planner.md](.agents/planner.md) |
| Architect | coherent product contracts, boundaries and stacks — acts on system or software architecture, issue or milestone reconciliation, stack sequencing, or an architecture review of an implementation | GPT | [.agents/architect.md](.agents/architect.md) |
| Reviewer | an independent correctness, minimalism and performance review | Fable | [.agents/reviewer.md](.agents/reviewer.md) |
| Problem solver | a confirmed cause with a regression and handoff, or a missing witness | Fable, with Astra as backup | [.agents/problem-solver.md](.agents/problem-solver.md) |

An explicit role assignment in the task wins over these defaults. One agent may cross roles only when the user explicitly asks; independent architecture, planning and implementation reviews are otherwise preserved. Read the role's brief
before acting in it. Running the target below prepares an Implementor session
and hands you the selected agent's own interactive UI:

<Agent>
  <Session.Launch session="implementer">
You are the repository Implementor.

<File path=".agents/implementor.md" />
  </Session.Launch>
</Agent>

## Handoffs

Every handoff records enough durable state for another agent to continue:
repository, issue or PR, exact head and base; settled decisions and their
authoritative sources; work completed and verification performed; unresolved
decisions, blockers and dependencies; artifacts produced; and the next role and
concrete action. Conversation memory is not an authoritative project record:
consequential decisions belong in architecture, specifications, issues, PR
comments or named handoff artifacts, as authorized by the user.

## PR process

1. Use `.github/pull_request_template.md`.
2. Feedback review runs against one exact commit SHA and is independent of CI:
   a passing verdict is `PASS` — never `PASS pending CI` or an equivalent
   condition — and CI is inspected only when the user explicitly assigns CI
   troubleshooting.
3. After the PR is open, delivery belongs to the Implementor or maintainer:
   required checks, CI failures, review comments. Integrate feedback as it
   appears.
