# Architecture guidelines

## Reading this architecture

Read this document to understand how XMD executes documents, connects components, retains state, and releases resources. Start with a document running, then follow component relationships, state, authority, resource ownership, and shared invariants.

The documents have different jobs:

- This architecture owns architecture principles, implementation invariants, and resource lifetimes.
- [The language specification](specs/executable-mdx-spec.md) owns authored syntax and observable behavior. Feature specifications own their detailed interfaces and contracts.
- [AGENTS.md](AGENTS.md) owns agent boundaries; policies own specific implementation patterns.
- [The vision](specs/markdown-agents-vision.md) explains product direction and is non-normative. [Decisions](specs/decisions.md) preserve history and consequential rationale.

The following table is a non-normative navigation aid.

| Question | Start here | Owning specification or reference |
| --- | --- | --- |
| What runs, and can a diagnostic journal continue it? | [A document running](#a-document-running) | [Language specification](specs/executable-mdx-spec.md), [Plan command specification](specs/plan-command-spec.md) |
| What does partial or completed replay restore after a write, read, and delete? | [A document running](#a-document-running), [Journal and Workspace](#journal-and-workspace) | [Workflow Workspace specification](specs/workflow-workspace-spec.md) |
| Which packages own execution, persistence, and repository behavior? | [Component relationships](#component-relationships) | [Language specification](specs/executable-mdx-spec.md), [Workflow Workspace specification](specs/workflow-workspace-spec.md) |
| Which values are live, retained, or available to a later entry? | [State](#state) | [Language specification](specs/executable-mdx-spec.md), [REPL specification](specs/repl-spec.md) |
| What may middleware replace, and what remains canonical? | [Authority](#authority) | [Language specification](specs/executable-mdx-spec.md) |
| When does an installed structural region run, and who cancels it? | [Resolution and extension](#resolution-and-extension), [Scopes and settlement](#scopes-and-settlement) | [Language specification: declared structural syntax](specs/executable-mdx-spec.md#declared-structural-syntax) |
| Who owns a native Agent handoff, and what if its executable changes? | [Retained resources and exclusive owners](#retained-resources-and-exclusive-owners) | [Native Agent session launch specification](specs/native-agent-session-launch-spec.md) |
| Why can Plan retry a refused candidate but stop on cleanup failure? | [Scopes and settlement](#scopes-and-settlement) | [Plan command specification](specs/plan-command-spec.md) |
| How do failures, rendered output, and command retention relate? | [Expansion and outcomes](#expansion-and-outcomes), [Journal and Workspace](#journal-and-workspace) | [Language specification](specs/executable-mdx-spec.md), [Testing specification](specs/testing-spec.md) |
| What can generated XMD do? | [Trust and permissions](#trust-and-permissions) | [Language specification](specs/executable-mdx-spec.md), [Workflow Workspace specification](specs/workflow-workspace-spec.md) |
| What does REPL history restore, and what belongs to the screen? | [Retained REPL history](#retained-repl-history), [Cancellation and attachment](#cancellation-and-attachment) | [REPL specification](specs/repl-spec.md) |
| Which properties must another engine implementation preserve? | [Shared invariants](#shared-invariants) | [Language specification](specs/executable-mdx-spec.md) and the relevant feature specification |
| Which documents state current behavior, and which explain earlier choices? | [Reading this architecture](#reading-this-architecture) | Specifications for behavior; [decisions](specs/decisions.md) and [vision](specs/markdown-agents-vision.md) for context |

## A document running

Consider a document that writes a file, reads its contents, then deletes it. Each step has an observable result. At the end the file is absent, but the read still describes the contents observed between the write and deletion.

An ordinary `xmd run` uses the caller’s environment. Its `--journal` is a new diagnostic trace; another CLI invocation starts a new execution.

A workflow instead retains its definition bytes, props, journal, and filesystem state under a run ID. Several document executions may advance the same workflow run; each execution owns its own live scope and ongoing work.

Partial replay rebuilds the live structure needed to continue and restores completed effects from their records. It then performs the first unrecorded work. Reaching a completed write or deletion does not perform it again.

A completed root returns its retained output and result without expanding the document or attaching operational providers.

The journal is historical; the Workspace is the current filesystem frontier. After the three steps above, replay restores the old read even though the file is absent. It does not refresh an observation to prove that an earlier effect happened.

The [Workflow Workspace specification](specs/workflow-workspace-spec.md) owns continuation and effect transactions. A Plan is source for a program — producing or approving it does not run it;
the [Plan command specification](specs/plan-command-spec.md) owns Plan
production and diagnostic journals.

Plan produces a program, Run executes a program from the host/CLI, and
composition decides whether and when a planned program runs.

### Expansion and outcomes

A document execution evaluates one root, producing an output stream and a completion result. Source acquisition and target selection precede authored effects. The selected source and exact target identify what executes.

Expansion follows the document’s structure under lexical bindings and middleware. A component invocation expands within that execution; it does not create another document root.

The ongoing work is organized as an Effection tree. Durable operations restore recorded outcomes during replay. Ephemeral operations reconstruct the live scopes and attachments needed for unfinished work.

Definitions own their output selection and declared return values. Projected content retains its caller’s lexical ownership; captures and value bodies keep their private rendering buffers.

Ordinary failure handling comes from the enclosing authored structure. Printing produces document data; explicit recovery determines whether execution may continue. A blocker awaiting input is a suspension rather than an ordinary failure.

An unbound nonzero command exit remains a checked failure unless authored recovery or canonical Test containment owns it. Binding an exec outcome instead makes its settled status data.

Durability and Files infrastructure failures escape ordinary document recovery. Neither printing nor retry middleware can turn those boundary failures into successful execution.

Concurrent children receive separate expansion state and private output buffers. Their identities and rendered order follow authored structure; scheduling does not choose either.

The [Language specification](specs/executable-mdx-spec.md) owns expansion, props, output, returns, errors, and concurrency. The [Testing specification](specs/testing-spec.md) owns test containment and authorized nested executions.

## Component relationships

Canonical `@executablemd/core` owns document execution, expansion, component selection, and acceptance of results. Trusted hosts contribute requirements through `@executablemd/core/host`; components and Plugins compose through published consumer APIs.

`@executablemd/durable-streams` supplies the durable execution protocol. Runtime services expose contextual operations for host behavior, including document files, processes, HTTP requests, configuration, and permissions.

Providers answer those operations. Runtime entrypoints install the appropriate adapters; shared orchestration does not discover a runtime or borrow another host when a capability is absent.

`@executablemd/workflow` adds run identity, retained storage, lifecycle, replay, and Workspace boundaries. It depends on Core, durable-streams, and runtime. Core imports neither Workflow nor Git.

`@executablemd/git` owns repository composition, Git operations, Git-host behavior, issues, and pull requests. It extends Workflow through Workflow’s published boundaries; Workflow imports no Git feature.

An Agent provider supplies conversation behavior. The Agent proposes source; canonical generated evaluation admits and performs it. Provider conversation continuity has its own contract in the [ACP client specification](specs/acp-client-spec.md).

Ordinary Agent Session placement is inert: a placed session contacts nothing
and costs nothing until its first consumption. The REPL's child-session entry
is the stated exception ([REPL specification](specs/repl-spec.md)).

`@executablemd/testing` divides testing with Core: Core owns genuine Test
containment, and the testing package owns activation, bindings, timeout,
classification, recording and reporting. `useTesting()` owns the root
boundary and a `Testing` region owns a lexical subtree. Activation owns, at
one boundary together, where results are collected, when the last staged one
is flushed, and what the run settles to; registering the components is not
one of them.

The CLI assembles these pieces for each command. The REPL remains a private CLI feature: its journal feeds a detached model, then resolved views and a mounted terminal tree. Typed actions return to the logical root.

The [Language specification](specs/executable-mdx-spec.md) owns extension
interfaces; the [Workflow Workspace specification](specs/workflow-workspace-spec.md),
[REPL specification](specs/repl-spec.md) and
[Testing specification](specs/testing-spec.md) own their host assemblies and
harness contracts.

## State

State has different writers and lifetimes. Bindings describe an expanding document; the journal records execution; the Workspace holds current filesystem state; retained history makes earlier outcomes readable after live resources end.

### Bindings and live values

Expansion and eval establish bindings in their owning environments. Ordinary component props cross the JSON and schema boundary; explicit captures and by-reference constructs preserve the values their contracts permit.

Bindings are a byproduct of expansion, not a journal event for every assignment. Durable eval retains its exports; captures and selections are otherwise reconstructed through expansion or retained result data.

Live bindings form a separate overlay for execution-owned resources. Only constructs that explicitly consume that overlay can read them. Ordinary durable eval, interpolation, and journal serialization do not receive live endpoints.

At settlement, Core can disclose eligible root data through its execution-owned policy. A later REPL entry receives detached retained data; it does not inherit the preceding entry’s live environment or capabilities.

The [Language specification](specs/executable-mdx-spec.md) owns binding and disclosure behavior. The [REPL specification](specs/repl-spec.md) owns inheritance between entries.

### Journal and Workspace

Canonical execution publishes effect outcomes to the journal. Storage and lifecycle providers retain run state under their own ownership checks. Readers parse retained records before using them.

A workflow’s immutable identity includes its definition and normalized props. Retrieval locations, status, and accumulated history do not redefine the run. Resuming obtains source from retained bytes.

One run store co-locates filtered journal history, filesystem roots and content, repository metadata, and Agent-session mappings. Filesystem content does not thereby become journal or training data.

A Workspace-local effect commits its mutation, resulting root, and filtered journal outcome together. The acknowledged record and the filesystem frontier therefore describe the same committed boundary.

External mutations cannot join that transaction. Their owning provider contract supplies reconciliation or idempotency; uncertainty does not establish safe permission to repeat a mutation.

Git-host effects, Issue effects, and Agent Prompts have distinct provider contracts. Completed records restore their historical outcomes without contacting those providers. Live attempts acquire authentication for their own invocation.

Agent Prompt usage is retained with the acknowledged Prompt under the producing execution's disclosure policy. Observation neither authorizes execution nor publishes an independent record. The [ACP client specification](specs/acp-client-spec.md#prompt-usage) owns the receiver's subscription lifetime and retained data.

A compatible history fork creates another run from a retained prefix and checkpoint. It preserves inherited evidence and does not rewind external systems. An XMD artifact exports immutable evidence rather than a writable continuation of its source run.

Command display and command retention are separate. Retained channels describe bytes received after enclosing host middleware; downstream display suppression does not alter that record.

The [Workflow Workspace specification](specs/workflow-workspace-spec.md) owns storage, transactions, reconciliation, and forks. The [XMD artifact specification](specs/xmd-artifact-spec.md) owns exports; the [Language specification](specs/executable-mdx-spec.md) owns process retention and delivery limits.

### Retained REPL history

The REPL retains successive entries in one physical journal, giving each execution a private view of its own segment. Settled entries are projected for reading; only the unfinished final entry is continued.

History projection detaches and freezes retained facts before views receive them. The live session owns current execution state. Views receive observations rather than a journal writer or execution capability.

Replay restores recorded results without restoring the whole host environment. New work uses the live environment, subject to the REPL’s placement, permission, and effect-specific checks.

Entry execution and Sidekick conversations have separate histories and publishers. Their presentation can be composed without inventing one persisted execution order across them.

The [REPL specification](specs/repl-spec.md) owns entry boundaries, retained operations, navigation, bindings, and Sidekick behavior.

## Authority

### Trusted hosts and canonical execution

The trusted host chooses what an execution is for and supplies its providers, declarations, admissions, and preparations. Core captures the required contributions before installed code or document policy can alter them.

Canonical execution decides admission, accepted execution options, replay identity, and settlement. Public execution middleware may observe, narrow, refuse, or add failure; it cannot fabricate completion or rescue canonical failure.

Replaceable Context values and contextual APIs support composition; a descendant may replace a same-named Context binding for its own descendants under ordinary lexical rules. Their names and returned shapes do not establish permission, durable identity, or ownership.

Capabilities that must remain execution-owned are delivered directly to their intended recipient. Public observations and retained descriptions carry no callable permission.

Cross-copy reachability is not holder transparency. State an object's holder
must not inspect lives in private fields or owner-held membership: cooperating
copies reach it through the owner, never through the object they hold.

The [Language specification](specs/executable-mdx-spec.md) owns execution requests, history admission, and protected invocation protocols. The [Testing specification](specs/testing-spec.md) owns the harness that authorizes nested roots.

### Resolution and extension

A Plugin is explicitly selected trusted code installed before root import. It contributes through existing execution boundaries; selecting it does not create a sandbox or a separate execution owner.

Engine structural syntax is recognized before component imports. The canonical protected tier fixes `Syntax`, `Evaluate`, `File`, `File.Delete`, and `Dir` ahead of host and author selections.

Host reservations precede workflow bundles and ordinary component selection. Conflicting reservations fail admission; installation order does not choose between them. Open component names retain their ordinary substitution behavior: a
repository component of a default's name wins over the installed default, and
configuring a provider installs defaults without changing that precedence.

Declared Markdown binds a reserved name to exact admitted source. Its private components belong to its lexical closure. Caller-projected content retains the caller’s closure.

Installed structural syntax binds declarations and their expansion handler in one installation. Region bodies run on consumer demand and remain owned by the handler’s invocation.

Syntax symbols describe the effective vocabulary; they grant nothing. Non-executing validation uses execution’s parsing and selection rules without invoking document code or operational providers.

These boundaries share declarations and source analysis so execution, inspection, and validation describe the same language. The [Language specification](specs/executable-mdx-spec.md) owns their detailed admission and conformance contracts.

### Trust and permissions

Selected authored documents and installed extensions are trusted programs running with the access their host permits. Generated evaluation receives untrusted source; external responses and saved records enter through validating boundaries.

Generated evaluation preflights the complete fragment before effects. It runs captured, admitted implementations under their permitted authored forms. Admission does not grant a second filesystem or bypass ordinary contextual operations.

The host offers generated names and forms; owning declarations identify their behavior. Authored effect selection narrows that offer. Continuation verifies retained admission before generated work can resume.

Configured Files and Fetch restrictions intersect and are checked against the effective request at the performing boundary. They do not implicitly govern subprocesses, native extensions, or every Git-host operation.

Ordinary host file containment has its stated stable-namespace limits. Workflow file paths remain inside the run’s logical Workspace. Neither filesystem guarantee contains native commands.

Live protected input belongs to its producing owner. Journals and public observations receive safe views or receipts; mandatory field protection remains active when heuristic scanning is disabled.

The [Language specification](specs/executable-mdx-spec.md) owns generated admission, permissions, and protected input. The [Workflow Workspace specification](specs/workflow-workspace-spec.md) owns workflow Agent isolation and provider ceilings.

## Resource ownership

### Scopes and settlement

The owner that acquires a resource releases it. Cleanup is established before work can outlive its operation, and settlement waits for owned tasks and resources to finish.

A component invocation owns projected content, body resources, and retained eval resources. Their cleanup is ordered and fully attempted before acceptance, caller binding, or later work proceeds.

Scoped state such as the working directory is provided through context and
belongs to the task performing the work — including a held conversation's
turns and session-owned entries; a component rebinds it for its own content.
That pattern does not generalize: execution capabilities that must be passed
directly are never supplied through replaceable context.

Callbacks registered with external event sources are resources too. Their owner detaches them on success, failure, cancellation, and race loss; late delivery cannot change a closed operation.

Concurrent children and structural-region producers remain inside their owning scopes. Failure or cancellation joins abandoned work before the enclosing operation settles.

Cleanup failure is settlement evidence. Plan can turn a typed candidate
refusal into another turn only after successful cleanup; a failed release
cannot authorize replacement work. Nested component aggregation and
whole-document ranking are distinct: an existing ordinary document failure
outranks ordinary root-scope teardown.

The [Language specification](specs/executable-mdx-spec.md) owns settlement ordering and failure precedence. The [Plan command specification](specs/plan-command-spec.md) owns candidate recovery.

### Retained resources and exclusive owners

Retention and live ownership have different lifetimes. A workflow run survives its document executions; middleware and ongoing effects do not. An ordinary managed checkout survives release of its execution’s locks and evidence.

A storage lease belongs to the scope that opened it. The provider owns the underlying connection through joined provider teardown. Closing one lease does not invalidate another.

The workflow executor holds the run’s exclusive executor lock through execution, cleanup, and committed lifecycle settlement. Connection serialization alone does not permit another executor to advance the run.

Native Agent ownership separately protects a logical provider conversation. Construction provenance and executable compatibility do not replace live ownership; release requires evidence that the owner’s work can no longer act.

A released operating-system lock proves a previous local workflow executor is gone. It does not, by itself, prove native Agent backend quiescence or clear an unresolved ownership record.

The [Workflow Workspace specification](specs/workflow-workspace-spec.md) owns executor and storage lifetimes. The [Native Agent session launch specification](specs/native-agent-session-launch-spec.md) owns handoff, build compatibility, and release proof.

### Cancellation and attachment

Cancellation joins physical cleanup; it does not promise rollback of committed effects or undo external work. Terminal Stop and resumable interruption differ in what logical execution remains pending.

An accepted terminal Stop joins authored finalization before cancelled completion. Resumable unwind releases physical resources while leaving unentered logical finalizers pending for continuation.

The local workflow’s foreground process owns its live execution. Management cancellation refuses while another executor holds the lock; foreground interruption leaves resumable state.

A REPL logical root outlives its screen connection. Detachment releases UI resources. Parent termination or explicit child Shutdown joins the headless children that parent owns.

REPL Entry Stop settles the entry before a successor starts. Exit can leave the final entry unfinished for continuation. Neither action’s meaning is inferred from a screen disappearing.

The run deadline is cancellation of the whole run. Exec, Fetch and
Agent-provider limits are owner-local, absent by default, and never default
across kinds; a local declaration overrides only the default it names, for
the region that declared it, a per-call value always outranks a configured
one, and a longer per-operation timeout still cannot outlive the run.

The [Language specification](specs/executable-mdx-spec.md), [Workflow Workspace specification](specs/workflow-workspace-spec.md), and [REPL specification](specs/repl-spec.md) own their respective cancellation contracts.

## Shared invariants

Shared code remains runtime-neutral. A missing required provider fails closed rather than falling back to the caller’s host or an empty implementation.

Independently loaded package copies compose through stable namespaced Context and Api names. Shared composition data is structural; package-instance identity cannot substitute for that compatibility boundary.

String names and metadata keys that cross loaded copies are compatibility
contracts; changing one is a breaking change. A module-local symbol is unreachable to another
loaded copy; a registry symbol is reachable but unowned, and offers nothing a
namespaced string does not. Any further exception for shared global state requires an explicit
architecture decision.

Runtime state stays with its owning scope: no module-scoped registries — not
as collections, not hidden inside library objects that accumulate.
Module-evaluation metadata stays on the author-owned value; the one narrowly defined exception — the weak association from a journal to
its provenance, owned by the [Language specification](specs/executable-mdx-spec.md) —
supplies no general exception for global registries.

Identity follows authored structure and admitted execution state. Time, scheduling, descriptive names, and replaceable observations do not allocate durable ownership.

Probabilistic behavior is visible in the document's structure rather than
hidden in machinery; eval is the stated exception, with direct reach to
`Date`, `Math.random` and the network; everything else is deterministic —
same inputs, same behavior.

A durable success becomes available only after publication is acknowledged. Persistence failure fences later durable entry and append; catching it cannot authorize continuation or a compensating completion.

Retained records are parsed and checked against their intended execution. Corrupt or incompatible
history is refused rather than repaired through fresh effects, refreshed
observations, or a substituted result. Readers of internal records refuse
incomplete, obsolete or extra fields — validation checks the complete current
shape — and there is no authenticity promise against an actor who can rewrite
the local database and construct a consistent replacement history.

Internal prerelease records are current-format only: no version branches, no
migrations, no compatibility adapters, and no manually invoked upgrade paths.
A retained schema label is not a promise to accept
another shape. Third-party protocols and public artifacts keep their
separately stated compatibility contracts.

Paths and ordinary error details are not inherently secret; explicitly
identified secrets are protected. Defensive complexity — and the tests that
exercise it — must be justified by an in-scope threat or a supported
reliability contract, using the simplest sufficient implementation and
evidence; additional adversarial tests cover distinct failure paths only.
Security tests exercise inputs their boundary can receive — missing fields and
invalid values in a response are relevant, while deliberately malicious
executable values fall under the trusted-extension assumption. Trusted code
can still contain bugs: supported API behavior remains part of each feature's
contract.

A second implementation preserves the shared parsing, selection and
validation rules and their observable outcomes, rather than merely
reproducing today's mechanics.

The [Language specification](specs/executable-mdx-spec.md) and feature specifications provide the behavioral contracts against which these invariants are verified.

