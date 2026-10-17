# Planner review: R2 correction at 87b25a40

REQUEST CHANGES at `87b25a40915a697a580e619072d433c9c676fec0`, parent
`14ee0d8ed2cf98468e8968fa766f2fb5bfafecf9`, branch agent/issue-883-pr2.
The signature verifies G and the implementation worktree is clean. One assigned
refusal path remains missing. Creation-policy compatibility separately remains
with the Architect. R2 and the complete CLI slice are not accepted.

## Corrections that pass

P1's actual interruption is now demonstrated. R2m2 holds the canonical turn:1
Prompt append after acceptance and a native-one assertion saved through
createAcpxSessionStore. The private state directory exists before saving, and
assertedSessions observes the save completing rather than sleeping. Only the
provider's canonical account survives the child. Cold reopening performs no
provider work or appends; explicit new work reaches the same native identity
without resending the interrupted message. R2m remains its ordinary control.
Pruning the private provider account in R2n is accepted fixture preparation for
the existing late-assertion path; it preserves the native mismatch and
multiple-identity refusal rather than weakening either.

P2's missing-marker recognition now occurs in production. The projector retains
null offers, checks later completed canonical input in the same conversation,
and recognizes the missing-marker delivery. An unmatched offer is exposed as
unestablished rather than dropped. The non-null marker check stays intact.

P3's assigned continuation now carries the acknowledged EntryInput and
interrupted Elicit in operation order, through the existing result renderers,
beside the actual current draft and new message. The old fill is not restored,
no suffix runs, and no question or answer is invented. The exact request is
retained for canonical delivery establishment. The original independent probe
passes all three steps unchanged. These corrections stay closed in the next
round.

## P1: unresolved acceptance does not stop continuation

The previous correction prompt explicitly requires reconciliation or refusal
when acceptance of a provider turn cannot be established. storage-contract.md
states the same rule: an unknown accepted-provider-turn status is canonically
reconciled or refused. Reporting unknown in a detached reading supplies the
observation; it does not implement the refusal.

R2q unknown now reaches the right state: the provider accepted feedback turn 2,
its canonical record never landed, and the cold reading holds
unestablished:[{conversation,turn:null}]. Its next arm nevertheless asserts
next.sent === true for a new message. owner.message/cycle/holding/respond never
uses unestablished to refuse that continuation. The new provider prompt runs
while the old acceptance remains unresolved. Avoiding a resend does not settle
the unknown accepted-turn status required by this contract.

The independent pr2-recovery-unknown-probe-87b25a40.test.ts uses the committed
subprocess phases without changing production. Its regression fails with
Expected:false / Received:true. The child's actual result reports prompts:1
and the same unresolved offer after sending "carry on". The paired control,
stopping after canonical completion but before the local marker, establishes
delivery and successfully sends one new turn. This distinguishes the missing
refusal from suppressing every continuation.

Refuse explicit work on this unresolved active conversation before opening a
provider session, writing a message/reference or starting a prompt, unless the
canonical facts first establish the pending delivery. Keep cold projection pure
and preserve the unresolved fact. A new message is not authority to disregard
it. Do not add a retry, resend, guessed marker or replacement conversation.
No new architecture decision is needed for this already assigned refusal.

## Reported message ordinal divergence

The report is confirmed by the focused log. After R2m2, chat reads:
person@1 "first", person@2 "second", reply@1 "Two."; the only canonical Prompt
is turn:1 carrying "second". nextTurn counts local person intents as well as
canonical attempts, while person.turn is projected directly from that predicted
value. Reply.turn comes from the canonical record.

The current projector keeps acknowledged record order and does not pair chat by
turn, so this is not a demonstrated ordering failure in the current presentation.
However those fields cannot safely be treated as one canonical correlation key.
The storage contract names message/turn correlation without defining this
interrupted-intent distinction. The narrowly scoped
pr2-recovery-message-correlation-architect-return.md asks the Architect to define
that meaning before a consumer relies on it. This review does not authorize the
Implementor to choose a new record/interface or rewrite an old intent. It is
separate from the demonstrated unknown-acceptance refusal.

## Evidence

All fourteen frozen commands were rerun, plus the unchanged recovery probe.
Thirteen commands pass independently: 111 tests/489 steps. The two broader
environment failures recur and are not counted green:

| Selection | Independent result |
| --- | --- |
| bound agent probe | 1 test / 2 steps |
| Core four agent suites | 12 / 67 |
| ACP host-conversation | 1 / 4 |
| Sidekick configuration, journey, lifecycle, controls, recovery, storage; repl-history | 27 / 154 |
| Sidekick output; entries, route, lifecycle, agent-journey | 38 / 146 |
| forms, presentation-style | 25 / 96 |
| six unchanged metadata/Stop/feedback/owner probes | 6 / 17 |
| unchanged recovery-contract probe | 1 / 3 |
| plan/adapters/agent-options selection | exit 1; 6 tests/92 steps pass, 3 tests/16 steps fail; registry DNS and disabled __proto__ errors |
| workflow selection | exit 1; npm-cache EPERM and resulting adapter/pending-event-loop failures |

The Implementor's all-green command report is separate evidence. First outputs
here are pr2-recovery-review-87b25a40-{bound,core,acp,focused,consumers,forms,
adapters,workflow,metadata,startup,join,receipt,contract,owner,recovery-probe}.log.
The new refusal probe exits 1 with its regression failing and its control
passing; its complete first output is
pr2-recovery-unknown-probe-87b25a40-first.log. Earlier probe files and failure
outputs are preserved. Mutation controls were not repeated. No full suite, CI
inspection or GitHub action informs this verdict.

## Continuity

Follow pr2-recovery-unknown-implementor-correction.md for the finite remaining
correction. Preserve this commit and the passing corrections. The existing
creation-policy Architect return stays open; the message-correlation return is
separate. Latest fully accepted head remains 2cd17192. Earlier accepted
configuration, questions, Stop, feedback, metadata, admission and R2 cases 1/3/4
remain closed. Section 5, program binding, remaining R3/R4/R5 integration, full
terminal R7 and the capture packet remain incomplete. No production file was
changed during this review; no push or GitHub write is authorized.
