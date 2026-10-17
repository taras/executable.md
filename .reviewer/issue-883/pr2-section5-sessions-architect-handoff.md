# Show Sidekick work in Sessions

**Resolved and assigned, 2026-10-14.**
[The completed decision](pr2-section5-sessions-architect-decision.md) settles
the boundary. Execute [the Implementor prompt](pr2-section5-sessions-implementor-prompt.md)
under [the frozen plan](pr2-section5-sessions-planner-handoff.md) from accepted
signed clean 10b17a40. The questions and proposals below are historical; the
decision, not an earlier recommendation, governs implementation.

Settle how Sessions presents Sidekick alongside entry Agent turns. A person
needs to recognize which work belongs to Sidekick, read its real conversation,
and keep their entry selection while inspecting it. The accepted plan requires
this integration, but the current Sessions reader assumes every turn belongs
to an entry. The next Implementor assignment needs the rules for the two
histories before it can be frozen.

## Exact starting point

Use signed clean `10b17a40fb07eb2fe623c9b4e4a5259d0501fe9a`, parent
`f8b4e035382e22cf0f19b743dcb3b26f3bd4cc02`, branch agent/issue-883-pr2, in
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`.
HEAD, parent, signature G tarasm@gmail.com and clean/no-untracked status were
independently checked during preparation. Main remains
`e61d6ce072735b5d0cf683eeaca0f2eefddc2d59` with unrelated local edits.
Do not import those edits or implement in main.

The [Preview review](pr2-preview-planner-review-10b17a40.md) is PASS.
Preview, Configure/Retry, questions, Stop, recovery, direct-provider routing,
configuration and earlier accepted work stay closed. This is planned remaining
work, not a finding against the accepted head.

Planning artifacts live in the main checkout's `.reviewer/issue-883`.
No production change, test run, commit, push, GitHub write, CI inspection or
capture accompanies this handoff.

## Governing contracts

- [Section 5 and R8](planner-handoff.md): identify Sidekick in Sessions using
  its real conversation association; combine the entry chronology and Sidekick
  reading at the root; never inject Sidekick events into the entry prefix or
  fabricate an entry key. Historical entry panes stay frozen while Sidekick
  stays current.
- [Canonical conversation observation](core-interfaces-proposal.md#accepted-handle-member-1-of-3-prompt):
  one canonical consumer, exact turn correlation and no synthetic entry key.
- [Storage and recovery](storage-contract.md): independent paired histories,
  unknown message/turn association, no repeated work and no guessed acceptance.
- Implementation `specs/repl-spec.md`, Sessions section: one turn keeps its row
  across publication; actual provider keys filter conversations; background
  work changes neither route nor focus; only an entry's retained marker is a
  position in entry History.
- [Accepted journey 12](remaining-architecture.md#accepted-journey-12-clear-terminal-layout-with-preserved-interaction):
  one narrow outlet, absence of hidden targets, preserved inputs and fixed
  seven-row footer.
- [Accepted Preview ruling](pr2-section5-preview-architect-decision.md): cleared
  source is not a rendered reply, and preview/acknowledgement identities are
  distinct from message IDs and turn numbers.

Follow `.agents/architect.md` and its applicable interface, architecture and
verification rules. Derive conforming details from approved rules. Interview
the Product Owner only where a material choice remains; do not ask again for
already accepted behavior or introduce names for local mechanics prematurely.

## Current implementation trace

All source paths below are relative to the implementation worktree.

1. `packages/cli/src/repl/application.ts`, chronology(), merges entry-model turns
   with `live.agent.slots`. It correlates by entry plus durable name. Both
   `ReplLiveTurn` and `ReplAgentSlot` in `agent.ts` require an actual entry key.
   Their scheduling order is local to the entry Agent observer.
2. application.ts, sessionRows(), offers actual provider conversation keys as
   filters. A recorded turn activates its entry marker; a live turn selects
   Sessions. Its measurement calls the same row builder as the drawing.
3. `route.ts`, selectConversation(), validates a filter against `model.sessions`
   or head-only `live.sessions`. It knows nothing about the Sidekick history.
   `viewFor()` discards live entry facts at a frozen prefix. Sidekick's existing
   presentation is composed separately at the root.
4. `sidekick/model.ts` projects conversation setup, actual saved turn numbers,
   chat and operation facts from the Sidekick file. `SidekickConversation.id`
   is the CLI conversation association, not a provider key obtained by parsing
   that ID. The current detached conversation shape has no native session-key
   member and no collection of full Sessions turn facts.
5. `sidekick/owner.ts` already owns a publisher inside each conversation's
   execution. Its begin handle maps to the exact registered response;
   observe() updates cleared literal Preview; publish() performs the canonical
   append. Installing a second competing publisher would displace that owner.
   Its changes stream already wakes the mounted loop.
6. `program.ts`, sidekickReadingOf(), currently exposes the active conversation's
   chat, busy state, question and settings. It does not supply Sessions turns
   from earlier Sidekick conversations. sidekickChatRows() is a chat
   composition, not a generic Agent-turn history reader.
7. Core's publisher observation carries the exact begin handle and cleared
   source, but explicitly carries no native identity or acceptance evidence.
   A successful publication may carry an association; unsuccessful publication
   may carry none. The saved canonical record and retained conversation checks
   remain the source for facts they actually establish.

## Decisions needed for the assignment

Return exact rules for these four connected parts. Ordinary private helper
names and module splits remain delegated; do not turn them into a public API.

### 1. Order across the two files

An entry can ask its agent while Sidekick is generating, and either may finish
first. Each file records its own order. The current local entry slot order does
not include Sidekick, and the paired files have no shared persisted scheduling
number. Cold reopen cannot recover a global start order from their independent
positions.

Specify what All conversations shows live and after reopening, including prior
Sidekick conversations after an agent replacement. Reconcile that rule with
the existing one-chronology prose. Recommend preserving each history's actual
order and avoiding a new durable ordering record for presentation alone; the
exact combined reading, or an explicit grouping amendment, needs a ruling.
Do not silently label append order or a timestamp as start order.

### 2. Conversation filters and frozen entry History

Specify the evidence that makes a Sidekick conversation selectable before and
after its first saved turn, the identity the existing session query names, and
what happens if an entry and Sidekick refer to the same provider key.
Distinguish a prepared CLI association from a provider-established conversation.
Unknown association stays unknown; it cannot be filled from a message ID,
response name, agent name or entry selection.

Also settle a saved Sidekick filter beside an earlier entry checkpoint. The
entry prefix must stay frozen and Sidekick stays current, while today's route
resolver rejects a conversation absent from that prefix. Define which detached
facts may satisfy that filter without placing Sidekick records in ReplModel.
Reading a prior conversation must not activate it for Send/Retry or switch the
active agent.

### 3. What a Sidekick turn says and where activation goes

Specify the Sidekick label, live/retained status, readable text and action of
its Sessions row. Today's entry rows show a Prompt and provider text, then
navigate to an entry marker. A Sidekick turn has no such entry marker, and its
generated control source is not person-facing chat. Automatic feedback turns
also belong to Sessions without becoming new person messages.

Recommend truthful Sidekick ownership, cleared/evaluated text from the accepted
display path, and no invented History location. Settle the exact activation
behavior, including a row from a previous conversation, without implicitly
reactivating it or replaying chat. Reuse existing navigation where it expresses
that decision; do not add a route member merely to fit the old row shape.

### 4. Observation and settlement ownership

Name the smallest existing CLI boundary that supplies detached Sessions facts
for these rules. Preserve the owner's one publisher, Core's one provider-stream
consumer and exact begin-handle correlation. Live-to-saved publication keeps
one row; cancellation with no canonical acknowledgement invents no saved turn.
Entry permission controls remain owned by their entry; native Sidekick tools
remain constrained by the accepted installation.

Prefer composing existing owner/entry facts at the root. If an actual missing
Core fact requires an interface change, identify the specific consumer and
conduct the required boundary review rather than adding a speculative stream,
coordinator accessor or identity setter. No public widening is preapproved.

## Evidence for the Planner to freeze after the ruling

These are representative boundaries, not a new Implementor matrix yet:

- An ordinary entry Agent turn and Sidekick turn held together, finishing in
  the opposite order: truthful owner labels, ruled order, exact publication
  replacement, no duplicate row and no entry-history injection.
- Actual Sidekick conversation filtering, clear-to-All and unknown-key refusal,
  alongside a selected earlier entry checkpoint: preserved entry selection,
  drafts, focus and current Sidekick facts; activation has the ruled effect.
- Agent replacement followed by cold reopen: both old and active Sidekick work
  are readable under the ruled filter/order, with no provider work on reading
  and no implicit conversation reactivation.
- Failed saved turn versus Stop before acknowledgement, including the accepted
  message-ID/turn-number divergence: truthful association, no invented record,
  source or navigation, and no collision with an entry's turn.
- A mounted no-input Sidekick update while Sessions is selected, plus an
  ordinary entry control; windowed rows and hidden-target absence at the three
  supported profiles, preserving the footer and both composers.

Use the real mounted program and existing `issue-883/mounted-program.ts` harness
with controlled transport. Reuse actual provider/append gates; no sleep proves
readiness. Likely test destinations are repl-sidekick-presentation.test.ts,
repl-agent-interface.test.ts, repl-route.test.ts and the affected owner/recovery
tiers. The Planner chooses the finite rows and proportional commands after
the ruling; do not instruct the Implementor to choose the acceptance threshold.

## Return and next action

Record the decision at
`.reviewer/issue-883/pr2-section5-sessions-architect-decision.md`. Carry accepted
product answers, governing rules, exact composition/identity/lifetime boundaries,
absence/failure behavior and any required specification amendment. Separate an
unresolved product question from a conforming architecture decision.

Then return to the Planner through
[the continuation prompt](pr2-section5-sessions-planner-prompt.md). The Planner
freezes the Sessions plan and self-contained Implementor prompt from accepted
`10b17a40`; no implementation assignment is released by this handoff alone.

Preview and earlier acceptances stay closed. Complete terminal R5–R8
reconciliation, the 36-frame capture packet and delivery remain separate.
No push, GitHub write, CI inspection, capture, dependency change or shared-cache
repair is authorized here.
