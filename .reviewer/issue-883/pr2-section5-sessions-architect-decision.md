# Sessions integration: architecture decisions

Status: architecture and product decisions complete; ready for the Planner to
freeze the bounded Sessions assignment. This record does not itself release an
implementation assignment. Preview and earlier acceptances remain closed.

Reviewed starting point: `10b17a40fb07eb2fe623c9b4e4a5259d0501fe9a`, parent
`f8b4e035382e22cf0f19b743dcb3b26f3bd4cc02`, branch `agent/issue-883-pr2`.
HEAD, signature G (`tarasm@gmail.com`) and clean worktree were independently
verified. Implementation remains unchanged.

## Accepted: two sections, each in its own order

The Product Owner approved separate **Entry agents** and **Sidekick** sections
under Sessions. Each contains saved and running work and preserves its own
history order. Previous Sidekick conversations remain readable after an agent
change. Conversation filtering narrows the view.

```text
Sessions
  All conversations

  Entry agents
    Entry 1 · summarize logs     completed
    Entry 2 · inspect failures   streaming

  Sidekick
    Explain these results       completed
    Try another approach        generating
```

Entry agents keep their existing ordering contract: previously saved turns
follow their recorded order; turns this process observes keep their scheduling
positions across publication. Sidekick keeps its own history order across
conversations, including conversations preceding an agent replacement. A live
Sidekick turn occupies its position in that section and its acknowledged record
replaces it once. Cold reopening uses the order the respective histories hold;
it does not reconstruct a shared scheduling order.

The two files have no shared persisted scheduling number. No timestamp,
completion order or append order is presented as a global start order. No new
durable ordering record is required solely for this presentation.

The Sessions section and the later entry-only chronology statement in
`specs/repl-spec.md` need an explicit amendment: Sessions has two labeled
sections rather than one interleaved chronology. The existing ordering contract
continues within Entry agents. This amendment is approved product behavior,
not an implementation interpretation of the old prose.

This follows architecture rules 3 and 9: reuse existing histories and compose
their detached readings at the root. It preserves the accepted separation of
entry History and current Sidekick facts; Sidekick records never enter
`ReplModel` or acquire fabricated entry keys.

## Accepted: selecting a turn opens its chat

Selecting a Sidekick turn opens the chat containing it in the Sidekick pane and
brings that turn into view. The current conversation keeps its usual controls.
An older conversation is read-only and offers **[Back to current chat]**.
Reading an old conversation does not change the active conversation or agent.
It offers no Send or Retry into that conversation. The message draft and entry
selection remain preserved; returning restores the current chat and its draft.

This is deliberate navigation. Background work never selects a conversation,
opens the pane or takes focus. It follows architecture rules 9, 13 and 21:
the root owns the reading selection, Freedom owns focus, and the narrow layout
mounts only its selected reading.

An old chat is a reading of acknowledged history. Opening it starts no provider,
performs no generated program and creates no history record. Pending questions,
configuration and execution controls belong to the current conversation and do
not become controls over the old chat.

## Derived: actual conversation filters beside entry History

The existing `session` query continues to mean the actual provider conversation
key. It filters both sections. If entry and Sidekick turns name the same key,
both remain visible under their respective owner labels. Their rows are not
merged. All conversations removes the filter and includes work whose provider
conversation is still unknown.

A prepared or activated CLI association alone does not establish a provider
key. A message ID, response name, turn number, agent name or spelling of the CLI
association cannot supply it. A nonempty key read through `parsePromptRecord()`
from an acknowledged canonical Prompt record is evidence for that saved turn,
including a failed or cancelled turn whose record names a key. An exact
successful `AgentPromptPublication.association` can supply the key for its own
live turn before append acknowledgement; it does not make that turn saved.
Without either fact, the turn has no provider filter membership. An earlier
turn's key is not substituted for evidence about a later turn.

Filter choices include keys established by the complete current Sidekick
reading and its exact live publication facts, even beside a frozen entry
checkpoint. Entry facts still come only from the selected entry prefix; live
entry facts remain head-only. Consequently a Sidekick filter can be valid where
the frozen entry prefix contains no such conversation. An entry-only key absent
from that prefix remains unavailable there. A key absent from all applicable
facts refuses rather than silently producing an apparently empty conversation.

