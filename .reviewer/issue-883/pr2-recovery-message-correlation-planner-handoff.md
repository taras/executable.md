# Implementation amendment: associate messages within their own requests

Implement the accepted message-correlation amendment from
`87b25a40915a697a580e619072d433c9c676fec0`, parent 14ee0d8e, on
agent/issue-883-pr2. The implementation worktree is clean and unchanged at that
signed revision. This is a decision-complete implementation assignment, not an
implementation PASS. The governing decision is
[pr2-recovery-message-correlation-architect-decision.md](pr2-recovery-message-correlation-architect-decision.md).

Terminology is settled: use **message ID**, **feedback text** or **reference
text** according to the contents, and **records for this request**. Preserve the
accepted fields and wire bytes. Carry only the approved message ID and turn
entries from architecture.md into the implementation worktree with the correction. Describe
when text was saved and whether delivery was confirmed; add no offer,
delivery-intent or interval abstraction. See
[the vocabulary decisions](pr2-recovery-message-vocabulary-decisions.md).

The second vocabulary interview is also complete: use turn, saved turn when
the distinction matters, and the turn recorded for this request when explaining
the association. See [the accepted decisions](pr2-recovery-turn-vocabulary-decisions.md). The proposed
R2d fixture correction is accepted there: insert the production feedback record
with turn:null before its second turn, preserving the delivery assertions and
the already assigned person.message adaptation. Report the fixture diff with
the feedback revision. The architecture and finite evidence remain settled.

Keep saved person messages in acknowledged order. After the existing R2m2
interruption, the intended reading is:

```text
message 1: first   --> turn unknown
message 2: second  --> turn 1 --> reply Two.
```

Also complete the already assigned unresolved-feedback-acceptance refusal in
[pr2-recovery-unknown-implementor-correction.md](pr2-recovery-unknown-implementor-correction.md).
These two corrections can share one stable feedback commit. Creation-policy
compatibility remains with the Architect and is not an implementation choice
in this assignment. R2 cannot be declared complete until that separate ruling
and its required evidence are supplied.

## 1. Read the existing request boundaries

In packages/cli/src/repl/sidekick/model.ts, derive request ownership from the
ordered retained records, separately for each conversation. A message record
or feedback record with turn:null begins the records for one request. Stop
before the next such initiating record in that same conversation. Selection,
reference and non-null feedback acknowledgement records do not begin a request.
Records of another conversation do not end this request's records.

Associate a request only with an agent_prompt outcome saved by Core named
turn:N. Use Core's existing event parser and parsePromptRecord API. That outcome establishes
the turn association even if it reports failure; it does not itself establish
completion or acceptance. No owned outcome means an unknown association, even
after a successor completes. Multiple turn outcomes for one request
refuse through the existing explicit history refusal; do not choose one.

Exact text may validate the request, but cannot move an outcome across its
boundary. A recovered-feedback record immediately before a message is superseded
as the initiating boundary by that message. The following prompt belongs to the
person's request; the recovered context can still be delivered with that same
request under the existing exact-input delivery contract. Preserve the passing
recovered-work and missing-marker controls.

Use the same ownership rules for detached projection and live lookup. The
Architect delegates helper structure: a private helper is appropriate if both
consumers need it. Do not create a second journal, counter, public API or
replaceable context account of ownership.

## 2. Separate the private read fields

Keep history.ts's wire schemas, parsers and existing bytes unchanged.
MessageRecord.turn is the retained message ID. ReferenceRecord.turn
names the corresponding message ID. Document these meanings; do not
rewrite either record after acknowledgement or migrate the file.

Change only the person variant of SidekickChatItem to expose:

```ts
{
  readonly kind: "person";
  readonly conversation: string;
  readonly message: number;
  readonly turn: number | null;
  readonly text: string;
}
```

message reads MessageRecord.turn; turn is the association established from
Core's saved records for this request, or null. The identity is conversation-scoped and need not be contiguous. Incomplete
and reply variants keep their turn fields and existing semantics.
The projector keeps record chronology rather than regrouping by these numbers.

In owner.ts, derive the next message ID from retained message IDs and
recorded attempts. Do not count nullable person.turn as the message ID.
Local response IDs remain local IDs. SidekickTurn.turn becomes number | null:
a failed cycle without an owned outcome saved by Core returns null, not a prediction.
A completed cycle returns its actual turn.

