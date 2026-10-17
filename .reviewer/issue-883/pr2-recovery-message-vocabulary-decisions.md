# Message correlation vocabulary decisions

The Product Owner accepted all three descriptions after individual interviews. These
wording decisions do not change the accepted correlation architecture, wire
schemas, field names or MC1–MC4 evidence. Exact implementation base remains
87b25a40915a697a580e619072d433c9c676fec0.

## 1. Message ID — accepted

The Product Owner accepted message ID for the number saved with a person
message. It is scoped to the conversation, fixed once saved and may have gaps.
It is not a list index. The pair (conversation, message ID) forms its lookup
key. Canonical turn association is separate and can be unknown.

The approved terminology entry is recorded in architecture.md:

> message ID: the number Sidekick retains to identify a saved person message
> within its conversation; fixed once saved, possibly noncontiguous, and
> independent of the turn numbers recorded by Core. The conversation and message ID
> together form its lookup key.

Use message ID in the affected #883 descriptions instead of claim as the
technical name of this number. Preserve MessageRecord.turn's existing wire
spelling and person.message's accepted private read field. Ordinary English
uses and unrelated Core identity names are outside this wording correction.

The Implementor carries this exact approved entry into the implementation
worktree's architecture.md with the correction; do not copy unrelated changes
from the main worktree's architecture.md.

## 2. Feedback text and reference text — accepted

The Product Owner accepted feedback text or reference text according to the
contents, and dropping offer as a technical term. Response continues to mean
the agent's reply; this text is sent to the agent. Delivery intent is not an
accepted replacement and adds no needed concept.

Describe when the text was saved and whether delivery was confirmed. Saving
the text before a turn does not prove the agent received it. Canonical turn
facts continue to supply that evidence. The feedback and reference record
schemas, payloads and delivery rules are unchanged.

Use these descriptions in the affected #883 prose, comments and private names.
No new shared offer abstraction, registry entry or generalized delivery type
is needed. The accepted ordinary descriptions use the existing record and text
concepts; this does not rename serialized fields or the agent response.

## 3. Records for this request — accepted

The Product Owner accepted records for this request instead of introducing
request interval as a named concept. Describe the actual boundary: start with
the saved initiating message or feedback record with turn:null, and read up to,
but excluding, the next initiating record in that same conversation. Only a
saved turn outcome from Core among those records can establish this request's turn.

This wording changes no ownership, lookup or refusal rule in the Architect
decision. Do not introduce an Interval abstraction or a new registry entry.
Private helpers and types describe the request and its existing records; their
ordinary structure remains delegated under the implementation handoff.

## Implementor action

All three vocabulary choices are settled. Resume the authorized correction from
87b25a40 under the correlation handoff and companion unknown-acceptance refusal
prompt. Apply the approved descriptions in the affected #883 prose, comments,
private type and union member, preserving every accepted field and wire schema.
Carry the approved message ID terminology entry and the turn entry accepted in
[the subsequent interview](pr2-recovery-turn-vocabulary-decisions.md). No repository-wide language
sweep or additional test matrix is assigned. The wording no longer blocks the
feedback commit: run the frozen evidence, commit promptly and return the SHA.

The earlier Planner disposition remains an unapproved historical proposal.
Creation-policy compatibility stays separately with the Architect; R2 is not
complete until that ruling and its evidence are supplied. No production code,
tests, commit, push or GitHub mutation occurs as part of this terminology record.
