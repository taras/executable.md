# Section 5: answer Sidekick questions from the REPL

**Accepted at bb60ca35, 2026-10-14.**
[The PASS review](pr2-question-planner-review-bb60ca35.md) closes Q-P1/Q-P2
and accepts this bounded slice. MQ1–MQ5 and both promoted pairs pass.
This plan is the scope record; it assigns no further implementation.
The feedback entry below is historical.

**Feedback at 2f3af332: REQUEST CHANGES, 2026-10-14.**
[The review](pr2-question-planner-review-2f3af332.md) and
[active correction prompt](pr2-question-implementor-correction-2f3af332.md)
restore input/drawer ownership for hidden-form and History transitions.
MQ1–MQ5 remain frozen; two paired regressions cover these existing boundaries.
Work from 2f3af332, not the original base below.

A reply can already ask canonical Elicit and wait for its validated answer.
This increment lets the person open that question in the Sidekick pane, fill
its form, close it without losing partial fields, and answer it. An entry may
ask at the same time; the two questions and answers stay independent.

**Ready for implementation from signed clean
a438905f8fa98d245bb6444058bd470f1312411b.** This is the next bounded section 5
assignment. The mounted message slice is accepted; no new architecture ruling
is needed.

## Base, authority and limits

- Worktree: /Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2
- Branch: agent/issue-883-pr2.
- Exact base: a438905f8fa98d245bb6444058bd470f1312411b.
- Parent: 86debcb96ba8f547d78712b2de66fcc1ed709ef9.
- Planner verified the worktree clean and signature G, tarasm@gmail.com.
- Planning records live in the main checkout, not the worktree.
- Read .agents/implementor.md and the current repository instructions.

