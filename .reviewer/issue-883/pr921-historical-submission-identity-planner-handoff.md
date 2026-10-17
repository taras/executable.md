# Reserve submitted entries from the acknowledged history

Correct the entry identity recorded when someone opens a historical REPL
location, returns to the live head and submits an entry. With two entries saved,
opening at Entry 1 must still reserve Entry 3 for new work. The durable Submit
intent, actual admitted source, completion receipt and output-read target must
refer to that same entry, whether it completes or fails.

This is one bounded #921 correction under the
[Architect scope ruling](pr921-agent-feedback-scope-architect-return-940249af.md).
It releases the correction below on the existing PR2 base. The separate
[stack-integration hold](pr890-pr921-main-integration-architect-handoff.md)
continues to prohibit rewriting either branch pending its own ruling and plan.

## Applies to and exact base

Follow .agents/implementor.md and the implementation checkout's AGENTS.md.
Read architecture.md, the REPL specification's submission/recovery and receipt
sections, the Architect return and this complete handoff before editing.

| Item | Required value |
| --- | --- |
| Branch | agent/issue-883-pr2 |
| Worktree | /Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2 |
| Feedback base | 940249af47159a3bbd960b8ca8df3f10bb53811c |
| Parent | ff0e52c643c21ad7dde34908a18a112add6312c7 |
| Existing PR1 dependency | 79d404d04d02c3840892473b6f1b2cf540f3edd1 |

PR2 was independently clean at this head when this plan was prepared. Recheck
advancement before editing. Preserve another writer's work and return an actual
base conflict rather than resetting. Use the existing Implementor session if
it retains useful context; this handoff is sufficient for a new session.

The reviewer packet lives in the root checkout, not necessarily in PR2's
worktree. This assignment authorizes a signed correction commit only. No
rebase, reset, amend, merge, push, GitHub mutation, CI inspection, dependency
change, user-history repair or terminal capture is assigned.

## Current defect and authoritative facts

The session deliberately keeps session.model projected at its opening
selection. Navigation asks reading(at) for another view; it does not rewrite
that opening selection. reading(undefined) already supplies the full
acknowledged history as a Result. The session submits against that full history
and returns the exact task-bound completion handle.

Three root uses currently mistake the opening projection for the head:

- program.ts, coldReservation near line 725: current.model.entries.
- program.ts, the submitForSidekick adapter near line 1039:
  current.model.entries.
- program.ts, the person's submit action near line 2847:
  session.model.entries.length for the next key and ordinal.

The Sidekick admission helper settles the writer, rechecks readiness, takes
the shared slot synchronously, binds the retained byte prefix and writes its
intent before submitting. The incorrect entries supplied to that helper make
its ordinal wrong despite that correct ordering. The completion receipt
already uses submission.entry and submission.join(); preserve it.

The Architect's recorded reproduction opens at compatibility marker close:root
after two entries, returns to live and reserves entry-2/ordinal 1 for an actual
entry-3. The receipt and output-read target correctly name entry-3. Cold
reconciliation then refuses the reservation's source mismatch. Do not weaken
that refusal to hide the incorrect intent.

The saved user session also contains wrongly attributed feedback, but its
producing revision is unknown. This correction does not claim to reproduce
that older receipt wording or repair that history.

## Ordered implementation

1. Add the mounted historical-opening reproduction and its head-opening
   control using the existing fixture and real on-disk repository. Capture
   the first regression failure before editing production. Establish the
   cold-recovery regression separately so changing only live Submit cannot
   appear to close both defects.
2. Supply the full acknowledged entry reading to Sidekick reservation,
   coldReservation and the person's next-slot calculation. Use the existing
   session capability; do not add a new public Core API, independent counter,
   second projection owner or cached head snapshot. An ordinary private helper
   or local adapter change is delegated.
3. Preserve reading failures as refusals. An unreadable acknowledged history
   supplies no guessed count, fallback opening model or permission to submit.
   Read the Sidekick count at the existing settled-writer boundary, then take
   the slot without suspension between the decision and reservation. Keep
   readiness checks and prefix binding in their current relative order.
4. Keep the person's and Sidekick's reservations on the same shared admission
   slot and acknowledged next-entry basis. Keep the actual-start recheck of
   route, revision and withdrawal. A screen still at a frozen checkpoint
   refuses submission; merely opening historically does not make later live
   submission invalid.
5. Reconcile pending reservations against the full acknowledged entries while
   leaving the selected screen frozen. Cold reading appends nothing and
   performs no entry or provider work. Retain the finding only at the existing
   explicit mutating-action boundary; absent work stays absent and admitted
   work is not repeated. Keep byte-prefix, ordinal, id and exact-source checks.
6. Keep completion and output reads bound to the returned submission handle.
   A failed entry gets its own failed receipt and read target, rather than a
   submission-refusal sentence naming no entry. Cancellation continues to
   withdraw an unadmitted request and join Sidekick work without cancelling an
   independently admitted entry.
7. Align the existing submission/recovery paragraphs in architecture.md and
   specs/repl-spec.md with this concrete distinction: the opening/displayed
   prefix is not the acknowledged history used to reserve or recover work.
   No new record schema, vocabulary, publication promise or public interface
   is introduced.

Expected production scope is program.ts and, only if its local adapter needs
to carry a reading refusal, sidekick/admission.ts. Session reading behavior,
gate.resolved(), completion handles, history formats and Core/ACP contracts
remain authoritative. Return a concrete conflict if this correction actually
needs a wider boundary. Ordinary fixture adaptations are allowed when they
preserve existing claims; report each adaptation.