Root composition passes these separate availability facts to route validation
and screen drawing. It does not add Sidekick turns to `ReplModel`, thaw the entry
prefix or obtain history by opening a provider. Selecting or clearing a filter
preserves the entry/scopes, checkpoint, drafts and selected surface. Background
changes leave route and focus alone.

This derives from the accepted actual-key filtering and independent-history
contracts, plus architecture rules 3, 9 and 15. It needs no new Core observation
member: the present publisher and canonical Prompt records supply the facts
they actually establish. No live `started` event is claimed where this owner
has not received one.

## Accepted: copied locations reopen the selected chat

The Product Owner approved reopening the same older read-only chat from a
copied REPL location, consistent with remembering a selected entry. Opening that
location sends nothing and does not switch the active conversation or agent.

## Accepted public location boundary: one new member

The accepted older-chat reading needs an exact CLI conversation association,
including chats whose first provider turn never produced a saved record. The
current public location has no member for that reading: `session` names a
provider key, and `view=sidekick` selects the pane rather than an individual
saved chat. Reusing either as the CLI association would change its meaning.

This triggers the Architect's system-boundary review because it adds a durable
reading selection to the public location. There is one new member in scope;
the meanings of `session`, `view`, `right`, entry scopes and `at` remain intact.

Accepted query, using the Product Owner's chosen name:
`sidekick=<saved-chat-id>`. This replaces the proposed `chat=` spelling; there
is no alias.

Accepted route member:

```ts
/**
 * The saved Sidekick chat to read, by its CLI conversation ID.
 *
 * Absent follows the current chat. Selecting one changes only the reading;
 * it never changes which conversation Send or Retry may continue.
 */
readonly sidekick: string | undefined;
```

Its owner is the root, its lifetime is the location's reading selection, and its
value names a conversation association already saved in this execution's
Sidekick history. It can name a saved chat even where no provider turn was
acknowledged. It grants no provider or execution capability.

The complete boundary is the existing location plus this member:

```text
xmd://repl/<execution>/<entries|sessions>[/<entry>][/<scope>]*[/+<drawer>]*
  [?at=<marker>][&inspect][&draft=<text>][&session=<provider-key>]
  [&view=sidekick][&right=bindings|sidekick][&sidekick=<saved-chat-id>]
```

These existing neighboring members keep distinct meanings:

| Member | Meaning |
| --- | --- |
| `session` | Filter Sessions by an actual provider conversation key. |
| `sidekick` | Select a saved CLI Sidekick chat for reading. |
| `view` | Select Sidekick as the explicit reading, including in a narrow frame. |
| `right` | Remember the right-hand tab. |
| Entry scopes and `at` | Preserve the selected entry and its History position. |

The existing codec percent-encodes the new value and puts it after the existing
query members. Old locations retain their spelling and meaning. Empty,
duplicate or unreadable values refuse. Resolution requires an exact association
in this execution's readable Sidekick history; an unknown ID refuses without
falling back to the current chat or creating one. Missing or unreadable history
uses the established storage refusal, not a manufactured empty reading. A
prepared or failed association is readable with its actual setup status; it
does not become a provider conversation or an active Send target.

Omission follows the current chat. An explicit ID pins the reading to that
association. It has the usual controls only while it is the actual active
association; otherwise it is read-only. A stored location grants no right to
continue an old conversation. Send, Retry, Configure and question actions retain
their existing owner checks; no action trusts the selector as authority.

Activating a Sidekick row sets `view=sidekick`, `right=sidekick` and the row's
exact saved chat ID. It preserves `session`, the left surface, entry/scopes,
History and drafts. Bringing the chosen turn into view is ordinary process-local
window navigation; the copied location promises the same chat, not an exact
scroll offset or a reconstructed ephemeral preview. **[Back to current chat]**
clears `sidekick`, keeps the Sidekick pane selected and restores the current
message input. Selecting Entries, Sessions or Bindings keeps the chat selection
available for returning, while retaining the existing `view`/`right` rules.

A successful agent change initiated from the current chat returns to the new
current chat by clearing this selector; a failed change preserves the prior
reading and active association. Background changes never retarget an explicitly
selected older chat. A read-only chat contains no Send, Retry, Configure,
pending-question or Stop controls addressing that old association. The return
control stays reachable outside the scrolling transcript. Existing Exit and the
ways back to current work remain available.

