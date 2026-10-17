# Integrate Sidekick with main's captured generated components

Saved REPL sessions keep their Sidekick chats. The integrated build reads the
existing conversation and can accept a new message under the same identity and
configuration checks. Changing Core's admission records is not permission to
discard a chat, require a replacement chat, or repeat its earlier work.

Each Sidekick conversation establishes its available controls when it opens.
Core captures their exact implementations during that conversation's execution
setup. Evaluating a reply supplies its program, not another list of controls.
The Product Owner explicitly accepted this evaluation-call amendment.

This resolves the two questions in the
[integration handoff](pr890-pr921-main-integration-architect-handoff.md).
It is an architecture decision for planning, not an implementation verdict,
rebase assignment, or publication approval.

## References and decision authority

| Committed reference | Exact SHA |
| --- | --- |
| Integration target, origin/main | `986948eabd070c0ae7354c2a0db8df7feed63621` |
| Reviewed #890 / agent/issue-883-pr1 | `79d404d04d02c3840892473b6f1b2cf540f3edd1` |
| Reviewed #921 / agent/issue-883-pr2 | `940249af47159a3bbd960b8ca8df3f10bb53811c` |

Use these committed contracts, not the unrelated edits in the main checkout.
Existing verdicts remain verdicts on their exact SHAs. Integrated revisions
receive new feedback SHAs and reviews.

The governing contracts are main's accepted U5 capture/live-authorization model,
U3 descriptive Syntax narrowing, PR1's root-versus-fragment language and binding
separation, and the
[bound evaluation amendment](root-evaluation-architect-handoff.md).
Architecture rules 2–3 and 23–25 delegate their conforming integration mechanics.

The public request change below is the accepted amendment. Preserving saved
chats, main's marker-4 fragment continuation, and the accepted root/fragment
failure distinction requires no additional Product Owner decision. The
Architect's later question about whether saved chats should survive an upgrade
was unnecessary and is withdrawn. No new reusable rule is inferred.

## The public evaluation boundary

Keep the bound method on both trusted handles. Its request contains only:

```ts
type GeneratedEffectClass = "read" | "write";

interface GeneratedXmdRequest {
  readonly id: string;
  readonly source: string;
  readonly allow?: readonly GeneratedEffectClass[];
  readonly position?: Readonly<SourcePosition>;
}

interface GeneratedXmdRootResult {
  readonly output: string;
  readonly hasOutput: boolean;
}

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

interface AgentConversationRequest {
  readonly history: DurableStream;
  readonly id: string;
  readonly agent: string;
  readonly installations: readonly ExecutionInstallation[];
}

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

function useAgentConversation(
  request: AgentConversationRequest,
): Operation<Result<AgentConversation>>;
```

`id` identifies the admission within the evaluation's owned sequence. `source`
is the exact proposed program. `allow` narrows the captured read/write classes;
omitting it selects read. Preserve main's validation, canonical class order,
absence behavior, and unavailable-class refusals. `position` remains diagnostic
source information and takes no part in identity or authorization.

Remove `observations`, `mutations`, `workspaceRoots`, and `selectedRoot` from
this public request. Do not retain an overload, alias, or alternate public
table-taking route. Core may keep private normalized tables for its evaluator;
those are implementation inputs, not a second host API.

Ordinary `execute()` still returns a DocumentExecution whose runtime object
exposes no root evaluator. A host can evaluate without an agent conversation
by keeping its HostExecution live. Prompt still returns source and does not
evaluate it automatically.

Pure preview is unchanged:

```ts
interface GeneratedXmdRootPreview {
  readonly output: string;
  readonly incomplete: boolean;
}

function previewGeneratedXmdRoot(
  source: string,
): Result<GeneratedXmdRootPreview>;
```

Keep GeneratedXmdRootError's existing ordinary-failure/optional-partial contract,
GeneratedXmdPreviewError, and HostExecutionError's busy/closed classification.
Preview reads syntax and authorizes no evaluation.

