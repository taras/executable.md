# Evaluate generated roots through their owning execution

The Product Owner accepts two ways to evaluate generated XMD: a method on a
trusted host's execution handle, and the same method on an agent conversation.
Both use the owning execution's captured package documentation. Standalone
evaluation requires no agent conversation.

```ts
const execution = yield* executeInstalled(options, installations);
const result = yield* execution.evaluateGeneratedXmdRoot(request);
```

Sidekick calls `yield* conversation.evaluateGeneratedXmdRoot(request)` after the
provider successfully completes its reply. Receiving either handle runs no
generated program. Preview does not authorize evaluation.

This is an accepted architecture/interface amendment, not an implementation
verdict. It resolves the proposal reviewed at
`8be2d2bc3c38c4a896d0b678e121beef28e02920`, parent
`91eb10bd14b279dc764958972c401810a77f230d`. No runtime evidence is claimed here.
Keep this correction in PR 2. The untracked `sidekick/gate.ts` remains untouched.

## Complete public boundary

The trusted host entrypoint exports this additional return type:

```ts
interface HostExecution extends DocumentExecution {
  /** Evaluate a complete generated root using this execution's captured reference. */
  evaluateGeneratedXmdRoot(
    request: GeneratedXmdRequest,
  ): Operation<Result<GeneratedXmdRootResult>>;
}

function executeInstalled(
  options: ExecuteOptions,
  installations: readonly ExecutionInstallation[],
  initialization?: ExecutionInitialization,
): Operation<HostExecution>;
```

HostExecution retains the existing output stream and iterable completion
contract. `yield* execution` still observes the canonical main document's result
after cleanup; it does not start or substitute a generated-root evaluation.
The method is required on the trusted host handle and usable only while that
execution is live. A host needing repeated evaluations keeps its execution
open; this amendment does not make a completed document reopenable.

The complete conversation handle is:

```ts
interface AgentConversation {
  /** Send one journaled turn and return its successfully completed reply. */
  prompt(
    input: string,
    configuration?: SessionConfiguration,
  ): Operation<Result<string>>;
  /** Inspect the selected agent's advertised model and effort choices. */
  options(request?: AgentOptionsRequest): Operation<Result<AgentOptions>>;
  /** Evaluate a complete generated root using this execution's captured reference. */
  evaluateGeneratedXmdRoot(
    request: GeneratedXmdRequest,
  ): Operation<Result<GeneratedXmdRootResult>>;
}
```

AgentConversationRequest and useAgentConversation's input/result stay unchanged.
Prompt returns source; it does not evaluate it. Evaluation is explicit and runs
no provider turn or model configuration change.

The siteless module-level `evaluateGeneratedXmdRoot(request)` host export is
replaced by these bound methods. This explicitly amends the earlier accepted
export; it does not reduce the documentation guarantee or remove standalone
capability. GeneratedXmdRequest, success/partial-error data and preview types
remain unchanged. Public preview and released fragment evaluation retain
their interfaces and behavior.

No generatedRoot installer callback, evaluator initialization member, new
request field, public site accessor or opaque reference token is added. Ordinary
document-facing `execute()` returns DocumentExecution. Its runtime object
exposes no host evaluator, including through its prototype; a narrower
TypeScript annotation alone does not enforce this boundary.

## Core-private handoff

Canonical executeDocument owns the inputs. After installIdentities mints its
protected implementations and Core constructs rootSyntaxReference from the
captured assembly, it binds the root evaluator using:

1. The exact Syntax definition in that execution's `identity.protected` table.
2. That execution's existing guarded componentRouting.
3. That execution's already captured SyntaxReference.

These inputs cross an internal factory call in Core by value. The factory
returns a bound operation; a public handle receives no protected definition,
table, domain, claimant or raw documentation index. The static SYNTAX_PROTECTED
declaration cannot replace the exact minted function used to narrow the route.

The private call inventory is:

| Boundary | What crosses | Owner |
| --- | --- | --- |
| executeDocument to the generated-root binder | Exact minted Syntax definition, guarded route, captured reference | Canonical execution |
| executeDocument to canonical documentWorkflow | Private binding/activation closure passed as an argument beside existing expansion inputs | Canonical execution |
| Canonical document workflow to its evaluation owner | Bound evaluator, canonical journal and owning Effection scope | Live document execution |
| Invocation completion wrapper to executeInstalled | Existing completion/output plus bound evaluation operation | Trusted host handle |
| executeInstalled to conversation.ts serve | HostExecution; its method is held privately by the mailbox | Conversation resource |

The canonical document workflow attaches the evaluation runner before authored
root work, in the scope where Execution.document has installed the document's
runtime services. Calls execute there rather than inheriting a caller's
document-time substitutions. If the host handle returns before its runner is
ready, evaluation waits for canonical readiness or reports closure; it does not
choose another scope or fallback environment.

