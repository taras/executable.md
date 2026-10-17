# Implementation amendment: evaluate roots through their owning execution

**Feedback status:** [PASS at 01abab27](pr2-root-evaluation-planner-review-01abab27.md).
The bound Core amendment satisfies E1–E9. Invocation closure, history-read
forwarding and authoritative failure ranking are accepted; all review findings
are closed. Resume the main plan's section 3 admission gate. The base below
records the original amendment base; the review records the accepted feedback
SHA and focused evidence. Full CLI acceptance remains separate.

Implement the accepted execution- and conversation-bound root evaluators before
continuing the Sidekick admission gate. Both read the documentation captured by
their owning execution before root import. This handoff supplies the ordered
work and finite feedback evidence for the accepted
[Architect boundary](root-evaluation-architect-handoff.md).

This amendment replaces the siteless root export and the request for another
wiring proposal in [the main plan](planner-handoff.md). The installer callback
and protected synthetic-host proposals are withdrawn. No architecture decision
remains open. Keep the correction inside PR 2; the series still contains two
PRs. The linked feedback verdict accepts this amendment's implementation; the
remaining CLI work stays governed by the main plan.

## Base and current state

Work in `.claude/worktrees/issue-883-pr2`, branch `agent/issue-883-pr2`, from
`8be2d2bc3c38c4a896d0b678e121beef28e02920`, parent
`91eb10bd14b279dc764958972c401810a77f230d`. Its accepted Core foundation is
`79d404d04d02c3840892473b6f1b2cf540f3edd1`. Preserve the untracked
`packages/cli/src/repl/sidekick/gate.ts` byte for byte; exclude it from this
feedback commit. Do not reset, stash or change the base as part of this
amendment.

At this head, generated-xmd.ts mints scoped Syntax routing and constructs a
reference from Core's documentation terminal. That prevents late substitution
but omits contributed package chapters. executeInstalled still returns
DocumentExecution, and AgentConversation has only prompt/options. The existing
controls tests call the siteless evaluator from inside a host component. Those
are the seams this amendment replaces.

Keep accepted storage, projection, output and control behavior. The Core tests
below prove Core recovery; they do not complete the CLI's remaining fresh-process
R2 cases or its admission gate. Those remain in the main plan.

## Public contract

Export HostExecution from `@executablemd/core/host` and change only the trusted
executeInstalled return type:

```ts
interface HostExecution extends DocumentExecution {
  evaluateGeneratedXmdRoot(
    request: GeneratedXmdRequest,
  ): Operation<Result<GeneratedXmdRootResult>>;
}

function executeInstalled(
  options: ExecuteOptions,
  installations: readonly ExecutionInstallation[],
  initialization?: ExecutionInitialization,
): Operation<HostExecution>;

interface AgentConversation {
  prompt(
    input: string,
    configuration?: SessionConfiguration,
  ): Operation<Result<string>>;
  options(request?: AgentOptionsRequest): Operation<Result<AgentOptions>>;
  evaluateGeneratedXmdRoot(
    request: GeneratedXmdRequest,
  ): Operation<Result<GeneratedXmdRootResult>>;
}
```

Remove the module-level siteless root evaluator from the host surface. Keep
GeneratedXmdRequest, success/partial-error data, preview, fragment evaluation and
useAgentConversation's request/result unchanged. Add no callback, initialization
member, request field, site accessor or reference token. Ordinary execute()
keeps DocumentExecution and exposes no evaluator at runtime, including through
its prototype. A host handle retains its existing output and iterable main
completion; evaluating a root does not complete or replace the main document.
The method works only while its execution is live.

Sidekick calls conversation.prompt first and evaluates only its successful
complete source with conversation.evaluateGeneratedXmdRoot. Prompt itself does
not evaluate. Evaluation sends no provider prompt and changes no configuration.
Standalone host evaluation requires no conversation or caller-side durable
context.

## Ordered implementation

### 1. Bind the evaluator where execution captures authority

In `packages/core/src/execute.ts`, after installIdentities and construction of
rootSyntaxReference, call a private binder in `src/generated-xmd.ts` with the
exact execution-minted Syntax definition from identity.protected, its guarded
componentRouting and its captured SyntaxReference. Pass these by value. The
static Syntax declaration cannot substitute for the minted implementation.
The binder returns an operation, not its protected inputs.

For each root call, include canonical self-closing Syntax in the final admitted
read table and retained policy, narrow routing using the exact admitted
implementations, and use capturedReference.available(admittedSymbols(entries)).
Bare Syntax describes that root's vocabulary. Named lookup retains captured
authoring symbols and package chapters, with availability information. Preserve
ordinary rendering, as capture and retained text; Syntax is not designated
Sidekick feedback. Keep selected classes, pinned identities, form/collision
checks, complete-source admission and the isolated root binding environment.

