# Streamed Sidekick Preview: observe the canonical turn

Core's existing prompt consumer sends live, disclosure-cleared text to an
optional method on the host publisher. Sidekick uses the existing pure preview
reader to show literal Output. Its provider is still called directly, once;
publication still acknowledges the saved turn, and evaluation still decides
what the response actually says and does.

This is the Architect ruling and Planner return requested by
[the Preview handoff](pr2-section5-preview-architect-handoff.md). It specifies
the missing observation mechanics under the accepted Preview product behavior.
It is not an implementation PASS or a new product interview.

## Exact base and limits

- SHA: `815233183c7c26cd40544347191b7ba5e1f975c3`.
- Parent: `57773de05246578da77c0f8689fbee004cbd84b4`.
- Branch: `agent/issue-883-pr2`.
- Implementation checkout: `.claude/worktrees/issue-883-pr2`.
- HEAD, signature G, signer tarasm@gmail.com and clean tree independently
  verified while preparing this ruling.

The implementation checkout remains unchanged. Configure/Retry and all prior
acceptances stay closed. No Sessions work, capture, push, GitHub mutation,
dependency change or CI inspection is included. The Planner freezes a bounded
Implementor assignment after this ruling.

## Why this surface

`runPrompt()` already consumes the canonical stream, places the direct-path
permission audit, calls the host publisher's `begin`, and returns the record
that `persistPrompt` publishes. Its consumer is the one place where the exact
turn and every arriving source delta are both known.

Ordinary Agent middleware no longer sees saved-conversation prompts. Putting
that routing back, decorating the selected provider or subscribing a second
time would duplicate an existing consumer or reopen the accepted routing
boundary. None is required. Extend the host publisher already installed inside
the conversation's execution, and observe from the existing consumer.

This follows architecture rules 23–25: observation belongs to the canonical
turn the host publisher already participates in; provider selection remains
fixed, and ordinary Agent composition stays available for ordinary work.

## 1. Exact host contract

In `packages/core/src/agent/publication.ts`, add this type and optional method:

```ts
export interface AgentPromptObservation {
  /** The exact value this turn's host begin returned. */
  readonly begun: AgentPromptHandle;
  /** Whole source received so far, or null to withdraw live text. */
  readonly text: string | null;
}

export interface AgentPromptPublisher {
  begin?(input: string): Operation<AgentPromptHandle>;
  observe?(observation: AgentPromptObservation): Operation<void>;
  publish(publication: AgentPromptPublication): Operation<void>;
}
```

Export `AgentPromptObservation` through `@executablemd/core/host`, beside the
existing publisher types. Keep `useAgentPromptPublisher` as the only host
installation operation. Add no public observer Context, Agent operation,
provider decorator, subscription API, scanner or policy accessor.

An observing publisher must supply `begin`. Refuse an observing installation
without it before any turn starts; old publishers without observe retain their
optional begin and existing behavior. Core carries the returned handle unchanged
and never interprets its contents. The CLI returns a fresh object per turn and
looks it up by exact identity in its private ownership map.

`observe` receives immutable snapshots. `text` is a replacement source prefix,
not a delta, rendered Output, a durable result or proof of acceptance. Empty
string is a cleared empty prefix; null means withdraw live text, with no source,
finding, scanner error or rejected value attached. It carries no Session,
checkpoint, predicted turn number or append operation.

The canonical consumer accumulates `text_delta` values in arrival order and
offers the complete prefix after each delta. When the stream returns, offer
its exact returned text if it differs from the last offered prefix, including
an empty return. This keeps Preview aligned with the source the canonical
record will actually hold without assuming deltas and return are identical.
Never repair or concatenate the stream's return value into its journal result.

Only live journal-owned turns notify. Replay invokes no begin/observe and
opens no provider stream. A public direct `Agent.prompt()` call outside the
canonical consumer acquires no observation or publication claim. Hosts with
no observe method incur no prefix accumulation or extra live scanning for
this feature; their existing consumer/publication behavior is unchanged.

