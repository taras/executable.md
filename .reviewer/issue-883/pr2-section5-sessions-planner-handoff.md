# Read Sidekick work and previous chats through Sessions

**Accepted at ab681d4a, 2026-10-15.** [PASS review](pr2-sessions-planner-review-ab681d4a.md) closes the frozen SS1–SS7
assignment and all Sessions corrections. Latest accepted signed clean head:
ab681d4acd824665188f2c6ab9997eecbbf178e0, parent 5ce2e2d2. No implementation
or correction remains assigned by this plan. Hold for the next bounded assignment;
terminal completion, captures and delivery stay separate. All instructions below
describe the completed assignment and its history.

**Correction at 5ce2e2d2: REQUEST CHANGES, 2026-10-15.**
[The review](pr2-sessions-planner-review-5ce2e2d2.md) closes all three
production findings and most SS-E1 evidence. Execute
[the remaining evidence correction](pr2-sessions-implementor-correction-5ce2e2d2.md)
from signed clean 5ce2e2d2ca7d4236ff9ceec224cc99dcf365f299. The frozen
architecture and matrix remain governing; no new product interview is needed.
Sessions remains unaccepted. Older starting revisions below are historical.

**Feedback at 4ee4f448: REQUEST CHANGES, 2026-10-15.**
Execute [the correction](pr2-sessions-implementor-correction-4ee4f448.md) from
signed clean 4ee4f44824ce39f41385e70cce107bd0d110ec6c, preserving 10b17a40.
[The review](pr2-sessions-planner-review-4ee4f448.md) reproduces populated-frame,
cross-chat identity and selected-turn reveal failures and incomplete frozen
observations. The architecture and SS1–SS7 below remain governing. The original
starting revision is historical; Sessions remains unaccepted.

Ready for implementation from signed clean
`10b17a40fb07eb2fe623c9b4e4a5259d0501fe9a`. Sessions shows **Entry agents**
and **Sidekick** as separate ordered sections. Selecting a Sidekick turn opens
its chat and brings that turn into view. Previous chats are read-only, can be
reopened from a copied location, and offer **[Back to current chat]**.

Execute [the Implementor prompt](pr2-section5-sessions-implementor-prompt.md).
The [completed Architect decision](pr2-section5-sessions-architect-decision.md)
settles all product and architecture choices. SS1–SS7, three controls and the
focused commands below are the finite feedback threshold. No interview remains
pending. Private fact shapes, helper names and ordinary mechanics are delegated.

## Base and scope