Remove the root's scoped minting and Core-terminal reference workaround once
both bound paths replace them. Remove installScopedProtected and any helper
introduced solely for that path only if no consumer remains. Preserve ordinary
protected installation, canonical Evaluate and released fragment admission,
reference, routing and record encodings. Do not recover raw contributions or
read Documentation middleware again during evaluation.

Observable result: canonical Syntax can describe the actual response ceiling
and read a captured package chapter without admitting that package's component.

### 2. Run and journal work in the live execution

Add a private `packages/core/src/generated-root-owner.ts` for the concrete
execution-owned request runner and its journal views. Keep admission and
rendering in generated-xmd.ts. In execute.ts, pass its private activation closure
beside the existing documentWorkflow expansion inputs. Activate the runner
before authored root work, inside the canonical document scope after
Execution.document has installed runtime services. Caller contexts never
select the execution environment or durable journal.

Carry the bound operation through the private invocation/completion result to
executeInstalled. Build the host wrapper there. Ordinary execute() returns
only the existing document object; do not attach a method and hide its type.
Initial evaluation waits for runner readiness or reports closure. It does not
fall back to a caller scope. Register cleanup before activation and producers.

The owner admits one root call at a time and refuses overlap without queuing.
A caller cancelling a call signals its worker and waits for its work and
cleanup to join. Busy lasts through cleanup. Closing the execution stops new
admission, cancels and joins evaluation work, then revokes identity/routing.
Each root's narrowed route stays usable by its own work until that work joins.
Closed and completed handles refuse without component work or reopening.

Each explicit call has a fresh sequence on the canonical journal. Allocate
addresses past retained evaluation history. Partition the main continuation
and evaluations with Core-owned stream views, preserving provenance, security
wrappers and acknowledged append order. Retained evaluation events must not be
consumed by the main continuation, or main events by an evaluation. Reopening
restores acknowledged facts without repeating a completed response or continuing
an interrupted suffix. Only new explicit work starts a new sequence.

Ordinary source/control errors return the existing Result and truthful partial
rendering. Integrity, infrastructure, policy and teardown failures keep their
canonical authority through the request runner and invocation completion. A
caller catching an authoritative evaluation failure cannot turn a failed execution into a
successful main completion.

Observable result: a host can keep a document open, evaluate repeatedly, cancel
and join one evaluation, and then start fresh work without sharing continuations.

### 3. Connect the conversation mailbox

In `packages/core/src/agent/conversation.ts`, add the third public method and an
evaluation job to the existing mailbox. In serve, obtain the actual
HostExecution method through a private readiness bridge before announcing the
conversation ready. The bridge carries only the bound operation. Keep
AgentConversationHost an ordinary declaration local to its synthetic root.
Do not change ProtectedSite, publish the protected table/import terminal on
ExecutionEnvironment or discover the operation through a replaceable context.

Prompt, options and evaluation share the existing busy guard and cancellation
join protocol. An evaluation gets an execution-owned sequence distinct from
provider turns. Extend retained-history reading to account for those sequences
without changing the canonical Prompt records that establish native identity.
Opening still sends no prompt and evaluates no response. Retain first-turn
assertion reconciliation and the existing refusal of ambiguous provider work.

Observable result: the caller explicitly evaluates a completed reply through
the same conversation that produced it, and every mailbox job waits for the
preceding job's cleanup before the handle becomes free.

### 4. Adapt consumers and document the implemented boundary

Update `packages/core/host.ts` exports and the existing root tests to use live
HostExecution methods. Keep `packages/core/mod.ts`'s ordinary execute surface
unchanged. Adapt `packages/cli/tests/repl-sidekick-controls.test.ts` to a held
real host execution, preserving all behavioral assertions. Its current test
helper must stop relying on an ambient durable sequence. The eventual
`sidekick/owner.ts` response owner in section 4 of the main plan uses the
conversation method after successful provider completion; no second evaluator
or provider loop is introduced now to stand in for that unfinished owner.

Update architecture.md's generated-root, trusted-host and syntax-reference
sections; specs/executable-mdx-spec.md's implementation inventory, generated
evaluation and execution/lifetime contracts; and specs/acp-client-spec.md's
host-conversation interface and cancellation/identity account. State the bound
interfaces, captured documentation, canonical sequence ownership, runtime
separation from ordinary execute and Result/fatal distinction in present tense.
Remove descriptions of per-root identity minting and the terminal-only fallback.
Keep the existing response/entry syntax and fragment contracts intact.

## Frozen focused evidence

