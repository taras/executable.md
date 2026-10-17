# Preserve failed provider turns and partial root output

Completed and accepted at `94acc66c8feb4f89c0d6d4d6b1ca8b5432390be6` in the
[Planner review](pr2-owner-planner-review-94acc66c.md). The instructions below
record the completed correction. Continue with planner-handoff.md's next action;
do not repeat these fixes.

Correct `e3aaa61e1977c5293842b5eba8a4505bd16b575d`, parent
`356f1b5164cc966cff92a0d5b6c5b554fc14e97d`, in
`.claude/worktrees/issue-883-pr2`, branch `agent/issue-883-pr2`.

The [Planner review](pr2-owner-planner-review-e3aaa61e.md) records two failures
of existing contracts. Preserve the current increment and the accepted Submit
delegation, orientation and ownership boundaries. Core, admission/Pause,
guide and read-wiring acceptance remain closed.

## P1: preserve a failed turn without admitting its unfinished response

A failed prompt currently appends a response record which projectSidekick
correctly refuses because its owning turn never completed. This makes the
newly written history unreadable and blocks the next explicit message.

Keep the completed-turn requirement for response outcomes. On provider failure,
use the canonical Prompt record already retained as the account of the failed
attempt and its source. Project that source as an Incomplete preview, distinct
from an admitted root reply; run no response controls. Remove the failed-turn
write that claims an admitted response. The immutable view representation may
change to express this distinction; no new durable record family is needed.

The projection remains readable after failure and when reopened. A later
explicit message may continue the same conversation at its next canonical
ordinal. A failure consumes an attempted ordinal but establishes neither a
completed response nor successful orientation delivery. Preserve the existing
first-orientation rule and authoritative identity checks. Do not relax the
response guard to trust arbitrary uncompleted or nonexistent turns.

## P2: retain the rendering Core already returned on ordinary failure

When evaluateGeneratedXmdRoot returns an ordinary GeneratedXmdRootError, use its
canonical partial result when present. Retain the actual partial output and
hasOutput and return those same facts on the owner result. Projection must show
that retained partial reply and its failure. Earlier completed controls remain
retained; later controls/source do not run.

An admission refusal with no partial has no invented rendering. Raised
durability, Files, secret-policy and teardown errors retain their existing
classification and identity. Keep this correction within the current
single-message cycle; follow-up, Stop and configuration stay for their planned
increments.

Align the affected specification and architecture prose with the canonical
failed-turn/Incomplete distinction and ordinary partial-root behavior.

## Finite evidence and feedback

Read the [probe](pr2-owner-failure-probe-e3aaa61e.test.ts) and its
[first output](pr2-owner-failure-probe-e3aaa61e.log). Integrate its two regressions
and successful-turn control into the existing owner journey boundary:

- Provider failure: no control or draft effect; canonical source remains an
  Incomplete preview; warm and reopened projections are readable; a later
  explicit message uses the same conversation's next ordinal and succeeds.
  This cold reading is ordinary projection evidence, not a claim to complete
  the separate subprocess R2 boundaries.
- Ordinary root failure: an earlier actual fill remains, partial Output and
  hasOutput survive in the result and retained/projected reply, and later source
  is absent. Inject only the ordinary failing root request; use the real
  evaluator and journal.
- Successful turns remain readable and continue normally. Preserve the existing
  recovery refusal for an admitted response without a canonical completed owner.

Run from the implementation worktree:

```sh
deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-owner-failure-probe-e3aaa61e.test.ts
deno task test packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-history.test.ts
```

Adapt a probe assertion only if the explicit Incomplete view changes its type;
preserve its observations. No new permutation matrix or full suite is assigned.
The review's tmux-socket failure is separately preserved in its terminal log.
This correction touches no terminal boundary, so that failure is not assigned
to these owner fixes.

Commit promptly when the focused evidence passes. Hand back the exact signed
SHA and parent, every focused command/result, the working-tree state and the
remaining incomplete work. Stop for Planner review before the next increment.
No push, GitHub mutation or CI inspection is authorized.

Exact reviewed base is e3aaa61e. Produced artifacts are this prompt, the linked
review, probe, first output, focused logs and planner-handoff.md. P1 and P2 are
the remaining blockers; no new product or architecture decision is required.
