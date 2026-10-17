# Show streamed Sidekick Output as Preview

**Accepted at 10b17a40, 2026-10-14.**
[The PASS review](pr2-preview-planner-review-10b17a40.md) closes PV-P1 and
PV-E1 and accepts this bounded PV1–PV5 slice at signed clean
10b17a40fb07eb2fe623c9b4e4a5259d0501fe9a. No Preview correction remains.
The frozen scope below records the accepted assignment; its older starting
revisions and correction statuses are historical. Hold the accepted head for
the next assignment. Sessions, complete terminal evidence, captures and delivery
remain deferred.

**Correction at f8b4e035: REQUEST CHANGES, 2026-10-14.**
[The review](pr2-preview-planner-review-f8b4e035.md) closes the collision and
most missing observations. Execute
[the narrow correction](pr2-preview-implementor-correction-f8b4e035.md) from
signed clean f8b4e035382e22cf0f19b743dcb3b26f3bd4cc02, preserving b44098ff.
One failed generation still becomes two rows after cleanup and changes its key;
PV5 still needs a held return observation. The ruled architecture/frozen matrix
remain authoritative. Earlier starting revisions below are historical; the
Preview slice remains unaccepted.

**Feedback at b44098ff: REQUEST CHANGES, 2026-10-14.**
Execute [the correction](pr2-preview-implementor-correction-b44098ff.md) from
signed clean b44098ffd18ebc2bb7f6f46a38a3f09a55889959, preserving parent
81523318. [The review](pr2-preview-planner-review-b44098ff.md) reproduces a
response-key collision and names the incomplete frozen observations. The ruling,
matrix and focused commands below still govern; the original starting revision
is historical. PV2 is accepted as the deterministic wake-control witness.
The slice remains unaccepted and deferred work stays closed.

Ready for implementation from signed clean
`815233183c7c26cd40544347191b7ba5e1f975c3`. A person sees literal Output as a
Sidekick response arrives, then sees that same item become the evaluated reply.
Partial generation performs no control. Failed or stopped generation leaves
Incomplete rather than claiming that a response ran.

This plan freezes the bounded streamed-Preview slice of #883 PR 2. Execute
[the Implementor prompt](pr2-section5-preview-implementor-prompt.md).
The [Architect ruling](pr2-section5-preview-architect-decision.md) is incorporated
below; no product or architecture answer remains pending for this slice.

## Base and scope

Implementation worktree:
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`.
Branch agent/issue-883-pr2, parent
`57773de05246578da77c0f8689fbee004cbd84b4`, signature G,
signer tarasm@gmail.com. HEAD and clean/untracked status were independently
verified during planning. Main is e61d6ce072735b5d0cf683eeaca0f2eefddc2d59 with
unrelated edits; it is not the implementation base.

Planning files live in the main checkout. Follow .agents/implementor.md,
repository instructions, the writing-for-agents guide for any instruction edit,
and the accepted architecture rules. Preserve unrelated work and all signed
ancestors. Reconcile an advanced head without reset, amend or discard.

Included: the specified optional Core host-publisher observation, its private
host-failure path, conversation-owned Preview facts, safe cold Incomplete
projection, same-item presentation, incremental fake transport gates, finite
Core/mounted evidence and affected documentation.

Configure/Retry, direct-provider routing, configuration comparison, completion
evidence, activation, native identity, R2, admission/Pause, Send/Stop and question
acceptances stay closed. No new record, storage migration, response permission,
provider method, flag, route member or scanner export. Sessions integration,
complete terminal R5–R8 closure, the 36-frame packet and delivery remain deferred.
No real terminal capture, dependency change, push, GitHub mutation or CI inspection.

## Governing contracts and current consumers

Read [the ruling](pr2-section5-preview-architect-decision.md) fully, then
[the traced handoff](pr2-section5-preview-architect-handoff.md),
[J4/J11](remaining-architecture.md#accepted-journey-4-streamed-chat-and-operation-feedback-stay-distinct),
[the pure preview contract](core-interfaces-proposal.md#2-safe-streaming-preview),
and DP2/DP4 in [the direct-provider plan](pr2-direct-provider-planner-handoff.md).
The ruling supersedes the original plan's unspecified observation mechanics.

Core's generated-xmd-preview.ts already supplies the pure reader. runPrompt()
in agent/function-components.ts is the canonical consumer for ordinary Prompt
and saved conversations, including the direct-path audit. agent/publication.ts
currently offers begin/publish, and agent/journal.ts owns the coordinated append.
The private clearsLiveOutput() already guards execute()'s live output bridge.

The CLI owner currently awaits handle.prompt() and projects acknowledged history;
program.ts's sidekickReadingOf() passes detached chat to application.ts's
sidekickItems(). owner.changes already feeds the root wake queue. owner.open()
supplies the conversation's execution installations. These are the concrete
consumers for the new hook; ordinary Agent middleware cannot observe the direct
conversation path and is not an alternative route.

Existing publisher consumers include core agent-function-components tests,
workflow's retained checkpoint publisher and the CLI workflow-agent host.
Their old optional begin and exact-once publication behavior remain covered.
fake-acp.ts currently supplies one reply delta and holds generation before text;
extend that fixture for controlled incremental delivery, rather than creating
a second provider or terminal harness.

## Exact Core contract

In packages/core/src/agent/publication.ts add, and in core/host.ts export, the
type specified by the Architect:

```ts
export interface AgentPromptObservation {
  readonly begun: AgentPromptHandle;
  readonly text: string | null;
}

