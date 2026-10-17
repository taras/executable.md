# Separate person messages from turns

The Product Owner accepted this behavior on 2026-10-12:

```text
Saved message "first"  --> turn association unknown
Saved message "second" --> turn 1 --> reply "Two."
```

The messages stay in acknowledged order. A missing saved outcome does not
mean the first message was unsent or rejected. Equality between a message ID
and a turn number never establishes a relationship.

This resolves the architecture question returned in
[pr2-recovery-message-correlation-architect-return.md](pr2-recovery-message-correlation-architect-return.md)
against `87b25a40915a697a580e619072d433c9c676fec0`, parent
`14ee0d8ed2cf98468e8968fa766f2fb5bfafecf9`. It is an architecture amendment,
not an implementation PASS or an additional failure verdict on current chat
ordering. The implementation worktree remains clean and unchanged.

The subsequent individual vocabulary interviews settle the wording below:
message ID, feedback text/reference text, records for this request, and turn
(saved turn when that distinction matters). The turn recorded for this request
describes the association; it is not a separate kind of turn.
See [the vocabulary decisions](pr2-recovery-message-vocabulary-decisions.md).
See also [the completed turn interview](pr2-recovery-turn-vocabulary-decisions.md).
These wording changes preserve the accepted architecture and wire contracts.

## Use the retained request boundary

No new durable record family or Core API is needed for this association. The
existing ordered history already supplies the boundary, under the accepted
single-writer, one-request-at-a-time and cancellation/join contracts:

1. A person-message record begins the records for that person's request in its
   conversation. A feedback record (`kind: feedback`, `turn: null`) begins the
   records for a feedback request. Conversation selection and reference records
   do not open a provider request.
2. A later message or feedback record with turn:null in that same conversation
   ends the earlier request's records and begins its own. A feedback delivery
   acknowledgement with a non-null turn does not open a request.
3. An `agent_prompt` outcome saved by Core named `turn:N` among the request's records
   establishes that request's turn identity. Its input saved by Core
   and result remain authoritative for what was sent and how it ended.
   Association alone does not claim completion or provider acceptance.
4. A request with no such outcome saved by Core has no established
   turn association. Do not search beyond its next request boundary to fill
   the gap. Do not select between multiple turn outcomes in one
   request; that contradicts one prompt per request and requires the existing
   explicit history refusal.

Filter boundaries by conversation. A recovered-feedback record written before
a person-message record is superseded as the initiating boundary by that
message before the prompt starts. It does not turn the ensuing person request
into a different message.

For R2m2 the retained ordering itself distinguishes the requests:

```text
message: first
    |  no saved outcome from Core
    |
message: second           <-- ends records for the first request
    |
saved turn:1   <-- belongs to the second request
    |
response for turn:1
```

This is an exact ownership boundary, not text matching. Identical message or
request text does not allow an outcome to cross it. The owner already writes
the initiating record before handle.prompt and refuses overlapping message
cycles. Core's prompt scope joins its turn before the call finishes or its
cancellation returns. A successor cannot retain its initiating record while
the predecessor still owns a late turn append.

## CLI-private read contract

Retain existing bytes and their strict wire schemas. In particular,
MessageRecord.turn remains the existing message ID for compatibility; document
that it is not a turn identity. Do not rewrite it after acknowledgement.
ReferenceRecord.turn identifies the corresponding message ID as well.

The person variant of SidekickChatItem separates those meanings explicitly:

```ts
{
  readonly kind: "person";
  readonly conversation: string;
  /** The retained message ID, independent of turn numbering. */
  readonly message: number;
  /** The turn among the records for this request, or unknown. */
  readonly turn: number | null;
  readonly text: string;
}
```

`message` reads the existing MessageRecord.turn. It creates no new counter and
does not promise contiguous message numbering. Its identity is scoped to the
conversation. `turn` reads the association established from Core's saved records defined above. Incomplete
and reply chat variants retain their existing turn identity and
semantics. A reply belongs to its completed turn, independently of
whether the person variant precedes a chain of feedback turns.

The owner continues deriving its next message ID from retained message IDs
and recorded attempts, rather than counting the newly nullable
person.turn. Local response IDs remain local IDs, not proof of a recorded turn. The
failed-cycle SidekickTurn.turn is likewise `number | null`: a failure before a
saved outcome from Core returns null, never a predicted turn number.
Completed-cycle values continue to carry the actual turn.

Replace the private canonicalTurn helper with turnForRequest, using only
records for the current request rather than an unbounded latest-identical-input lookup. A successful prompt without an owned
completed outcome saved by Core cannot publish a response against a guessed turn.
The exact input saved by Core may validate the live request, but text equality
alone cannot choose its owner.

Reference records retain their current payload and message ID. Establish the
turn through the associated message's records, then use the
completed turn's saved input to verify the supplied reference content. Never use
ReferenceRecord.turn directly as a turn key in the saved records. This preserves the accepted
orientation behavior when local and recorded turn numbering diverge.

These are CLI-private projection and bookkeeping changes implementing the
accepted distinction. Architecture rule 2 delegates their helper structure;
the existing storage contract delegates private schema names. This amendment
prescribes their identity and absence semantics without broadening the public
Core prompt contract or changing provider ownership.

## Finite evidence and handoff

The Planner incorporates this amendment into the current R2 correction. Extend
the existing R2m2 observation to show:

- Cold reopening retains the first person message with its local message
  identity and turn:null, without provider calls or appends.
- After the explicit second message, both messages remain in order and retain
  distinct local identities. The second has turn 1; the first still
  has turn:null. The reply remains owned by turn 1.
- The second request carries its own orientation through that same
  association when required, despite the different message ID.
- Existing native-conversation continuity and no-resend observations remain
  intact.

Use existing ordinary, failure, configuration and feedback controls for the
surrounding behavior. This assigns no new crash or permutation matrix. Planner
owns the exact focused command selection and stable feedback commit; Architect
has not run tests or accepted an implementation here.

No new terminal label or grouping UI is assigned. The eventual reader uses
association established from Core's saved records only when present and preserves chronology when absent.
No wire migration, extra persistence record, second turn counter, provider
identity change, implicit replay or native-session replacement is authorized.

The independently assigned unknown-acceptance refusal correction can proceed.
Creation-policy compatibility remains a separate unresolved Architect return.
No production change, push, GitHub write or CI inspection occurs in this ruling.