### Public exports

The trusted host entrypoint exposes the handles, request/result types,
conversation resource, root errors, and pure preview required above. Keep
GeneratedEffectClass there because the public request uses it.

Use main's existing `Component` and `GeneratedSelection` consumer surface from
`@executablemd/core/api` for setup. Use the existing trusted installation and
component-answer contracts where definitions are installed. Definitions carry
main's owner-declared per-form identity URLs and effects.

Do not restore the removed public FragmentEvaluationInput/FragmentEntry,
capability tables, Workspace inputs, GeneratedRequest inventories,
RetainedFragmentIdentity, GeneratedObservation/GeneratedMutation,
GeneratedComponentForm, or pinned* factories as a Sidekick installation API.
The older public table-taking evaluateGeneratedXmd function is not restored:
main already replaced that host surface. Authored `<Evaluate>` remains the
supported fragment interface, with main's existing behavior. Private helper
names and layouts remain delegated.

This explicitly reconciles the older bound-root amendment's promise to leave
GeneratedXmdRequest unchanged with the subsequently accepted U5 removal of its
old inputs. It does not remove standalone host evaluation or authored Evaluate.

## Who installs and captures the controls

```text
Sidekick conversation owner
  |
  +-- its own control definitions and complete Component.generated selection
  |       |
  |       v
  |   trusted conversation installations
  |       |
  |       v
  |   Core setup: capture once, before public execution policy
  |       |
  |       v
  +-- conversation.evaluateGeneratedXmdRoot({ id, source, allow })
          |
          v
      exact captured controls; this response's journal and feedback
```

The CLI constructs one conversation-owned set of REPL and Guide controls.
Their declarations retain their existing forms, schemas, return behavior, and
designated-feedback distinction. It installs them before Core captures the
conversation's generated selection. Select the complete Sidekick vocabulary
explicitly; do not merge or fall back to the ordinary REPL entry's defaults.
Canonical Elicit remains Core's component with the conversation's existing
question provider.

Core applies main's capture order: initialization and captured installation
callbacks; one validated owned selection; one resolution per selected name;
retention of each actual published definition; then public execution policy
and the canonical root. Captured implementation, form, schema, identity, and
effect cannot be replaced by later middleware or another call's context.

Conversation controls may read changing REPL state through their existing
owned request handles. Capturing the implementation does not freeze the binding
map or draft. Likewise, each response gets its own control orders, Submit
association, journal, and feedback. The CLI owner associates those facts with
the active response before evaluation and releases that association only after
evaluation and cleanup join. It cannot leave the first response's journal
captured forever, borrow another chat's association, or obtain one from
replaceable caller context. The local implementation of that owned association
is delegated; add no public callback or context protocol for it.

The trusted HostExecution root method similarly uses its execution's captured
selection. Neither method accepts callable implementations from the evaluation
request. Keep Core's private handoff of the exact execution-minted Syntax
implementation, guarded route, captured reference, and captured selection.
Do not publish these through ExecutionEnvironment, a new ProtectedSite accessor,
or a caller-readable reference token.

Canonical self-closing Syntax remains a read in the root vocabulary. Use the
execution's exact minted implementation, or its own captured/routed guard over
that same implementation. If the selection already includes canonical Syntax,
retain one entry rather than adding a duplicate. A different implementation
under that name remains a collision, not an implicit substitution. Preserve
main's absent-profile and unavailable-class refusals; supplying Syntax does not
create a host evaluation profile where none was established.

## Closed admission records

Keep **marker 4 for fragments** exactly as main writes and reads it. Use
**marker 5 for roots**, with the same ordered selection fields. Marker 5 is the
root record in this contract, not a new fragment format. The marker on both the
result and its policy must match the expected evaluation kind.

The distinct markers carry the root/fragment distinction. No optional context
field, missing-field default, legacy identity conversion, or extra field is
needed. A marker-4 record cannot authorize a root and a marker-5 record cannot
authorize a fragment, including when their source and selected rows happen to
be equal. This representation preserves the already accepted context-separation
behavior without changing marker 4's closed shape.