## Frozen evidence

Use the existing mounted-program fixture, real repository/session, canonical
entry evaluator, Sidekick owner and control journal. Replace only terminal and
agent transport as the mounted fixture already does. Entry sources are small,
agent-free and local; use gates and observed boundaries rather than sleeps as
readiness evidence. Do not execute the user's copied location or unsent draft.

| Row | Required observation and destination |
| --- | --- |
| HI1 — successful submission | In repl-sidekick-presentation.test.ts, create two completed entries, open a copied location at the first entry's valid checkpoint, return to live through the mounted UI, then ask Sidekick to fill and Submit distinct literal source. Read the saved intent, admitted entry, rendered receipt and output-read target together: ordinal 2 and entry-3 throughout, exact source and retained-prefix binding intact. The head-opening control follows the same path without a historical opening. |
| HI2 — failed entry | In the same mounted tier, submit source that is admitted and then fails, rather than source refused during preflight. After the same historical-open/live transition, intent, actual failed entry, failed completion receipt and read target all name entry-3. Assert the entry's own failure and preserved prior entries. Reuse the HI1 setup and head control where suitable; no provider or malformed-input matrix is needed. |
| HI3 — person's Run and frozen refusal | In the existing mounted presentation tier, open historically, attempt Run while still frozen and establish no new entry; return live and Run through the ordinary control, admitting entry-3 with its literal source and correct draft clearing. Review that the private reservation uses the same acknowledged basis as Sidekick. The person's private reservation identity has no public display, so the mounted actual-entry assertion alone is not evidence of that internal calculation; source review supplies that part. Do not add an inspection API to expose it. Preserve existing contention and actual-start rows. |
| HI4 — admitted pending reservation | In repl-sidekick-recovery.test.ts with existing recovery phases, leave an actual Submit intent unanswered after its entry is admitted, following two prior completed entries. Reopen at the earlier checkpoint through runReplProgram: cold opening changes neither file and performs zero provider work or repeated entry effects. The next explicit mutating action retains an admitted finding for entry-3 before new work. This must exercise program.ts's cold adapter, not only call coldReservation with a test-selected full list. The existing head-opening recovery is the control. |
| HI5 — absent pending reservation | Use the same recovery path but interrupt after the intent and before entry admission. Reopen at the earlier checkpoint: no append, no provider turn and no admission of the reserved source. At the next explicit mutating action, retain absent before the new, distinct ordinary entry takes entry-3. The head-opening absent case is the control. Existing changed-prefix and source-mismatch refusals remain passing and unchanged in meaning. |
| HI6 — existing lifecycle and navigation | The commands below preserve acknowledged-prefix settlement (R2l), absent/admitted and changed-history recovery (R2i–R2k), shared admission, held-preflight edits, Stop, task-bound receipts/output reads, ordinary Run and historical display/navigation. No assertions are weakened to fit the correction. |

HI4 and HI5 may extend the existing subprocess phases and mounted fixture to
share an on-disk root and pass an opening location. Preserve genuine interrupted
operations; throwing an error that writes an outcome is not an interruption.
Use the existing operation-level append gate when an append must never reach
the physical host. A queued Promise append cannot prove that absence.

The archived
[focused probe](pr921-historical-opening-reservation-probe.test.ts.txt) and
[corrected-marker output](pr921-historical-opening-reservation-probe-940249af-corrected-marker.log)
remain historical evidence. That probe embeds the old session.model adapter,
so fixing program.ts does not make its unchanged copy correct. It is not an
assigned required-green command. The permanent mounted rows exercise the
corrected production path; do not export a production test hook or edit the
archive to manufacture a green probe.

Capture the HI1 and HI4/HI5 historical-path failures on the base, with their
head-opening controls, before applying the corresponding production fixes.
These baselines discriminate live reservation from cold recovery; no mutation
battery or full suite is assigned.

## Focused feedback commands

Run from the PR2 worktree against the final source:

```sh
deno task test packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts
deno task test packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-controls.test.ts
deno task test packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-journey.test.ts
```

These cover the mounted/root, subprocess-recovery and ordinary-entry/navigation
consumers that import-only selection could miss. Preserve complete first failure
output before rerunning. Fix and rerun a failed assigned command. A failure
followed by success on the identical revision is handled under AGENTS.md's
flake rule, not discarded. Full lint/check, JSR, runtime suites and CI belong to
delivery and are not additional feedback prerequisites for this assignment.

## Scope and handback

Keep #922 deferred. Do not change Parse/SafeParse, Let or capture persistence,
binding-map contents, publication APIs, or expose intermediate agent replies.
Those are separate feedback dispositions, not missing parts of this correction.
Do not implement B–D's pending UI proposals or perform stack integration.

Once HI1–HI6 and the three commands pass, promptly create one signed feedback
commit on 940249af, preserving its parent chain. Hand back the exact SHA,
parent, branch, signature and tree state; each command/result; the row-to-test
mapping; first failure logs; fixture adaptations; and any concrete limit.
Stop for review of that exact commit. Do not ask for permission again merely
to complete the already assigned correction and its focused evidence.

Continuity: base 940249af; produced handoff and companion
pr921-historical-submission-identity-implementor-prompt.md in this packet.
No product or architecture choice remains open within this correction. The
independent rebase ruling, B–D, teaching, captures and delivery remain separate.
Next Implementor action: verify the clean base, reproduce the mounted live and
cold defects, implement the bounded root correction and return the signed SHA.
