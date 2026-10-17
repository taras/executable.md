# Section 5: mount the Sidekick and connect explicit messages

**Accepted at a438905f, 2026-10-14.**
[The final review](pr2-mounted-planner-review-a438905f.md) closes M-P1/M-P2
and accepts M1–M8 plus their two corrections. This plan remains the scope
record. No further implementation is assigned by it; deferred work needs a
separate bounded handoff. The feedback entry below is historical.

**Feedback at 86debcb9: REQUEST CHANGES, 2026-10-14.**
[The review](pr2-mounted-planner-review-86debcb9.md) and
[active correction prompt](pr2-mounted-implementor-correction-86debcb9.md)
restore cancellation coverage and the actual-start gate. The M1–M8 contract
below stays frozen; the correction adds two paired regressions for requirements
already stated here. Work from 86debcb9, not the original base.

**Original assignment base: `004de839e85e53cff4d960cb515729d350383f30`.**
Connect the accepted Sidekick owner to the real REPL screen so a person can
select its tab, edit Message Sidekick, Send, read acknowledged chat and Stop.
The same command still admits ordinary entries through the existing Draft/Run
path. This is the first mounted increment, not completion of section 5.

This bounded assignment replaces the standing mounted-section-5 prohibition
only for the work below. P1/P2, increment 4 and R2 remain closed. No Core or ACP
API amendment is assigned.

## Authority, base and scope

