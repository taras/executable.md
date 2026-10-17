# Message identity and canonical turn association

The reported ambiguity is confirmed at
`87b25a40915a697a580e619072d433c9c676fec0`, parent
`14ee0d8ed2cf98468e8968fa766f2fb5bfafecf9`. The implementation worktree is
clean. The Product Owner accepted the message/turn distinction and its recovery
behavior on 2026-10-12. The resulting architecture amendment is in
[pr2-recovery-message-correlation-architect-decision.md](pr2-recovery-message-correlation-architect-decision.md).
This assessment is not a failing verdict on the current chat ordering.

## What the retained history establishes

The existing R2m2 observation is:

```text
person@1: first
person@2: second
reply@1: Two.
canonical turn:1 carries the request containing second
```

The first person message is acknowledged locally. Its provider turn has no
acknowledged canonical Prompt record. The provider assertion establishes the
native conversation, not the missing message-to-turn association. It does not
establish that the first message was rejected or never sent.

The second person message has local claim 2. Its completed request has canonical
turn 1. Equality between those two numbering domains cannot establish ownership.
The current chat remains in acknowledged record order and does not join them.

Source evidence in the reviewed worktree:

- `packages/cli/src/repl/sidekick/owner.ts:1227`: nextTurn counts canonical
  attempts and retained person-message claims together.
- `packages/cli/src/repl/sidekick/owner.ts:961`: the message retains that
  predicted number before calling prompt.
- `packages/cli/src/repl/sidekick/owner.ts:1249`: canonicalTurn finds a retained
  Prompt by its complete request input; replies use the resulting canonical
  number. This live lookup does not retain a message-to-Prompt link for a cold
  reader.
- `packages/cli/src/repl/sidekick/model.ts:479`: person projection copies the
  local number unchanged. Response projection checks its canonical completed
  turn separately.
- `packages/cli/src/repl/sidekick/history.ts:1100`: EventRecord.sequence
  addresses canonical events in a conversation. It neither names a person
  message nor reserves a sequence for that message before provider work.
- `packages/core/src/agent/conversation.ts:898`: Core persists the request
  under its own canonical turn name. Its accepted prompt API returns
  Result<string>, without a message identity.

The existing focused log confirms the chronology above. No tests were rerun,
and no CI was inspected for this assessment.

## Boundary interview

The trigger is the meaning and absence semantics of a retained association:
message admission and canonical turn acknowledgement are independently
meaningful facts. The architecture and product-interface rulebooks require
Product Owner review where that boundary is unresolved.

The narrow inventory has three parts:

1. Identity of an acknowledged person message, independent of provider work.
2. Association of that message with a canonically recorded provider request,
   including an unknown association after interruption.
3. Ownership of a reply by its canonical completed turn, which is already
   established and remains unchanged.

Accepted interview item: separate message identity from canonical turn identity
and preserve the observable recovery behavior below.

Proposed behavior:

- Keep `first` visible in its original position. Its canonical turn association
  is unknown; do not label it unsent, rejected or completed from this history.
- Keep `second` visible after it. Establish that canonical turn 1 carried this
  request and that `Two.` is its reply. Never attach that reply to `first`
  because a locally predicted number happens to equal 1.
- Treat the existing MessageRecord.turn as a local claim, not canonical proof.
  Any exposed canonical association must distinguish unknown from a real turn.
- Use retained identity and an exact request boundary to establish the link.
  Do not infer it from matching message text, equality of ordinals or an
  unbounded search for the latest identical request. Decide whether existing
  ordered request boundaries suffice before adding an explicit association
  record. No new Core API or second turn counter is assigned by this proposal.

No wire schema, migration, projection signature or new UI label is approved by
this assessment. Existing records remain untouched. ReferenceRecord.turn also
uses the local prediction; it must be considered when specifying the eventual
association boundary so orientation offers do not silently acquire a different
meaning. That observation does not reopen the accepted orientation content.

## Proposed finite verification

Extend the existing R2m2 observation rather than adding a crash matrix. After
cold reopening and the explicit second message, verify that both messages remain
in order, the first has no established canonical turn association, and the
second is associated with canonical turn 1 and its reply `Two.`. Preserve the
existing same-native-conversation and no-cold-work observations. The first
message's provider acceptance remains unknown in the local history.

The Product Owner accepted this behavior with the message/turn distinction.
The Planner derives its focused assertions from the decision record.

## Continuity

The distinction is accepted. Follow the decision record for the smallest exact
read boundary and Planner handoff. No historical-record rewriting is authorized.

The independent unresolved-acceptance refusal correction can proceed. The
creation-policy Architect return remains separate and unresolved. No production
files, pending implementation, GitHub state or CI were changed.
