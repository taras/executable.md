# Restore the accepted Sidekick control feedback

Completed and accepted, including the remaining receipt correction, at
`2fddcf6b49859e630fc21ec3372a6bd765fb415c` in the
[Planner review](pr2-feedback-planner-review-2fddcf6b.md). The instructions and
intermediate status below record the completed rounds. Follow the main handoff's
next action; do not repeat these fixes.

The designation omission and pre-reservation refusal path are corrected at
`f5b60c9957e7cc08ef0748e7144425d4b9921ee2`. The
[review](pr2-feedback-planner-review-f5b60c99.md) records two remaining receipt
requirements from this assignment. Follow
[pr2-feedback-receipts-implementor-prompt.md](pr2-feedback-receipts-implementor-prompt.md)
next; preserve the corrected designation and refusal paths. The instructions
below retain the original assignment and evidence.

Correct `97f8cb794752bc89047cea13d618aba8bce28be2`, parent
`94acc66c8feb4f89c0d6d4d6b1ca8b5432390be6`, in
`.claude/worktrees/issue-883-pr2`, branch `agent/issue-883-pr2`.

The [Planner review](pr2-feedback-planner-review-97f8cb79.md) records two failures
of existing feedback contracts. Preserve the increment and fix those failures;
no new product approval or architecture decision is required. Section 4's first
owner increment and the earlier accepted admission/Pause/recovery work stay closed.

## Deliver the original controls as well as the new help reads

Read [remaining-architecture.md](remaining-architecture.md) part 2 directly.
It designates Bindings, EntryInput, Submit and EntryOutput as feedback, alongside
REPL.Syntax. The [syntax-discovery amendment](syntax-discovery-amendment.md)
adds Guide.* and REPL.Environment. A write can be designated feedback. Canonical
Syntax and arbitrary component returns remain ordinary render/capture values.
Sidekick Elicit remains for its planned increment.

After each response finishes and joins, deliver these retained results in
invocation admission order to the same conversation and request the next turn:

- REPL.Bindings: the actual detached JSON map, with no provenance or status
  injected into it. A single result is that value directly.
- REPL.EntryInput: Entry input updated. Retain source/revision internally;
  do not echo the entry program as its acknowledgement.
- REPL.Submit: the exact admitted entry's actual terminal outcome after its
  task teardown joins, followed by its exact-entry EntryOutput read invocation.
  An actual failed entry carries its safe failure reason; an admission refusal
  names no entry. No output body or summary belongs in this receipt.
- REPL.EntryOutput: the actual resolved entry, observed range/completion state,
  exact requested text in a sufficiently long fence, and pinned adjacent read
  instructions. Use the existing read rendering contract, not JSON serialization
  of the internal snapshot.

Continue using retained facts as the source of successful results, including
the Submit intent's exact entry and the retained terminal outcome. Share pure
formatting with the existing control renderers where useful. Do not substitute
JSON null for a receipt, serialize an internal snapshot as the read message, or
trust a fresh filesystem read to recreate an earlier result. Keep control failures
distinct from successful values and entry failure distinct from admission refusal.

Several results use short component headings in admission order. JSON values
under those headings use adequate fences. Keep internal IDs, ordinals and Result
envelopes out of the agent-facing message. Ordinary root failure still follows
the retained results, names its reason and says earlier effects stand.

## Return a refused Submit without inventing an attempt

A Submit refused before reservation currently disappears from feedback because
it has no control pair and does not fail the root. Convey that known ordinary
Result refusal from the root request to the conversation owner. After the response
joins, retain its component/reason in feedback before sending the automatic
correction turn. Use the existing feedback family and response ownership; this
does not require an entry reservation or a new journal.

Preserve the accepted admission ordering and prompt busy refusal. Do not queue
the request, write a bound Submit intent for a slot never taken, duplicate the
pair for a reserved Submit, or change the entry grammar. Retain the refusal as
feedback without claiming an admitted entry. Actual reserved submissions retain
their existing intent/outcome pair and exact-entry completion handle. Raised
durability, policy, Files and teardown failures keep their authoritative owner;
do not turn them into automatic ordinary corrections.

## Finite evidence

Integrate the [probe](pr2-feedback-contract-probe-97f8cb79.test.ts)'s four
regressions and Guide control in the existing owner journey tier. Its
[first failing output](pr2-feedback-contract-probe-97f8cb79-first.log) is preserved.

1. Bindings sends its actual empty detached map on the canonical second turn.
2. Literal EntryInput followed by Submit runs one real entry, then delivers
   the draft acknowledgement and exact completion/read receipt in that order.
   The feedback contains no submitted source/output body and runs no second entry.
3. EntryOutput reads a real completed entry and delivers its pinned, fenced
   window rather than the internal snapshot object.
4. Submit with an empty draft delivers its ordinary refusal for correction,
   creates no entry or reservation, and remains readable.
5. A Guide result still causes the canonical second turn. Preserve the existing
   chapter marker-pair, two-read ordering, ordinary partial-failure and Output-only
   rows. Output-only work and ordinary canonical Syntax still cause no feedback.

Replace the newly added assertion that prepare/Submit sends nothing. Script
its expected follow-up instead; do not weaken the actual entry, draft-clear,
single-pair or completed-turn assertions. This is a correction to this unaccepted
increment's premise, not permission to change accepted no-wait journeys.

Update the affected specification/architecture prose and surface description to
make the full designated set and refusal correction clear. Preserve the new
Output-only chat rule and canonical delivery proof. This assignment adds no
permutation matrix or interruption-boundary claim.

Run from the implementation worktree:

```sh
deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-feedback-contract-probe-97f8cb79.test.ts
deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-owner-failure-probe-e3aaa61e.test.ts
deno task test packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-history.test.ts
deno task test packages/cli/tests/repl-sidekick-output.test.ts packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-route.test.ts packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-agent-journey.test.ts
```

Commit promptly once focused evidence passes. Hand back the exact signed SHA
and parent, every focused command/result, worktree state and remaining incomplete
work. Stop for Planner review before the next increment. No full-suite run, CI
inspection, push or GitHub mutation is assigned or authorized.

Exact correction base is 97f8cb79; accepted owner base remains 94acc66c. Produced
artifacts are this prompt, its linked review/probe/output, focused logs and the
updated main handoff. P1/P2 remain blocking until corrected. Stop, Sidekick Elicit,
configuration, metadata refresh, program binding, R2 cases 2/5/6 and section 5
remain outside this correction.
