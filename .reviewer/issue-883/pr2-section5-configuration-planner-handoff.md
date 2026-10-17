# Section 5: Configure Sidekick and retry a failed message

**Accepted at 81523318: PASS, 2026-10-14.**
[The review](pr2-configuration-planner-review-81523318.md) closes C-P1 Apply
ownership and accepts this frozen CFG1–CFG9 slice at signed clean
`815233183c7c26cd40544347191b7ba5e1f975c3`, parent 57773de0. Six independent
first-run selections pass 192 tests / 716 steps; all three unchanged probes pass
nine steps. No correction remains assigned. Hold for the next Planner
assignment; deferred features, capture and delivery remain unopened. The plan
below records the accepted scope; earlier feedback entries are historical.

**Correction at 57773de0: REQUEST CHANGES, 2026-10-14.**
[The review](pr2-configuration-planner-review-57773de0.md) closes the four-finding
probe and missing evidence, but leaves C-P1's Apply-report ownership open.
Execute [the narrow correction](pr2-configuration-implementor-correction-57773de0.md)
from signed clean 57773de05246578da77c0f8689fbee004cbd84b4, preserving its
parent d4f38f6e. The frozen matrix/decisions remain governing; no new interview
is needed. The slice remains unaccepted. Earlier feedback entries are history.

**Feedback at d4f38f6e: REQUEST CHANGES, 2026-10-14.**
[The review](pr2-configuration-planner-review-d4f38f6e.md) passes the six
commands but reproduces four existing-contract failures and identifies missing
frozen evidence. Execute [the correction prompt](pr2-configuration-implementor-correction-d4f38f6e.md)
from d4f38f6e5cc068bb655a48f1e3cf5d90c2437ea2, preserving that commit.
The matrix and settled decisions below remain authoritative. This slice is
unaccepted; the original base/readiness entry below is historical.

**Ready for implementation, 2026-10-14.** Base: signed clean
`bb60ca35661c2988ef647cc7a456470482d06e2e`, branch agent/issue-883-pr2.
The question drawer is accepted. Execute
[the Implementor prompt](pr2-section5-configuration-implementor-prompt.md)
under this frozen plan. This planning work changes no production file.

The next slice lets a person inspect and choose the Sidekick agent, model and
thinking effort in its pane. It distinguishes saved preferences from settings
the provider has verified and offers explicit recovery from an unavailable
agent. The
[timing ruling](pr2-section5-configuration-timing-architect-decision.md)
settles saving while busy, the exact next-turn boundary and shared-writer
ordering. The [accepted Retry decision](pr2-section5-configuration-product-decisions.md)
resends the failed person's request as a new message in the same conversation,
without bypassing unknown acceptance or integrity refusals.

The same [accepted product decisions](pr2-section5-configuration-product-decisions.md)
settle Apply/Close: Apply saves and closes on success; Close discards unsaved
choices; reopening shows saved preferences. Failed Apply keeps the drawer open
and shows its reason. No identified product or architecture question remains
unanswered. CFG1–CFG9 and the six feedback commands below define acceptance.

## Base, scope and ownership