E1–E9 amend C1/C3 and preserve R3/R5/R6. These are the finite feedback threshold
for this correction, not new product journeys. Test destinations may share
helpers; the required observations stay the same. Add
`packages/core/tests/host-generated-root.test.ts` for host ownership tests and
extend the existing root/conversation files. Use real canonical journals and
execution installations. Synchronize with held operations and cleanup latches,
never sleeps. No package-by-package or malformed-input cross-product is required.

| Row | Required observations and the defect they distinguish | Destination |
| --- | --- | --- |
| E1 — public boundary/readiness | A held live executeInstalled handle evaluates from its caller with no provider conversation or ambient DurableContext. Call as soon as the handle permits; if runner readiness is pending, it waits without fallback or component work. Once ready, evaluation runs while the main body remains held. Output and iterable main completion remain canonical and wait for main cleanup. An ordinary execute object has no evaluator, including inherited properties; the host module exports no siteless root evaluator. | host-generated-root.test.ts; execution-protocol.test.ts |
| E2 — Syntax admission/capture | Through each bound entrypoint, bare Syntax reports the final response vocabulary, including Syntax, without the enclosing executable vocabulary. Named Syntax with the canonical names array renders actual Core chapter text; as captures that text once. Write-only selection refuses Syntax before any control effect. Preserve the existing root Syntax form/collision and passive Let → EntryInput assertions. | generated-xmd-root.test.ts; agent-conversation.test.ts; repl-sidekick-controls.test.ts |
| E3 — captured composed documentation | Reuse the trusted Marker registration/contribution fixture from syntax-component.test.ts. Through each bound entrypoint, named lookup renders its captured distinctive chapter even when Marker is not admitted; availability says so, and attempting Marker remains refused with zero invocation. Install late Documentation middleware replacing the sentence actually rendered; assert original text present, replacement and missing-documentation notice absent. Use two live owners with different Marker prose to prove each keeps its own capture. No raw index is supplied to the evaluator by the test. | host-generated-root.test.ts; agent-conversation.test.ts |
| E4 — separate acknowledged histories | On a held host document with real main work before and after evaluation, run two explicit roots and inspect the canonical journal. Each has a distinct owned sequence and the same canonical admission/effect records as before; main work consumes neither sequence. Main output excludes generated output, each method returns its own rendering, and main completion still follows its own teardown. | host-generated-root.test.ts; document-output-api.test.ts |
| E5 — cancellation joins | Through both handles, cancel a root after its first acknowledged effect while a later body/cleanup is held. The caller's halt remains pending; overlapping evaluation refuses without effects. Release cleanup, observe halt completing, then evaluate fresh work exactly once. Close an owner during held evaluation and prove its cleanup joins before closure completes; saved handles refuse afterwards. Use one shared held-work fixture for the two wrappers. | host-generated-root.test.ts; agent-conversation.test.ts |
| E6 — reopen without response replay | For a host journal and a conversation journal, retain one completed evaluation and a later evaluation's first effect, then cancel before its next effect. Close/reopen the genuine owner over that journal. Opening repeats neither completed effect nor interrupted suffix. A new explicit call gets an address beyond retained evaluation work and runs once. For the conversation, retain a completed Prompt first and check the same native identity after reopening and the next explicit prompt. | host-generated-root.test.ts; agent-conversation.test.ts |
| E7 — failure authority | Through both wrappers, an ordinary generated/control failure preserves Result and the real earlier partial render. Separately inject a canonical persistence failure and a held cleanup failure; each retains its authoritative failure identity/classification through the caller and execution completion rather than becoming a correctable reply or a successful main result. Existing policy/integrity and failure-ranking regressions remain unchanged. | host-generated-root.test.ts; agent-conversation.test.ts; execution-protocol.test.ts |
| E8 — one conversation mailbox | Immediately after useAgentConversation provides the handle, complete one prompt and explicitly evaluate its source; no generated effect precedes that call and evaluation adds no provider/configuration call. Hold evaluation: prompt/options refuse without traffic. Hold prompt, then options: evaluation refuses in each case without component work. Retain the existing prompt cancellation/configuration/native-identity tests. | agent-conversation.test.ts; packages/acp/tests/host-conversation.test.ts |
| E9 — released and CLI contracts | Preserve released fragment/composition/profile tests, canonical protected Syntax and Evaluate lifetime tests, and the four existing Sidekick tiers. Adapt only evaluator setup/imports in their existing rows; keep literal draft content, ordered requests, controls, output and recovery assertions. Entry-only components remain unavailable to response execution and canonical Syntax is not designated feedback. Provider-success gating and the future real CLI owner are still proved by R2/R5/R6 in the main plan. | focused commands below |

