# Configure/Retry review: REQUEST CHANGES at d4f38f6e

The six focused commands pass, but the mounted implementation does not yet
satisfy the frozen contract. Four failures reproduce through runReplProgram.
Several required observations were replaced with weaker controls or omitted.
Correct the existing behavior and complete the assigned evidence before this
slice can be accepted. No new product or architecture decision is required.

## Exact revision and independent evidence

- Reviewed: `d4f38f6e5cc068bb655a48f1e3cf5d90c2437ea2`.
- Parent and latest accepted head: `bb60ca35661c2988ef647cc7a456470482d06e2e`.
- Branch: agent/issue-883-pr2; signature G, tarasm@gmail.com.
- Worktree verified clean with no untracked files, before and after review.
- Seventeen files, +2886/−67. No push, GitHub write, CI inspection or capture.

The authority is [the frozen CFG1–CFG9 plan](pr2-section5-configuration-planner-handoff.md),
[the timing ruling](pr2-section5-configuration-timing-architect-decision.md),
and [the product decisions](pr2-section5-configuration-product-decisions.md).

All six frozen commands ran independently against the reviewed source, first
runs green, with full output retained:

| Selection | Result | First log |
| --- | --- | --- |
| presentation / Sidekick journey / Sidekick lifecycle | 20 tests / 67 steps | pr2-configuration-review-d4f38f6e-mounted-first.log |
| entries / history / agent-execution / controls / output | 51 / 201 | pr2-configuration-review-d4f38f6e-entries-first.log |
| storage / recovery / configuration | 15 / 77 | pr2-configuration-review-d4f38f6e-recovery-first.log |
| journey / agent-interface / agent-journey / forms | 71 / 185 | pr2-configuration-review-d4f38f6e-journey-first.log |
| route / layout-admission / presentation-style / source-reading | 28 / 130 | pr2-configuration-review-d4f38f6e-layout-first.log |
| execution / lifecycle | 6 / 39 | pr2-configuration-review-d4f38f6e-lifecycle-first.log |

Total: **191 tests / 699 steps**, zero failures. No U2 intermittence recurred.
The unchanged writer-cancellation probe also passes 1 test / 2 steps; output is
pr2-configuration-review-d4f38f6e-writer-probe-first.log. This establishes the
queued-waiter correction, not all configuration shutdown paths.

The Implementor reports check = 0 and three discriminating controls. This review
did not repeat check or the mutations: four independently reproduced contract
failures already require correction. Production source was never modified by
the Planner.

## Reproduced findings

### C-P1 — a late model inspection supplies another model's effort choices

In application.ts offering() at lines 2344–2384, the model argument is not used.
The returned levels are tagged with held.model, the current selection, rather
than the model that was inspected. Hold an inspection for Fast, select Balanced,
release the read, then wait for the result to be applied: Low, Fast's level, is
offered under Balanced.

```text
staleReadApplied: { balanced: true, fastEffortOffered: true }
```

The permanent CFG2 stale row passes because its post-release predicate, "Effort
for balanced", was already true before the held result returned. It asserts
before observing that result. The review waits for the Reading row to disappear
before checking the choices. This is a CFG2 regression, not a new timing case.

Also align open-configure's inspection request with the selection initialized
from saved preferences: its intent currently uses the previous held.model while
the new drawer uses requested.model. Reopening must not relabel inspection
defaults as the saved model's options. Bind reports to their originating drawer,
conversation and requested model; the same report-ownership requirement applies
to late Apply outcomes, which currently carry only Result<void> into applied().

### C-P2 — Stop and start new conversation never stops

The busy button is mounted, but program.ts replace-agent at lines 2217–2222
calls owner.select() directly. select() correctly refuses while the cycle is
busy. No owner.stop() or cancellation join happens. The held-cancellation probe
reports:

```text
busySwitchEnteredCancellation: false
```

CFG4 has only idle success and unreachable-agent rows. It supplies no busy
Stop/join/admitted-entry observation. This violates the accepted busy switch,
not an implementation detail the Planner can waive.