Implementation checkout:
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`.
Parent: `2f3af332e09a7aa8e6acda6e51e1f63aab13614e`. The Planner verified HEAD,
signature G, signer tarasm@gmail.com and a clean tree. Main is at
e61d6ce072735b5d0cf683eeaca0f2eefddc2d59 with unrelated local edits; it is not
this assignment's implementation base. Do not import, discard or commit those
edits. Planning records live in the main checkout.

Follow .agents/implementor.md, the current repository instructions and the
writing-for-agents guide when writing instructions. Read architecture.md's REPL
ownership, modal/input and Sidekick sections; specs/repl-spec.md's bounded
forms, locations, Sidekick and configuration sections; and the applicable
agent conversation/configuration sections of specs/executable-mdx-spec.md.

Included: Configure, provider-advertised choices, saved versus last verified
settings, busy preference retention, ordered chat writes, explicit idle/busy
agent replacement, explicit Retry, their mounted geometry and lifetimes.

Configuration P1/P2, Core direct-provider routing, identity/activation/recording,
R2, mounted Message/Send/Stop and question acceptances stay closed. This opens
the precise CLI preference-timing correction the Architect authorized; it does
not reopen Core/provider configuration semantics. No public Core/ACP interface,
record format, provider route, response ceiling, route codec, CLI flag,
dependency or vendored runtime change is assigned.

Deferred: streamed preview, Sidekick Sessions integration, remaining complete
terminal R5–R8 acceptance, the 36-frame capture packet and delivery. No
placeholders, push, GitHub mutation, CI inspection or real terminal capture.

## Settled behavior

The sources are [accepted configuration decisions](architecture-review.md#accepted-agent-change-identity),
[J9](remaining-architecture.md#accepted-journey-9-configure-sidekick-independently-of-entry-agents),
[terminal integration](planner-handoff.md#5-integrate-the-terminal-and-configuration),
[the timing ruling](pr2-section5-configuration-timing-architect-decision.md),
and [the question-drawer PASS](pr2-question-planner-review-bb60ca35.md).

- Configure opens inside the Sidekick pane. Its state is process-local and
  carries no route or durable drawer spelling.
- Apply saves and closes on success. Close discards unapplied selections and
  performs no save/provider change. Reopening shows saved preferences. If Apply
  fails, retain the selections, keep Configure open and show the reason.
- No provider inspection, session placement, turn or write occurs merely to
  acquire the owner, render a frame, switch a tab, resize or cold reopen.
- Explicit option inspection uses owner.options(). Provider model/effort IDs,
  labels, descriptions, groups and null support remain truthful. A changed
  model requires its own effort choices; a stale inspection cannot replace
  choices for a newer selection.
- A saved model/effort preference belongs to its conversation and applies at
  the next turn through Core's existing application/readback contract. It is
  not evidence that settings have already been applied. Omitted members leave
  the native setting alone; this slice assigns no new reset-to-default policy.
- Saving is allowed during current Sidekick work for an already active
  conversation. It does not inspect, stop or reconfigure that work. A busy
  initial setup with no active conversation refuses the save rather than
  attaching it later to whichever setup wins.
- Agent replacement explicitly starts a new conversation. Preserve old chat
  and its association. owner.select() activates after inspection succeeds;
  failed setup preserves the prior active association. Busy replacement uses
  Stop and start new conversation and waits for Stop's join. An admitted entry
  continues independently. A switch sends no model prompt.
- An unavailable agent gives its own reason with Retry and Configure. There is
  no implicit agent fallback, automatic resend or fresh-conversation recovery.
  Existing unknown-acceptance, identity and trusted-integrity refusals remain
  authoritative.
- Explicit Retry resends the saved failed person's request as a new message in
  the same conversation through the existing canonical message/turn path. The
  previous failure remains recorded; Retry uses the failed request's text,
  rather than unrelated current composer text. It uses the accepted next-turn
  preferences and is not just an availability check.

## Required implementation boundaries

Use the existing root owner and the mounted-program.ts harness. There is no
second terminal host, configuration provider or conversation owner.

`packages/cli/src/repl/sidekick/owner.ts` already exposes options(), configure(),
select(), message() and stop(). The root must serialize explicit configuration
jobs with Send and agent replacement: owner.busy alone does not reserve an
options/select job. Slow inspection runs on an owned task, leaving keyboard and
command shutdown responsive. Late results must remain bound to the conversation
and selection that requested them. This explicit-operation reservation must
allow preference Apply alongside an already-admitted message cycle.

### Preference retention and turn handoff

In owner.ts, configure() captures the active conversation and scalar requested
settings before suspending. For an active conversation, append the complete
existing preferences record without holding(), options() or any provider call.
An idle first explicit configuration may retain existing establishment behavior.
Refuse unreadable history or conflicting setup/replacement. A stale Apply cannot
be redirected to a new conversation. Every call remains a complete preference;
omitted effort requests no effort change and copies no previous model's choice.

After message/feedback retention and message acknowledgement, respond() reads
the latest acknowledged records from the shared chat writer and derives the
preference for its fixed conversation. Immediately pass a fresh scalar copy to
handle.prompt(), with no intervening preparation, UI or acknowledgement yield.
Do not use respond()'s earlier reading snapshot for this choice. A preference
acknowledged before selection applies to that turn; one acknowledged after
handoff belongs to a later turn. An unreadable reading refuses rather than using
older preferences.

In sidekick/history.ts, serialize each physical SidekickWriter append and its
in-memory publication together, for every existing caller. The next append may
reach the host only after both complete. The preference read uses these ordered
acknowledged records. Do not hold serialization across prompts, evaluation,
questions, entry completion, inspection or setup. There is one existing writer
and no new record family, queue on disk or history source.

Capture choices by conversation, agent and model. While busy, already advertised
matching choices remain usable. A model whose effort needs fresh inspection
reports that refresh is unavailable until explicit inspection can run. Permit a
model-only preference, with no effort request. Do not copy another model's
effort list, silently choose an effort, stop work or schedule an inspection to
run later. Preserve the existing owner-level rejected-ID regression: mounted
choices do not replace Core's final validation.

The save belongs to the root independently of the message cycle. Stop joins the
cycle but does not discard an acknowledged preference or cancel that independent
save. Finish or cancel/join a save before replacement setup. Invalidate stale
drawer choices/results when the conversation changes. Shutdown cancels and
joins all configuration work before releasing the writer/provider. Cancellation
before append publishes nothing; once physical append starts, join its write
and local acknowledgement/failure so it cannot finish behind a closed owner or
be overtaken. Keep existing storage failure classification; invent no rollback
or successful save after an uncertain write.

`packages/cli/src/repl/sidekick/model.ts` projects saved preferences but no
verified configuration fact. Core's exported parsePromptRecord() already reads
PromptRecord.configuration. Its contract establishes settings only when the
provider said the turn started; a turn failing before application supplies no
such evidence. Project a CLI-private per-conversation "Last verified" reading
from that saved record. Neither an inspection's selected defaults nor requested
preferences may supply it. A started turn that later fails may still carry
verified configuration; successful completion is not the only qualifying state.
Do not add a durable record family or widen Core's API to repeat that evidence.

`application.ts` owns local drawer/selection state, typed actions and detached
rendering facts. Agent selection uses an exact-name input rather than a
hardcoded catalogue; owner.select() validates it through the real provider.
Model and effort use existing bounded choices. Apply and Close follow the
accepted semantics above; unapplied UI selections are not saved preferences.
Model/effort Apply succeeds on preference acknowledgement, not native provider
application. Agent Apply keeps its existing new-conversation setup semantics
and closes only on success.

`program.ts` owns authority, configuration tasks, notifications and wakeups.
Rendering receives detached facts. Reuse the selected pane's existing drawer
rectangle, measured window and Freedom ownership. Only the presented modal has
input/targets; History retains precedence. Do not undo bb60ca35's frame-derived
question-input check. A hidden Configure drawer cannot consume Draft or Message
typing, and closing Configure must not answer or withdraw a pending question.
Keep partial Sidekick question values and the entry's separate close behavior.

All jobs join at Exit/Control-C. Cancellation cannot publish late option results
or activate a replacement conversation after shutdown. Neither composer is
cleared by configuration inspection or preference changes.

## Mounted interaction and acknowledgements

Configure is in the Sidekick header. Opening it explicitly requests an
inspection when the owner is available; when busy, it opens immediately using
matching cached advertisements or states that inspection is unavailable. A
visible Refresh action requests fresh options explicitly. Do not run deferred
inspection automatically when a cycle ends. Slow operations leave the keyboard,
Close, Stop where applicable, and Exit responsive; a conflicting Send or second
explicit job refuses rather than queues. Reserve before spawning, including
two activations in one input burst.

Keep Stop reachable while a cycle is busy through the presented drawer's own
row, rather than a control in its hidden pane body. Stop's existing lifetime
and the independent preference save remain unchanged.

Initialize choices from saved preferences for the bound conversation. Show an
unadvertised saved ID truthfully as unavailable, retaining it rather than
selecting an advertised substitute. With no requested setting, show that no
change is requested; an inspection's selected value is not a saved request.
Omission means leave that native member alone, never reset it. Changing models
invalidates effort choices that belonged to the old model. Labels, descriptions
and groups stay provider-authored; clipping follows the existing measured
window and does not change IDs carried by actions.

Same-agent Apply saves the complete preference and closes Configure after
acknowledgement. Show Requested independently of Last verified; where no saved
verification exists, say so. Close discards unapplied choices without a save or
provider change; reopening initializes saved preferences. Failed Apply keeps
choices and its reason visible. A Close while a job is already admitted hides
the drawer; it does not undo that job. A late UI result cannot reopen the drawer
or replace a newer selection.

If the entered agent differs, the action explicitly says Start new conversation
or, while busy, Stop and start new conversation. Disable old-agent model/effort
choices for that replacement; they cannot be applied to another agent. Apply
joins Stop if needed, then uses owner.select(). Success activates and closes;
failure leaves the old association and attempted name/reason in the drawer.
Opening Configure again explicitly inspects the new agent's choices. Neither
old preferences nor old chat are replayed into the new conversation. Selecting
the unchanged agent does not manufacture a replacement.

Configure and the question form are alternative pane-local modal contents.
Opening either does not answer or withdraw the other owner's question. Keep
question partial values when Configure replaces its presentation. Route drawers
retain precedence. Closing History closes History once, without accidentally
applying or closing an underlying Configure. Hidden/default-pane drawers on
shrink have no input/focus targets. Reuse frame-derived presentation ownership,
not just a remembered open flag; preserve current route/default behavior.

Retry resolves the exact failed person's saved message by its conversation and
message ID at activation. Recheck the active association and existing refusal
facts at actual start. Use requestsFromHistory() and existing saved outcomes
where association is needed; message ID equality, matching text and an absent
turn are not evidence of acceptance or failure. Unknown acceptance is not
unsent work. Do not offer a usable retry around that refusal, an unreadable
history or an identity/configuration-integrity refusal.

Pass the saved literal text through owner.message(), reserving the same single
message cycle as Send before spawning. Retain the failed attempt; the normal
owner path allocates a new message ID and actual turn association. Do not replay
the previous response program, reuse its control identities or automatically
repeat a failed follow-up. Cold reopen resumes nothing; Retry still requires
activation and a known eligible failed request. An absent saved failed message
has nothing to retry.

Retry does not send or consume unrelated Message text. Adapt CLI-private
acknowledgement facts to distinguish a saved-message retry from a composer Send;
do not temporarily overwrite the composer or invent a sentinel revision. Retry
is an explicit instruction at the captured draft revision: acknowledge before
reply fills, preserving newer edits/takeover under the existing rule. Retry
itself does not clear the draft text. Keep normal Send's revision-safe clearing
and existing acknowledgement-before-fill assertions unchanged. Show failure
when owner.message() answers Err and when its successful Result carries a
failed SidekickTurn; ok alone does not mean an answered request. A later
successful explicit message or replacement invalidates a stale retry target.

## Ordered work

1. Serialize the existing writer's physical append/publication and ordered
   acknowledged reading. Establish CFG8 before allowing concurrent saves.
2. Correct owner.configure() and prompt handoff, adapting R7 exactly as ruled.
   Project per-conversation last verified configuration from Core's saved
   PromptRecord without changing its journal or authority.
3. Add root-owned configuration jobs and detached, conversation/model-bound
   choices. Connect typed Configure/Refresh/Apply/Close actions and measured
   pane-local presentation, including busy saves and explicit replacement.
4. Connect Retry to the saved message and existing cycle/acknowledgement path.
   Complete CFG1–CFG7 and CFG9 through the existing shared mounted harness.
5. Align specs/repl-spec.md and architecture.md with implemented interaction,
   preference handoff, write ordering and shutdown. Correct owner/history
   comments that say only messages can explicitly establish storage or that an
   omitted setting resets a native default. Do not copy unrelated main edits.
6. Run the six frozen commands after final edits; commit and hand back promptly.

## Frozen evidence: CFG1–CFG9

Use real runReplProgram for mounted observations, replacing only terminal and
agent transport. Actual held writes/turns/cleanup establish readiness; deadlines
only bound failure. Calling owner methods directly does not prove a mounted
action. The existing owner-only R7 and writer rows prove their own boundaries.
This finite selection is not complete terminal acceptance or capture.

| Row | Required observations | Destination |
| --- | --- | --- |
| CFG1 | Explicit Configure displays real advertised IDs/names/descriptions/groups with no prompt or turn. Null support is unavailable rather than a fabricated empty selector. Before opening, and on cold reopen/tab/resize, zero provider inspection or writes. Both composers stand. | repl-sidekick-configuration.test.ts, mounted tier |
| CFG2 | Choose a model and inspect its own effort levels. Hold one inspection, change/close its selection, then release: no stale result overwrites or reopens the current drawer. Close unapplied choices, reopen saved preferences, then Apply and reopen the saved choice. Requested is visible while Last verified stays old/unknown. Next real message verifies model first, status, effort, status before prompt; saved verification matches it. Keep the existing rejected-ID/no-substitution owner row. Reuse this mounted case while busy: uncached effort refresh unavailable, no inspection/cross-model list, model-only Apply with no silent effort request. | repl-sidekick-configuration.test.ts |
| CFG3 | Held-entry pair: cache advertised settings, real response Submit and independently held entry, mounted Apply acknowledges different model/effort while the entry stays held and sends no provider work. Release produces one automatic feedback turn on the same native conversation under the new verified settings. The unchanged-preference control uses old settings. Entry agent configuration stays independent. | repl-sidekick-configuration.test.ts, mounted tier |
| CFG4 | Mounted idle replacement preserves prior chat association, sends no prompt and closes only after successful setup; next explicit message really runs under the new agent. Unreachable replacement keeps the old active association, leaves Configure open with attempted name/reason, and the old conversation still takes a real message. Busy Stop and start new conversation holds cleanup: no activation/successor Send/prompt before join; admitted entry continues, replacement starts after join. | repl-sidekick-configuration.test.ts; held-cleanup arm in repl-sidekick-lifecycle.test.ts |
| CFG5 | Real provider failure retains a saved person's request. Write unrelated newer Message text and a draft edit, restore transport availability, activate Retry twice in one burst. One new person message uses the old literal request, same conversation/native association and current requested settings; prior failure and unrelated Message text survive. No activation is the no-work control. Mount an existing unresolved-acceptance recovery fixture: Retry cannot send, append or replace its association. Ordinary entry work remains usable under existing rules. | repl-sidekick-configuration.test.ts, mounted tier; reuse recovery fixtures |
| CFG6 | One Configure journey through 160x36, 120x30, 72x20, 60x15 refusal and recovery: seven-row footer, independent texts and one presented modal. Reference pane starts are 124/92/0, not production-derived bounds. Reach off-window choices by real scrolling. History over Configure closes once; a Sidekick question retains partial values. Default-pane shrink hides Configure and typing edits Draft; explicitly selected narrow Configure remains its own input owner as positive control. | repl-sidekick-presentation.test.ts |
| CFG7 | Adapt existing held-generation R7 exactly: options/select still refuse, configure succeeds on the same active conversation, zero provider work from save, in-flight turn unchanged. Stop joins and preference stands; next explicit turn uses it without another save. Keep exact validation/rejection and other R7 assertions. | repl-sidekick-configuration.test.ts, existing R7 tier |
| CFG8 | Hold a physical preference append and request a competing response/Core append. No host overlap/overtaking; after release acknowledged memory matches exact disk order. Replacement cannot retarget that admitted save. A cancelled waiting save writes nothing; ordinary successful ordering is its control. Serialization covers all callers and ends before provider/entry waits. | repl-sidekick-storage.test.ts, existing writer/host fixtures |
| CFG9 | Hold a root preference append after physical write starts: Exit waits for completion/local publication or failure before writer release and restore. A competing waiting save is cancelled without late append. Reuse one held inspection/setup cancellation for Control-C: no late selection/result/activation, one restore, no live reader/listener. Failed Apply stays open with its reason; successful Apply in CFG2/CFG4 is its closing control. | repl-sidekick-lifecycle.test.ts, existing held-write/transport fixtures |

Keep scenario counts bounded as above. CFG8/CFG9 may share the held-write
fixture but need distinct owner endings. Do not multiply profiles by every
provider setting, cancellation position or interruption case.

Use repl-sidekick-configuration.test.ts for mounted configuration/recovery,
repl-sidekick-presentation.test.ts for geometry/input ownership, and
repl-sidekick-lifecycle.test.ts for held joins/shutdown. Existing owner-only rows
remain useful but do not replace mounted proof. Report every assertion/fixture
adaptation. The timing ruling authorizes the specified busy R7 adaptation;
all other established claims remain intact. Extend mounted-program.ts and
fake-acp.ts only for transport offers/agents or real barriers needed above;
there is no second renderer, terminal host, storage or canned projection.
Obtain unknown-acceptance history through the existing recovery producer where
its fixture crosses processes.

## Discriminating controls

Perform three mutations, each confirmed applied before interpreting output:

1. Restore old busy configure refusal and early reading snapshot. CFG3's
   changed-settings arm fails; its unchanged-settings control stays green.
2. Remove serialization around physical append/publication. CFG8 reports host
   overlap/overtaking or memory/disk disagreement; its uncontended control stays
   green. Hold actual writes so scheduler luck cannot supply this ordering.
3. Make Retry take current composer text. CFG5's saved-text assertion fails;
   ordinary Send's existing literal-text row remains green.

Preserve first mutation output, restore byte-identically, and rerun affected
evidence. Prior notification, question-close and ownership controls are not
repeated unless their connections change. The positive observations for failed
versus successful Apply and default-hidden versus explicitly visible Configure
are already frozen; do not invent another mutation battery.

## Frozen feedback selection

Run these six commands from the implementation checkout after the final edit.
They include the writer, configuration, program, form, modal and lifecycle
consumers this slice changes. No Core/ACP API or runtime adapter change is
assigned, so no new exhaustive selection is warranted.

```sh
deno task test packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts
deno task test packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-agent-execution.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-output.test.ts
deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts
deno task test packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-agent-journey.test.ts packages/cli/tests/repl-forms.test.ts
deno task test packages/cli/tests/repl-route.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-source-reading.test.ts
deno task test packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-lifecycle.test.ts
```

The Planner ran no tests for these planning-only edits. Implementation must
preserve the first output of a failure before rerunning. Existing U2 permission
intermittence remains recorded in pr2-mounted-permission-u2-flake-a438905f.md;
do not weaken its assertion or treat an unchanged green rerun as a correction.
If an identical revision passes after failure, report the intermittence and
follow repository flake rules within the no-GitHub-mutation limit.

After focused evidence passes, make one signed feedback commit without waiting
for full suite, lint, check, JSR, packaging or CI. Report exact SHA, parent,
branch, signature, clean/untracked state, every command/result, CFG mapping,
controls and all fixture/assertion adaptations. Keep the assigned base
reachable; do not amend accepted commits. Return a real boundary conflict to
the Planner/Architect rather than work around it with new authority or weaker
evidence. Additional specialized checks still apply if an unexpected edit
actually touches their boundary. Delivery verification remains separate.

## Continuity

Exact base bb60ca35; produced artifacts are this frozen plan and
[the Implementor assignment](pr2-section5-configuration-implementor-prompt.md).
Retry, Apply/Close, busy preference timing, writer ordering and ownership are
settled. No unresolved blocker remains for this bounded slice. Next action is
implementation under CFG1–CFG9 and six commands, then one signed feedback commit
and review. Preview, Sessions integration, full terminal acceptance, captures,
pushes, GitHub writes and CI inspection remain outside it.