This is the only public widening approved here. It is justified by reopening a
selected old chat, including one with no known provider key, rather than by the
shape of an existing entry row. No Core interface, provider method or durable
record format changes.

## Derived: truthful Sidekick rows

Where Sidekick is installed, Sessions shows the two accepted sections in fixed
order: Entry agents, then Sidekick. An empty section says it has no turns;
unreadable history displays its refusal instead of claiming emptiness. With no
Sidekick installation, ordinary entry Sessions behavior remains unchanged.
Filter choices follow the sections' order and each section's own first-observed
key order, with a duplicate provider key offered once. No shared observation
clock is inferred across the files.

Every Sidekick turn identifies its owner as **Sidekick** and its own agent and
chat. Agent metadata comes from that chat and canonical turn, never from
whichever agent is active now. A person's request uses the exact associated
saved message for its title. An automatic follow-up is labeled **Automatic
feedback**; its machine input, bootstrap and reference chapters do not become a
person message or person-facing chat. Canonical turns without a proven person
association remain turns without one.

Progress and recording are separate facts. Before publication the row reports
only the phase the owner actually observes: a pending request, generation or
evaluation. A saved Prompt establishes its own completed, failed or cancelled
status. It does not prove that the returned program was evaluated successfully.
While evaluation is in progress, the row can say so even though the provider
turn is saved; an evaluated response supplies the rendered outcome and failure
when present. No row claims provider `started` evidence that this owner never
received.

Readable text follows the accepted Preview path: cleared literal Output while
generating, actual evaluated Output once available, and the existing safe
incomplete projection for a saved failed/cancelled attempt. A withdrawal removes
live text. Raw generated XMD, feedback envelopes and tool/control input never
substitute for a chat body. A controls-only response still has its turn and
status; it need not invent a textual reply.

A saved completed Prompt with no evaluated-response record is shown as such:
**Turn saved; no evaluated reply recorded.** Opening its chat exposes this
inert status at the selected turn, not a replay or a fabricated reply. The same
principle supplies a readable anchor for automatic feedback turns and failed
turns even when they have no rendered body. These are display facts, not new
chat-history records.

Sidekick rows have no entry marker and never navigate to a guessed one. Entry
rows keep their existing marker activation and permission behavior. Saved
Sidekick permission audit, if any, is inert; this integration installs no native
Sidekick permission UI and does not change its constrained provider setup.

## Derived: one owner supplies the facts

The existing `sidekick/owner.ts` publisher remains the sole publisher in each
Sidekick execution. Extend that owner's detached reading and the pure
`sidekick/model.ts` projection for Sessions. `program.ts` composes them with
entry facts for `application.ts` and `route.ts`; components receive immutable
data and send semantic actions to the root. Private helper names, internal CLI
fact shapes and module splits remain delegated under architecture rule 2.

```text
Entry history + entry observer ----> Entry agents section
                                            |
                                            v
                                      root composition
                                            ^
                                            |
Sidekick history + existing owner -> Sidekick section + selected chat
                                            |
                                            v
                               one mounted application reading
```

`begin(input)` already receives the canonical input and returns the exact handle
that `observe()` and `publish()` receive. Its existing association with the
registered `ResponseAt` identifies the live row. Begin must announce the row
even when the turn produces no literal Output; the present `previewing` getter's
empty-text behavior cannot be the test for whether a Sessions turn exists.
Input may establish internal correlation without being rendered as a title.

Keep the existing begin-handle registration, cleared observation, single
provider-stream consumer and one `publication.append()` call. Do not install a
second publisher, wrap a second subscription, add an observer middleware around
the direct provider, or expose a coordinator to obtain display data. A
publication association belongs only to its exact begun row. After append
acknowledgement, the parsed canonical record and the existing request-boundary
reader establish which saved turn the response became. A private reference to
that exact record can bridge the interval before the detached reading refreshes;
it is not a durable identity supplied by the UI.

The existing message/turn divergence rules remain binding. Correlate using the
registered response and exact request records, not matching text, predicted
ordinals, latest-turn selection or arithmetic on message IDs. Saved identities
are scoped by CLI chat and canonical turn/name; live identities are scoped by
their exact registration and remain stable when their own record arrives. Entry
and Sidekick keys have separate owner domains, so an equal provider key or turn
number cannot merge their rows.