## 2. Bind updates to the response that asked for the turn

Install one publisher for each held Sidekick conversation through its existing
execution installations in `owner.ts`'s `open` path. Do not install it around
`owner.message()` in the outer CLI scope: that is not where the saved
conversation executes.

Before `respond()` hands its request to `handle.prompt`, register its existing
`ResponseAt` and a live response slot privately with this conversation's
publisher. This registration is an ordinary local action and does not suspend
between next-turn preference selection and prompt handoff.

`begin()` consumes that registration for this canonical invocation and returns
a fresh opaque handle. Map that exact handle to the registered response slot.
`observe()` and `publish()` use the same mapping. Do not correlate by input
text, message contents, coroutine recency, guessed canonical turn numbers or
the next matching event. `ResponseAt` is the existing CLI response identity;
its spelling does not establish which canonical turn ran.

Each automatic follow-up registers its own response slot and gets a distinct
begin handle. A notification for a closed, stopped or replaced slot changes
nothing. Register slot cleanup before prompting. Stop, failure and conversation
replacement revoke the slot through its owner's teardown; joined cancellation
means no old observer can update a later chat after Stop returns.

The CLI's publish implementation calls the exact `publication.append()` once.
It does not substitute a record, acknowledge from observe, or announce a final
reply from a provider terminal. After acknowledgement, existing
`turnForRequest` reads the actual canonical association, and the existing
response evaluation/record supplies final Output. Use that evidence to merge
the live slot with the corresponding retained item.

Keep one presentation key for that item across Preview, evaluation and retained
reply/incomplete transition. Any local key/alias needed to connect the opaque
handle to the acknowledged item is process-local view data, not a new durable
ID. Never show the live slot and its acknowledged counterpart as duplicate
responses. A cancelled slot with no canonical record claims no turn number.

## 3. Clear whole prefixes inside the owning execution

Before calling observe with text, Core's canonical consumer calls the existing
package-private `clearsLiveOutput(wholePrefix)` inside the conversation's own
execution. It is the same authenticated disclosure operation used by
`execute()`'s output bridge. The source has not yet left Core at this point.

Scan the accumulated source, not each transport delta in isolation. A secret
split between deltas must be detected when the whole prefix contains it. Clear
the exact string handed to observe, including the final-return replacement if
one is offered. The CLI then calls `previewGeneratedXmdRoot` on that cleared
prefix and retains only its safe literal Output projection for presentation.
It adds no scanner, tag regexp, interpolation evaluator or source repair.

On findings, scanner failure, missing policy or counterfeit policy, send null
to withdraw any earlier live body, then withhold further source notifications
for that turn. This is a presentation decision, not a provider failure or an
admission result. Continue the one canonical consumer and leave its journal
gate responsible for the definitive persistence outcome. A live scan failure
does not get serialized into a fabricated agent terminal.

Only the owning execution's explicitly disabled policy clears without scanning.
An enabled/disabled description or scan run in the outer CLI execution cannot
clear another execution's source. Keep the policy/scanner private, and update
the helper's package-private caller documentation rather than exporting it.
Do not print raw candidate text, findings, scanner exceptions or observer
exceptions through a diagnostic fallback.

The pure preview reader's `incomplete` flag describes syntax, not provider
completion. Even a syntactically complete prefix remains Preview until the
provider has completed, its turn is acknowledged and response evaluation has
settled. A preview refusal removes its candidate body; it cannot authorize
controls, render raw source or create a fallback chat response.

## 4. One subscription; host failures keep their classification

Observe inline in the existing canonical consumer, after processing the source
delta and before requesting the next provider event. Await the observation
operation. It may suspend consumption; there is one observer call in flight,
no detached delivery task, second subscription or unbounded notification queue.
The CLI observer only updates its local preview facts and sends the owner's
existing wake notification. It does not wait for input, a frame, a database
transaction, evaluation or another provider call.