Governing sources:
[accepted question behavior](remaining-architecture.md#accepted-journey-5-sidekick-owns-its-question-and-answer),
[terminal adaptation](reference/README.md#accepted-terminal-adaptation),
[questions and presentation](planner-handoff.md#questions-selection-and-presentation),
and [the accepted mounted review](pr2-mounted-planner-review-a438905f.md).
Read architecture.md's private REPL kernel, modal/focus and Sidekick Elicit
sections; specs/repl-spec.md's entry question, bounded form, location, Sidekick
and terminal sections; and the applicable Elicit/generated-response sections
of specs/executable-mdx-spec.md.

Included: Sidekick question notifications, passive announcement, deliberate
pane-local opening, root-owned partial form state, validation messages,
owner-routed answer, focus/target behavior, tab/resize preservation, Stop and
whole-command shutdown with a question pending.

Deferred: streamed preview, Configure/Retry and agent/model/effort controls,
Sidekick rows in Sessions, the full terminal comparison/capture packet and
delivery. This does not reopen configuration P1/P2, R2 or the accepted mounted
message slice. No Core/ACP API, schema language, provider configuration,
response ceiling or journal grammar changes are assigned.

## What already exists

SidekickOwner.questions exposes ReplElicitations: pending, changes and asked.
sidekick/questions.ts installs useReplElicitation in the owner's scope and
journals the Elicit control pair. The canonical component, schema compilation,
validator, durable answer and designated feedback are already implemented.
Stop cancels the evaluated root and withdraws its pending question without an
outcome. The entry's provider lives separately in ReplSession.elicitation.

program.ts currently subscribes to owner.changes and the entry's elicitation
changes, but not SidekickOwner.questions.changes. Its liveOf/sidekickReadingOf
supplies chat/busy/agent facts, while perform's answer branch submits only to
session.overlay.question.

application.ts has one entry ReplFormState and form renderer. Entry opening is
a live-elicit route drawer; closing deliberately clears that entry form.
Sidekick question drawers have no route spelling. Reusing the entry's slot or
live-elicit route would conflate ownership and apply the wrong close/History
rules. The existing whole-body drawerRect is also not a Sidekick-pane rectangle.

The existing form rows, bounded choices, complete-message fitting, measured
window, field issues and Freedom modal machinery are the mechanisms to reuse.
There is no second form parser, validator, Elicitation provider or question
journal to build.

## 1. Observe the actual question at the root

Subscribe to sidekick.questions.changes in drive's existing scope before any
message can publish a question. Follow the existing owned stream pattern,
subscribing before relying on pending and releasing with the scope. Send
notifications into the existing wake queue; reread the owner's pending
question at the root. No polling, timer or filesystem watcher is needed.

Keep root-only access to ReplQuestion.submit. Give the view detached message,
form and pending-state facts, with a stable process-local question key for
typed actions. Bind that key to the exact pending object in root-owned state;
text, schema equality or a count alone does not establish which question an
answer targets. Private mapping/helper names and factoring are delegated.
Nothing is serialized or added to Core's interfaces.

The same question keeps its key and form state through close, tab changes,
History selection and resizing. A different pending object starts with an
empty Sidekick form; an ended question loses its form and open presentation.
A delayed action for the old key must not answer a new question.

Announce a pending Sidekick question with text on the existing Sidekick
selection control when its pane is hidden, and with a question notice and
explicit answer control in the selected pane. Use existing words such as
Sidekick, question and answer. Arrival changes no selected tab, route, History,
focus, shared Draft or Message text. It opens no drawer and sends no turn.
Explicit Sidekick tab activation still focuses Message as already accepted;
opening the answer control is a separate deliberate act.

## 2. Keep the two forms and answer paths separate

Add process-local Sidekick form/open state beside the existing entry form.
Use typed actions/intents to identify the question being opened, edited,
chosen, submitted or closed. No provider/owner/operation reaches a component.
Keep the two text revisions and takeover behavior independent of form editing.

Reuse the bounded form's display and editing helpers rather than copy its
schema rules. String fields, enum choices, conditional required indicators,
field errors, full-object submission and complete-message scrolling retain
their existing semantics. Typing a form field named message or draft must
still edit that form, not either composer.

Only program.ts performs an answer: verify the targeted key still names the
owner's exact pending object, then call that question's submit(values).
Use its ReplFormOutcome. Invalid leaves the same question and field values
pending and applies its normalized issues. Answered closes that Sidekick
drawer and clears only its ended form. The existing canonical operation
writes the answer and the existing feedback cycle delivers it; the screen
writes no answer/control outcome of its own.

Do not call the entry answered() transition for a Sidekick answer: it names an
entry invocation and alters the live-elicit route. Preserve the entry's answer,
record/focus restoration, historical refusal and discard-on-close behavior.
A Sidekick question belongs to the current conversation even while an older
entry is inspected; entry History does not prohibit answering Sidekick or move
that inspection.

A valid answer returns focus through Freedom to an appropriate mounted
Sidekick control, normally Message after the answer control disappears.
Closing returns to the answer opener while it remains pending. Apply any
restoration once; background publication makes no focus claim. Existing
entry focus assertions are unchanged.

## 3. Draw one pane-local form using the existing presentation path

The Sidekick drawer is process-local. Add no +sidekick/+question route drawer,
query member or public opener. Printed/reopened locations retain their current
codec and contain no request key, form values, field errors or open-state flag.

Draw the question only when Sidekick is the selected reading. It occupies
Sidekick's chat pane in wide/medium and the routed Sidekick outlet in narrow,
above the unchanged seven-row ordinary footer. It must not become the current
global whole-body entry drawer. Derive its rectangle and fitting width from
that owning pane through one shared layout calculation used by measurement,
admission, description, committed rendering and hit testing.

Reuse the drawer's opaque coverage, bounded ordered window, fixed close/title/
scroll controls and existing form rows. A field, choice or submit control
outside the admitted window contributes no node, Tab stop or pointer target.
Do not clip live controls into a smaller rectangle or draw entry and Sidekick
form targets at once. Preserve the existing entry/permission/History drawers.

Only one question drawer is presented at a time through the existing modal
rules. Opening Sidekick does not dismiss a permission request or answer/deny
anything underneath it. Do not bypass an existing modal's dispatch boundary;
its existing explicit close path precedes reaching the Sidekick opener.

Use Freedom's modal push/pop and typed navigation. Keep explicit close and
command Exit reachable. Preserve the existing Sidekick Stop control while
busy and the pane/surface navigation needed to leave this reading; reparent
existing controls into the active modal focus root where necessary, as the
current drawer already does for History/Exit, rather than duplicate controls
or introduce a second focus store. Hidden Sidekick form controls must not
remain in a modal root after leaving that pane.

Closing or selecting another pane/surface hides the Sidekick drawer but
preserves the pending question, its partial values and errors. Returning
selects the reading normally; reopen the drawer deliberately. No background
event reopens it. The entry's close-clears-form rule remains entry-specific.
The existing route transitions preserve their scopes/History/draft meanings.

## 4. Withdraw truthfully and preserve lifecycle ownership

Stop uses the existing owner.stop operation. Whether the form is open or
closed, it withdraws the Sidekick question without a submitted answer,
control outcome or follow-up turn, after cancellation cleanup joins. Remove
the ended form/targets without manufacturing an answer. An entry's question
and work remain independently pending and answerable.

Exit, Control-C, EOF and failure use the existing drive lifetime and join both
owners before terminal release. An unanswered question records no answer.
Partial form text is process-local and is not restored after cold reopen.
Existing interruption/recovery rules remain authoritative; reopen does not
re-ask the dead process's question or start any provider work.

## Frozen evidence: MQ1–MQ5

Use the real runReplProgram, repository, profile, response ceiling, owner,
entry session, canonical Elicit and committed mounted tree/grid. Only terminal
and transport are controlled. Extend the shared mounted-program fixture where
needed; no second terminal host or injected finished UI state.

| Row | Required observations | Destination |
| --- | --- | --- |
| MQ1 — announce without taking over | At 160x36, hold the real Elicit control-intent append before publication, let the already-busy frame commit, then release it without another input. The Sidekick question notice appears while the root waits for an answer. Record terminal input count unchanged. Start on Bindings with Draft focused and an entry/History selection; tab, focus, both texts and History stay unchanged. Explicitly select Sidekick then open its answer control; only this act opens the form. Include an ordinary entry question announcement as the wakeup control. | repl-sidekick-presentation.test.ts |
| MQ2 — invalid, partial and preserved | Drive a real canonical Sidekick question with an enum and a required string constrained by minLength. An invalid/partial submission shows the correct field issue, publishes no answer/outcome and leaves the same question. Type partial text, close, select Bindings and return, then reopen: same values/issues, no second question. Complete it validly; exactly one canonical answer/outcome and owning feedback are observed. Preserve unsent Message and Draft. Use a form field named message to distinguish form editing from the composer. Pair this with the same valid flow without close/tab changes. | Mounted tier in repl-sidekick-lifecycle.test.ts, presentation assertions shared as needed |
| MQ3 — two owners and Stop | Keep an ordinary entry question and a Sidekick question pending with overlapping field names and distinct messages/answers. Through mounted controls, answer Sidekick, observe its exact feedback, and prove the entry remains pending; answer entry independently and observe its actual result. In a separate Stop arm, Stop through its mounted control while Sidekick's form is pending/open: no Sidekick answer or control outcome, no follow-up; entry remains answerable. A later explicit message asks a new question with the same field names and starts with empty form values, not the stopped form. Existing held-cleanup Stop tests remain intact. | repl-sidekick-lifecycle.test.ts |
| MQ4 — pane, windows and sizes | One partial-question resize journey covers 160x36, 120x30, 72x20, 60x15 refusal, 72x20 recovery and wide recovery. Preserve exact pending question, values/issues, both composers and route. Read the actual committed drawer bounds and targets: wholly inside the selected Sidekick pane/outlet, above the seven-row footer, opaque coverage and no entry-form targets. Independent outer pane envelopes are x>=124 at 160 columns, x>=92 at 120 columns, and x>=0 at 72; right edge <= terminal width and bottom <= rows-7. Compare against those reference values rather than calling the production drawer rectangle to derive the expectation. Use a question long enough to scroll to its last field/choice and submit control; off-window targets are absent and later become reachable through real scrolling. Leaving Sidekick removes its form targets; reopen deliberately and retain partial fields. | repl-sidekick-presentation.test.ts |
| MQ5 — command shutdown and cold reopen | Exit and Control-C while the Sidekick form holds partial text and an entry question is also pending. Neither question gets an invented answer, the root tasks join and terminal restoration occurs once. Existing M8 held-cleanup ordering evidence stands; no new cleanup latch family is required. Cold reopen projects the interrupted operation but has no pending live form, no restored partial fields and zero provider/turn/write activity. | repl-sidekick-lifecycle.test.ts, reuse mounted repository/reopen fixture |

Rows may share scenarios. This is not a required number of tests or a new
schema/resize permutation matrix. MQ2's no-close positive control and MQ3's
actual answers establish that preserving partial text does not merely leave
an unanswerable form on screen. Keep existing R6 owner-only assertions and
all accepted M1–M8/R2 assertions intact.

Two discriminating controls are assigned, no others required:
1. Disable only the new Sidekick-question wake notification, retaining owner
   chat/busy, entry question and final-job notifications. MQ1's no-input
   announcement fails; the ordinary entry announcement control stays green.
2. Clear Sidekick form values on close, the entry rule mistakenly applied to
   Sidekick. MQ2's close/tab preservation arm fails; its no-close valid control
   stays green.

For both, confirm the mutation actually applied before interpreting the
result, preserve first output, restore byte-identically and rerun affected
tests. Gates establish readiness; timeouts bound failures and sleeps do not
establish ordering.

## Files, documents and focused commands

Expected production surfaces: program.ts, application.ts,
components/actions.ts, components/rows.ts and private layout/presentation
helpers in layout.ts/layout-admission.ts/description.ts as necessary.
sidekick/owner.ts or questions.ts may change only for necessary private
notification plumbing; their provider, journaling, scope and admission
contracts remain as accepted. Do not change session.ts or elicitation.ts's
schema/validation semantics. Reuse its existing parsed form/submit interface.

Update specs/repl-spec.md and architecture.md for the implemented Sidekick
drawer, separate partial state, owner routing and pane geometry. Qualify
existing entry-only close/discard prose rather than silently changing it for
both. Do not rewrite unrelated guides or the terminology registry. Use
established words: question, form, field, drawer, owner.

After the final source/spec edit run these six commands in the worktree:

```text
deno task test packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts

deno task test packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-agent-execution.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-output.test.ts

deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts

deno task test packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-agent-journey.test.ts packages/cli/tests/repl-forms.test.ts

deno task test packages/cli/tests/repl-route.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-source-reading.test.ts

deno task test packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-lifecycle.test.ts
```

These include the shared form, presentation, modal/permission, program,
owner, recovery and session consumers of this connection. Preserve the first
output of a failure before rerunning. The unrelated existing U2 intermittence
is [recorded separately](pr2-mounted-permission-u2-flake-a438905f.md);
do not weaken its assertion or silently claim a green first run. No full
suite, full lint/check/JSR, build, CI or capture is a feedback prerequisite.

Do not rerun the two previous correction probes solely for confidence.
R1u and mounted M-P2 are now in this selection. If you materially change their
writer handoff or actual-start boundary, return that fact and include the
existing regression evidence; do not broaden this UI assignment on your own.
No vendored Freedom/renderer lifecycle or Core/ACP API change is assigned.
If such a change proves necessary, preserve the concrete failure and return
that boundary to the Planner before implementing it.

Commit promptly as one signed feedback increment after the frozen evidence
passes. Return SHA/parent/branch/signature/clean-tree state, all six commands
and results, MQ1–MQ5 mapping, controls and every fixture/assertion adaptation.
Stop for review. No push, GitHub mutation, CI inspection or real-terminal
capture is assigned.

## Continuity

Exact base: a438905f8fa98d245bb6444058bd470f1312411b.
Artifacts: this plan and
[the Implementor prompt](pr2-section5-question-drawer-implementor-prompt.md).
Settled: canonical provider reuse, independent owner/form state, deliberate
pane-local opening, partial text preservation, exact-question answers and
existing Stop/shutdown ownership. No product or architecture blocker remains.
Next action: implement only this drawer slice and return one signed feedback
commit. Deferred section 5 work remains separate.