For E3, bootstrap the Marker registration and chapter together through the
existing contribution mechanism. Install the late replacement inside an
Execution.document wrapper, after canonical capture and before delegating to
the document workflow. This puts the replacement in the runner's inherited
scope: recollecting there must encounter it. Count contribution reads before
and after evaluation and require no new collection. A replacement installed
only in a sibling caller scope cannot by itself distinguish captured-reference
use from recollection in the runner. Reuse this setup for both public handles.

Keep archived reproductions and their first failure logs unchanged. Produce
bound-interface copies alongside them:

- `pr2-controls-bound.probe.ts` from `pr2-controls-dc87c5fd.probe.ts`;
- `pr2-syntax-documentation-bound.probe.ts` from
  `pr2-syntax-documentation-66d330dd.probe.ts`;
- `pr2-documentation-capture-bound.probe.ts` from
  `pr2-documentation-capture-91eb10bd.probe.ts`.

Change imports and ownership setup to use a live host handle. Keep all seven
existing probe steps and their behavioral assertions. Preserve Core chapter
content checks, absence of the missing-documentation notice and the replacement
of the rendered sentence. Integrate the discriminating regressions into the
discovered test files above; reviewer probes do not replace permanent tests.
No additional mutation-control exercise is required.

## Commands and feedback commit

Run these focused commands from the PR 2 worktree after the bound correction:

```sh
deno task test packages/core/tests/host-generated-root.test.ts packages/core/tests/generated-xmd-root.test.ts packages/core/tests/generated-xmd-preview.test.ts packages/core/tests/agent-conversation.test.ts
deno task test packages/core/tests/generated-xmd.test.ts packages/core/tests/generated-composition.test.ts packages/core/tests/evaluation-profile.test.ts packages/core/tests/evaluate-provider-lifetime.test.ts
deno task test packages/core/tests/execution-protocol.test.ts packages/core/tests/document-output-api.test.ts packages/core/tests/syntax-component.test.ts
deno task test packages/core/tests/agent-components.test.ts packages/core/tests/agent-session-placement.test.ts packages/core/tests/agent-session-use.test.ts packages/core/tests/agent-session-use-loaded-copy.test.ts packages/acp/tests/host-conversation.test.ts
deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-output.test.ts packages/cli/tests/repl-sidekick-controls.test.ts
deno test --allow-all --frozen --config deno.json /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-controls-bound.probe.ts /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-syntax-documentation-bound.probe.ts /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-documentation-capture-bound.probe.ts
deno task validate:docs
```

These paths deliberately include cross-package and dynamic execution boundaries.
Use affected-test selection only for a further changed boundary they do not
cover. This correction changes neither discovery nor runtime adapters; a full
Core/package/runtime suite is not a feedback prerequisite. Lint, broad
typechecks, JSR and CI remain the separate delivery gate under AGENTS.md.

Commit promptly when this evidence passes. Hand back the exact SHA/parent,
resolved base, every focused command/result, E1–E9 mapping and remaining CLI
claims. Record any test-path successor explicitly. Do not include gate.ts or
delay this Core feedback commit for the unfinished admission gate or terminal
gallery. Planner acceptance here permits resuming those main-plan sections; it
does not declare the complete CLI ready to merge.

## Continuity and next action

Original amendment base: `8be2d2bc3c38c4a896d0b678e121beef28e02920`, parent
`91eb10bd14b279dc764958972c401810a77f230d`, on `agent/issue-883-pr2` above
accepted Core `79d404d04d02c3840892473b6f1b2cf540f3edd1`.
Produced artifacts: this amendment, updated planner-handoff.md and updated
core-interfaces-proposal.md in `.reviewer/issue-883/`.
Governing decision: root-evaluation-architect-handoff.md; product, storage,
discovery and terminal contracts remain governed by the main plan's sources.

Settled: both bound public methods, exact captured execution authority, ordinary
execute runtime separation, shared conversation admission, cancellation joins,
fresh durable response sequences and the two-PR split. No unresolved design or
approval blocker remains. The current implementation verdict and focused
evidence are recorded in the feedback-status link above.

Accepted feedback SHA: `01abab2763a7ef95d6bcfb67582df161f80918a5`, parent
`3e6329f78551978b05542d2bd9e808ee34e8f5f9`. Next Implementor action:
resume section 3's admission gate and R2 cases 3/4, then section 4's Sidekick
owner and R2 cases 2/5/6. Preserve the existing gate.ts draft while completing
it with its own focused evidence. This handoff authorizes no GitHub write or CI
inspection/dispatch. No production code changed in this planning update; the
linked review records the focused runtime evidence at the accepted SHA.