Every admitted result has exactly `version`, `decision`, `source`, `named`, and
`policy`. Its policy has exactly `version`, `allow`, and `allowed`. A named row
has exactly `name`, `identity`, and `form`. An allowed row has exactly `name`,
`form`, `identity`, `kind`, and `effect`, with main's validated identity namespace
and enums. No Workspace basis, request inventory, or live permission snapshot
is recorded.

A complete fragment example, with File selected for reading:

```json
{
  "version": 4,
  "decision": "admitted",
  "source": "<File path=\"notes.md\" as=\"note\" /><Json value={note} />",
  "named": [
    { "name": "File", "identity": "https://executable.md/components/file/read", "form": "self-closing" },
    { "name": "Json", "identity": "https://executable.md/components/json", "form": "self-closing" }
  ],
  "policy": {
    "version": 4,
    "allow": ["read"],
    "allowed": [
      { "name": "Json", "form": "self-closing", "identity": "https://executable.md/components/json", "kind": "capability", "effect": "composition" },
      { "name": "File", "form": "self-closing", "identity": "https://executable.md/components/file/read", "kind": "component-answer", "effect": "read" }
    ]
  }
}
```

A complete standalone host-root example, with canonical Syntax selected for
reading. A Sidekick root has additional rows for its own captured controls.

```json
{
  "version": 5,
  "decision": "admitted",
  "source": "<Output>Ready.</Output>",
  "named": [],
  "policy": {
    "version": 5,
    "allow": ["read"],
    "allowed": [
      { "name": "Json", "form": "self-closing", "identity": "https://executable.md/components/json", "kind": "capability", "effect": "composition" },
      { "name": "Syntax", "form": "self-closing", "identity": "https://executable.md/components/syntax/read", "kind": "component-answer", "effect": "read" }
    ]
  }
}
```

Refused results contain exactly `version`, `decision`, and `construct`, with
the evaluator's existing construct classification. They grant no execution:

```json
{ "version": 4, "decision": "refused", "construct": "component" }
```

```json
{ "version": 5, "decision": "refused", "construct": "component" }
```

Retain the existing `generated_xmd` durable operation and `generated:<id>` name.
Its diagnostic input uses the corresponding policy shape. Core allocates root
sequences; the CLI does not allocate or fabricate canonical admissions.

### Exact comparison

Before any admitted component runs, require the expected record marker and
closed shape, exact source bytes, the same canonical allow selection, and the
same ordered allowed rows. Compare every row's name, authored form, identity
URL, implementation kind, and effect. Preserve main's order: composition, read,
then write; preserve capture order within each class and canonical form order.
Do not sort two differing policies into equivalence or compare them as sets.

Preserve main's reading of named invocations and preflight against the current
captured implementations. Updating a body under the same owner-declared URL
between executions remains main's existing implementation-update rule; changing
its URL, kind, offered form, effect, or ordered selection changes the grant.

## Saved history and continuation

| Historical state | Integrated behavior |
| --- | --- |
| Valid saved Sidekick chat, including earlier root records | Read the same messages and outcomes. A new explicit message continues the same conversation under its existing identity/configuration checks and evaluates a fresh response using current controls. |
| Completed Sidekick response | Restore its published historical result for inspection; do not evaluate its source again. |
| Interrupted Sidekick response | Preserve the incomplete outcome and actual completed controls. Do not automatically resume its unexecuted program suffix. Existing explicit recovery/Retry behavior stays in force. |
| Existing marker-4 fragment admission | Remains readable and resumable on main's exact reconciliation terms. Completed effects restore recorded results; only unrecorded work runs. |
| Untagged v1, marker-2, or marker-3 fragment admission offered for continuation | Refuse as main already does, before a generated component or effect runs. Do not migrate or reinterpret it. |
| Earlier root admission, including #883 marker-2 root records, offered as authorization for a current evaluation | Refuse; it is not a marker-5 root admission. Keeping it in chat history does not offer it for evaluation. |
| Marker 4 offered to a root; marker 5 offered to a fragment; unknown/mixed markers or extra fields | Refuse the admission as unreadable for that evaluation. |
| Completed document replay | Preserve its existing completed-root bypass. Do not add a scan that rejects historical inspection merely because an unvisited older admission exists. |