export interface AgentPromptPublisher {
  begin?(input: string): Operation<AgentPromptHandle>;
  observe?(observation: AgentPromptObservation): Operation<void>;
  publish(publication: AgentPromptPublication): Operation<void>;
}
```

useAgentPromptPublisher() remains the installation operation. An installation
with observe but without begin refuses before a turn starts. Nonobserving
publishers retain optional begin and their current behavior. No new public error
family, Context, subscription method, Agent operation or provider decorator.

The canonical consumer sends immutable snapshots carrying the exact begin
handle and whole accumulated source after each text_delta. The returned stream
text replaces the last candidate when different, including an empty return.
It is never concatenated into or substituted for the provider's journal result.
No observer means no feature-specific accumulation or extra live scanning.
Replay and nonjournaled direct Agent.prompt() calls notify nobody.

Before exposing each candidate, including a changed final return, call the
existing package-private clearsLiveOutput(wholePrefix) inside the owning
execution. A cleared empty string and null are distinct: null withdraws the
body. Findings, scanner failure, unavailable or counterfeit policy send null
and withhold further source notifications for that turn. Continue consumption;
the existing durable gate still decides persistence failure. Only the owning
execution's explicit disabled policy clears without scanning.

Observe inline, await it, then request the next provider event. There is one
cold subscription, one observation in flight and no detached queue. Preserve
provider return, terminal/checkpoint association, permission audit and ordinary
Prompt semantics. Generic DocumentOutput stays buffered.

An observe exception is a trusted host failure. Join provider cleanup and carry
the original exception through a Core-private marker past runPrompt's provider
catch and promptPublication's result serialization to the existing
activateFailure path before any Prompt result is appended. Retain already
classified durability failure identity/cause under its existing contract.
Do not synthesize a provider-failed terminal or make this an automatic correction
or Retry. Null withdrawal is not an exception. Old begin/publish behavior is not
redesigned. Local private factoring is delegated within these constraints.

## Conversation and screen ownership

Install the publisher inside each held conversation through owner.open()'s
execution installations. Its publish calls the supplied publication.append()
exactly once. Observation cannot acknowledge a turn or publish a final reply.

Before respond() hands off to handle.prompt(), register its existing ResponseAt
and process-local response slot with that conversation's publisher. Register
cleanup before prompting. Registration is a synchronous local action: it adds
no suspension between the latest acknowledged preference selection and prompt
handoff. begin() consumes that registration and returns a fresh object; a
private exact-identity map relates it to this response. Each automatic follow-up
has its own registration/handle. Do not match input text, guess a turn number,
reuse a previous handle or infer an association from source syntax.

Observe updates only the still-owned slot and the owner's existing wake signal.
It waits for no frame, input, database transaction, evaluation or provider call.
Stop, replacement, failure and teardown revoke through the existing owner
lifetimes. Old notifications cannot change a successor. Publication failure
withdraws the body and follows the existing fatal command/conversation path.

The owner retains cleared literal Output from previewGeneratedXmdRoot(), not
raw source for the UI. Pass detached facts through program.ts to application.ts.
Keep live facts outside SidekickReading's acknowledged projection. A preview
parse refusal removes the candidate body, never displays raw source or grants
execution. Syntax incomplete:false is not provider completion.

One presentation key spans live generation, response execution and retained
reply/Incomplete. A local alias may connect the live slot to the actual canonical
turn obtained by turnForRequest() after append; it is not a durable ID. Do not
mount both representations. Preview remains labelled Preview while evaluated
controls or an admitted entry are pending. Only acknowledged evaluated Output
replaces it, including actual partial Output on ordinary evaluation failure.
Controls-only replies and designated feedback produce no fallback body chat.

For failed generation, use the acknowledged failed Prompt source through the
pure reader and preserve its saved reason/Retry association. Stop can leave no
Prompt outcome: retain the last cleared literal body as process-local Incomplete,
with no claimed turn, response record, provider acceptance or invented failure.
New explicit work replaces that transient slot; real retained attempts remain.
Stop during evaluation preserves effects already performed and unfinished
operation records. It is not a rollback to before generation.

A cold read projects only actual failed/cancelled Prompt source, which crossed
the durable disclosure gate, through the pure reader. It starts no provider,
performs no fresh outer-scope scan and reconstructs no unsaved cancelled slot.
An unreadable history shows its refusal instead of a remembered body.

Use the existing chat window and mounted tree. Preserve both composers, draft
takeover, History, tab/route choices, frame-derived drawer ownership, all three
admitted layouts, the seven-row footer and the existing too-small refusal.
Background updates move no focus or selected pane. Hidden bodies gain no targets.

## Ordered implementation

1. Add the exact host type/method and installation validation. Add the narrow
   private observation-failure distinction used by the canonical consumer and
   journal coordinator. Do not widen core/mod.ts or provider APIs.
2. Observe from runPrompt's existing stream consumption, with accumulated-prefix
   clearing and the changed final-return rule. Reuse clearsLiveOutput; update
   its caller documentation to include this consumer, leaving policy behavior
   and exports unchanged. Preserve the direct audit and publication.
3. Add conversation-installed publication/observation in owner.ts, response
   registration/revocation and detached Preview facts. Preserve next-turn
   preference timing and the owner-owned Stop/join contract.
4. Compose live and acknowledged items in program.ts; render Preview/Incomplete
   and evaluated replacements in application.ts. Keep model.ts an acknowledged
   projection; use its canonical failed-source facts for safe cold presentation.
   Local view fields/keys are delegated; no new journal or application store.
5. Extend only the existing fake ACP transport for scripted deltas, held-after-
   delta release/failure and cancellation observations. Preserve all old fixture
   defaults. Use mounted-program.ts and existing owner/Core fixtures for PV1–PV5.
6. Align core host/publisher/consumer/policy comments and the relevant sections
   or module inventory in specs/executable-mdx-spec.md and architecture.md.
   Update specs/repl-spec.md's current busy-only sentence and the implemented
   Sidekick Preview/Incomplete behavior. Remove affected stale source comments
   that say this pane has no question/Configure controls; do not sweep unrelated
   prose. No guide/bootstrap or vocabulary change is assigned.
7. Complete the finite evidence and controls below, run the final focused
   selections, then return one signed feedback commit. The layers above are
   ordered work within this single bounded slice, not separate product approvals.

## Frozen evidence: PV1–PV5

These five groups implement the Architect's five observations. Paired arms may
share fixtures and existing rows. Do not duplicate the Core parser/policy corpus
or add a timing/settings permutation matrix. A deadline bounds a missing result;
readiness comes from a real held event/append/cleanup, not elapsed time.

| Group | Required observations | Permanent destination |
| --- | --- | --- |
| PV1 — one item, no early effects | A real direct-provider turn streams literal Output plus candidate EntryInput and a designated read, then holds. With terminal.fed unchanged, Preview arrives once; no control pair/read/fill has run; both composers keep unsent text, Send is unavailable and Stop remains available. Release generation and hold real response evaluation separately: the same item stays Preview until evaluation settles, then becomes canonical Output with no duplicate node/item. Compare actual ordered designated feedback at the next turn; it is not chat. Pair with controls-only/no-fallback behavior. Adapt/reuse the existing ordinary partial-root failure row so evaluated partial Output replaces the candidate and earlier effects stand. | repl-sidekick-journey.test.ts mounted tier; existing owner partial-failure row may carry that consequence; presentation test only for necessary node identity/focus observations |
| PV2 — whole prefixes, exact return | One representative incremental mounted sequence splits an Output delimiter, a declarative expression/interpolation and a passive fence. Compare each released prefix with previewGeneratedXmdRoot(); computed content waits, passive examples create no Output and parse refusal withdraws its body. A syntactically complete held prefix still executes nothing. At Core's canonical consumer, a return differing from its deltas replaces the candidate exactly; include an empty-return arm. Two canonical invocations use distinct begin objects even with equal input, and each observation/publication carries its own exact object. Old C2 parser rows remain unchanged. | repl-sidekick-journey.test.ts for representative mounted splits; agent-conversation.test.ts for canonical prefix/return/handle facts; existing generated-xmd-preview.test.ts unchanged |
| PV3 — Incomplete and cancellation | Pair generation failure after a shown literal body with Stop after a shown body. Candidate controls never run and no automatic successor starts. Failure projects its real canonical failed record; a cold reopen shows safe literal Incomplete/reason with no provider calls or writes. Stop joins a held provider cleanup, preserves an independent admitted entry and leaves process-local Incomplete without inventing a Prompt/response/turn. Cold reopen cannot restore that unsaved slot. A following explicit turn has its own item and no stale updates from the stopped/replaced slot. Existing replacement revocation remains asserted by the owned-slot boundary; no new agent-settings matrix. | repl-sidekick-lifecycle.test.ts mounted tier; reuse existing mounted/recovery helpers for cold reopen and existing Stop/entry controls |
| PV4 — disclosure before observation | Through the direct canonical consumer, first show a cleared prefix, then split a synthetic secret across deltas. When the whole prefix matches, observer receives null, the earlier body disappears and later source is withheld; only the existing journal gate decides failure. A cleared control notifies/publishes normally. Add one counterfeit-policy arm versus the authentic control at this new consumer: it withdraws without treating outer policy as clearance. Reuse existing policy tests for scanner failure/disabled/missing-policy details. A changed final-return candidate crosses the same clearing path. Assert sanitized facts without printing candidate secrets or scanner errors. | agent-conversation.test.ts for direct consumer observation under owning execution; existing secret-detection.test.ts for policy corpus; use existing private scanner-factory test seam rather than a new detector |
| PV5 — host failure, ordinary compatibility | An observing installation without begin refuses before provider/session/turn work; a valid one is its control. An observe that throws causes authoritative host/durability failure with the original cause under the existing contract, joins held provider cleanup, appends no fabricated provider-failed Prompt/response and evaluates no candidate. Its nonthrowing direct-path control publishes once with exact begin handle, permissions and checkpoint unchanged. Replay causes zero begin/observe/provider work. Preserve existing nonobserving AFP/CV/DP2/DP4 and workflow publisher assertions; no prefix scan is added when observation is absent. | agent-conversation.test.ts direct tier; agent-function-components.test.ts for ordinary publication/installation compatibility; workflow/ACP focused suites below |

PV1/PV3 drive runReplProgram with the real profile, repository, owner, evaluator
and mounted tree. Only terminal and ACP transport are replaced. Use a production
read/append/evaluation boundary for holds; do not hand-write an admitted response
or saved result to establish the effect being tested. Cold checks reopen the
history the preceding real execution wrote. The existing recovery subprocess
producer may be reused if needed, without creating a second journal.

Keep the private handle, raw source and append function out of ReplLive display
facts. Inspect actual mounted identity for the same-item claim; counting matching
text alone does not prove that a preview node was replaced. Use the mounted
fixture's existing typing/resize/tab tools to check no focus/composer regression;
the frozen predecessor layout rows supply the full geometry corpus.

### Three discriminating controls

Run each against a private byte copy, confirm the mutation is present, preserve
its first output, restore byte-identically and rerun its affected rows:

1. Suppress the owner's wake notification for an observation only. PV1's
   no-terminal-input Preview assertion fails; an ordinary completed-reply wake
   control stays green. Do not also remove the existing completion wake path.
2. Clear individual deltas instead of the accumulated candidate. PV4's split
   secret/withdrawal regression fails, while its cleared control stays green.
   Observe booleans/counters/null for failure reporting, not raw secret text.
3. Convert an observe exception into the ordinary failed-provider result instead
   of the ruled host-failure path. PV5's host-failure regression fails; its
   nonthrowing exact-publication control stays green.

These are the finite mutation threshold. Prior five Configure controls, Apply
controls and DP2/DP4 mutations need not be repeated; their permanent rows remain
in the selections. If a control cannot discriminate, return the measured gap
rather than inventing another matrix or claiming a pass.

## Focused commands for the feedback commit

Run from the implementation worktree after the final edit. Commands 1–4 cover
the changed canonical consumer, private disclosure, public publisher and known
black-box host/checkpoint consumers. Commands 5–10 retain the mounted selections
because owner/program/application changes cross those product boundaries.

1. Canonical turn and ordinary lifecycle consumers:

```sh
deno task test packages/core/tests/agent-function-components.test.ts packages/core/tests/agent-conversation.test.ts packages/core/tests/agent-components.test.ts packages/core/tests/agent-session-launch.test.ts
```

2. Existing pure preview and authenticated disclosure corpus:

```sh
deno task test packages/core/tests/generated-xmd-preview.test.ts packages/core/tests/secret-detection.test.ts
```

3. Direct-provider and loaded-copy integrations:

```sh
deno task test packages/acp/tests/host-conversation.test.ts packages/acp/tests/loaded-copy.test.ts
```

4. Existing nonobserving host publishers and retained checkpoints:

```sh
deno task test packages/workflow/tests/workflow-agent-checkpoints.test.ts packages/cli/tests/workflow-agent.test.ts packages/cli/tests/workflow-agent-sessions.test.ts
```

5. Mounted Sidekick and owner lifetimes:

```sh
deno task test packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts
```

6. Entries, acknowledged reads and response controls:

```sh
deno task test packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-agent-execution.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-output.test.ts
```

7. Recovery, serialized chat writes and configuration:

```sh
deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts
```

8. Ordinary journeys, agent observations and forms:

```sh
deno task test packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-agent-journey.test.ts packages/cli/tests/repl-forms.test.ts
```

9. Route, layout and source reading:

```sh
deno task test packages/cli/tests/repl-route.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-source-reading.test.ts
```

10. Execution departure and lifecycle:

```sh
deno task test packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-lifecycle.test.ts
```

No runtime test was run for this planning task: source/contract tracing and the
accepted 81523318 review establish the starting state. Full suite, check, lint,
JSR, packaging, captures and CI are not feedback prerequisites. Source/package
documentation and specialized repository procedures still apply when touched;
no dependency, build or generated artifact change is assigned.

Preserve first failure output before rerunning. Known U2 intermittence remains
separate in [its local record](pr2-mounted-permission-u2-flake-a438905f.md).
Report a recurrence and unchanged rerun without weakening its assertion or
folding unrelated repair into this slice. No GitHub mutation is authorized.
Old scratch probes are not newly assigned commands; accepted permanent rows
remain the regression baseline.

## Feedback and continuity

Once PV1–PV5, the three controls and these ten focused commands pass, commit
promptly with signing enabled and return exact SHA, parent, branch, signature,
tree/untracked status, every command/result, PV mapping, mutation output and
fixture/assertion adaptations. Preserve any first failure output. Do not end
after individual files or rows: continue to the signed handback, with progress
updates, unless a concrete contract conflict requires a ruling.

The next action is implementation from exact accepted base
815233183c7c26cd40544347191b7ba5e1f975c3 and a Planner review of the resulting
feedback SHA. This remains PR 2 on its accepted stack; no main-first work or
new PR split is needed. Produced artifacts are this plan and the linked
Implementor prompt. The publisher interface, turn correlation, disclosure,
host-failure classification and transient/cold Incomplete behavior are settled
by the Architect. No unresolved blocker remains for this bounded assignment.
Sessions integration, complete terminal evidence, the capture packet and
delivery await separate assignments.