Publication replaces the live row exactly once, including a failed saved turn.
An evaluation finishing later updates that same row. A Stop with no acknowledged
Prompt has no saved turn, marker or acceptance claim. Its cleared unfinished
preview may remain only for the lifetime already approved by Preview; cold
reopening invents none of it. Late observations after Stop, replacement or
owner teardown cannot change a different row. Existing storage refusal and
unknown-acceptance recovery remain authoritative.

An actual key observed before append acknowledgement may remain a process-local
known conversation for the owner's lifetime, so a selected filter does not
become a guessed empty conversation when that attempt stops. It still supplies
no saved turn. A cold location containing an exclusively ephemeral key can
refuse because the saved files establish no such conversation.

All Sidekick generations, acknowledgements and evaluated responses wake the
existing mounted loop without input. Pure historical reads start no provider,
open no Core conversation, append no record and evaluate no program. Entry
prefix freezing removes live entry facts only; it never suppresses current
Sidekick facts. The detached facts used for resolution, measurement and committed
drawing must describe the same reading. Windowing, hidden-target absence,
Freedom focus ownership and the seven-row footer remain unchanged.

## Product evidence for the Planner

Freeze a finite matrix for the already accepted behavior, using the real mounted
program and controlled provider/append gates:

1. Hold an entry turn and a Sidekick turn together and finish them in reverse
   order. Show the two sections, truthful progress, one exact live-to-saved row
   per turn and no Sidekick event in entry History. Include a no-Output turn.
2. Filter by an actual Sidekick key beside an earlier entry checkpoint, clear
   to All and refuse an unknown key. Preserve entry selection, drafts and focus;
   keep Sidekick current. An entry/Sidekick shared key shows both owner labels.
3. Change agents, then open a previous turn and cold-reopen its copied
   `sidekick=` location. Show its own agent and chat read-only, no old Send/Retry
   or hidden controls, no provider traffic or writes, and a working return to
   the current chat/draft. Include a known chat without a known provider key,
   and unknown-ID refusal. Old locations still round-trip unchanged.
4. Distinguish a saved failed/cancelled turn from Stop with no acknowledgement.
   Preserve the accepted message-ID/turn-number divergence and stable row
   replacement. Show no fabricated turn, source, person message or entry marker;
   automatic feedback is readable as agent work rather than a person message.
5. With Sessions selected, deliver a Sidekick update without input and observe
   the mounted change. Retain an ordinary entry control and the three-profile
   window/hidden-target checks, seven-row footer and both draft values. Read-only
   chat navigation must not introduce focus targets for its absent controls.

The Planner derives proportional commands and discriminating controls from
these boundaries. Reuse the current mounted fixture and deterministic gates;
no sleeps, new debug API, complete runtime battery or capture packet is required
for this feedback slice. Prior Preview evidence remains accepted and is repeated
only where the changed composition actually touches it.

## Specification amendments and next action

The implementation assignment updates the affected Sessions, location, frozen
History and Sidekick-reading descriptions in `specs/repl-spec.md`, plus the
corresponding CLI reading/location discussion in `architecture.md`. Describe
implemented behavior in the present tense. Replace the single combined
chronology promise explicitly; preserve the existing entry ordering contract.
Document `sidekick` independently of `session`, omission as current chat,
read-only historical activation and pure reopening. No new storage version,
terminology register or Core interface documentation is required.

Governing rules applied: product-interface 1, 3, 4, 6 and 7; architecture 2, 3,
9, 13, 15, 16 and 21; product-verification 2–4. Product choices were interviewed:
two ordered sections, turn activation into chat, read-only previous chat with
**[Back to current chat]**, copied-location restoration, and the Product Owner's
`sidekick=` spelling. The remaining details above apply the accepted ownership,
identity, observation, storage and layout contracts. No material question is
left for the Implementor to decide.

Continue with [the Planner prompt](pr2-section5-sessions-planner-prompt.md) from
accepted signed clean `10b17a40`. The Planner freezes the evidence and writes
the Sessions handoff and self-contained Implementor prompt before implementation
starts. Full terminal acceptance, the 36-frame packet and delivery remain
separate. This Architect turn changes review records only: no source, tests,
commit, push, GitHub write, CI inspection, capture, dependency or cache change.