Configure also omits the busy Stop row required by the plan: drawerRows() adds
Stop only for asking !== undefined. Render the applicable Stop within the
presented Configure modal; the hidden pane's control is not a substitute.
Old-agent model/effort controls also remain offered after a different name is
entered, although the plan requires those choices to be disabled for replacement.

### C-P3 — configuration jobs do not exclude Send or Retry

program.ts reserve() at lines 1178–1183 checks cycle only. retrying() likewise
checks cycle only. admit() checks configuring only. The two reservations are
independent, so an inspection/setup can coexist with a new explicit message.
The stored job conversation is not an admission check.

Open Configure with its status read held, close the drawer, then Send. No model
prompt occurs because Core refuses overlapping conversation work, but the root
has already retained and consumed a person message:

```text
messagesDuringInspection: 1, prompts: 0
```

The frozen requirement is a root refusal before starting that conflicting
message, not a failed request after writing it. Protect Send and Retry against
an admitted explicit job, protect setup/inspection against conflicting message
admission, and preserve the permitted independent save beside a running cycle.
Validate the target conversation before a configuration job starts; storing an
unused name does not bind an Apply.

### C-P4 — success does not invalidate an old Retry target

retryable() checks that the named request failed and belongs to the active
conversation, but never checks that later successful explicit work superseded
it. After a failed first message and a successful new message, the old Retry is
still offered and remains eligible:

```text
retryAfterSuccess: true
```

The plan explicitly invalidates that stale target after a successful explicit
message. Keep the old attempt in history; remove its eligibility and reject stale
activation. The existing answered-request control only starts with a successful
message and cannot discriminate this transition.

## Probe fidelity and preserved output

Run the current
[mounted boundary probe](pr2-configure-boundaries-probe-d4f38f6e.test.ts)
from the implementation checkout. Its four steps all fail on d4f38f6e.
The decisive output is in
pr2-configure-boundaries-probe-d4f38f6e-visible-input.log.

The first output is preserved separately as
pr2-configure-boundaries-probe-d4f38f6e-first.log. That run reproduced C-P1/C-P4;
the other two steps stopped before their boundary because the probe expected a
closing bracket clipped from the busy label and used a message too long for the
36-column composer. Only those probe literals changed: the visible busy-label
prefix is clicked and the request is shortened to "during". The reviewed source
did not change. The next run reaches and reproduces all four contract failures.
This is probe adaptation, not product intermittence or a passing rerun.

## C-E1 — finish the already frozen evidence

The following observations are missing, regardless of the green aggregate:

- CFG4: busy switch with held cancellation, no activation/Send before join,
  admitted entry independent. C-P2 supplies the regression to promote.
- CFG5: unresolved-acceptance history mounted through the existing recovery
  producer, blocked Retry with zero writes/provider work; no-activation control,
  and current preference/native association for the actual retry. The supplied
  answered-only control does not replace these observations.
- CFG6: real off-window choices reached by scrolling, Sidekick question partial
  values across Configure, and explicit narrow Configure input as the positive
  control for the hidden-default case. The existing two rows check bounds and
  preservation but do not perform those actions.
- CFG8: the promised competing response/Core writer and conversation-replacement
  binding observation. Three preference appends prove the common queue, but do
  not exercise the root's replacement/save ownership boundary.
- CFG9: an admitted save waiting behind another write is cancelled without a
  late append; a held inspection/setup cancelled by Control-C has no late result
  or activation. The current Control-C control chooses a value but admits no
  job, so it cannot establish either cancellation branch.

Keep the existing CFG9 Exit physical-save join and R1v ordering pairs; they
pass and are useful. Complete the missing observations using the already
assigned representative fixtures, not a wider permutation matrix. No extra
runtime battery, new Core API or new product approval is needed.

## Disposition

Execute [the correction prompt](pr2-configuration-implementor-correction-d4f38f6e.md)
on d4f38f6e. Preserve that signed commit, correct these existing criteria, then
return a new signed feedback commit and the six frozen commands. The bounded
Configure/Retry slice remains unaccepted. Accepted bb60ca35 and all prior Core,
configuration/R2, mounted message/question work stay closed. Deferred features
and delivery remain unopened.