Keep the exact existing provider events, returned text, terminal/checkpoint
association, direct-path permission audit and canonical result construction.
Observer bookkeeping does not invent a started/terminal event or alter the
provider's status. Generic DocumentOutput stays buffered.

An observer that throws has failed a trusted host operation, as a throwing
publish does. It is not an agent failure. Cancel and join the stream through
its existing scope and carry the original failure to the canonical
publication coordinator's existing `activateFailure` path. Do not append a
provider-failed Prompt record or evaluate candidate source because this hook
failed. Keep an already classified durability failure and its cause/identity
under the existing failure contract.

This needs a narrow internal distinction: `runPrompt` currently catches errors
as provider failures, and `promptPublication` currently serializes errors from
its execute body. A failure from the new host observation call must bypass
those provider-result conversions and reach `activateFailure` before
publication. Use a Core-private wrapper/marker carrying the original exception;
its internal name/factoring is delegated. Add no public error family, Context
approval flag or new journal grammar. Old begin/publish and nonobserving turn
behavior are not redesigned.

Null from the disclosure check is not an observer exception and takes no such
failure path. The journal's existing pre-append secret/persistence gate stays
authoritative. A publication failure withdraws the live slot and propagates
through the existing fatal conversation/command path; the host does not mark
it as a recoverable provider failure or enable Retry to bypass it.

Cancellation stops an awaited observation as part of that same turn. No late
callback remains after the consumer joins. Closing the REPL joins the response,
its observer and provider cleanup through their existing owners. An admitted
entry remains independent, as the accepted Stop contract requires.

## 5. Preview, Incomplete and saved facts

Keep live preview outside `SidekickReading`'s acknowledged history projection.
Expose detached process-local preview facts from the existing owner for
`program.ts` to compose into `ReplSidekickReading`; `application.ts` receives
display data, never source, host handles, a writer or new execution control.
The owner retains only cleared literal Output and its existing response binding.
Its changes stream wakes the root without terminal input.

Preview survives the transition from generation to response execution. It stays
labelled Preview while controls are running or an admitted entry is pending.
The existing acknowledged response outcome replaces that same item with actual
evaluated Output, including Core's evaluated partial Output on an ordinary
runtime failure. Earlier effects stand. Controls-only replies render no fallback
body chat, and operation feedback does not become chat.

A provider failure during generation executes none of its candidate controls.
Where a canonical failed record is acknowledged, project its source through
the pure preview reader and merge it into the same item labelled Incomplete,
with the retained failure. Stop during generation also executes none of the
candidate controls. Cancellation may retain no Prompt outcome: keep the last
cleared literal Preview as process-local Incomplete, without claiming provider
acceptance, a canonical turn, response record or failure that was not saved.
Stop during evaluation preserves already executed effects and existing
unfinished-operation records; it does not roll them back to pretend generation
was the only phase that ran.

On a cold read, only an actual canonical failed/cancelled Prompt record supplies
source for an Incomplete item's pure projection. Restored records have crossed
the existing durable disclosure gate; follow the established restoration
contract rather than using an unrelated ambient policy as proof or starting
provider work to render history. `execute()` already treats restored output as
previously gated. The pure reader still excludes computed text and controls.
No saved record means there is no cold reconstruction of a process-local
cancelled Preview. Do not persist it solely to preserve a screen.

New explicit work clears/replaces the previous transient slot and obtains its
own begin handle. Its updates cannot revive a stopped Preview or leak one
conversation's candidate into a replacement agent. Existing retained
Incomplete items and Retry associations remain historical facts. An unreadable
history still shows its refusal instead of a remembered live body.

## Planner return: source boundaries and finite evidence

The required source/public-contract changes are:

- Core `agent/publication.ts` and `host.ts`: the exact optional observe member,
  observation type and installation validation above; retain begin/publish.
