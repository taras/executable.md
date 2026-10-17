# Implementor correction: mounted Sidekick at 86debcb9

**Closed at a438905f, 2026-10-14.**
[The PASS review](pr2-mounted-planner-review-a438905f.md) accepts both fixes
and the bounded mounted slice. This prompt is historical; it assigns no
further work.

Fix two failures of the existing mounted assignment: Stop during a legacy
publication wait must release the entry writer, and a reply's Submit must
refuse stale Draft text when preflight resumes.

Follow .agents/implementor.md. Work only in
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`,
branch agent/issue-883-pr2, from exact signed clean base
`86debcb96ba8f547d78712b2de66fcc1ed709ef9`, parent
`004de839e85e53cff4d960cb515729d350383f30`.
Verify the head and reconcile any later delta without reset, amend or discard.

Read [the review](pr2-mounted-planner-review-86debcb9.md) and
[the frozen mounted plan](pr2-section5-mounted-message-planner-handoff.md).
The two reviewer probes and logs live in the main checkout's
`.reviewer/issue-883/`. No new product or architecture decision is delegated.

## 1. Release the writer if acquiring the hold is cancelled

upgradeExecution currently yields writer.hold() outside its try/finally.
hold() changes writer state before waiting for an append to settle.
Establish release coverage before entering that operation, so cancellation
while acquiring the hold releases it just as cancellation later in publication
does. Keep the hold through snapshot, publication and redirect. Release queued
records to the surviving target on success, failure and cancellation.

Do not remove the whole-publication hold, cancel an admitted entry, replace the
session/writer or acknowledge an unsettled prefix. Use existing Effection
lifetime mechanisms; local factoring is yours.

Promote the regression and control from
pr2-mounted-handoff-cancel-probe-86debcb9.test.ts into the existing storage test
destination. Hold an actual issued append, cancel upgrade while hold waits,
release the append and prove a subsequent append through the same facade
finishes. Keep the paired ordinary-failure control. Use explicit gates and
register their teardown before waits; a deadline may bound failure but cannot
establish readiness. This is finite cancellation coverage of plan steps 1–2,
not a new storage design.

## 2. Ask the existing root gate when reply Submit actually starts

Wire submitForSidekick and its program.ts adapter to the session's existing
StartingCheck. The check must close over the exact reservation being submitted
and read fresh root facts when ReplSession calls it after preflight.
Reuse stillAdmissible; do not create another predicate or submission owner.
A captured facts snapshot or a check before preflight cannot satisfy this.

Local changes to the CLI-private AdmittingSession/submitForSidekick plumbing
are allowed where needed to carry the exact reservation and fresh-facts check.
No Core/ACP API, global ordinary-session restriction, new authority channel or
replacement ReplSession is needed. Preserve the human Run path and its pending
Pause/admitting-record order.

A changed revision, frozen route or withdrawn request refuses at that existing
boundary. Refusal starts no entry, keeps newer Draft text, reports through the
existing refusal/outcome/feedback path and releases the reservation correctly.
An acknowledged entry retains its independent lifetime and exact-entry handle.

Promote the regression and control from
pr2-mounted-start-recheck-probe-86debcb9.test.ts into the mounted presentation
destination. Through the real Message/Send path, hold the entry's component
read during preflight, edit Draft through its mounted input, release, and prove
no stale entry was admitted and the newer Draft survives. The paired unchanged
Draft admits the exact requested source once. Preserve the existing M1–M8,
no-wait journeys, message acknowledgement and Stop assertions. No additional
route/revision permutation matrix is required.

## Evidence and feedback

After the final edit, run the original six commands from the worktree:

```text
deno task test packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts

deno task test packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-agent-execution.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-output.test.ts

deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts

deno task test packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-agent-journey.test.ts packages/cli/tests/repl-forms.test.ts

deno task test packages/cli/tests/repl-route.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-source-reading.test.ts

deno task test packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-lifecycle.test.ts
```

Also run both reviewer probes unmodified from that worktree:

```text
deno test --allow-all --config ./deno.json /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-mounted-handoff-cancel-probe-86debcb9.test.ts

deno test --allow-all --config ./deno.json /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-mounted-start-recheck-probe-86debcb9.test.ts
```

Preserve first failure output. Each probe must pass both its regression and
control. Confirm each fix discriminates by restoring only its defective
behavior against the corresponding new pair: cancellation regression red /
ordinary-failure control green; stale-Draft regression red / unchanged-Draft
control green. Verify each mutation applied before interpreting it, restore
byte-identically, and rerun affected evidence. The original notification
mutation need not be repeated unless that connection changes.

Align existing documentation only if the correction makes a current statement
false. Do not add a new product promise or vocabulary. Report every fixture or
assertion adaptation explicitly. No full suite, lint, check, JSR, packaging
build or CI wait is a feedback prerequisite.

Commit promptly as one signed feedback correction when this finite evidence
passes. Preserve 86debcb9 as its parent rather than amending it. Return exact
SHA, parent, branch, signature, clean-tree status, all commands/results, the
two regression/control observations and mutation evidence. Stop for review.

## Continuity and limits

Configuration P1/P2, increment 4 and R2 remain closed at their accepted
prerequisite. These findings are M-P1/M-P2 about the mounted connection;
86debcb9 remains unaccepted until corrected and reviewed.

The deferred preview, Sidekick question and Configure drawers, configuration
controls, Sessions catalog integration, full terminal acceptance and 36-frame
packet do not open. No push, GitHub mutation, CI inspection, dependency change,
main-checkout production change or unrelated cleanup is authorized.

Exact base: 86debcb9. Artifacts: this correction prompt, the linked review,
original mounted plan and the two named reviewer probes. Settled decisions:
cleanup covers hold acquisition; reply Submit uses the existing exact-reservation
start gate. No architecture blocker remains for this correction. Next action:
implement only these two fixes and return their signed feedback commit.