These paths are deliberately separate. A saved response's records are evidence
of past work; they need not be accepted as authorization to perform new work.
The existing generated-root owner partitions `generated_root:N` sequences from
the conversation's main continuation and allocates past every retained root
sequence. Keep that partition independent of admission version so older root
sequences are not accidentally replayed as conversation work.

Do not rewrite user history, replace its provider identity, synthesize missing
acknowledgements, or reprompt an agent as a migration step. Preserve the existing
refusals for genuinely inconsistent histories, unacknowledged provider turns,
and incompatible provider configuration. Compatibility does not authorize
guessing past those failures.

## Live authorization and completed replay

Retire the older evaluator's generic request ceilings, normalized request
inventory, Workspace-root membership comparison, and caller-supplied live
configuration snapshots. Do not restore their old public inputs or serializers.

Language admission establishes available components and forms. The actual
provider and live Permissions checks establish what a new effect may do at
its performer, after applicable request transformations and before transport
or mutation. Existing owner-specific restrictions remain there. Sidekick's
draft revisions, shared submission slot, control revocation, question handling,
and separate entry admission remain with their current owners.

A completed durable effect restores its recorded result without consulting
today's live destination restriction or repeating transport/mutation. An
unrecorded effect meets the current restriction. Earlier committed work remains
retained if later work is refused. This is main's accepted U5 model, not a new
Sidekick exception.

## Syntax describes; captured routing executes

Install main's `useNarrowedSyntax(reference)` inside the scoped generated
expansion for both roots and fragments, before their source expands. It supplies
symbols at `min` and disappears when the expansion and its cleanup end.

For a fragment, use the protected Evaluate site's captured owner reference,
narrowed by the actual admitted symbols, as main does. For a root, use the
bound execution's captured reference and the actual root admission, including
canonical Syntax. Derive availability through the reference's existing
`available(admittedSymbols(...))` operation; do not recollect documentation or
rebuild a Core-only catalog.

Named documentation keeps the enclosing owner's captured package chapters and
uses the narrowed symbols for availability. It may describe a component the
generated source cannot invoke. Ending the generated scope restores the
enclosing descriptive view. Preserve main's lazy Syntax property/method
contract, recorded text, ordinary rendering/capture, and loaded-copy behavior.

Description does not select executable implementations. Actual generated
resolution uses only the captured definitions and the narrowed protected route.
A later contextual answer can neither authorize an omitted component nor
replace a captured control or the exact protected Syntax implementation.
Canonical Syntax remains ordinary output/capture, not designated Sidekick
feedback; REPL.Syntax remains the separate entry-vocabulary read.

## Roots and fragments keep their accepted error behavior

| Scope | Error mode and result |
| --- | --- |
| Generated fragment | `throw`; an undecided failure stops the fragment and propagates through the existing authored recovery boundary. |
| Generated text root | `output`, with the root's own empty binding environment and existing Output selection. An undecided ordinary failure stops that root; it does not become printed success. |
| Component that already explicitly handles/prints its own expected failure | Keeps that existing behavior. The integration does not change Parse, SafeParse, or generic component recovery. |

An ordinary generated-root failure returns Err(GeneratedXmdRootError), carrying
the canonical partial rendering when expansion began. Admission refusal performs
nothing and invents no partial output. Preserve `hasOutput` so no explicit
Output remains distinguishable from an explicitly empty region. The CLI still
publishes only explicit root Output to the person.