Implementation worktree:
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`.
Branch agent/issue-883-pr2; parent
`f8b4e035382e22cf0f19b743dcb3b26f3bd4cc02`; signature G, tarasm@gmail.com.
The Planner independently verified the exact HEAD, parent, signature and clean
tree with no untracked files. Main is
`e61d6ce072735b5d0cf683eeaca0f2eefddc2d59` with unrelated edits. Do not import,
discard or commit those edits. Planning records live in main's `.reviewer/issue-883`.

This is a single bounded CLI slice in PR 2. Included: detached Sidekick turn
facts, the two Sessions sections, provider-key filtering, selected-chat
navigation, `sidekick=` codec/resolution, read-only prior chats, exact turn
reveal, notifications and proportional documentation/evidence.

Preview is accepted by [the exact-head review](pr2-preview-planner-review-10b17a40.md).
Configure/Retry, question drawers, Stop, message/turn correlation, paired-history
upgrade, direct-provider routing and configuration remain accepted. Preserve
their behavior while changing the shared root reading. This assignment does not
reopen their designs or require their old mutation batteries again.

No Core/ACP public interface, provider routing, native permission UI, journal
format/version, durable ordering record, CLI flag, dependency or vendored
renderer change. Sidekick stays out of ReplModel. No invented entry, marker,
provider identity or acknowledgement. Full terminal R5–R8 reconciliation,
the 36-frame capture packet and delivery are later assignments. No push,
GitHub write, CI inspection or terminal capture is authorized.

Follow `.agents/implementor.md`, repository instructions and the writing-for-
agents rules for instruction edits. Read the Architect decision in full and
the affected Sessions, location, History and Sidekick sections of
`specs/repl-spec.md` and the REPL composition discussion in `architecture.md`.
Core's existing publication/Prompt-record contracts are references, not changes
assigned here.

## What changes and where

The current `application.ts` chronology merges retained entry turns with
`live.agent.slots`, correlated by real entry plus durable name. sessionRows()
uses provider keys for filtering and entry markers for navigation. Keep that
entry behavior intact. `sidekick/model.ts` reads canonical turns but currently
retains only the conversation's attempted/completed numbers and chat outcomes;
the Sessions reading needs their own detached facts. `owner.ts` already owns
the one publisher and maps exact begin handles to registered responses.

`program.ts` currently composes active-chat facts only. It must compose current
Sidekick history separately from the selected entry prefix, and choose a chat
for reading independently of the active conversation. `viewFor()` currently
drops live entry facts at a frozen prefix; it must preserve the independent
Sidekick facts. `route.ts` currently validates a conversation filter only
against entry history/head facts; it needs the applicable Sidekick facts too.

Important early boundary: `runReplProgram()` calls resolvable() before
openReplSession(). Extend that pure cold validation using the repository's
already-readable chat records. An unknown selected chat or Sidekick filter
must not be discovered only after entry replay/resumption could append. Do not
open the Sidekick conversation to obtain validation facts. A paired execution
already supplies its chat records; a legacy one supplies no saved chat.

Required production surfaces are:

- `sidekick/model.ts`: pure canonical turn/request projection across all chats.
- `sidekick/owner.ts`: exact live facts, publication replacement and changes.
- `program.ts`: cold validation, root composition, navigation/reveal and owner checks.
- `application.ts`: two sections, selected chat, read-only controls, same measured
  and committed row building, process-local window/reveal state.
- `route.ts`: the new member and independent Sidekick resolution/availability.
- `components/actions.ts` and `components/rows.ts`: semantic selection/return
  actions and parsing, preserving keyboard/pointer equivalence.

Small private extraction is permitted for these concrete consumers. There is
no new generic history framework, registry, event interpreter or second
terminal host. Description/layout helpers may be adjusted only where the new
rows/windows require it; renderer validation and the seven-row footer stay intact.

## Ordered implementation

### 1. Project actual Sidekick turns

Extend the pure Sidekick reading from the existing records, using Core's
parsePromptRecord() and the existing requestsFromHistory() boundaries. Preserve
Sidekick file order across chats. A saved turn carries its own CLI chat,
canonical turn/name, agent, status, provider key when present, request
association when established, and its evaluated outcome when recorded.
Freeze detached values; no durable event, writer, handle, operation or raw
generated source reaches the application.

A person's title is the exact saved message associated with that request.
A proven automatic follow-up is **Automatic feedback**, not a new person
message. Without a proven person association, do not substitute the most recent
message or publish the canonical machine input. Bootstrap, reference chapters,
feedback envelopes and control arguments are not displayed as titles or bodies.

Parse the key from that saved turn's nonempty PromptRecord.sessionKey, including
failed/cancelled records. A prior turn's key does not give a later one filter
membership. Unknown stays unknown. An evaluated response supplies actual Output
and any failure. Completed generation without an evaluated-response record has
the inert anchor **Turn saved; no evaluated reply recorded.** Do not replay it.
Failed/cancelled source uses the accepted safe incomplete projection. A
controls-only turn remains readable without inventing an Output body.

### 2. Extend the existing owner's observation

The existing publisher remains the only publisher in each conversation's
execution. Begin announces a Sessions row even before there is literal Output.
Keep its existing exact registration/handle correlation and one append. Observe
uses Core-cleared prefixes and the pure preview reader; withdrawal removes text.
Do not add a provider subscription, middleware observer or Core hook.

Expose only phases the owner knows: pending/generating/evaluating and actual
saved/evaluated outcomes. A saved successful Prompt does not mean evaluation
has finished. Source arrival or a prepared association does not mean the
provider reported started. Keep progress and recording separate.

An exact publication association may establish a nonempty provider key for its
own live row before append acknowledgement. Announce that change before waiting
on the append. After acknowledgement, use its exact canonical record/request
association, with a private bridge if the detached refresh has not caught up.
Replace the live row once, under the same mounted identity, and update it when
evaluation settles. A failed saved turn follows the same replacement rule.

Stop without an acknowledged Prompt creates no saved turn or marker. Retain
only the unfinished cleared preview permitted by the accepted Preview lifetime;
none of it appears after a cold reopen. A genuinely observed ephemeral provider
key may remain known for the owner lifetime, so a filter the person selected
does not become guessed emptiness after Stop. Cold reopening may refuse that
exclusively ephemeral key. Late work cannot update a successor or replaced chat.

Do not infer identity from equal text, message IDs, response numbers, latest
turns or publication order. Namespace entry and Sidekick rows by their actual
owner. Equal provider keys never merge the rows. Preserve both unchanged
Preview probes named below.

### 3. Resolve the location without changing what can run

Append exactly one member to ReplRoute, with the accepted documentation:

```ts
/**
 * The saved Sidekick chat to read, by its CLI conversation ID.
 *
 * Absent follows the current chat. Selecting one changes only the reading;
 * it never changes which conversation Send or Retry may continue.
 */