Keep the protected table and import terminal out of ExecutionEnvironment.
No ProtectedSite member changes. AgentConversationHost remains an ordinary
Core-owned declaration local to its synthetic root; it is not added to the
global protected catalog. Conversation serve receives the actual HostExecution
method before announcing readiness. A private readiness bridge handles ordering
between the synthetic host starting and executeInstalled returning; it carries
only the operation, never an alternative authority source.

The ordinary execute wrapper returns only the existing document handle. Core
may carry the additional operation in a private invocation result before the
trusted host wrapper exposes it. Do not attach it to the ordinary returned
object and rely on type hiding.

## Per-root admission and reference

For each call, build the root's final admitted table, including canonical
self-closing Syntax in the read class only. Use the execution-minted definition
and existing identity metadata; preserve pinned forms, permissions, collision
checks and retained policy comparison. Syntax grants no additional executable
vocabulary.

Narrow the route using the exact admitted implementations. Narrow the captured
reference with `available(admittedSymbols(entries))`. Bare Syntax describes the
root's admitted vocabulary; named lookup retains the owner's captured authoring
reference and package chapters, including availability information. Reading a
chapter grants no execution permission. Preserve canonical render/capture and
retained Syntax text. Syntax remains ordinary output, not designated Sidekick
operation feedback.

Do not recollect Documentation middleware during evaluation, read only Core's
package asset as a substitute, recover raw contributions, or discover authority
through a replaceable context. Once both bound paths replace the siteless path,
remove its scoped Syntax minting and terminal-read workaround if unused. The
released fragment path and canonical Evaluate's protected handoff stay intact.

## Work ownership, history and failure

Core owns the execution scope in which each evaluation task runs. The calling
operation owns its cancellation request and waits for the task and cleanup to
join. Execution teardown stops admission, cancels and joins active evaluations,
then revokes the underlying identity domains and routing. Each per-root narrowed
route closes after its own work joins. A retained method cannot reach a closed
execution.

One root evaluation runs at a time per host evaluation owner. Overlapping root
calls refuse rather than queue behind admitted work. Conversation prompt,
options and evaluation share its existing mailbox admission guard; another
job cannot slip in while a cancelled job is still unwinding. Initial runner
readiness is distinct from queuing behind an admitted job.

Each explicit root evaluation gets a fresh owned durable sequence on the
execution's canonical journal, separate from its main document continuation and
provider turns. Core allocates sequence addresses past retained evaluation
history. Reopening does not run a completed response again or resume an
unfinished response suffix. Partition main continuation and evaluation history
through Core-owned stream views so one does not consume or replay the other's
events. Preserve acknowledged append order, canonical admission/security
wrappers, actual partial facts and the two-file Sidekick storage boundary.
There is no third file, CLI-fabricated terminal or new source of native identity.

Fresh sequence ownership does not weaken generated admission: exact source,
selected classes, pinned identities, forms and retained ceilings retain their
current comparisons. Reusing history does not authorize different work.

Ordinary generated-source/control failures retain Result and canonical partial
rendering. Closed/busy availability failures perform no component work.
Infrastructure, integrity, policy and teardown failures retain their existing
authoritative classification; wrappers do not turn them into correctable
response errors or suppress the execution's failure.

The CLI still owns response authorization, draft revisions, control revocation
and feedback. It joins response work before feedback or another turn. Stop
Sidekick does not cancel an independently admitted ordinary REPL entry.

## Planner handoff and finite evidence

All three boundary decisions are settled. The Planner updates the plan and
finite evidence mapping before implementation. This amendment supersedes the
callback and protected synthetic-host proposals. It adds no product journey,
third PR, dependency or GitHub-write authorization.

Keep accepted storage, projection, recovery, control and output evidence. Adapt
the existing root tests and archived probe reproductions to the bound public
interfaces; preserve their behavioral assertions and historical logs. Removing
an export changes probe setup and imports, not their acceptance criteria.

Derive focused evidence for these existing structural requirements:

- Both bound entrypoints reach canonical Syntax with ordinary capture, correct
  read admission and the actual response vocabulary. Reuse a trusted package
  chapter fixture to establish composed documentation, with late middleware as
  the negative control.
- Host evaluation works without a provider conversation and needs no caller
  ambient durable context. Ordinary execute exposes no host evaluator;
  completed/closed handles refuse rather than reopen work.
- An evaluation has its own sequence. Cancellation joins before another call;
  reopening and explicit new work do not replay an unfinished suffix or lose
  established provider identity. Preserve overlap refusal and fatal-failure
  authority through both wrappers.
- Main document output/completion and released fragment behavior remain intact.

Use the focused root, fragment, composition, profile, conversation and CLI
Sidekick tiers, plus affected execution protocol/lifetime regression files.
The Planner selects the smallest discriminating cases and commands; do not add
a package-by-package or malformed-input matrix. Hand back a stable feedback
commit with exact SHA/parent and the focused commands/results.

The next review is implementation feedback against that amended plan. No
production code, CI or GitHub state changes are part of this Architect record.