Failures already classified as fatal, including integrity/durability,
secret-policy, Files infrastructure, and teardown failures, keep their existing
authoritative classifications. Ordinary live permission refusals keep their
existing request-refusal behavior; this ruling does not make every Permissions
denial fatal. Do not broaden the ordinary-root error catch while integrating
main's wrappers. A fatal root evaluation failure also
fails its owning execution; catching the method's failure cannot leave a
successful canonical completion. Cancellation stays cancellation and joins
owned work before another call is admitted.

Preserve the bound owner's busy/closed behavior, mailbox exclusion across
prompt/options/evaluation, canonical readiness, fresh root sequences, and
route/identity lifetimes. Stop Sidekick does not cancel an independently
admitted REPL entry. Installing descriptive Syntax middleware changes none of
these error, ownership, or execution rules.

## Planner return

The two integration contracts are settled. Freeze one bottom-up assignment for
both PRs, preserving their reviewed heads and the existing safety ref before
any authorized rewrite. Coordinate with the owners of
`.claude/worktrees/issue-883-pr1` and `.claude/worktrees/issue-883-pr2`; do not
move either checked-out branch from the main checkout. Recheck origin/main
advancement and return any new material conflict instead of silently changing
this ruling. Review replacement feedback SHAs, not a claim that the old PASS
automatically transfers.

Name the allocation of Core binding work and CLI/conversation consumers between
the two replacement revisions. Each feedback revision must expose a coherent
boundary; do not restore an obsolete siteless or table-taking public evaluator
as an intermediate integration step. If coherence requires moving existing
Core-only binding work earlier in the stack, state that redistribution explicitly
in the plan rather than treating it as conflict resolution. The final ownership
and public contract are the ones settled above.

Reuse the existing finite evidence for root/passive draft capture, fragment
composition, generated selection, live authorization, Syntax, conversation,
Stop/cancellation, and Sidekick response records. Derive focused integration
checks for these concrete requirements:

- Marker-4 fragment history continues unchanged; roots write marker 5; cross-
  kind and malformed/unknown-marker admissions refuse before effects.
- An older valid saved Sidekick conversation remains readable and accepts a
  new turn without replaying completed or interrupted root sequences. No
  history migration or native-identity replacement occurs.
- Two chats capture different owned controls. Later middleware or entry
  selection changes neither. Two responses in one chat write their own control
  associations and feedback, including cancellation and ordinary failure.
- Host evaluation works without an agent; ordinary execute exposes no host
  evaluator; no-selection/busy/closed calls preserve their refusal behavior.
- Root and fragment Syntax show actual admitted vocabulary, retain named package
  documentation and ordinary capture, restore the enclosing view, and grant no
  extra executable capability.
- Partial root output and fragment failure propagation retain their distinct
  contracts; authoritative fatal failures survive both bound wrappers.

The Planner owns exact test files and commands. No full-suite run, dependency
setup/change, CI inspection, or unrelated mutation battery is assigned by this
architecture return. This decision is based on committed code/data-flow and
accepted contracts; it claims no integrated runtime test results.

Parse [#922](https://github.com/taras/executable.md/issues/922), new binding
publication behavior, new agent-result inspection, UI choices B–D, and unrelated
cleanup remain outside this integration. The independently reproduced
[submission-identity correction](pr921-agent-feedback-scope-architect-return-940249af.md)
remains a separate bounded #921 correction; sequence its work with integration
without absorbing its acceptance or rewriting the user's saved files.

No production source, specification, branch, remote, dependency state, user
history, GitHub record, or CI state was changed by the Architect to prepare this
decision. The three committed references above remain unchanged. This turn
performed no implementation or rebase.

At the final read-only state check, PR2 has concurrent uncommitted changes in
program.ts, sidekick/admission.ts, the recovery-phase and sidekick-harness
fixtures, and the Sidekick lifecycle, presentation, and recovery tests. They
were left untouched and are not reviewed here. The Planner must coordinate with
that worktree's owner and its bounded correction before scheduling integration;
do not reset those changes to recover the earlier clean state.

Next owner: Planner freezes the combined assignment under this ruling.