## 3. Bind live outcomes and orientation to the request

Replace this PR's private canonicalTurn helper with turnForRequest, using only
the records for the current request instead of the unbounded latest-identical-input search. The owner writes the initiating record before
handle.prompt; retain its identity/position for the lookup using ordinary private
bookkeeping. A successful prompt without an owned completed outcome saved by Core
must refuse response publication. Remove predicted-turn fallback from that
publication path. Failure preserves its existing reporting but claims no
turn where none is retained.

For orientation, first associate ReferenceRecord's message ID with
that message and its records in the same conversation. Only then inspect the
completed turn's saved input for the supplied reference content. Do not use
ReferenceRecord.turn directly as a turn key in the saved records. Keep the existing
failed-refresh retry, successful refresh, wrong-input refusal and no-repeat
orientation behavior.

The scope's one-request-at-a-time and cancellation/join rules remain unchanged.
No pending request survives as live work on cold reopen. Do not add terminal
labels, grouping UI, provider identity changes or native-session replacement.

## Frozen evidence

Extend R2m2 in packages/cli/tests/repl-sidekick-recovery.test.ts through its
existing real subprocess phases. Adapt readingOf in
tests/fixtures/repl/issue-883/recovery-phase.ts to report the person's message
field and the conversation's established orientation from production reading;
do not calculate either association in the test harness.

| Row | Required observation |
| --- | --- |
| MC1 — existing cold reopen | The first message retains its local message identity and turn:null. Cold reopen still performs zero provider work and zero appends. |
| MC2 — existing explicit successor | Both messages stay in acknowledged order with distinct local identities. First remains turn:null; second associates with turn 1; Two. remains reply@1. Neither ordinal equality nor the later outcome associates the first message. |
| MC3 — orientation on that successor | The second request carries its required orientation. Production reading establishes those supplied versions through the second message's actual turn despite its different message ID. Reuse the existing second-turn orientation control to show the orientation is not supplied again once established. |
| MC4 — original R2m2 contract | The held first turn append, accepted turn and durable native-one assertion remain observed; explicit new work reaches the same native identity without replacement or resending the first message. |

Keep existing ordinary, failure, configuration and feedback cases as surrounding
controls. Update assertions or fixture reporting that used person.turn as a
local identity to state the accepted distinction; report each adaptation. Do
not weaken response ownership established by Core's saved records, exact-input delivery or failed-turn
projection. Request boundaries, same-conversation filtering, ambiguity refusal
and the live no-guessed-publication path are required code-review checks, not
permission to expand the crash matrix.

For the changed association, restore the old message-ID-as-turn projection or
remove the request bound once and show MC1/MC2 fail while the ordinary R2m control
continues to pass. Verify the mutation really applied. Keep the independent
unknown-acceptance refusal/control from its companion prompt.

## Focused commands and feedback

Use the companion refusal prompt's three explicit commands: the unknown probe,
the unchanged original recovery-contract probe and the seven-file Sidekick plus
repl-history selection. That selection already covers the new MC observations,
ordinary/failure responses, metadata, questions, Stop and configuration. Also
run its six unchanged metadata/startup/join/receipt/contract/owner probe commands.
No new full suite, adapter/workflow selection, check, lint or CI prerequisite is
added. If session.ts changes, the companion's controller-consumer selection
still applies; no session change is required by this amendment.

Align the affected architecture.md and specs/repl-spec.md prose with these
implemented meanings, including the history module comments. Do not add roadmap
language or alter the accepted creation-policy contract.

Commit promptly once this finite evidence and the refusal correction pass.
Return the exact signed SHA, parent, branch, tree status, every focused command
and result, MC1–MC4 observations and any private fixture/type adaptations.
Preserve first failures and report environment restrictions separately. Stop
for Planner review; do not resume section 5 or declare R2 complete.

## Continuity

Exact implementation base: 87b25a40915a697a580e619072d433c9c676fec0.
Latest fully accepted implementation head: 2cd17192. Produced planning artifact:
this handoff, linked from the main planner-handoff.md and companion refusal
prompt. Message identity, request ownership, nullable association and reference
delivery are settled by the Architect decision. Creation-policy compatibility
remains separately unresolved. All earlier accepted increments stay closed.
No production code changed while planning. No push, GitHub write, CI inspection
or memory restructuring is authorized.
