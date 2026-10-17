# Planner review: admission gate increment 2 at f156f2c3

P1 is subsequently closed by the [PASS at cf3c6526](pr2-admission-pause-planner-review-cf3c6526.md).
A1 remains with the Architect. The findings and evidence below describe f156f2c3.

REQUEST CHANGES at `f156f2c387073baad681e350c8ff3a64a69c2d1a`, parent
`14ebf82d05d30d861ab1e36458e46291486a4841`, branch
`agent/issue-883-pr2`. The exact implementation worktree is clean.
The four frozen commands pass: 113 tests, 340 steps, zero failures.
One startup-refusal case violates the completion-handle contract. Separately,
admission-time arming needs an Architect ruling because it contradicts the
accepted startup boundary. Increment 3 remains paused.

## P1 — a refused startup returns a successful completion handle

`session.ts:784` calls `running.admit(Ok(undefined))` from `reached()`.
The observer at `session.ts:1121` calls it after every appended event, even
when reprojection just refused that event's history. A document policy that
throws before delegation writes a root settlement without a root admission.
That settlement nevertheless resolves the submission as admitted, and
`submitting()` at line 893 returns `Ok(submissionOf(started))`.

The [reproducer](pr2-admission-pause-startup-probe.test.ts) uses the precise
Execution.document refusal specified by PPA3(b). Before its final assertion it
establishes all these facts:

- The stream contains a settlement and no `import_component("__root__")`.
- The reading refuses with “settling that it never admitted.”
- A proposed successor is refused by that same grammar.
- The original submission still returned success and a completion handle.

Its valid-startup control returns entry-1's handle and joins successfully.
This is the ordered correction's existing requirement: “A successful handle
names only its admitted entry” and “Refusal returns no completion handle.”
It is not a request to make malformed histories admit successors.

Correct the acknowledgement so a non-admission event, including a refused
settlement, cannot produce a successful handle. Preserve the authoritative
startup failure and the existing history refusal. Keep the valid-startup
control and exact-entry joined-cleanup behavior. This can be corrected
independently of the Architect ruling below.

## A1 — admission-time arming changes the accepted boundary

The accepted [Architect handoff](pr2-admission-pause-planner-handoff.md)
requires the private handoff before the entry's first expansion gate and says
it “cannot depend on a later paint, admission acknowledgement or lookup of
whichever entry is latest.”

`session.ts:1013–1025` instead spawns a waiter on `admission.operation` and
arms after it resolves. The commit also changes architecture.md and
specs/repl-spec.md to declare admission the earliest coherent point. The
Implementor reports that an earlier arm holds component import before the
admission record and breaks the retained J1 history expectation. The focused
journeys establish a later hold before the reference document's question;
they do not resolve the explicit architectural contradiction.

The Planner cannot approve this boundary change as ordinary helper mechanics.
The [Architect return](pr2-admission-pause-startup-architect-return.md)
requests a ruling that reconciles the existing first-gate language, admission
ordering and unchanged J1 behavior. No replacement boundary is accepted by
this review. Preserve the working commit while that ruling is made.

## Evidence rulings

PPA1 passes, including both unchanged J1 input sequences and the extra true
single-burst row. PPA2/PPA5 supply the three held-preflight sizes, real mounted
Pause, separate state text, focus continuity and the hold before the reference
question. Their startup-boundary acceptance depends on A1. PPA3(a), PPA4 and
PPA6 pass their selected scenarios.

The handback is correct that PPA3(b)'s specified fixture cannot demonstrate a
valid successor in the same session: the resulting history is refused. The
Planner withdraws that fixture's successor expectation. Do not change the
journal grammar or an accepted journey to make it pass. The fixture remains
useful for P1's already-required refusal/no-handle behavior. Any additional
after-arming cleanup scenario depends on the Architect's settled startup
boundary; no replacement permutation is assigned now.

The teardown-disarm mutation is not discriminating in the reported journeys.
Do not claim those rows prove that branch. Keep the owned cleanup while A1 is
resolved; this review requests no artificial failure hook or additional
mutation matrix.

## Commands and results

All four commands ran in `.claude/worktrees/issue-883-pr2` at the exact SHA:

```sh
deno task test packages/cli/tests/repl-journey.test.ts
deno task test packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-agent-execution.test.ts packages/cli/tests/repl-sidekick-controls.test.ts
deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-output.test.ts
deno task test packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts
```

Results respectively: 39/68, 44/161, 11/57 and 19/54, zero failures.
The local diagnostic additionally ran from that worktree:

```sh
deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-admission-pause-startup-probe.test.ts
```

It exits 1: the startup refusal fails the no-handle assertion; the valid
startup control passes. The [complete diagnostic output](pr2-admission-pause-startup-probe-f156f2c3.log)
is retained. No full-suite or CI result was used for the verdict.

## Revision prompt

> Correct P1 at f156f2c3: only an actual entry admission may acknowledge a
> successful submission and produce ReplSubmission. A startup refused before
> admission returns failure with no handle, preserving its authoritative
> failure and the existing history refusal. Integrate the archived reproducer
> and its valid-startup control. Do not repair or weaken the journal grammar.
> A1 is returned to the Architect; do not choose a replacement startup boundary
> or rewrite the no-wait journeys. Once that ruling is recorded, the Planner
> will align the startup step and finite PPA3 evidence. Then rerun the four
> focused commands and return a new feedback SHA. Increment 3 stays paused.

## Continuity

Produced this review, the startup diagnostic and its output, and the Architect
return. Updated the main plan's head and next action. No production code,
implementation commit, memory, GitHub or CI state changed. Core PR 1, the bound
Core amendment and increment 1 retain their accepted standing. The series
remains two PRs. Increment 3/R2 cases 3/4, remaining section 3 wiring and
sections 4/5 remain incomplete.