Read the accepted contracts in
[planner-handoff.md](planner-handoff.md#one-owner-per-retained-repl-execution),
[remaining-architecture.md](remaining-architecture.md),
[storage-contract.md](storage-contract.md) and
[the terminal adaptation](reference/README.md#accepted-terminal-adaptation).
[The reconciliation](pr2-r2-completion-reconciliation-004de839.md) closes the
recovery/configuration prerequisite. The two exact-commit direct-provider
reviews remain authoritative; this work does not reopen their architecture.

- Worktree: `/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`.
- Branch: agent/issue-883-pr2.
- Exact base: `004de839e85e53cff4d960cb515729d350383f30`.
- Parent: `08c95ca28fdf71a9a3a32b08fdd0f9abe8ed40cd`.
- Planner verified this head signed G, tarasm@gmail.com, and clean.
- Planning records live in the main checkout's `.reviewer/issue-883/`.

Do not reset, amend or discard a later delta. Reconcile it before changing the
assigned base. No main-checkout source or rulebook transfer is needed here.

Included: one owner per running REPL; both entry-storage forms; cold chat
projection; root notifications and message acknowledgement; mounted chat,
Message, Send and Stop; tab/reading routing, focus and basic resizing; existing
shared admission/fill/read wiring; controlled Exit/Control-C cleanup.

Deferred: streaming source/Output preview, mounted Sidekick question and
Configure drawers, agent/model/effort controls, Sidekick rows in the Sessions
catalog, full terminal R5–R8 acceptance, real-terminal capture and the 36-frame
packet. Those accepted final behaviors remain required later. Do not add inert
controls for them, remove Elicit from the response ceiling, answer a question
automatically, or write tests treating an unfinished mounted feature as its
final product behavior. The accepted owner still retains any waiting question;
Stop must cancel it truthfully. This slice does not claim it can be answered
from the terminal yet.

## Current source and the two entry paths

cli.ts's repl command assembles one ReplExecutionProfile and calls
runReplProgram. program.ts creates or opens a pairedReplRepository execution,
validates the route and opens one ReplSession, then enters drive(). There is
one program entry point, with fresh and reopened invocations. Reopened data
has two storage forms: legacy `<execution>.jsonl` and the published pair.

Acquire the owner for **all** these supported executions. It belongs to the
REPL execution, not to the first entry, selected entry/History position, tab,
Message node, generated response root or provider turn. Do not implement a
paired-only Sidekick or acquire another owner when somebody changes tabs.

drive() already owns the root's state, wake queue, Admitting slot, queued fills,
cold reservation finding and screen/tree/frame resources. Its SidekickRoot
already supplies rootReads and an awaited fill operation, but has no consumer.
The owner has reading/busy getters and message/stop operations; it has no root
change notification or awaited message-admission connection yet. Those two
connections are included here, rather than left for the Implementor to guess.

## 1. Acquire and release at the root

Pass the repository already constructed by runReplProgram into drive through
private plumbing. Inside drive's existing scoped screen-loop lifetime, acquire
useSidekickOwner once after the root wake queue, shared slot/fill and reopening
callbacks exist, before the first normal frame is composed. Use the profile's
existing sidekickAssembly and the execution's actual chat storage.

Owner acquisition projects acknowledged history only. Fresh opening, cold
reopening, tab selection, resize and History navigation start no Sidekick
provider, options inspection, prompt, control or legacy upgrade. An unreadable
owner reading remains an explicit refusal; do not replace it with empty chat.

The owner resource and every root job/subscription are children of that drive
scope. Keep its conversation lifetime inside the owner, as accepted. No tab or
child view owns a task or provider. Exit, Control-C, EOF and failure unwind and
join this work before the command hands back its result and the terminal is
released. Do not catch an authoritative journal/policy/teardown failure merely
to turn it into printable chat. Ordinary owner Result refusals remain ordinary.

## 2. Establish storage without replacing the entry session

For an already paired execution, establish returns its existing PairedChatStorage.
For a legacy execution, the **first explicit Send** asks the root to call that
repository's upgrade on the current execution. Do not upgrade at acquisition,
tab activation or layout. Preserve execution ID, route, entry task, observer
and the same MovableWriter facade.

The root holds new entry admissions while the handoff is in progress. Use the
existing upgrade/MovableWriter handoff, which waits for issued appends and moves
the writer after acknowledged publication. An entry already running continues
through that facade; do not cancel it, replay it as migration, or construct a
second ReplSession. Existing preflight work also retains that facade.

Keep the root's current execution/storage association up to date after upgrade
before acknowledging establish or allowing another admission. Later Submit,
reservation reconciliation and reads must use that current association, not
the original legacy object captured when drive started. The operation lives
in root-owned work, outside the keyboard reduction; input and Stop stay usable
while an append is held. No second admission owner or fake entry reservation
represents the storage handoff. Existing publication/error semantics apply.

## 3. Wire requests through the existing root

Give the owner the existing rootReads/fill operation. Bind submit(at, journal)
to submitForSidekick using the same Admitting slot as human Run, the current
entry writer, live session terms and current root draft facts. Keep the actual
start recheck for route, revision, takeover and liveness. Process its admission
reports through the loop's existing applyReports; do not await an entry's
completion on the keyboard loop or bypass its exact-entry completion handle.

Before explicit mutating work, retain the existing cold reservation resolution
as already required. Preserve R2's unresolved-acceptance refusal and strict
prefix binding. Stop withdraws only the Sidekick's pending requests; an already
acknowledged ordinary entry continues. All these are bindings of accepted
operations, not new submission or recovery implementations.

## 4. Notify the loop and acknowledge the submitted message

Add a CLI-private owner change stream using the same owned signal/subscription
pattern as ReplSession and ReplElicitations. It reports reading/busy changes;
the root reads a fresh immutable snapshot when notified. Notify after relevant
acknowledged chat changes, cycle completion/failure and joined Stop, including
the state before waiting on a provider. No polling or filesystem watcher is
needed. Subscribe before spawning the first message, and release the
subscription with the drive scope. This notification carries no authority.

Add a root-owned **awaited acknowledgement of a saved person message** to the
existing CLI-private owner input. The local member/type names are delegated;
the operation receives the submitted message revision and returns only after
the loop has applied it. This is analogous to the existing awaited root fill,
not a new Core callback or provider interface.

Send synchronously captures the exact text, its message revision and the draft
revision, and reserves the root's one message cycle before spawning work.
Keep input.revision tied to that captured message, not whatever the person has
typed by the time storage setup finishes. The owner uses that revision in its
existing message record, then asks for root acknowledgement **after the physical
append has acknowledged and before it prompts/evaluates controls**. The root
queues and applies the acknowledgement, then answers it. A provider completing
immediately must not race that root transition.

Clear only the submitted Message revision. Preserve newer unsent text. Release
an existing Draft takeover for this explicit instruction only if no newer Draft
edit occurred since Send; a later human edit still owns the draft. Reuse the
revision helpers and adapt instructed() accordingly: its current unconditional
message clear is not suitable for a delayed acknowledgement. Apply this report
before any fills waiting on that instruction. A refused/unacknowledged message
clears no Message text and releases no newer takeover.

This additive CLI-private plumbing may require mechanical changes in the
owner-only fixture. Preserve all its assertions and report every adaptation.
No record schema, new message counter or durable revision is introduced.

## 5. Mount the selected chat and input controls

Pass detached Sidekick reading/busy/agent/refusal facts down the existing
application/view builder. Components receive no owner, session, writer,
repository or operation. They emit typed semantic actions; the root alone
changes route/state and performs work. Use the same builder for measurement
and committed drawing, with Freedom owning focus and the existing frame map
owning pointer targets. No second tree, renderer or application store.

Render acknowledged person messages, evaluated replies with hasOutput, and
incomplete attempts with their retained failure distinction. Do not present
response body fallback, raw executable source, chapters or feedback envelopes
as completed chat. Safe ordinary refusals remain visible. Live generation is
busy state in this slice; it is not a fabricated preview or completed reply.

Wide/medium uses the saved left surface and Bindings/Sidekick right tabs;
omitted right defaults to Sidekick while initial focus remains Draft. Narrow
uses one outlet and defaults to Entries unless view=sidekick is explicit.
Use the accepted select-pane/select-surface route transitions unchanged.
Explicit Sidekick activation focuses Message Sidekick through the tree; cold
default visibility, replies, background fills and resize make no new focus
claim. Selecting Bindings removes the Sidekick body and its input targets.

Message is a distinct single-line text destination with its own revision.
Typing and Backspace while it holds focus edit only Message; Enter there or
activation of Send explicitly requests that text. Draft Enter retains Run.
Empty Message sends nothing. While busy, Message stays editable, Send has no
admitted activation target, and Stop is visible. Completion/Stop does not
automatically send text prepared while busy. Preserve both texts across tab
switches, History and resize; Message remains process-local and absent from
the printed location.

Reserve synchronously and remount changed affordances within an input burst
where needed, using the existing batching/remount mechanism. Do not add a
readiness wait to the no-wait Run/Backtab/Pause journeys. Spawn message and
Stop work on the drive task; a slow provider, admission, joined entry outcome
or Stop cleanup must not block ordinary input. Busy remains true until owned
work joins. Repeated Send while busy cannot queue another cycle.

Keep the accepted one-cell separators/header fills and text-visible selected
tab, input labels and busy state. Keep the full-width seven-row footer, History,
Draft, Run/Pause and Exit. No question or Configure control is mounted in this
slice. Add no placeholder that promises either operation.

## Affected files and boundaries

Required source surfaces are program.ts, application.ts, components/actions.ts,
components/rows.ts, description.ts as needed, layout.ts, layout-admission.ts and
sidekick/owner.ts. Reuse sidekick/admission.ts, requests.ts, gate.ts and
repository.ts; change their internals only where this actual connection needs
it. The existing route codec and profile selection stay accepted.

Update specs/repl-spec.md and corresponding architecture.md text for the
implemented root lifetime, message acknowledgement and mounted path. Preserve
the accepted final UI contract; do not describe deferred drawers/preview as
implemented. No dependency, generated artifact, Core/ACP API or new Context is
assigned. Use existing module/operation names; local factoring stays delegated.

## Frozen mounted evidence: M1–M8

Use real runReplProgram, repository, profile, entry session, Sidekick owner,
canonical conversation/evaluator and mounted tree/commit/grid. Only transport
and terminal host are controlled. Reuse fake-acp.ts, the existing journey
terminal/clock helpers and presentation.ts; extract reusable fixture setup
under fixtures/repl/issue-883 rather than acquiring an owner outside the
program. All actions in these rows go through mounted input/targets, not direct
owner calls, injected finished state or reducer shortcuts. Gates are explicit
signals, never sleeps; teardown releases every test latch.

| Row | Finite observations | Destination |
| --- | --- | --- |
| M1 — acquire both forms without work | Fresh paired command and cold reopen show current/empty chat with zero Sidekick sessions/prompts/control work. Legacy reopen leaves its file unchanged and creates no pair. Switching to Sidekick starts none. Wide/medium initial focus remains Draft; narrow starts Entries. Run still admits a real ordinary entry. | New repl-sidekick-presentation.test.ts plus existing journey/storage fixtures |
| M2 — first legacy Send owns the upgrade | Through the mounted Message/Send path, hold an actual append of a running legacy entry, ask Sidekick, and prove no provider turn before acknowledged publication. The keyboard remains usable while held. Release it; one pair is published under the same execution and writer facade, that same entry's later append reaches only the new entries file, and the message runs once. Old bytes remain the retained origin. | New mounted presentation tier, reusing storage/entry gates |
| M3 — actual shared entry path | Mounted explicit message drives the accepted greeting/then-table-revision journey through real EntryInput/Submit. Compare literal admitted source, actual entry output, cleared submitted Draft revision, exact-entry receipt feedback and final Output chat. A second explicit message uses the same conversation; changing the real binding used by a read changes the feedback/output observation. No body-only response is shown as chat. | repl-sidekick-journey.test.ts, added mounted tier |
| M4 — delayed message acknowledgement | Hold the physical message append, type newer Message text and a newer Draft edit, release it. The sent input/record uses the captured old text/revision; both newer texts survive and the newer Draft takeover remains. A same-revision control clears Message when its admission is acknowledged. Apply the root acknowledgement before an immediate reply's fill, so an unchanged prior takeover is released correctly. | New mounted presentation tier |
| M5 — busy and live wakeups | Hold generation after Send. Message remains editable, Send is not activatable and Stop is visible. Have the first response retain explicit Output plus a designated read, then hold its automatic follow-up generation. With no keyboard/entry event and the original message job still pending, the acknowledged first reply must appear. Release the follow-up; final chat updates, prepared unsent text survives and sends no extra turn. Include a one-burst repeated-Send attempt proving synchronous cycle reservation. | New mounted presentation tier, shared with M4 where practical |
| M6 — mounted Stop | Stop through its real control while Submit waits on an admitted entry. Sidekick joins, its reservation/control wait is withdrawn, no automatic next turn runs, and the entry remains running until independently released. Preserve chat/drafts; a later explicit Send is possible. Reuse one held owner-cleanup latch to show Stop has not reported completion or enabled a successor before join, while ordinary typing still works. | repl-sidekick-lifecycle.test.ts, added mounted tier |
| M7 — route, History and three profiles | At 160x36, 120x30 and 72x20, assert explicit Message focus, selected-body target absence, both text values and seven footer rows. Shrink default Sidekick visibility to narrow Entries, then explicit view=sidekick to narrow Sidekick, and expand without route loss. Include 60x15 refusal/recovery preserving texts. An older entry/History stays frozen while a current Sidekick message/read updates; Bindings switching and its old inspector remain usable. No final drawer or capture claim. | New repl-sidekick-presentation.test.ts using the real committed grid |
| M8 — command release | Controlled Exit and Control-C while Sidekick work is held cancel/join the owner and entry work, release subscriptions and restore the terminal once without another key. Hold cleanup long enough to prove the command has not returned early. Stop's entry-independent control in M6 distinguishes whole-command shutdown from Sidekick-only cancellation. | repl-sidekick-lifecycle.test.ts with the real program and terminal host |

Rows may share fixtures; this is not a required count of new tests. M2's storage
mechanism is already accepted; the new evidence proves the real mounted caller
uses it. M3 adds the production program connection missing from owner-only R5.
M7 is partial R8 evidence. Full R3/R4/R5/R6/R7/R8 and the packet remain open.

Existing owner, configuration and R2 assertions stay intact. Existing tests
specifically exercising the Bindings inspector may explicitly select Bindings
in setup now that the accepted command default is Sidekick; report that change
and preserve their claims. Do not add waits to the accepted no-wait journeys
or weaken terminal/layout assertions merely to make a new view fit.

## Focused commands and feedback commit

After the final source/spec edit, run these six commands in the worktree:

```text
deno task test packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts

deno task test packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-agent-execution.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-output.test.ts

deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts

deno task test packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-agent-journey.test.ts packages/cli/tests/repl-forms.test.ts

deno task test packages/cli/tests/repl-route.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-source-reading.test.ts

deno task test packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-lifecycle.test.ts
```

This includes the known program and layout consumers plus the new mounted
scenarios and underlying recovery/owner contracts. No full lint/check/JSR,
runtime suite, packaging build or CI is a feedback prerequisite. If a concrete
consumer outside this selection fails, preserve its first output and report the
selection gap; do not silently broaden acceptance or alter a journey.

One discriminating control is assigned: disable the new owner reading/busy
change notification while keeping the message-admission handshake, final job
reports and ordinary entry notifications intact. M5's no-input first-reply
observation while the follow-up is held must fail; its entry-update control
stays green. Checking only a final reply after the whole message returned would
not discriminate this, because the final job report also wakes the loop.
Confirm the mutation actually applied, preserve the first output, restore
byte-identically and rerun affected tests. No mutation matrix is required.

Commit promptly as one signed feedback increment when this evidence passes.
Return SHA, parent, branch, signature, tree status, all six commands/results,
M1–M8 mapping, control output and every fixture/assertion adaptation. Stop for
review. No push, GitHub mutation, CI inspection or terminal capture is assigned.

## Continuity

Base: `004de839e85e53cff4d960cb515729d350383f30`, signed G and clean.
Artifacts: this plan and
[the Implementor prompt](pr2-section5-mounted-message-implementor-prompt.md).
Settled: execution-owned acquisition on both storage forms, root-owned upgrade,
awaited revision acknowledgement, owned notifications, typed mounted Send/Stop
and six focused commands. P1/P2 and R2 remain closed. No material architecture
decision is delegated. Next action: implement only this slice and return its
signed feedback commit. Drawers, preview, Sessions integration, full terminal
acceptance and the capture packet remain separate work.