readonly sidekick: string | undefined;
```

The query spelling is `sidekick=<saved-chat-id>`, after every existing member;
there is no `chat=` alias. Percent-encode its value through the existing codec.
Old locations re-encode byte for byte. Reject empty, bare, repeated or unreadable
values. Resolve an exact saved association from readable Sidekick history,
including prepared/failed setup with no provider key. Unknown refuses. A legacy
execution has no saved association to select and is not upgraded by reading.
Missing/unreadable paired history keeps its storage refusal.

`session` continues to name an actual provider key and filters both sections.
Offer keys in Entry agents order, then Sidekick order, each section earliest
observed first and duplicates once. All includes unknown-key turns. Filter
availability includes complete current Sidekick saved facts and exact live
publication facts even at an earlier entry checkpoint. Entry facts still come
only from that prefix, plus live entry facts at head. An entry-only key absent
from the frozen prefix still refuses. Do not smuggle Sidekick availability into
the entry-only head branch.

Use the same detached availability for cold validation, navigation, measurement
and committed drawing. A filter key and selected-chat ID answer different
questions; neither is a provider capability or active-conversation setter.

### 4. Draw and navigate the two readings

With Sidekick installed, draw **Entry agents** then **Sidekick**, each with its
own order. Empty sections say they have no turns. An unreadable Sidekick
history says why it cannot be read; it does not masquerade as an empty section.
Without Sidekick installed, preserve existing entry-only Sessions behavior.
Use one consistent row builder for measurement, content length and admitted
window contents. Off-window rows have no keyboard or pointer targets.

Sidekick rows identify Sidekick, their own chat and agent. Entry rows retain
their marker and permission behavior. A Sidekick activation sets `view=sidekick`,
`right=sidekick` and its exact saved CLI chat ID; preserve session filter, saved
left surface, entry/scopes, History and both drafts. Reveal that actual turn in
the chat's measured window using ordinary process-local navigation. No guessed
entry marker, durable scroll value or reconstructed ephemeral preview.

Supply an inert display anchor for every selected saved turn that has no
rendered reply, including automatic feedback and completed-but-unevaluated work.
These are display facts, not new chat records or additional person messages.
Do not rebuild an evaluated reply from its source. Preserve actual chat order
and avoid duplicating a reply merely to add an anchor.

Omitted `sidekick` follows current chat; an explicit ID pins the reading.
The actual active chat keeps its usual controls even if explicitly selected.
Every other saved chat is read-only: no composer, Send, Retry, Configure,
pending-question or Stop target addressing it. Hide any current-chat modal
presentation while reading the old chat, preserving its existing process-local
question values. Route drawers retain precedence. Absent controls have no
focus claim, input ownership or pointer target. Root actions still validate the
actual current owner; the selector never redirects an operation into old work.

Keep **[Back to current chat]** outside the scrolling transcript. It clears
only the chat selector, keeps Sidekick selected, and restores the current
message draft. Selecting Entries, Sessions or Bindings preserves the selector
for a later return and follows the existing view/right rules. Background work
and resize never retarget a pinned older chat or take focus. A copied location
restores the selected chat but promises no scroll offset.

A successful agent replacement requested from current chat returns to the new
current chat by clearing the selector. A failed replacement preserves the
reading and active association. Preserve the existing conversation/revision
checks on late configuration reports: a late result cannot overwrite a newer
deliberate old-chat reading. Selecting a reading starts no provider, creates no
record and does not stop current work. Current work remains reachable through
Back to current chat and existing navigation; Exit remains available.

### 5. Prove the finite matrix and align prose

Use runReplProgram, the production profile/repository/session/owner and existing
`tests/fixtures/repl/issue-883/mounted-program.ts`. Replace only terminal and
provider transport. Reuse fake-acp.ts and real append/provider/cleanup gates.
Small additive transport controls are permitted where a required boundary has
no existing gate. No second owner, journal, terminal host, debug export or
hand-injected finished state proves a mounted journey.

Use canonical-record fixtures for the pure reader/route cases explicitly
identified below. They test parsing and composition, not production retention.
The mounted/cold rows use real files and real writing paths. Deadlines bound
failure; neither sleep nor a fixed count of scheduler yields establishes
readiness. Register teardown before taking test gates.

## Frozen evidence: SS1–SS7

These groups cover the Architect's five product-evidence families. Existing
accepted rows can supply named controls; do not add a permutation merely to
increase the count. New rows need distinct names, assertions and boundary
observations, not a prescribed test-count total.

| Group | Required observation and representative arms | Destination |
| --- | --- | --- |
| SS1: sections and exact settlement | Hold a real entry Agent turn and a Sidekick turn concurrently; release the later-started one first. Show fixed owner sections, each preserving its own order, own agents and distinct keys. Capture real live facts and their acknowledged replacements: one stable row per turn, including while Sidekick evaluation is held after its Prompt is saved. The entry journal contains no Sidekick event. Pair with a no-Output Sidekick turn: it is announced at begin, remains a turn and gains an inert selected-chat anchor rather than disappearing or showing control source. | repl-sidekick-presentation.test.ts mounted tier; real-owner identity snapshots may live in repl-sidekick-journey.test.ts |
| SS2: codec and early resolution | Old locations keep their exact spelling. Round-trip a percent-encoded sidekick ID beside all existing members; reject empty/bare/duplicate/malformed values and chat= alias. Semantic turn selection/Back and Entries/Sessions/Bindings transitions preserve the ruled members. Cold-open an unknown ID against an execution with an unfinished entry: refuse before resumption/provider/append, files byte-identical. A known prepared or failed chat with no Prompt/provider key opens read-only with its actual setup status; a legacy location with sidekick= refuses without upgrading. | repl-route.test.ts for codec/reducer; repl-sidekick-presentation.test.ts for actual cold command; reuse recovery-phase production setup for the no-key fixture |
| SS3: provider keys and frozen entry History | Select a parsed saved Sidekick key beside a checkpoint preceding that conversation. Sidekick keeps updating while entry panes/prefix stay frozen; filter/clear preserve scopes, checkpoint, both texts and unrelated focus. Unknown key refuses; an entry-only later key remains unavailable at that prefix. A pure canonical-record composition case uses the same provider key for entry and Sidekick: one filter choice, both owner rows; unknown-key turns appear in All only. Hold Sidekick's canonical append after an exact successful publication association: its live row may be filtered by that key while still unsaved; Stop gives no saved turn, the owner keeps the actually observed key, and cold read cannot invent it. | repl-sidekick-presentation.test.ts mounted/append arms; repl-route.test.ts and repl-sidekick-recovery.test.ts pure key/evidence cases |
| SS4: older chat and active owner | Use two real conversations across agent replacement, with a pending unsent message preserved. Activate an older turn by the mounted control, reveal it beyond the initial transcript window, show its own agent/chat and Back outside the window. It has no composer/Send/Retry/Configure/question/Stop targets; selecting it starts no provider, writes nothing and keeps the entry selection. Deliver a current-chat update while reading old chat: the selected old reading/focus stay. Back restores current chat and the original message draft. Reuse a held current question to prove its partial values survive the read-only visit; no hidden form consumes typing. Include matching successful replacement clearing an explicit-current selector and failed replacement preserving it. | repl-sidekick-presentation.test.ts; the replacement success/failure assertions may extend existing CFG4 rows in repl-sidekick-configuration.test.ts |
| SS5: pure copied-location restoration | Exit a real two-chat run and cold-open its copied sidekick= location using a fresh owner/transport. Same old chat is selected read-only, current association unchanged, zero runtime/session/prompt/provider inspection and zero appends, both files byte-identical. Back works; selecting Entries/Bindings and returning does not forget the pinned chat. Pure missing/unreadable paired-history arms keep the established refusal rather than returning current/empty chat. | repl-sidekick-presentation.test.ts cold mounted tier; reuse existing storage refusal fixtures in repl-sidekick-storage.test.ts |
| SS6: failure, feedback and identity gaps | Through real owner/files, preserve the accepted interrupted-first-message gap, then a saved failed successor: own turn/key/status and safe Incomplete, no collision with earlier reply or an entry turn. Pair with Stop before acknowledgement: no saved turn, provider membership or acceptance inferred from text or message ID, and no unsaved row after cold reopen. A real automatic feedback turn is labeled Automatic feedback and opens an inert anchor if it has no evaluated response; bootstrap/feedback/source never become person text. A canonical failed/cancelled-record table proves each actual nonempty key remains filter evidence while a record lacking it gains none; a completed Prompt with no response shows the exact inert saved-turn status. | repl-sidekick-journey.test.ts / repl-sidekick-lifecycle.test.ts for real owner outcomes; repl-sidekick-recovery.test.ts for canonical status/association table and the retained-boundary fixture |
| SS7: wake, window and absence | With Sessions selected and terminal.fed unchanged, a held Sidekick begins without Output, then cleared text arrives, its Prompt lands and evaluation settles: each material fact reaches the mounted screen without input. Ordinary entry notification is the control. Run one populated navigation journey at 160x36, 120x30 and 72x20: two sections/window controls, reveal an off-window old turn, Back reachable, hidden outlets and read-only controls absent from descriptions/mounted nodes/target map; seven-row footer and both draft values preserved. Add a no-Sidekick application reading as the entry-only compatibility control and an unreadable Sidekick reading as refusal-not-empty. | repl-sidekick-presentation.test.ts; existing entry notification/geometry harness reused |

Do not confuse saved Prompt completion with evaluated completion, selected chat
with active owner, or a provider key with the CLI chat ID. Read actual files to
establish writes/associations. Compare only current-size frames after resize.
For identity use real before/after owner facts and actual row keys, not a live
snapshot manufactured from a later saved record. No capture gallery is required.

The same-key and failed/cancelled canonical tables may use the existing pure
record fixture builders, parsed through production readers; this is deliberate
because those rows establish evidence interpretation, not provider routing.
An ordinary old chat and the active chat are the positive controls for read-only
absence. A turn with unknown provider membership is not a whole empty chat.

## Three discriminating controls

After the normal rows pass, mutate only each named connection in a byte copy,
confirm the diff applied, run the relevant regression and named control in the
same selection, preserve output and restore byte-identically:

1. Suppress only the new Sessions notification at canonical begin, leaving
   ordinary entry, existing Preview observation and publication notifications
   intact. Hold before the first delta: SS7's no-Output no-input announcement
   must fail; the entry notification control stays green.
2. Restrict Sidekick filter availability to entry head as the old resolver did.
   SS3's Sidekick key at an earlier entry checkpoint must fail; the entry-only
   unknown/later-key refusal and head filtering control stay green.
3. Remove the read-only control/presentation gate for a nonactive selected chat.
   SS4 must expose the wrongly mounted current controls or hidden modal and
   fail; the active-chat control still has its real composer/controls and passes.

No further mutation battery is assigned. If one control cannot isolate its
named connection, report that evidence to the Planner instead of silently
substituting a different criterion. Existing Preview controls remain accepted.

## Documentation and permitted fixture adaptations

Update `specs/repl-spec.md`'s Sessions and later entry-only chronology statements
to the two labeled sections, preserving ordering within Entry agents. Align the
location roster/example, frozen-History rule and Sidekick navigation: actual
provider session filter versus saved-chat selector, omission/current, explicit
pinning/read-only, setup status, selected-turn inert anchors and pure cold read.
Align the corresponding `architecture.md` REPL composition/location discussion
without copying unrelated main edits. Use present-tense implemented behavior.
No new terminology row, storage version or Core export documentation is needed.

ReplRoute fixtures may mechanically gain `sidekick: undefined`; constructors,
reference models and printed-location tests must preserve every older expected
location. Keep independent expected members/cells rather than calculating them
from the implementation under test. A root Sessions assertion that literally
requires the old single section may be adapted to the approved two-section
contract. Entry-only chronology, entry identity, permission and focus assertions
remain unchanged. Report every adaptation and why its previous claim changed.

Reuse mounted-program.ts, recovery-phase.ts and fake-acp.ts. Add local helpers
or exact transport/append latches as needed, without a second account of the
product. No rewriting malformed stored histories to make selectors resolve.
No authored Promise synchronization, type casts, synchronous filesystem access
or post-acquisition cleanup registration in new work.

## Focused feedback commands

Run these seven selections against the final tree in the implementation worktree.
They cover the changed root, route, owner, ordinary Sessions and mounted lifecycle
consumers; prior Core/workflow matrices are not repeated for this CLI-only slice.

```sh
deno task test packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts
deno task test packages/cli/tests/repl-route.test.ts packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-boundaries.test.ts
deno task test packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-agent-journey.test.ts
deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts
deno task test packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-agent-execution.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-output.test.ts
deno task test packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-forms.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-source-reading.test.ts
deno task test packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-lifecycle.test.ts
```

Also run both unchanged Preview probes by absolute main-checkout path, from
the implementation worktree:

```sh
deno task test /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-preview-correlation-probe-b44098ff.test.ts /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-preview-single-item-probe-f8b4e035.test.ts
```

Preserve a failure's first complete output before fixing or rerunning. The
[open L2 record](pr2-repl-lifecycle-l2-flake-10b17a40.md) and
[open U2 record](pr2-mounted-permission-u2-flake-a438905f.md) remain open;
an unchanged rerun does not fix their causes. Record new intermittence under
the repository rule, without a GitHub mutation under this assignment. Report
an environment limitation with its exact command/output; do not repair shared
caches, dependencies or tests to avoid it.

No full suite, runtime battery, check/lint/JSR, packaging, capture or CI gate is
a prerequisite for feedback. A newly changed boundary outside these explicit
consumers needs only its directly affected test, with the reason reported;
material scope expansion returns to the Planner before implementation.

## Feedback and continuity

Complete the bounded slice and its frozen evidence, then promptly create one
signed feedback commit atop `10b17a40`, preserving that commit and its ancestors.
Do not amend, reset, push or begin another slice. Hand back exact SHA/parent,
branch, signature, clean/untracked status, diffstat, every focused command and
result, SS1–SS7 mapping, three controls, fixture/doc adaptations and limitations.
Review is against that exact committed tree; no reported run may predate a
later source/test edit.

Work continuously through routine checkpoints; send concise progress updates
without yielding merely because one layer is complete. Stop only for the
concrete conflicts in `.agents/implementor.md` or the final signed handback.

Produced artifacts: this plan and
[the self-contained Implementor prompt](pr2-section5-sessions-implementor-prompt.md).
Settled: two ordered sections, actual provider filtering, read-only older-chat
navigation, `sidekick=` copied-location restoration and one existing publisher.
Unresolved blockers: none. Next Implementor action: verify `10b17a40`, read
the plan/decision, implement in the order above and return the signed feedback
commit. Terminal completion, the 36-frame packet and delivery remain deferred.