- Core `agent/function-components.ts`: optional canonical source accumulation,
  owning-execution disclosure and inline observation on the one consumer.
- Core `agent/journal.ts`: route observation host failures to its existing
  durability activation rather than provider-result serialization; preserve
  exact once-only append and associations.
- Core `secrets/policy.ts`: reuse the existing private clearing operation and
  align its caller documentation. No scanner/policy export or behavior change.
- CLI `sidekick/owner.ts`: conversation-installed publisher, private response
  registration/handle mapping, preview facts and revocation. No Agent routing.
- CLI `program.ts`/`application.ts`: detached live/history composition with a
  stable response item, Preview/Incomplete labels and existing wake/focus rules.
  `model.ts` keeps acknowledged source facts and the pure history boundary.
- Existing fake ACP fixture: incremental deltas and a held-after-delta gate,
  used through the real owner/profile/provider and mounted-program harness.
- Affected host publisher, preview, disclosure and Sidekick specification /
  architecture descriptions. No new durable records or provider API fields.

Freeze a finite matrix from the handoff's already accepted J4/J11 journeys:

1. A real direct turn held after literal Output plus candidate controls shows
   Preview without input, writes no control pair/effect and preserves both
   composers. Hold evaluation separately after successful generation; the same
   item stays Preview until acknowledged evaluated Output replaces it. A
   controls-only control supplies no fallback body chat. Reuse the existing
   ordinary evaluation-failure case to check that actual partial Output also
   replaces Preview on failure, with earlier effects intact.
2. Use representative delimiter/expression/passive-fence splits and compare
   mounted text with the existing Core pure reader. Reuse its parser corpus;
   do not duplicate it in CLI tests. Never infer permission from syntax completion.
3. Pair provider failure after text with Stop after text: Incomplete literal
   body, no candidate evaluation or automatic successor, proper join and entry
   independence. Include a following explicit turn to prove stale handles do
   not update its item. Canonical failed-record cold projection and the absence
   of a record after cancellation establish the two truthful recovery cases.
4. Pair an owning-execution secret-bearing accumulated prefix with cleared
   text. Split the secret across deltas; the full candidate is withheld and
   prior body withdrawn, while the existing journal gate still determines
   failure. Use one authentic-policy versus unavailable/counterfeit-policy
   observation at this new consumer; reuse existing policy tests for detailed
   scanner authentication/failure and disabled-policy behavior. Do not create
   another hostile-context matrix or log rejected contents.
5. One observer-exception control proves a host failure, joined provider
   cleanup and no fabricated provider-failed Prompt/response. Its nonthrowing
   control publishes once with the same begun handle, permissions and checkpoint.
   Preserve DP2/DP4 and ordinary nonobserving publisher assertions.

The Planner chooses permanent fixture/test placement and focused commands,
including the affected Core agent-function/agent-conversation, pure preview and
secret-detection consumers plus the existing mounted Sidekick selections.
Known workflow/ordinary publisher consumers retain their accepted behavior;
include their focused checks if the actual patch touches that integration.
No full suite, capture or delivery battery is needed to prepare or give
feedback on this slice. Preserve first failure output for any assigned probe
or command. Do not broaden the matrix with speculative permutations.

No unresolved product choice was found in this trace. The exact observation,
disclosure, correlation and failure mechanics above are the ruling for the
Planner; do not delegate them to the Implementor. Local helpers and view-data
field names remain implementation choices. Write the bounded Planner handoff
and ready-to-send Implementor prompt, grounded at verified 81523318, before
implementation begins.

This ruling used direct source/contract tracing; no probe or runtime test was
needed. No implementation edit, commit, push, GitHub mutation, CI inspection or
capture was performed. Next action: Planner freezes the Preview assignment;
Configure/Retry, all prior slices and separate delivery limits remain closed.
The [Planner continuation prompt](pr2-section5-preview-planner-prompt.md) is
ready to send.
