# Reusable interface prerequisite for PR #902

Read this before designing the interface that replaces repository-function forwarding. The Product Owner requires a separate prerequisite PR establishing that interface, followed by refactoring PR #902 to consume it. Delivering #902 with the forwarding retained and removing it later was rejected.

## Applies to

Ordinary document execution, Deno source/compiled REPL entries and isolated ordinary children. Preserve Node/Bun startup and provider absence. This is an architecture record, not a decision-complete implementation handoff.

## Accepted order

1. Design and review a reusable interface in a prerequisite PR against main.
2. Refactor #902 to consume it and remove the existing forwarding.
3. Review each exact implementation separately, followed by its Product Owner review, delivery verification and explicit merge approval.

The ordering decision does not approve a complete interface signature. Keep ordinary repository setup functions and fresh state in existing executing scopes. Do not reintroduce an operation that performs repository installation, an extra local owner label, or continuation metadata. The Product Owner has authorized review of an execution setup primitive and contextual dependency properties; its contract remains under interview.

## Source boundary

The reviewed base is `f79f6730784a7ecba7253dcd35e6e5567293876c`. The preserved consumer worktree is clean at `2b475121ab76ec1147c7661c76200efd80488506`, branch `agent/repl-file-dir-pr1`, under `/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/pr1-file-dir`. These are the source revisions for this interview, not a fresh remote-main verification.

The [exact-revision review](upstream-repository-pr1-architecture-review-2b475121.md) records S1's source trace. The setup function currently reaches ordinary `runDocument`, REPL `runEntry` and isolated `runProfileChild` through forwarded functions. Core captures trusted evaluation inputs before installation callbacks and `Execution.execute` middleware. Those existing callbacks therefore do not provide the preparation route the consumer needs.

## Current contract

The interface, scope, product-verification decisions and five-increment upstream grouping below are accepted. The member review is complete. A new Planner owns the upstream prerequisite plan and handoffs; the previous Planner retains the preserved #902 consumer and later repository work. This record authorizes no implementation and approves no eventual patch or merge.

Host initialization runs in each execution's own scope before core reads its contextual dependencies. Core then retains the generated component selection and resolved declarations before public execution policy and document execution. Setup uses ordinary package functions. No setup operation receives an installation array, execution id, entry key or receipt. Existing unrelated trusted Workflow and Plugin contributions retain their owning paths.

```text
Command host installs Execution.init middleware
  -> core creates an execution-owned scope
     -> initialization installs providers, scoped dependencies and recording
     -> core validates and retains generated selection and declarations
     -> existing journal validation/preparation and document policy paths
     -> recorded results replay; new operations use the live environment
     -> scope teardown completes before execution returns
```

Accepted API members, alongside their unchanged existing members:

```ts
interface ExecutionApi {
  init(): Operation<void>;
}

interface ComponentApi {
  readonly generated: Readonly<Record<string, readonly InvocationForm[]>> | undefined;
}

interface PermissionsApi {
  fetch(input: string, init?: FetchInit): boolean;
  files(operation: "read" | "write"): boolean;
}

interface SyntaxApi {
  readonly symbols: Operation<SyntaxSymbols>;
  readonly text: Operation<string>;
  documentation(names: readonly string[]): Operation<string>;
}

interface ComponentDeclaration {
  readonly generated?: Readonly<Partial<Record<InvocationForm, GeneratedForm>>>;
}

interface GeneratedForm {
  readonly identity: string;
  readonly effect: "read" | "write";
}

interface ComponentAnswerRequest {
  readonly name: string;
  readonly position?: Readonly<SourcePosition>;
  answer(definition: ImportedDefinition): ImportedDefinition;
}
```

The snippets show additions or changed members, not replacements for complete existing APIs. Declaration metadata travels with the resolved definition, including provider answers. The Component.generated property selects names and forms without duplicating contracts or implementation identities. Its undefined default preserves absence of generated evaluation; explicit empty or invalid selections refuse setup. Generated identity URLs use https://executable.md/ with no revision or version segment. Core retains the actual selected implementation and metadata together; copied URLs alone supply no authority.

Initialization defaults to no-op; middleware sets up then delegates. Permissions defaults permit, restrictions refuse or delegate unchanged arguments with default max ordering, and provider implementations check immediately before I/O. Authored and generated operations share Files and Fetch contextual routes. Synthetic answers performing no I/O require no transport permission check. Files refusals use normal Err results; Fetch refusals retain existing operation-failure behavior and bind no response. Existing path containment and provider limits remain effective. Pure preliminary path checking remains before File children; write authorization remains at the eventual write. Owned cleanup follows resource lifetime and does not become a fresh document mutation.

File, File.Delete and Dir have fixed component implementations. Files middleware remains customizable. Dir moves into core and becomes available without Git; this does not expand host generated selections. Reuse existing canonical selection and final-answer verification while keeping ordinary component bodies and form dispatch. Do not introduce an identity factory, effect-site input or new routing protocol merely to make these names non-replaceable. Other core names retain their existing replacement contracts unless separately amended.

Syntax's three members use ordinary contextual dispatch. The accepted [A2 type amendment](upstream-repository-prerequisite-u3-syntax-architecture-resolution.md) makes the two lazy properties Operation-valued so installed context-api can type suspending defaults and delegation. Consumers still yield the properties without parentheses; middleware returns Operations, including synthetic answers. Default text renders contextual symbols; default named documentation uses the enclosing catalog and contextual availability. These descriptive answers do not control generated admission. Root inspection remains lazy and origin-only inspection does not load otherwise unused TypeScript implementations. Completed Syntax replay returns its recorded final text.

The accepted [A3 host setup amendment](upstream-repository-prerequisite-u3-plan-named-lookup-architecture-resolution.md) exports `useSyntax(source: () => Operation<SyntaxSymbols>): Operation<void>` from `@executablemd/core/host`. Setup snapshots existing scoped documentation contributions and installs ordinary providers backed by the lazy source. Core keeps canonical named selection and safe-refusal classification private; provider failures remain terminal. The execution-derived reference is the API fallback, host providers install at `min`, and generated scopes narrow symbols while preserving the enclosing named catalog. CLI inspection and standalone Plan share bounded target-run assembly through this helper. It replaces the old descriptive installation input without a public catalog property, forwarding API or admission authority.

Completed local operations return recorded results without physical replay, checkout inventory, validation or restoration. New operations use the live environment. Unacknowledged local work may retry. Existing Workflow and external Git-host/Issue reconciliation keep their owning journal paths. Execution.historyChecks and restoreContext are excluded. Do not split existing mixed journal callbacks into new generic phases or collections.

Remove the separate evaluation Files/Fetch adapters, read/write contract tables, frozen fetchTimeout, Workspace snapshot input and generic snapshot-membership check. Use Config for request timeout and Permissions for actual runtime requests; no static request inventory is required. Replace the affected generated identity/schema boundary with one current schema and no old-schema compatibility readers. Preserve unrelated snapshot storage, database checks, Workflow restoration/forks, structural declarations, harness lifetimes and ordinary isolation.

The accepted product evidence covers read-only scope composition, changed-file reopening, interruption before/after result recording, bounded File/Dir cost against equal live-run fixtures, and fixed filesystem components in a core host without Git. A2 and A3 link their separate feasibility proofs; they do not replace production implementation evidence. Each eventual exact implementation still requires Architect review, Product Owner review, delivery verification and explicit merge approval.

## Interview reference

This section preserves the member-by-member review. Earlier proposals and intermediate decisions are superseded by the current contract above and the later accepted decisions below. Remaining implementation details are not permission to reopen settled product behavior.

The system-boundary interview applies because the proposed change replaces dependency delivery across packages and changes setup reachability and capture order. The Product Owner's hypothesis is that installation values belong on their owning contextual APIs and execution middleware applies the supplied behavior in each execution's scope. Consumers import the operations they need rather than receive the entire installation array. The Product Owner authorized proceeding with that review, including examining an upstream prerequisite if necessary; this does not approve an implementation or a complete new interface.

The Architect has withdrawn both `Repository.installations: readonly ExecutionInstallation[]` and a generic `prepare(installations)` operation. Both preserved the aggregate dependency container instead of resolving its responsibility. The zero-argument execution initialization member is accepted; replacement dependency-property signatures remain under review. The distinction between a value property and a callable operation remains settled: the installed `@effectionx/context-api@0.6.0` already supports ordinary properties. A consumer yields `SomeApi.operations.someProperty`, without parentheses; its API member is typed as the value, not as `Operation<Value>`.

### Inventory and review order

Review the execution setup boundary first. Then review the eleven existing `ExecutionInstallation` members one at a time: `evaluation`, `admissions`, `prepare`, `bundle`, `declarations`, `expand`, `components`, `componentAnswers`, `testHarness`, `symbols`, and `install`. Keep relationships intact, particularly a structural declaration and the handler that expands it. This inventory sets the review scope; it does not decide that each member becomes a separate API or that all eleven migrate in the prerequisite PR.

Trace ordinary document execution, REPL entry execution and isolated ordinary child execution before completing the boundary. Their existing behavior and lifetimes remain settled. Isolated children inherit no middleware and must explicitly assemble the selected host behavior again; inheritance alone is not an implementation route.

### Accepted boundary: host setup before dependency reads

Status: accepted by the Product Owner after reviewing the setup, dependency-read, policy, document and teardown diagram. Exact API names and signatures remain under interview.

Use the execution-owned scope that canonical core already creates. Host execution setup middleware supplies the appropriate typed contextual dependencies and installs operation wrappers in that scope. Core then reads, validates and captures the authoritative inputs it needs before public execution policy and document execution. Completion and cancellation close that same scope; a nested ordinary scope does not create a second recorder.

```text
Host registers execution setup middleware
  -> canonical core creates execution-owned scope
     -> host setup supplies contextual dependencies and recording
     -> core reads and captures authoritative inputs
     -> public execution policy and document execution
     -> scope teardown, then completion
```

This is an accepted lifecycle and ownership boundary, not a new aggregate configuration API. Host setup and execution policy have distinct responsibilities: setup supplies contextual dependencies, establishes execution-local state and attaches operation wrappers; policy inspects, modifies or refuses the document request and delegates. Core reads its required contextual dependencies after host setup and before execution policy. Neither phase receives or returns an aggregate execution installation array. The names, signature and delivery of host setup remain under review. Do not move the existing public `Execution.execute` policy ahead of dependency reads without a separately accepted change to its authority. Core retains the host's maximum generated-XMD allowance; the effective permission also respects narrower restrictions applied by enclosing document scopes, as accepted below. Runtime recording state is created for each execution, while completed local operations continue reading the existing journal without performing local work again.

The gap established by source inspection is in core's execution setup and dependency capture boundary. Context-api value-property support already exists; inspection has not established that a context-api or Effection library change is necessary.

### Accepted permission composition

The Product Owner accepted `Permissions` as the name for scope-wide operation policy. It is distinct from Execution initialization and lifetime, generated-program vocabulary, providers, and Workspace information. Do not rename the complete evaluation profile to Permissions: that would preserve its mixed responsibilities. The Permissions member signatures and policy representation remain under review.

The Product Owner accepted this contract: permissions apply to all operations within a scope, regardless of where they originate. The host defines the maximum allowance, and a document may narrow it for its children. Effective permission is the intersection of the host's allowance and the restrictions applied by enclosing document scopes. A nested scope cannot widen an enclosing restriction, and leaving a restrictive scope restores the enclosing allowance for subsequent siblings.

For example, a host permits reads and writes and a document applies a read-only restriction to a child scope. A File write in the document, a File write inside text passed to Evaluate, and another caller's filesystem write operation within that scope receive the same restriction. Retaining the host's maximum allowance does not bypass that child restriction. Generated filesystem operations must participate in the narrowing even though their host-supplied operations are retained separately from the ordinary Files middleware chain. Wrapping or retaining an operation does not exempt its eventual invocation from the permissions of the scope in which it runs.

Existing `Evaluate` selects narrower tables with its own `allow` prop; source inspection does not establish a general contextual child-permission mechanism. The accepted contract does not approve a new component spelling or an API signature, and it does not establish that arbitrary native runtime calls are already mediated. The prerequisite design must identify the operation boundaries through which permissions are enforced and disclose any unsupported route instead of describing an unimplemented universal sandbox. The Product Owner separately accepted the setup/public-policy phase separation in the execution diagram above.

### Execution middleware member: init

The Product Owner selected `init` as the name of the execution initialization member, replacing the Architect's proposed name `setup`. It belongs on the existing Execution contextual API. The signature under review is:

```ts
interface ExecutionApi {
  /**
   * Establish contextual dependencies and behavior in the execution's own
   * scope, before core reads dependencies and execution policy runs.
   */
  init(): Operation<void>;
}
```

Existing `execute` and `document` members remain. Middleware registers through `Execution.around({ init: ... })`; canonical core invokes initialization inside the execution-owned scope. The proposal supplies no aggregate installation array, execution id or entry key. Selection of the name does not finalize the initialization delegation contract, absence behavior, dependency member interfaces or operation-level permission enforcement.

The Product Owner accepted the zero-argument member and execution-scope setup behavior in the interface review. This record already uses the selected name `init`; the Architect preserves that naming change instead of replacing it with `setup` from the conversational example. Initialization delegation and default behavior still require review before the complete interface is finalized.

### Evaluation boundary: shared filesystem delivery accepted

This member review triggers a nested system-boundary interview: `FragmentEvaluationInput` combines component tables (`read`, `write`), Workspace observations (`workspace`), filesystem operations (`files`), transport (`fetch`) and its timeout (`fetchTimeout`). Inventory: six members. Start with `files`, because it is the separate delivery path that requires #902 to wrap existing installation inputs.

Current: `readonly files?: FragmentFileAccess` supplies host methods that generated File bodies invoke directly. Ordinary File bodies invoke the existing Files contextual API. The private access route binds the host's selected provider and lifetime, but bypasses contextual Files middleware. Adding permission checks to ordinary Files middleware alone would therefore leave generated operations outside the new scope-wide contract.

Accepted by the Product Owner: File invocations in documents and in Evaluate both cross the existing Files contextual operation boundary. Execution initialization installs the host provider and execution-local recording there. Operation-level permission enforcement applies the host allowance and enclosing restrictions to both routes. Remove the separate evaluation `files` delivery member as part of a replacement that preserves host containment, execution lifetime, ordinary middleware behavior, workflow transactions and replay. Syntax admission and operation permission remain distinct responsibilities.

The intended result is one File recording middleware rather than an authored wrapper plus a generated-access wrapper. This outcome is not established by property lookup support alone. The common operation route, mandatory permission enforcement and lifetime checks require an exact design and focused evidence before implementation scope is finalized.

### Shared evaluation transport accepted

Progress in the six-member evaluation boundary review: the shared `files` and `fetch` routes are accepted. The remaining members are `read`, `write`, `workspace` and `fetchTimeout`.

Current: `readonly fetch?: FragmentFetchAccess` supplies an adapter returning a detached response record. The workflow adapter in `packages/workflow/src/deno/workspace/evaluate.ts` stores `API.Fetch.operations.fetch` in `perform`, then yields `perform(...)` when the generated request runs. Inspection of context-api's operation implementation shows that this retains a function reference, not a resolved middleware stack or provider. Middleware is collected from the consuming scope when the operation is yielded. The adapter's comment describing a frozen transport does not match this call path.

Accepted by the Product Owner: remove the second evaluation transport dependency and have generated Fetch invoke existing contextual `API.Fetch` directly, with ordinary response normalization and the same mandatory scope permissions. Preserve request admission, the host's destination/method/header bounds, effective timeout normalization, durable request/result records and execution lifetime. Removing the transport member does not add Fetch to any host's generated vocabulary; the ordinary CLI profile still admits no generated Fetch. The response-record conversion remains a useful adapter and is not itself a separate permission mechanism.

The common Fetch transport route already exists in the workflow adapter. No new transport API or context-api primitive is established as necessary by this member review. Exact timeout treatment remains a separate member decision.

### Permission delivery through contextual properties

The Product Owner corrected the Architect's proposed generic invocation hook. The Architect withdraws that proposal: a new context-api hook is not established as necessary. The proposed design uses the existing contextual property mechanism. A Fetch operation reads `yield* Permissions.operations.fetch`; a filesystem operation reads `yield* Permissions.operations.files`. The operation applies its relevant permission policy before proceeding.

The Product Owner supplied the two permission members `fetch` and `files`. Inventory for this boundary: two members, with `fetch` first. Property support remains available, but the Product Owner subsequently proposed direct request-dependent authorization for Fetch rather than a property returning a policy wrapper. The Files member shape remains under review. Permission lookup or authorization does not itself perform a network or filesystem operation.

Trace the shared implementations so all supported callers that perform an effect reach the applicable permission check, including the now-accepted generated routes. The implementation that acts must enforce the effective policy, not merely retrieve and ignore it. Preserve the accepted host allowance, descendant narrowing, execution lifetime and ordinary middleware behavior. The Product Owner places authorization at the end of the operation chain, immediately before implementation I/O, as specified below. No generic invocation-hook prerequisite is approved.

### First Permissions member: direct Fetch authorization

Status: direct authorization shape, permissive default, restriction composition and implementation-side check accepted by the Product Owner. Refusal representation, normalization and remaining host-authority details remain under review. Member 1 of 2; Files is reviewed next.

The shared runtime Fetch operation accepts a URL plus `FetchInit`, including methods and a body, while the journaled Fetch component admits GET and HEAD only. A policy needs to examine the actual request to support read-only scopes and existing destination/method/header restrictions. A single enabled flag cannot represent these distinctions.

The Architect withdraws the proposed `FetchPermissions` wrapper with an `allows` method. Use direct authorization with the runtime's existing Fetch arguments:

```ts
interface PermissionsApi {
  /** Decide whether this HTTP request is allowed, without sending it. */
  fetch(input: string, init?: FetchInit): boolean;
}
```

Context-api already lifts this boolean-returning method to an operation. The consumer is `const allowed = yield* Permissions.operations.fetch(url, init)`. The Fetch operation asks for authorization for each request in its current scope and refuses before transport when the answer is false. There is no policy object for the consumer to retain or call separately.

A read-only Fetch restriction permits GET and HEAD and refuses other methods. Existing exact-request constraints can compare the relevant normalized request fields. The proposed middleware convention refuses directly when its own restriction fails and delegates when its own restriction permits, preserving inner refusals. Enclosing restrictions must remain applicable rather than being replaced by inner middleware. The direct method does not itself establish this composition or host authority, and those routes still require review. Refusal representation, canonical normalization and the API export details remain undecided; accepting this shape does not silently settle them.

### Accepted Fetch authorization default

The Product Owner accepted the permissive default for the direct `fetch(input, init): boolean` shape. Composition and the implementation-side check are accepted in the following sections; the Files member remains under review.

Current behavior: the default runtime Fetch adapter performs HTTP requests without a permission-policy installation (`packages/runtime/apis.ts`). The specification's runtime Fetch evidence covers the ordinary call forms and contextual refusal (§Tier FR). Introducing a default denial would require explicit permission installation for existing ordinary callers and test hosts.

Accepted: with no installed restriction, `Permissions.fetch` returns true. This preserves ordinary Fetch behavior. A constrained host installs its bounds, and a document may add narrower restrictions for children. A false decision refuses before transport. The true default adds no generated component vocabulary and removes none of the provider's own restrictions. This default alone does not establish non-widening composition or mandatory enforcement; those still require their own review.

### Accepted Fetch restriction composition

Accepted by the Product Owner: install permission restrictions using context-api's default `max` ordering. A restriction returns false when it refuses and delegates the unchanged request when its own condition permits. The final default returns true. Restrictions do not return true to finish authorization early. Ancestor `max` handlers run before descendant handlers, so a parent's refusal prevents a child from answering. A parent that delegates still receives a child's false result. Leaving the child scope removes that child's restriction.

For a read-only child scope:

```ts
yield* Permissions.around({
  *fetch([url, init], next) {
    const method = init?.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      return false;
    }
    return yield* next(url, init);
  },
});
```

This is the accepted contract for restriction middleware. Context-api permits other middleware behavior; the example does not establish an unreplaceable security boundary. Mandatory enforcement and the host's authoritative bounds still need a source-grounded design. Do not mutate `next`, attach metadata to it, or add a policy-object wrapper.

### Accepted Fetch authorization at implementation

Source trace: the public runtime `fetch()` helper and its chained forms all dispatch through `API.Fetch.operations.fetch`. The workflow generated adapter also retains and invokes that operation. Direct calls to the contextual operation are a supported route, including in the Plan tests. The current default implementation in `packages/runtime/apis.ts` calls `effectionFetch`. Production Fetch middleware in the Plan writer and test-agent worker refuses without delegating; test middleware also supplies responses without sending requests.

The Product Owner rejected the Architect's pre-dispatch operation wrapper. The Architect withdraws it. Accepted direction: place the permission check at the end of the existing Fetch chain, immediately before the implementation performs network I/O. The network implementation asks `Permissions.operations.fetch(input, init)` about the request it is about to send; false refuses before I/O. Existing callers and Fetch middleware keep their current API and behavior. Middleware may answer without sending a request, and no additional authorization wrapper precedes the chain.

```text
fetch(url, init), its chained forms, or direct contextual call
  -> API.Fetch.operations.fetch
     -> existing Fetch middleware
        -> network implementation
           -> Permissions.operations.fetch(actualUrl, actualInit)
              -> false: refuse
              -> true: perform network request
```

The check sees the request after Fetch middleware has transformed it. A replacement implementation that performs network I/O has the same responsibility to authorize its actual request before sending; answering with a mock or cached response sends no request. Existing provider restrictions remain applicable. This is a change to the existing implementation, not a second middleware layer, an API descriptor wrapper or a context-api extension. Refusal representation, normalization and the remaining host-authority design still require review.

### Accepted second Permissions member: filesystem effect class

Member 2 of 2. This member lets an enclosing scope permit filesystem reads while refusing mutations, regardless of whether the caller is authored or generated XMD. Existing providers already own path resolution and containment. Their host and workflow implementations expose seven members: `checkFilePath`, `readTextFile`, `writeTextFile`, `deleteFile`, `ensureDirectory`, `globFiles`, and `temporaryDirectory`. The first is a pure preliminary check; the other six perform observations, mutations or resource acquisition.

Accepted by the Product Owner: use the existing `read` and `write` effect classes directly rather than introducing a request union or duplicating the provider interface:

```ts
interface PermissionsApi {
  /** Decide whether this HTTP request is allowed, without sending it. */
  fetch(input: string, init?: FetchInit): boolean;
  /** Decide whether this filesystem effect class is allowed in this scope. */
  files(operation: "read" | "write"): boolean;
}
```

`readTextFile` and `globFiles` ask for `read`. File replacement, deletion, directory creation and temporary-directory acquisition ask for `write`. The policy is independent of paths; existing provider containment still decides which path is admissible. The Product Owner confirmed that read/write granularity is sufficient now and additional options can be considered later when needed. Do not add per-path permission rules to this scope.

The intended consumer is `yield* Permissions.operations.files("write")` in the implementation before its effect, using the same placement already accepted for Fetch. Exact default and refusal behavior, the preliminary write check before File children expand, replay ordering and cleanup of acquired resources require follow-through. Do not add another operation wrapper or mutate the middleware continuation.

Source: `packages/runtime/files.ts` defines the seven operation contracts; `packages/runtime/host-files.ts` implements host I/O; `packages/workflow/src/deno/workspace/files.ts` implements transaction-bound logical filesystem effects. Temporary-directory acquisition is unavailable under the workflow provider. A permission decision does not supply an absent capability or replace provider-specific restrictions.

### Accepted Files permission refusal

Current behavior: filesystem implementations return Effection `Result` for ordinary filesystem conditions. Core turns arbitrary throws from a Files handler into a fatal provider-contract failure (`packages/core/src/files.ts`, `invokeFiles`). The existing `FilesOperationDeniedError` describes an unsupported temporary-directory capability, not a scope's read/write policy. File's normal error handling can report a failed operation; infrastructure failures instead end the execution and bypass that handling.

Accepted by the Product Owner: a false Files permission decision is a normal failed operation returned as `Err`, with no filesystem I/O performed. The component reports the refusal through its ordinary error behavior. The policy refusal does not classify a functioning provider as broken and introduces no automatic fatal-execution rule. This permits the foreground user or agent to see the failure and adjust subsequent work. The precise error data and diagnostic follow this observable decision; no new error class or persistence shape is approved here.

### Accepted scope permission verification

Accepted by the Product Owner: start with a host permitting reads and writes, apply a read-only restriction to a child scope, and perform both authored and generated operations there. Reads succeed. Writes through both routes return normal permission failures and leave their targets unchanged. After the child scope closes, a sibling write succeeds under the enclosing permission. A design that restricts only generated operations, only authored operations, or leaks the child restriction into later siblings does not satisfy this journey.

This is one scope-composition journey. It does not approve a new document component spelling, add permission options, require a second recorder, or authorize implementation. The Planner derives focused lower-level evidence from this accepted behavior. Other focused journeys, including completed-result replay and owned-resource cleanup, remain to be reconciled against their existing accepted contracts.

### Permissions boundary summary

The two member shapes and the child-scope verification journey are accepted. Apply the same reviewed permission pattern to Files: absent a restriction, authorization permits; a restriction refuses or delegates; the implementation checks before filesystem I/O and returns a normal failed Result on refusal. This applies the existing pattern within this boundary, not a new reusable rule. An authorization answer supplies no missing provider and does not remove provider containment. Error representation, execution integration, preliminary File checks, replay and cleanup still need source-grounded follow-through; the accepted member review is not an implementation verdict.

### Accepted Execution initialization composition

Return to the accepted zero-argument `Execution.init(): Operation<void>` member. The remaining decision is its default and delegation behavior. Current Execution policy uses contextual middleware, and the existing `DocumentOutput` API demonstrates a no-op default for additive behavior. Execution's `execute` and `document` defaults intentionally refuse because they are not authoritative entrypoints; initialization does not execute or settle a document.

Accepted by the Product Owner: `init` has a no-op default. Each initialization middleware establishes its dependencies and behavior in the execution-owned scope, then delegates with `yield* next()`. Core waits for the entire initialization chain to return before reading dependencies and running public execution policy. A setup failure ends initialization and existing structured teardown runs. Missing required dependencies fail at their owning API or core's dependency validation; the no-op default grants no capability. No initialization receipt, extra identity or installation array is introduced.

For example, command-host middleware can call the existing setup function in the new execution scope:

```ts
yield* Execution.around({
  *init(_args, next) {
    yield* useHostFiles();
    yield* next();
  },
});
```

This is an accepted use of the proposed new member, not existing implemented behavior. Additional host setup, including the entry recorder, composes through initialization middleware with the same delegation contract.

### Evaluation dependency review resumes: read vocabulary

Progress in the six-member evaluation boundary: separate `files` and `fetch` transport delivery is removed in favor of the accepted shared operation routes. The remaining members are `read`, `write`, `workspace` and `fetchTimeout`. Review `read` next.

Feature: the host decides which exact component names and forms generated program text may use as reads. The ordinary host's read table contains self-closing File, Glob and Syntax. Workflow hosts supply their own table and may admit bounded Fetch requests. This is syntax and implementation admission; `Permissions.files` and `Permissions.fetch` separately decide whether the implementation may perform the requested operation in its current scope. Allowing file reads does not make arbitrary generated components available.

Current signature on `FragmentEvaluationInput`: `readonly read: readonly FragmentEntry[]`. Entries contain stable identities, admitted forms and capability-specific limits, not an array of execution setup callbacks. Core copies and validates this vocabulary for the invocation. An absent evaluation input offers no evaluator; a supplied profile with both effect tables empty is rejected.

Proposed for interview, not accepted: an owning core `Evaluation` contextual API supplies the read table as an ordinary value property, consumed after initialization and retained before public execution policy:

```ts
interface EvaluationApi {
  /** The host's generated-XMD read vocabulary, absent when not supplied. */
  readonly read: readonly FragmentEntry[] | undefined;
}
```

The consumer is `yield* Evaluation.operations.read`, without parentheses. Undefined preserves absence rather than inventing a default vocabulary. Capture and existing identity validation still belong to core; document middleware after capture does not widen the retained host table. The `Evaluation` name and property are proposals in this member review. Write-table coupling, duplicate host profiles, Workspace delivery and timeout behavior remain unsettled and must be reviewed before completing the boundary. This does not approve a mixed aggregate profile on the new API.

### Syntax boundary exploration replaces the pending read-property proposal

The Product Owner proposed a Syntax contextual API with rendered text matching bare `<Syntax />` and another member describing its form or structure. Pause the unaccepted `Evaluation.read` proposal to explore this existing boundary first. The Product Owner clarified that existing symbols can supply the structured information, including forms; reuse SyntaxSymbols rather than add a parallel forms table. The complete contextual API and its delivery contract remain under review.

This triggers a system-boundary interview: the proposal changes the delivery of syntax across consumers and introduces related public members. Inventory: rendered text, structured vocabulary, and existing named-component documentation. Review the meaning of the structured vocabulary first; the other members must remain consistent with it.

Source evidence: `packages/core/src/inspect.ts` already defines `SyntaxSymbols`, including categories and entries with names, component forms, prop schemas, returns, descriptions and origins. Some repository TypeScript components are origin-only because inspection does not execute their modules. `renderSyntaxMarkdown` in `syntax-markdown.ts` derives text from this model. `SyntaxReference` in `syntax-reference.ts` currently exposes rendered `symbols()`, selected `documentation(names)`, and the `available(symbols)` narrowing operation. Bare Syntax describes current availability; named Syntax retains access to enclosing authoring documentation and marks whether an entry is available. The Syntax component journals the resulting text and restores it without rebuilding on replay.

The two reviewed views, not yet a complete accepted contextual delivery contract:

```ts
interface SyntaxApi {
  readonly text: string;
  readonly symbols: SyntaxSymbols;
}
```

Consumers would yield `Syntax.operations.text` or `Syntax.operations.symbols`. Text is derived from the same structured vocabulary, not independently supplied prose. The Product Owner accepts reuse of the existing symbols information for forms. Do not add a top-level forms member duplicating component entries. Existing origin-only entries remain origin-only; reuse does not invent forms for a TypeScript module inspection has not loaded. This sketch does not decide contextual delivery, absence or snapshot lifetime. Preserve existing lazy construction, current-scope availability and recorded-text replay.

Existing SyntaxSymbols describes syntax; it does not contain every stable admission identity, capability selector or request limit carried by FragmentEntry. Investigate whether a shared underlying description can supply both views before deciding that SyntaxSymbols itself replaces the generated admission table. Do not equate readable documentation with execution authority or silently retain a redundant table under another name.

### Accepted Syntax named documentation member

The remaining existing reader behavior is `<Syntax names={...} />`. It renders selected metadata and package documentation, using the enclosing authoring catalog while stating each entry's availability in the current evaluation. The existing SyntaxReference already expresses this with `documentation(names): Operation<string>`.

Accepted by the Product Owner: preserve that operation on the contextual Syntax API, beside the two views:

```ts
interface SyntaxApi {
  readonly symbols: SyntaxSymbols;
  readonly text: string;
  documentation(names: readonly string[]): Operation<string>;
}
```

Bare Syntax obtains its live text from `Syntax.operations.text`. Named Syntax obtains its live text from `Syntax.operations.documentation(names)`. The protected component still records its answer through the existing journal, and replay restores recorded text without querying the API again. The operation preserves current selection, ordering and unavailable-entry reporting. Its existence does not grant execution of a documented component. Contextual construction and authoritative delivery remain to be reviewed after the member inventory.

### Accepted common structured vocabulary source

The Syntax member inventory is settled in shape; the Product Owner also accepts a shared structured source for Syntax and generated-code admission. Current code prepares and validates FragmentEntry tables, then derives generated SyntaxSymbols from the admitted entries with `admittedSymbols`. Ordinary Syntax derives symbols from the execution's component selection inputs. The Markdown renderer consumes symbols, while named documentation additionally retains enclosing authoring symbols and the documentation index.

The existing SyntaxSymbols type describes names, forms and schemas but does not supply FragmentEntry's complete stable implementation identity, capability selector, legacy compatibility metadata or bounded request list. Some symbols are intentionally origin-only. It cannot directly replace an admission table without deciding where those facts come from.

Accepted by the Product Owner: use a common validated structured vocabulary as the source of both the Syntax view and generated-code name/form admission. Avoid independently supplied read/write vocabulary tables repeating the same names, forms and schemas. Core still validates actual implementations and retains the relevant durable identities and limits; scope Permissions still decides actual I/O. This is a direction for the source relationship, not approval of a new type, an expanded SyntaxSymbols record, or automatic execution authority for contextual text. Review the exact required metadata and source ownership next.

### Accepted shared vocabulary identity ownership

First metadata item: implementation identity. Existing FragmentIdentity has `origin`, `key` and `revision`. Generated continuation compares these retained fields; the same displayed name and forms do not establish that a component is the same implementation. Current core already retains identity alongside the resolved definition in CapturedEntry. SyntaxSymbols is a descriptive projection of that entry and does not expose the definition.

Accepted by the Product Owner: keep implementation identity with core's resolved component record in the common validated vocabulary. Both generated admission and Syntax derive their names, forms and schemas from that record; admission also uses its identity. Preserve the existing public SyntaxSymbols shape rather than adding identity fields solely to transport execution metadata. This reuses the existing core ownership boundary and does not introduce a caller-supplied operation identity, a site parameter or an extra provider handle. Exact construction of the shared record remains under review.

This settles ownership and projection. The later accepted URL identity decision replaces origin/key/revision, the Permissions decision removes request limits from this vocabulary, and the compatibility decision below excludes old-format support from this replacement. Preserve the origin-only inspection path. Do not copy the entire old profile into a new generic container.

### Superseded Fetch request-limit placement

Current `fetchEntry(requests)` requires a non-empty request list. Core captures and normalizes it per entry, whole-fragment preflight compares each generated request against it before effects, and continuation compares its retained structural policy. These describe the existing implementation. The later accepted runtime authorization decision removes the requirement to preserve this advance request inventory and static authorization behavior in the replacement design.

The earlier placement of these bounds on the common component vocabulary is superseded by the accepted request-policy separation below. Request restrictions belong to host and scope Permissions. The network implementation continues to ask Permissions immediately before I/O, including after Fetch middleware changes the request. Do not add request bounds to the public SyntaxSymbols view or require a separate generated-request list as generic component metadata.

Timeout normalization still requires reconciliation with that separation. Older affected admission formats are outside compatibility scope by the later explicit Product Owner decision. Completed-result replay and the accepted implementation-side authorization placement remain settled. Workflow request preflight is removed by the later explicit Product Owner decision below.

### Accepted generated effect-class membership

Next metadata item: which existing generated effect class admits each component form. Current `Evaluate.selectedTables` selects entries from separate read and write tables according to `allow`. A component name alone is insufficient: self-closing File reads while paired File writes, and self-closing File.Delete writes. The existing core composition entries remain available independently of effect selection. These classifications describe generated vocabulary selection; actual I/O still asks scope Permissions.

Accepted by the Product Owner: retain the existing read/write membership with each admitted form in the common validated vocabulary, alongside the identity and contract that admission already uses. Derive the evaluator's read/write selections and Syntax's available forms from that source instead of independently supplying complete tables. A name with different admitted identities or classes for its forms retains those distinctions. Do not infer an effect class by running a component or from the spelling of its form.

Examples: self-closing File belongs to read; paired File belongs to write; self-closing File.Delete belongs to write. Existing core composition remains independent of read/write. This is a relocation of existing membership information, not a new public SyntaxSymbols field, a new effect class or a grant to arbitrary components. Exact internal record layout and host delivery remain under review.

### Accepted component declaration delivery

Source trace: `Component.operations.registry` already supplies scoped host registrations. `registerComponents()` validates a batch, installs an immutable layer and preserves enclosing registrations for later siblings. `ComponentRegistration` carries name, origin, props, forms, returns, captures, documentation and implementation. Core defaults are outside this registry; repository source and middleware answers also enter through ordinary selection and resolution. Therefore the registry alone is not the complete vocabulary, and replacing it with a second complete registry is not justified.

Accepted by the Product Owner: supply generated-use metadata beside the component's owning declaration, through its existing setup or resolution path. Names, forms, schemas and documentation remain on that declaration rather than being repeated in independent generated read/write tables. Core resolves and validates the relevant declarations after initialization, retaining the shared records before public execution policy. Syntax and generated admission project from those records. Preserve ordinary lazy inspection and origin-only entries; constructing a descriptive view does not load an otherwise unneeded TypeScript implementation.

This accepts placement and ownership, not a field signature. The placement must cover core defaults, host registrations and existing provider answers without forcing every component into the host registry or changing resolution precedence. Components lacking generated-use metadata remain available on their existing ordinary authored paths and gain no generated admission automatically. Host-specific request restrictions belong to Permissions rather than the component declaration; this supersedes the earlier proposed placement of Fetch request bounds. Existing protected-component and durable-identity delivery remain intact; no new invocation parameter or replacement of `next` is proposed.

### Accepted generated metadata member

The Product Owner accepted the optional declaration member `generated` and its per-form map. Its nested information is a URL identity and read/write classification. Request restrictions are excluded by the accepted separation below, and backward compatibility for the replaced representation is not required. This does not reopen the unrelated members of ComponentApi.

Current `ComponentDeclaration` describes name, origin, props, returns, captures, forms and documentation. `ComponentRegistration` additionally supplies the implementation and registration precedence. Neither currently carries generated admission metadata. Accepted addition:

```ts
interface ComponentDeclaration {
  /** Forms this declaration makes available to generated XMD. */
  readonly generated?: Readonly<Partial<Record<InvocationForm, GeneratedForm>>>;
  // Existing declaration members remain.
}

interface GeneratedForm {
  /** HTTPS URL under executable.md identifying this component form. */
  readonly identity: string;
  readonly effect: "read" | "write";
}
```

This is the accepted shape. Request bounds and legacy compatibility fields are excluded from generic metadata. The `generated` map selects a subset of the declaration's existing accepted forms; it does not redefine which forms the implementation supports. Omitted metadata or an omitted form offers no generated use for that declaration or form. A map key for a form the declaration does not accept is invalid and is refused during core validation. Identity is a stable component-form URL, not a source location or invocation parameter. No names, schemas, functions or setup callbacks are repeated inside this map.

For File, the self-closing entry has effect `read` and a URL for its read form; the paired entry has effect `write` and a distinct URL for its write form. This preserves distinct retained identities for forms while allowing one component declaration and schema. The accepted signature must be carried through the existing declaration/registration paths rather than treating this illustrative interface excerpt as a second runtime registry.

### Accepted request policy separation

Omit `requests` from generic `GeneratedForm`. Component declarations describe generated availability, implementation identity and effect class. Host and scope Permissions decide whether an actual request may be sent. A host may impose an exact allowlist as its policy; generic component metadata does not require one. The actual Fetch request and response remain journal data. This supersedes the earlier request-limit placement on the common component vocabulary. Identity, effect, generated availability and the accepted implementation-side authorization placement remain settled.

### Accepted runtime request authorization

The Product Owner rejected preserving static request authorization during workflow preflight. A URL may be produced during execution, so the design must authorize the actual request after its inputs have been resolved. Do not require generated programs to enumerate potential requests or add a static Permissions pass to retain the old refusal timing. This decision applies to the replacement shared Fetch route, including workflow; it changes that specific behavior rather than reopening unaffected workflow contracts.

The implementation calls `Permissions.operations.fetch(actualUrl, actualInit)` immediately before network I/O. This uses the effective permissions in the performing scope and checks the request after Fetch middleware transformations. A false result prevents that request. Earlier completed operations may already have occurred; this permission contract adds no rollback or whole-fragment all-or-nothing guarantee. Syntax, component-name and form admission checks remain independently applicable, but do not establish request authorization. The decision does not add new generated expression syntax.

Completed journaled Fetch operations return recorded results without sending or reauthorizing the completed request. New or interrupted unacknowledged requests use runtime authorization when they actually execute. The replacement design does not require serializing Permissions functions or comparing inventories of hypothetical requests on continuation. The later explicit compatibility decision excludes the replaced generated-admission formats from support; unrelated identity and workflow reconciliation remain intact. Timeout normalization remains a separate integration item.

### Accepted URL component identities

Use one URL string under `https://executable.md/` for each generated component form, replacing the structured origin, key and revision identity. The Product Owner explicitly selected this HTTPS namespace, accepted removal of the component revision and accepted updating the affected existing components. The accepted member is:

```ts
interface GeneratedForm {
  /** HTTPS URL under executable.md identifying this component form. */
  readonly identity: string;
  readonly effect: "read" | "write";
}
```

The URL is stored as a string and validated in the `https://executable.md/` namespace. Representative identifiers are `https://executable.md/components/file/read` for File's self-closing read form and `https://executable.md/components/file/write` for its paired write form. The HTTPS origin is accepted; these paths illustrate the naming and do not establish a published endpoint or a complete path convention. The URL identifies the component form; it need not be fetched to execute the component. Do not silently restore a required revision field as a version segment in the URL.

An implementation updated under the same URL retains its identity, so the identity comparison no longer rejects it solely because a revision changed. A different URL denotes a different identity. Existing checks binding an actual implementation to the resolved answer remain separate from the URL's spelling; this decision does not turn a copied identity string into execution authority.

### Accepted compatibility scope

The Product Owner explicitly states that backward compatibility is not needed here. Upgrade the affected existing component declarations and provider identity inputs to the URL representation. The replacement generated identity and admission formats need no old-version readers, alias tables or migration adapters. The earlier proposal to preserve those compatibility paths is withdrawn, and continuation rules for their old request-policy data are removed from the design inventory.

Histories in the replaced generated-admission formats are unsupported by the new path; they are not interpreted as new records. No existing journal is rewritten or deleted as part of this architecture review. This decision concerns the representation being replaced, not unrelated journal events, storage or external-effect reconciliation. Replay and continuation within the new supported format retain the accepted completed-result and live-operation semantics. The precise new record shape remains to be specified; no additional format-version mechanism is required by this compatibility decision.

The Product Owner further clarifies: "I don't want revisions that would expect different schemas". The replacement boundary uses one current schema. Do not introduce revision-selected schemas, schema negotiation, old-schema readers or migrations. Validate data against the current schema directly. Snapshot content identifiers identify saved filesystem state; they do not select a component or journal schema. This decision introduces no new storage-format revision mechanism and does not expand the prerequisite into removing unrelated existing database format checks.

### Accepted evaluation Fetch timeout removal

Evaluation dependency progress: separate Files and Fetch transport delivery is removed in favor of their contextual operation routes. Read/write tables are replaced by the accepted per-form component metadata, whose contextual delivery still needs integration. Two original evaluation members remain for review: `fetchTimeout` and `workspace`. Review Fetch timeout first because runtime-only request authorization removes the reason to freeze a timeout for a static request-list comparison.

Current `FragmentEvaluationInput.fetchTimeout?: number` carries a host-resolved number into generated request normalization. Workflow assembly reads the validated runtime `timeoutFetch` once and puts that number on the profile. Ordinary Fetch already calls `prepareFetchRequest(props)`, which reads the validated contextual `timeoutFetch` and applies the component's explicit duration when present. The runtime network adapter also uses the contextual default for direct calls without an explicit timeout. Existing Config members are scoped value properties; no new property API is needed.

Accepted by the Product Owner: remove the separate evaluation `fetchTimeout` input. Generated and authored Fetch use the existing request preparation and Config timeout contract in the scope where the request is made. An explicit component `timeout` takes precedence; otherwise the validated contextual `Config.timeoutFetch` supplies the default. When both are absent, there is no request-specific timeout, while enclosing cancellation and the run deadline remain effective. Do not treat the default timeout as a permission ceiling or add a second generated-only timeout property.

For example, a scope with `timeoutFetch` set to 5,000 milliseconds gives an authored or generated Fetch without a timeout the same five-second bound. An explicit `timeout="1s"` gives either route a one-second bound. A narrower child Config override has its existing scope lifetime and does not leak into siblings. Actual live request normalization remains journal data; completed replay returns the recorded response without transport, and an unacknowledged request that executes again uses the effective timeout of that execution. This changes the generated profile's frozen-default mechanism, while reusing the existing ordinary timeout behavior and preserving body-read cancellation and teardown.

Source evidence: `packages/runtime/config.ts` (Config value members, validated `timeoutFetch`, scope override contract); `packages/core/src/fetch-request.ts` (`prepareFetchRequest`, `normalizeFetchRequest`); `packages/core/src/components/Fetch.ts` (request preparation and journaling); `packages/runtime/apis.ts` (Fetch terminal); `packages/workflow/src/deno/workspace/evaluate.ts` (assembly-time timeout copy). This accepts the member removal, not implementation authorization.

### Accepted removal of evaluation Workspace tracking

The final original evaluation input member is `workspace`. Its current signature is `readonly workspace?: FragmentWorkspaceAccess`, where `snapshot(): Operation<{ readonly roots: readonly string[]; readonly current: string }>` returns the run's retained root identifiers and current root identifier. The workflow adapter binds it to the owning run database and validates its lease through `workspaceRootSelection()`. Ordinary hosts omit it. Evaluate reads the snapshot after its producer renders, since that producer may itself advance the Workspace.

The consumer does not use the snapshot to supply a filesystem, select a checkout, restore bytes or authorize an operation. Core copies it into generated admission provenance and `workspaceHolds()` later checks that every root retained at admission is still present, including the selected root. Additional roots and an advanced current root are permitted. The field therefore couples generic generated evaluation to a Workflow history-retention check. Actual workflow Files operations already run through the owning provider and its durable Workspace-effect transaction; restoration validates the root it loads independently.

Accepted by the Product Owner: remove Workspace observation delivery and the additional per-admission root-membership comparison from the generic evaluator. Evaluation takes no filesystem snapshot identifiers or component revisions and performs no version comparison. Ordinary and REPL evaluation acquire no Workspace dependency. Do not replace this field with a new root-list contextual API solely to preserve the same generic coupling.

This removes one existing behavior: generic Evaluate no longer refuses solely because a root listed by an earlier generated admission disappeared. The corresponding admission data and regressions belong in the removal scope. Existing old-format compatibility is already excluded.

Workflow retains responsibility for filesystem snapshot storage, restoration and forks, including validating snapshots when restoration needs them. The Product Owner separately accepts one current schema without revision-selected schemas or compatibility readers. Snapshot content identifiers do not select a schema. No implementation or deletion of stored data is authorized by this record.

The six original evaluation dependencies are now reviewed: `files` and `fetch` use the existing contextual operation APIs; `fetchTimeout` uses existing Config; `read` and `write` are derived from the shared component declarations; `workspace` observation and its admission-history check are removed. This settles these removals and source relationships. Contextual vocabulary delivery, host narrowing and remaining integration details still require review before the complete prerequisite is ready for planning.

Source evidence: `packages/core/src/components/Evaluate.ts` (snapshot timing and handoff); `evaluation-profile.ts` (`FragmentWorkspaceAccess`, `bindWorkspace`); `generated-xmd.ts` (`workspaceBasis`, `workspaceHolds`); `packages/workflow/src/deno/workspace/evaluate.ts` (`workspaceAccess`); `packages/workflow/src/deno/workspace/effect.ts` (`workspaceRootSelection`, Workspace effect ownership); `packages/workflow/src/deno/workspace/files.ts` (durable file effects); `packages/workflow/src/deno/workspace/restore.ts` (root restoration validation); `specs/workflow-workspace-spec.md` §8.4 (current admission-root membership contract).

### Accepted Syntax contextual text answers

Resume the three-member Syntax boundary: `symbols`, `text` and `documentation(names)`. Their signatures are accepted. Review the dispatch behavior of `text` first because replacing the private Syntax reference with a contextual API changes who can answer a live request. Existing `Syntax.ts` obtains text from the execution-private `SyntaxReference` inside its durable observation. The current implementation intentionally prevents ordinary middleware from supplying that answer. Context-api property middleware, by comparison, may answer a value request or transform the delegated value.

Accepted by the Product Owner: live bare Syntax reads `yield* Syntax.operations.text` through ordinary contextual middleware. The default derives text from the current structured vocabulary. Middleware may answer or transform that descriptive result, with its normal scope lifetime. The Syntax component records the final returned text; completed replay returns that record without calling the contextual API again. Keep component invocation validation and the journal boundary intact.

Generated admission continues to use core's captured, validated component declarations. It does not parse a Syntax answer to decide which components may execute. A middleware-supplied answer can therefore describe something that generated evaluation will refuse; that descriptive replacement does not add executable components or change I/O permissions. The Product Owner accepts this change to the existing protection of the live Syntax answer. It adds no pre-dispatch wrapper, caller-supplied site, metadata on `next`, or secondary component registry.

Source evidence: `packages/core/src/components/Syntax.ts` (private reference and recorded answer); `packages/core/src/syntax-reference.ts` (default vocabulary rendering and narrowed views); `packages/core/src/components/Evaluate.ts` (admitted entries and narrowed Syntax); `packages/core/src/evaluation-profile.ts` (captured declarations and resolved implementations); `node_modules/@effectionx/context-api/mod.ts` (ordinary property middleware).

### Accepted Syntax structured answers

Member 2 of 3: `readonly symbols: SyntaxSymbols`. Its shape and use of the existing SyntaxSymbols representation are accepted. The remaining decision is whether ordinary contextual middleware can answer or transform this structured descriptive view, and whether default text rendering consumes that contextual answer.

Accepted by the Product Owner: `Syntax.operations.symbols` uses ordinary contextual property dispatch. Core supplies the current descriptive vocabulary, including an evaluator's narrowed names and forms where applicable. Middleware may answer or transform this value in its scope. The default text provider reads `yield* Syntax.operations.symbols` and renders the returned value with the existing `renderSyntaxMarkdown()`; it does not independently rebuild the private vocabulary. The already accepted text middleware may then customize the rendered answer. This is lazy, per-request composition rather than a new cached execution snapshot or a second vocabulary table.

Generated admission continues to use the captured declarations directly. Hiding a symbol from documentation does not disable its execution, and adding one to documentation does not make it executable. Normal well-formed SyntaxSymbols is the provider contract; this decision adds no cross-view equality check or new schema revision. Named documentation delivery remains the final member to review.

Source evidence: `packages/core/src/syntax-markdown.ts` (`renderSyntaxMarkdown` is a pure symbols-to-text renderer); `packages/core/src/syntax-reference.ts` (lazy root view, current availability and enclosing authoring catalog); `packages/core/src/syntax-admitted.ts` (admitted forms projected into the existing symbols shape); `node_modules/@effectionx/context-api/mod.ts` (value property dispatch).

### Accepted Syntax named documentation delivery

Member 3 of 3: `documentation(names: readonly string[]): Operation<string>`. Its signature and access to the enclosing authoring catalog are accepted. Named documentation can explain a component that the current generated fragment cannot execute; its availability annotation tells the reader that distinction. Existing `SyntaxReference.documentation()` selects metadata from the enclosing catalog and compares against a private current symbols view. The contextual replacement must choose whether that availability annotation follows the effective contextual symbols or bypasses symbols middleware.

Accepted by the Product Owner: the default named-documentation provider retains the enclosing catalog for metadata and long-form documentation, and reads the current `Syntax.operations.symbols` answer once to determine reported availability. It does not parse the rendered text. Thus symbols middleware affects both default text rendering and the availability annotations in default named documentation. A component absent from current symbols can still be explained if it exists in the enclosing catalog; its annotation says unavailable. Text-only customization affects neither structured symbols nor named lookup. This extends the accepted descriptive-view contract, not generated admission: a custom descriptive filter does not disable executable components. Existing selection order, unknown-name failure and lazy TypeScript inspection remain intact.

Named documentation uses ordinary contextual method dispatch, consistent with the two accepted descriptive members. Middleware may answer or transform the returned documentation. The Syntax component journals the final named answer and completed replay makes no contextual lookup. Do not add an independent public catalog property or a repeated component table to implement this member.

Source evidence: `packages/core/src/syntax-reference.ts` (`referencing`, `documentation`, `select`); `packages/core/src/syntax-markdown.ts` (`SelectedEntry.available`, `renderSelectedDocumentation`); `packages/core/src/components/Syntax.ts` (named request and durable answer).

### Accepted Syntax boundary summary

The complete reviewed interface incorporates the later accepted [A2 lazy-property type amendment](upstream-repository-prerequisite-u3-syntax-architecture-resolution.md). Earlier plain-value Syntax sketches in the interview are superseded only on these two property types:

```ts
interface SyntaxApi {
  readonly symbols: Operation<SyntaxSymbols>;
  readonly text: Operation<string>;
  documentation(names: readonly string[]): Operation<string>;
}
```

All three members use ordinary contextual middleware. Core supplies the descriptive vocabulary; default text renders contextual symbols, and default named documentation combines the enclosing catalog with contextual availability. Live Syntax invocations record their final answers and completed replay reads those records. Generated admission uses captured declarations independently of these descriptive answers. Root construction stays lazy; evaluator scopes narrow their descriptive names and forms; leaving a child restores its enclosing providers. Existing ordinary isolated execution children still require explicit host assembly, as accepted in the execution boundary.

The later accepted [A3 host setup amendment](upstream-repository-prerequisite-u3-plan-named-lookup-architecture-resolution.md) supplies `useSyntax(source: () => Operation<SyntaxSymbols>): Operation<void>` at `/host`. It binds the lazy host profile and existing scoped documentation to core's private named-reference owner. Host providers install at `min`; the execution-derived reference supplies the API fallback; generated narrowing changes symbols only. Canonical selection alone produces a safe unknown-name refusal, while provider failures remain terminal. This settles Syntax host binding without adding a Syntax member or migrating unrelated installation responsibilities.

### Accepted File permission refusal timing

Resume the recorded Files integration questions. The current paired File performs a pure `checkFilePath`, renders its children, then calls `writeTextFile`. A write implementation owns filesystem admission and I/O; the early pure check only rejects an unusable path or absent provider before child expansion. The accepted permission check sits in the implementation immediately before I/O.

Accepted by the Product Owner: preserve this ordering. Do not add a separate early permission check to File or change the pure path check into permission authorization. Within a read-only scope, an otherwise valid paired File can render children that perform permitted reads, then receive a normal permission failure from the write operation. The destination remains unchanged; completed child operations remain completed. Each child effect independently obeys the scope's permissions. Generated name/form admission may separately refuse a write form before expansion; this proposal does not change that admission rule.

Concrete journey: in a read-only scope, `<File path="copy.txt"><File path="source.txt" /></File>` reads the source, then reports the refused destination write without changing `copy.txt`. This adds no rollback or all-or-nothing File body. Existing invalid-path and provider-absence behavior still prevents children. Completed-result replay remains independent of this live refusal timing.

Source evidence: `packages/core/src/components/File.ts` (paired body order); `packages/runtime/files.ts` (`checkFilePath` purity and whole-write operation); `specs/executable-mdx-spec.md` §6.13 (lexical check before children, filesystem resolution after them).

### Resource cleanup follows existing ownership

Apply the accepted resource-lifetime contract without another product decision. Temporary-directory acquisition asks for write permission before creating anything. Once acquired, the provider still owns teardown on completion, failure and cancellation. Cleanup releases that exact owned resource; it does not dispatch a fresh document delete or ask a narrower descendant scope for permission to complete teardown. Existing provider cleanup outcomes remain intact. Likewise, a whole-write implementation retains ownership of its staging-file cleanup after acquisition. The permission change must not introduce a suspension between native resource creation and establishing its existing cleanup. This specifies the integration consequence of the existing ownership rule rather than a new cleanup API or exception allowing general document mutations.

The existing Files failure vocabulary already includes `permission-denied`. Reuse the owning operation's normal failed Result and validated failure data for a permission refusal; no separate fatal-provider category or new error schema is needed for this behavior. Source evidence: `packages/runtime/host-files.ts` (temporary acquisition, `ensure`, owned discard and write staging cleanup); `packages/runtime/files.ts` (FilesReason and failure constructors); `packages/core/src/files.ts` (ordinary outcomes versus provider-contract failure).

### Installation member 2 of 11: admissions under review

Return to the installation inventory after completing the evaluation dependency and Syntax member reviews. `readonly admissions?: readonly JournalAdmission[]` supplies callbacks core runs against the exact retained journal before replay, terminal-result reuse, document execution or append. Each existing `JournalAdmission` has signature `(retained: readonly DurableEvent[]) => Operation<void>`: it returns normally or refuses by throwing, and cannot replace the history. The callbacks combine history validation and publication of history-derived execution state. Core's own root-history check is separate and remains mandatory.

Withdrawn pending responsibility review: the Architect proposed the following value property as if every callback were only a history check:

```ts
interface ExecutionApi {
  /** Checks the retained journal must pass before this execution replays it. */
  readonly admissions: readonly JournalAdmission[];
  // Existing members, including the accepted init member, remain.
}
```

This property is not accepted. The Product Owner agrees to resolve the mixed responsibility before approving a replacement. Retain the existing implementation while reviewing the boundary; do not rename all callbacks to validators or move the array mechanically. Their paired run, bundle and provider inputs require review with the corresponding installation members.

Source evidence: `packages/core/src/execute.ts` (`JournalAdmission`, `guardedJournal`, installation capture); `packages/workflow/src/run.ts` (`admits`, `createWorkflowRunInstallation`); `packages/workflow/src/bundle.ts` (`admits`, `workflowBundleInstallation`); `packages/git/src/identities.ts` (Git-host and Issue checks); `packages/cli/src/plugin-host.ts` (selected Plugin contributions).

### Accepted retained-history responsibilities and ordering

The mixed boundary triggers a focused system-boundary interview within installation member 2. Inventory: two responsibilities, history validation and restoration of execution-local context. Review their ordering before choosing replacement member names or types.

Concrete source inventory: Workflow bundle handling checks recorded imports against the retained component catalog; Workflow run handling checks its run record and publishes the accepted run into this execution's slot; Git-host and Issue handling parse recorded identities and publish execution-local values used during reconciliation. Those last callbacks are not merely yes/no checks. Their parsers can also refuse malformed history. On completed replay, the normal durable body and its run preparation are skipped, so restoring the execution-local run must happen before returning the completed result.

Accepted by the Product Owner: distinguish the mandatory decision that the retained history is usable from publishing the execution-local state derived from that history. Read and retain one history value, complete its required validation, then restore the owning packages' execution-local context before replay or terminal-result reuse. A refusal prevents both replay and publication of a successfully restored context. Restoration sets runtime context from recorded data; it does not repeat recorded filesystem or external operations. Apply the same ownership on failure and cancellation, and never accept replaceable context values as proof that a required check passed.

This accepts the distinction between validation and derived execution data, not two new callback arrays, a generic recovery object, new journal records or an additional API. The later Product Owner correction below rejects introducing a generic context-restoration phase or new contextual exposure of recorded values. Required Workflow and reconciliation behavior remains in its existing owners. Consumer tracing confirms that Workflow exposes its run through `getWorkflowRun()` and Git-host/Issue effects consume owning-package identity values. Consumers do not obtain these values by unpacking a root installation list.

### Withdrawn history-check property

The Product Owner withdrew the previously accepted Execution.historyChecks property after the owning-feature trace established that the prerequisite does not require moving existing journal-read contributions. Add no HistoryCheck type or contextual history-check collection for this work. Preserve validation, mandatory internal root-history checks and existing Workflow/Git owning paths as specified in the accepted scope reduction below.

### No generic context-restoration API

The Product Owner rejects both the proposed generic context-restoration method and the asserted need to expose recorded values through an additional contextual API. Withdraw `Execution.restoreContext` and the new generic restoration phase. Do not introduce a replacement lifecycle hook, restored-values bag, second callback collection or public history property to preserve that proposal under another name.

Journal replay already returns recorded operation results. Values used by an owning Workflow or external-effect implementation remain within its existing journal and provider paths. A concrete consumer requirement must establish any further delivery; the existence of a record or an existing test does not establish a need for a new shared API. Preserve the accepted distinction between validation and deriving runtime data without turning that distinction into two general lifecycle mechanisms. The later accepted scope reduction also withdraws historyChecks and preserves the existing owning run, preparation, bundle and external-effect paths; do not migrate their callbacks mechanically.

The source trace identifies existing Workflow context behavior in `specs/workflow-spec.md` §§2–4 and the completed-output case in `packages/workflow/tests/workflow-run.test.ts` WR4. Git-host and Issue code use retained identities during partial replay and forks. These existing contracts are evidence for preserving their supported behavior, not approval to generalize their current context slots into a new Execution API. This prerequisite adds no new requirement for exposing recorded values during completed replay. No implementation changes or deletion of existing values are authorized by this correction.

### Accepted installation member 3 scope: prepare

The existing signature is `readonly prepare?: DurablePreparation`, with `type DurablePreparation = () => Workflow<void>`. It supplies trusted journaled work inside the durable root, after retained-history validation and before public document policy or the root import. Workflow uses it to establish the run record before authored effects. This differs from Execution initialization: initialization establishes live scope dependencies and providers; durable preparation records an operation whose completed result is subsequently replayed.

The ordinary journal protocol already supplies the required behavior. A live run performs and records the preparation effect. A partial continuation returns its recorded result without repeating that effect. A completed root bypasses preparation entirely. Failure prevents later preparation and document work while preserving any earlier committed effects. This is existing background Workflow behavior, not a new requirement for foreground REPL recovery. The unrelated `prepare` callback in ACP launch coordination is a different interface and is outside this member review.

Accepted by the Product Owner: preserve this existing durable preparation behavior and its trusted owning-feature contribution path in the prerequisite. Add no contextual `prepare` operation, preparations property or new restoration phase. Review its paired Workflow run handling when resolving migration of mixed admission callbacks; do not split those existing responsibilities by merely copying callbacks into new generic collections. Necessary integration with Execution initialization must preserve its journal ordering, completed-result behavior and mandatory position before document policy. This limits the interface redesign; it does not approve an implementation or rule out necessary integration edits.

Source evidence: `packages/core/src/document-request.ts` (`DurablePreparation`); `packages/core/src/execute.ts` (capture and `beforeAnyImport`); `packages/workflow/src/run.ts` (`prepare`, `createWorkflowRunInstallation`); `specs/executable-mdx-spec.md` (Trusted durable preparation); `packages/core/tests/execution-protocol.test.ts` DP18–DP22 (existing focused cases).

### Remaining installation inventory: required integration and preserved contracts

The Architect applies architecture rules 3 and 5 to preserve established patterns outside the changed boundary. This assessment does not introduce new public members or approve an implementation. Do not move every installation member onto a contextual API merely because it appears in the inventory.

| Member | Assessed scope |
| --- | --- |
| 4. `bundle` | Preserve the retained Workflow source catalog, exact resolution and paired history validation. This is Workflow definition data. No new bundle contextual API is required for File recording. |
| 5. `declarations` | Preserve existing exact-Markdown and structural declaration ownership and resolution precedence. Carry accepted generated metadata through the applicable owning declaration paths; that enrichment does not require replacing the whole declaration catalog. |
| 6. `expand` | Keep structural declarations and their owning handler paired. Preserve rejection of either half alone. Do not turn it into an unrelated global expansion provider. |
| 7. `testHarness` | Preserve invocation-bound delivery to canonical Test and expiry with that test. Isolated ordinary children explicitly install the required host behavior in their own scope. No new shared harness context is justified here. |
| 8. `components` | Preserve existing general invocation-bound component factories. Integrate generated metadata where applicable without replacing unrelated component invocation identities. Removing the rejected File-specific protocol does not remove this general contract. |
| 9. `componentAnswers` | Preserve general provider-answer registration and canonical implementation binding. Upgrade the affected generated identity metadata to the accepted URL representation; do not reintroduce File-specific routing or sites. |
| 10. `symbols` | Use the reviewed Syntax contextual members for descriptive answers. Preserve the Plan author's ability to describe the target run profile rather than the restricted authoring execution. This affects documentation, not generated admission. |
| 11. `install` | Use the accepted Execution initialization boundary for the host setup needed by this change. Invoke ordinary owning-package setup functions in each executing scope. Preserve existing unrelated trusted contributions; do not add an installations value property or repository-installer forwarding. |

This completes the inventory assessment, not the exact integration design. The bounded prerequisite changes setup timing, the shared File/Fetch routes, scope permissions and their relevant vocabulary/identity delivery. It does not undertake a wholesale migration of unaffected Workflow, Plugin or harness contracts. Any necessary integration edit retains the preserved contract and belongs in focused evidence. The remaining mixed-callback migration and host metadata construction must be resolved explicitly before a final implementation handoff.

Source evidence: `packages/core/src/components/bundle.ts` (captured Workflow catalog and exact source resolution); `packages/core/src/execution-declarations.ts` (`RetainedInstallation`, `incompleteStructural`); `packages/core/src/test-harness.ts` (per-Test delivery and lifetime); `packages/core/src/invocation-identity.ts` (`IdentityComponent`); `packages/core/src/component-answers.ts` (provider installer and registrar); `packages/cli/src/plan-writer-profile.ts` (target run symbols); `packages/cli/src/testing-host.ts` (isolated child assembly).

### Accepted product evidence: reopening against a changed file

Accepted by the Product Owner: use this public REPL journey in source and compiled Deno hosts. An entry writes `first` to a file, reads it and retains the read value in a binding. Leave the REPL and change that file externally to `second`. Reopen the same REPL history. The binding still holds the recorded `first`; the physical file still contains `second`. A new entry reading the file returns `second`. Reopening repeats neither the completed write nor the completed read, and requires no checkout restoration or environment matching. This distinguishes restored execution state from a new live operation against the current environment.

The Planner derives exact public invocation steps and focused evidence from this accepted journey. No new component spelling, implementation or test run is authorized by accepting it. Interruption and ordinary File/Dir cost evidence remain separate required journeys.

### Accepted product evidence: interruption across result recording

Accepted by the Product Owner: demonstrate continuation of an interrupted REPL entry at both sides of the local operation's durable result record. Use deterministic evidence for the cut; elapsed timing or an observed file alone does not establish which case occurred.

| Interruption point | Required continuation behavior |
| --- | --- |
| The File write's result is recorded, but its entry is still incomplete. | Return the recorded operation result without repeating the physical write. An external edit made before continuation remains intact until subsequent live work changes it. Continue the entry from its recorded execution state. |
| The File write reached disk, but its result is not recorded. | Treat the operation as unacknowledged. Continuation may attempt it again against the live environment, with ordinary overwrite and refusal behavior. Do not infer a recorded completion merely from the target's current contents or require checkout restoration before proceeding. |

Concrete consequence in the second case: a write intended to produce `first` can be interrupted after changing the file. If the user then changes it to `second`, a live retry may write `first` again. The design promises no exactly-once physical mutation in that interval. Once the retried operation's result is recorded, subsequent replay returns that result without another physical write. Existing scope teardown releases the interrupted execution's resources before another execution acquires them. This evidence concerns local operations; external Git-host and Issue reconciliation retains its existing rules.

The Planner derives the smallest discriminating interruption controls and source/compiled host coverage. This evidence introduces no new public fault-injection interface, recovery protocol or environment inventory. It verifies the already accepted distinction between recorded local results and unacknowledged local work.

### Accepted product evidence: ordinary File and Dir cost

Accepted by the Product Owner: perform the same File reads, writes and deletes and Dir creation in an ordinary run and a fresh REPL entry, with equal payloads and unrelated checkout content. Both produce the expected results and filesystem changes. Repeat with more unrelated content to expose checkout-wide work introduced by recording. Reopen the completed entry separately: it returns recorded results without repeating the completed physical operations or inspecting unrelated checkout content. This supplies the bounded comparison against the live-run baseline required by the stack review.

Recording adds work for the operations performed; ordinary local operations do not require checkout inventory or recovery. An implementation that produces correct output by scanning the entire checkout is incomplete. Compare operation counts, journal growth and elapsed time using equivalent fixtures, and report the added cost without inventing a numeric acceptance budget. This stays a bounded comparison, not a broader benchmark project. The Planner derives focused commands and measurements after the product journey is accepted.

### Accepted component meaning: File and Dir are non-replaceable

Accepted by the Product Owner: File and Dir keep their owning implementations across authored and generated use. Repository-local components, registrations and import middleware cannot replace their component bodies or change the meaning of their forms. File retains its self-closing read and paired write behavior. Dir remains paired-only: it ensures the directory, enters it for its content and restores the enclosing working directory on success, failure or cancellation. This supersedes the unaccepted proposal to let a local File shadow the core component and thereby remove generated availability.

Filesystem customization remains on the shared Files contextual operations. Middleware may answer, transform, delegate or refuse those operations; providers supply storage behavior, and the accepted terminal Permissions checks still apply before I/O. Component import middleware may observe, delegate or refuse imports without replacing these component implementations. Custom component bodies use other names. This fixes component semantics without introducing a File-specific identity protocol, caller-supplied site or changes to the continuation.

File and File.Delete belong to core. The separately accepted ownership amendment below moves Dir from Git into core and makes it available without the Git Plugin. This does not activate the Git Plugin in additional hosts or admit generated Dir into profiles that currently omit it. Do not assume a reserved registration alone prevents replacement by import middleware: registration precedence and final import-answer verification are different parts of the current resolver.

Specifications and regressions must reflect the accepted behavior change: existing ordinary-default override expectations no longer apply to File and installed Dir. Focused evidence covers repository-local replacements, registration/import replacements, ordinary Files middleware answers and transformations, authored/generated behavior, Dir scope restoration and provider absence. Use existing selection and verification mechanisms where they satisfy this contract; a new cross-package interface, if required, returns to the boundary interview rather than being inferred from this acceptance.

Source evidence: `packages/core/src/components/File.ts` (form behavior and Files calls); `packages/core/src/components/select.ts`, `registry.ts` and `protected.ts` (selection, defaults and canonical verification); `packages/git/src/composition/components/Dir.ts` (ensure and scope behavior); `packages/git/src/composition/installation.ts` and `plugin.ts` (package-owned ordinary registration and host availability); `specs/executable-mdx-spec.md` §5.3 and `packages/core/tests/component-registration.test.ts` CR16b (existing default override contract).

### Accepted adjacent name: File.Delete

Accepted separately by the Product Owner: File.Delete is non-replaceable under the same component rule as File and Dir. Its self-closing delete meaning stays with core; its Files delete operation remains customizable through ordinary middleware and providers. The accepted set is File, File.Delete and Dir; this does not reserve every core component by implication.

### Accepted ownership amendment: Dir belongs to core

Source tracing shows that Dir's implementation depends only on core's content and ensureDirectory operations, runtime Files failure parsing and the contextual working directory. It performs no Git or repository operation. Its current Git ownership supplies registration and generated identity, not a Git-dependent implementation. Making this package-supplied component non-replaceable would otherwise require deciding how core enforces an optional package's fixed implementation.

Accepted by the Product Owner: move Dir's component ownership to core alongside File and File.Delete, preserving its paired form, directory creation, refusal and scoped working-directory behavior. This makes Dir available without the Git Plugin, including ordinary hosts that currently omit that package's vocabulary. It does not automatically admit generated Dir into additional host profiles; the generated maximum allowance remains a separate host choice.

Move the owning declaration and documentation with the implementation, remove the Git package's duplicate registration, and use the existing core selection/verification path for the fixed component. Do not design a new cross-package protection interface solely for Dir. Exact migration and affected public package exports belong in the bounded integration assessment; this acceptance authorizes no implementation or compatibility policy change by itself.

### Accepted host selection property: Component.generated

Resume the setup boundary with one unresolved member: host selection of generated component forms. A component's accepted `generated` declaration metadata supplies its URL identity and effect class. That metadata alone does not preserve the existing difference between ordinary generated vocabulary (no Fetch or Dir) and Workflow vocabulary (Dir and optionally Fetch). The old `FragmentEvaluationInput.read` and `.write` combine that selection with repeated component contracts. The accepted replacement must preserve the host choice without reconstructing those full tables.

Accepted by the Product Owner: a contextual value property on the existing Component API:

```ts
interface ComponentApi {
  /** Component forms this host offers to generated XMD. */
  readonly generated: Readonly<Record<string, readonly InvocationForm[]>> | undefined;
  // Existing members remain.
}
```

The value selects names and forms only. Identities, read/write classification, schemas, documentation and implementation remain with each owning declaration. Core resolves each selected name once after initialization, validates that every selected form has generated metadata, and retains the actual implementation and metadata before public execution policy. Missing names, missing generated metadata, invalid forms and an explicitly empty selection refuse setup. The default is undefined: the host offers no generated evaluation, retaining the existing refusal before its producer runs. This property supplies neither providers nor an execution installation array.

The ordinary host selects File's two forms, self-closing File.Delete, Glob and Syntax, and paired Elicit. It selects no Dir or Fetch, even though core owns Dir after the accepted move. Workflow selects its existing generated forms through the same property. Requests are still authorized by Permissions at actual I/O; there is no static request inventory. Later contextual replacements cannot widen the privately captured host selection. Existing evaluator `allow` selects read/write classes from the captured forms and descendant Permissions still narrows actual operations.

This accepted cross-package property selects a subset of the common declarations; it is not a second component registry or another independently supplied read/write contract table. Exact provider metadata construction and implementation binding still require source integration review. Acceptance of this property alone does not approve that implementation or a final handoff.

Source evidence: `packages/cli/src/evaluation-profile.ts` (ordinary selected forms); `packages/workflow/src/deno/workspace/evaluate.ts` (Workflow selection); `packages/core/src/evaluation-profile.ts` (current pre-capture selection and no-profile behavior); `packages/core/src/component-api.ts` and `components/registration.ts` (existing contextual registry and declaration boundary).

### Accepted provider member: answer the declared definition

The remaining generated metadata delivery changes an existing cross-package boundary: ComponentAnswerRequest. Inventory: `name` and optional diagnostic `position` retain their current contracts; the answer-publication method changes. Review that method only. The existing request receives an imported definition plus a separate implementation identity. The replacement identity is already part of the accepted per-form generated metadata on the owning declaration, so a second identity argument would duplicate it and cannot express distinct read/write identities cleanly.

Accepted by the Product Owner:

```ts
interface ComponentAnswerRequest {
  readonly name: string;
  readonly position?: Readonly<SourcePosition>;
  /** Supply this provider's definition for the component being resolved. */
  answer(definition: ImportedDefinition): ImportedDefinition;
}
```

Carry the already accepted optional `generated` metadata through the owning declaration into its resolved definition, including provider-supplied definitions. The provider passes that definition once to its existing per-import request. Core retains the definition and per-form metadata together and associates them with the provider and the import being resolved through the existing private resolution machinery. There is no separate URL argument, replacement registry, caller-supplied site or metadata attached to the continuation. The diagnostic position supplies no component or operation identity.

Preserve the existing ownership and lifetime: only the currently open handler request supplies that provider's answer; return, failure and cancellation close it; an answer must belong to the actual resolution and remain the definition retained for that answer. An ordinary unidentified middleware answer remains valid outside generated admission, while a selected generated form requires its validated metadata and the existing implementation binding. A copied URL by itself supplies no authority. Host selection through Component.generated and core's private capture remain mandatory.

This proposal updates the existing provider-publication member, not an additional provider installation interface. The method is synchronous metadata publication and performs no component body or I/O. Core resolves each selected name once, validates its selected forms and retains the final provider-bound definition before document execution. Older identity representations remain outside the accepted compatibility scope. Exact internal representation, package exports and focused lifetime/loaded-copy evidence remain part of the implementation review; accepting this member alone does not finish the prerequisite.

Source evidence: `packages/core/src/components/component-resolution.ts` (request construction, closing, retained definition and provider association); `packages/core/src/component-answers.ts` (existing registrar); `packages/core/src/execute.ts` (`resolveComponentAnswers`); `packages/core/src/evaluation-profile.ts` (current separately supplied identity and sealed implementation); `packages/core/tests/support/answer-provider.ts` (provider construction).

### Accepted scope reduction: preserve the existing journal-read contributions

The final mixed-callback trace finds three existing owning features: Workflow bundle validation, Workflow run validation/publication paired with durable preparation, and Git-host/Issue retained identity parsing/publication. Their trusted journal-read contribution path already runs on the retained snapshot before replay or reuse. The REPL Files recorder does not require moving these contributions onto a new contextual property. The installation inventory assessment also preserves their bundle, preparation and reconciliation ownership rather than migrating every installation member.

Accepted by the Product Owner: withdraw the previously accepted new Execution.historyChecks property from this prerequisite. Preserve the existing trusted journal-read contributions, their owning callbacks and supported ordering. Do not split mixed callbacks into new generic validation/publication phases or reuse the rejected restoreContext design under another name. Keep each owner's validation before that owner uses or publishes its derived data, and keep the existing internal root-history validation before replay or result reuse. Existing Workflow run visibility, durable preparation and external-effect identity/reconciliation behavior remain supported.

This changes the proposed interface scope, not the requirement to validate retained history. The earlier historyChecks decision was made while reviewing a broader migration of installation members; the now-bounded setup/evaluation replacement does not need that migration. Introducing an additional delivery path while retaining the necessary owning paths adds machinery without enabling the File/Dir feature. The Product Owner accepted this reduction after reviewing its source evidence; architecture rules 3 and 5 support preserving the existing owning paths.

Keep Execution.init as the accepted live setup boundary. Its placement must preserve the execution-owned scopes and journal-read order used by existing Workflow and Git contributions. Provider metadata delivery and generated host selection use their newly accepted Component interfaces; unrelated bundle, preparation, structural and test-harness contributions do not acquire replacement APIs. Any integration edit must preserve these contracts and be included in focused evidence. This does not authorize deferred removal of the rejected repository forwarding from #902; that removal remains required before its delivery.

Source evidence: `packages/workflow/src/bundle.ts` (`admits`, retained import validation); `packages/workflow/src/run.ts` (`admits`, `publish`, `prepare`, per-execution slot); `packages/git/src/identities.ts` (retained identity parsing and execution-local publication); `packages/core/src/execute.ts` (`guardedJournal`, capture and read ordering). Existing completed-output behavior remains covered by Workflow WR4; the new API is unnecessary to preserve it.

### Source evidence

- `packages/core/src/execute.ts`: `runInvocation()` creates and joins the owning task and scope; `invoke()` captures installation inputs before invoking installation callbacks and public `Execution.execute` middleware.
- `packages/core/src/execution-request.ts`: canonical core already owns each invocation and issues its one-use request. No additional execution id, entry key or owner token is needed for this proposal.
- `packages/core/src/execution-environment.ts`: authoritative captured services already travel privately through expansion. Moving setup input delivery to contextual APIs does not automatically move enforcement to replaceable context state.
- `packages/core/tests/execution-protocol.test.ts`: EP23 and EP24 cover invocation context isolation and teardown before completion. Existing admission and capture tests describe contracts a replacement must preserve or explicitly amend.
- `packages/cli/src/testing-host.ts`: `runProfileChild()` explicitly installs behavior in the child's isolated scope. The replacement must account for this route as well as root and REPL execution.
- `node_modules/@effectionx/context-api/mod.ts`: value members are lifted to operations and resolve the middleware visible in the consuming scope. The library does not itself provide an execution setup or capture phase.

### Verified property support

Property support was independently verified by reading the installed package's `mod.ts` (`Operations<A>` and the value-member branch of `createApi`) and running a [typechecked probe](context-api-property-probe.ts):

```bash
deno run --check --allow-all --frozen --config deno.json /private/tmp/xmd-pr181-bench-rXAXyb/context-api-property-probe.ts
```

Result: exit 0. The [output](context-api-property-probe-checked.log) records successful default-array lookup, scoped replacement, nested replacement and restoration through property reads without parentheses. This probe changes no repository implementation, dependencies or tests.

## Accepted product verification: fixed filesystem components without Git

Accepted by the Product Owner: execute a document through a core host with a Files provider and no Git Plugin. Place repository-local components named File, File.Delete and Dir in its include path, each rendering a recognizable replacement marker. The document uses Dir to create and enter a directory, File to write and read text there, and File.Delete to remove that file. Observe the normal read text, no replacement markers, the retained directory and the removed file. A failure in the Dir body still restores the enclosing working directory, following its existing scope contract.

Repeat with ordinary Files middleware transforming the written content. The later read returns the transformed text. Fixed component bodies therefore do not prevent operation middleware from customizing filesystem behavior. The Planner derives lower-level evidence for registrations/import replacement, canonical verification, host assembly, cancellation and runtime coverage from this accepted behavior and the existing ownership contracts; this journey adds no public no-Git command-line switch.

This distinguishes a complete change from one that merely alters repository-file precedence, requires the Git Plugin for Dir, or disables ordinary Files middleware while protecting component names. It adds no generated vocabulary to hosts by implication; the existing explicit Component.generated selection remains effective.

## Accepted composition decision: one generated selection from middleware

The final boundary check identifies an existing failure behavior that cannot be preserved silently through the new property. Current execution refuses two explicit evaluation profiles. The CLI separately uses statesEvaluation to omit its ordinary profile when an installation already supplied one. With Component.generated, normal contextual dispatch returns one final selection value; it does not expose a count of independent contributors that answered or could have answered.

Accepted by the Product Owner: use normal contextual composition for this property. Host middleware may supply or transform one complete generated selection during initialization. Core validates and privately retains the final returned selection before public execution policy. Do not automatically union selections, and do not introduce contributor receipts or another collection solely to reproduce the old two-profile check. Two middleware handlers are not by themselves a setup error. This removes the old count-based refusal; the host assembly is responsible for composing the value it intends to offer.

An ordinary command may supply its existing selection as a default when delegated lookup returns undefined, retaining an already supplied custom-host selection. A defined empty or malformed value must reach core validation and fail; it must not trigger the ordinary default. Hosts offering no evaluation retain undefined when no ordinary command default is installed. This is property composition, not a Files provider-unavailable fallback or a change to Permissions. Later document middleware cannot widen the selection core already retained.

Source evidence: packages/core/src/evaluation-profile.ts (TWO_PROFILES); packages/core/src/execute.ts (profile count validation); packages/cli/src/evaluation-profile.ts (statesEvaluation); packages/cli/src/cli.ts (ordinary profile omitted when another installation supplies one). The Product Owner explicitly accepted this change to competing-host refusal.

## Bounded integration assessment and proposed prerequisite stack

The complete accepted boundary is coherent: initialization supplies live dependencies in the existing execution scope; Component.generated selects names/forms; owning declarations and provider answers supply their metadata and implementations; Syntax describes; Permissions authorizes actual I/O; the existing journal returns recorded results. There is no unowned setup value or new generic restoration responsibility. An ordinary nested scope inherits its recorder, an executing REPL entry owns fresh recorder state, and isolated ordinary children explicitly assemble their chosen host behavior. These follow the accepted lifecycle and existing isolation contracts, not new interfaces.

Current source verification: the inspected workspace is local main at e61d6ce072735b5d0cf683eeaca0f2eefddc2d59. Its committed tree is identical to the reviewed f79f6730784a7ecba7253dcd35e6e5567293876c baseline. The preserved consumer remains clean at 2b475121ab76ec1147c7661c76200efd80488506. Existing uncommitted architecture/agent files in the workspace were left untouched. This is local source verification, not a fresh remote-main or CI verdict.

The initial prerequisite was described as one PR. Its accepted scope now covers independently useful language, runtime-policy, setup and generated-admission changes. The Product Owner accepted the following upstream increments, all before refactoring #902, and requested a handoff to a different Planner. This is an accepted delivery decomposition, not a plan or implementation approval.

| Order | Useful outcome and dependencies | Approximate reviewed diff |
| --- | --- | --- |
| U1 | Fixed File/File.Delete/Dir semantics; Dir available from core without Git. | 0.7–1.8k lines |
| U2 | Scope-wide operation permissions and shared authored/generated Files and Fetch routes; follows U1. | 1.5–3.5k lines |
| U3 | Execution-owned initialization and contextual Syntax; follows U2 for a stable shared operation boundary. | 1–2.5k lines |
| U4 | Per-form generated declaration metadata, URL identities and provider answer publication; follows U3. | 2–4.5k lines |
| U5 | Contextual host selection and removal of the remaining mixed evaluation inputs; follows U4. | 1.5–3.5k lines |
| Consumer | Refactor #902 onto initialization and one Files recorder; follows U1–U5. | 0.5–1.5k lines against its preserved head, with high uncertainty |

These are source-informed estimates of additions plus deletions, including tests, specification changes and moves counted on both sides. They are not measured patches, targets or allowances; test/schema migration makes U4/U5 least certain. The inspected central modules alone contain about 10.9k existing source lines, which is an exposure inventory, not the number to change. Planner scoping must show exact module ownership and expected diff shape before implementation. If a boundary remains too large to understand, return a concrete further split; do not approve it merely because its count resembles an earlier merged PR.

### U1: fixed filesystem components

Include core ownership of Dir, fixed canonical selection and final-answer verification for File/File.Delete/Dir, the owning documentation and selection/inspection/specification updates. Keep the existing ordinary component bodies and form dispatchers. Remove the Git-owned Dir implementation/registration duplication and update its definition consumers to the core-owned source; preserve generated availability in existing hosts at this increment. Do not broaden the fixed-name set or redesign operation providers, the journal or generated identities here.

Affected boundaries: core component selection/inspection, Git declaration assembly and provider-neutral Files/working-directory composition. Focused evidence is the accepted no-Git core-host journey, local/registered/import replacement refusals, continued middleware customization, Dir scope restoration and existing ordinary/runtime startup behavior. Reuse core File/Delete implementations, Dir's provider-neutral body and current canonical import verification. Redesign their selection ownership; discard the duplicate Git declaration.

### U2: permissions and shared operation routes

Include Permissions.fetch/files, their permissive defaults and restriction composition, authorization immediately before actual host/Workflow I/O, normal Files permission Err data and existing Fetch failure semantics. Route generated Files/Fetch through the same contextual APIs as authored callers and remove their separate transport dependencies and adapters. Preserve containment, Workflow transactions, owned cleanup, middleware answers/transformations, response normalization, request timeout behavior and existing journal ordering. Retain unrelated evaluation inputs until their complete replacement in U5; do not describe the final schema as already shipped.

Affected boundaries: runtime provider implementations, Workflow Files/network behavior, core generated operation performers and host assembly. Focused evidence is the accepted child read-only journey, both authored/generated routes, direct contextual consumers, final transformed requests, synthetic middleware answers, cleanup/cancellation and existing Workflow transaction regressions. Reuse providers and their lifecycle/error machinery. Remove the private duplicate I/O delivery; do not replace it with dispatch wrappers or a Files effect factory.

### U3: initialization and contextual Syntax

Include Execution.init in the existing execution-owned scope before authoritative dependency reads and public execution policy, the no-op/default delegation contract, and command/isolated-child reachability. Introduce the accepted Syntax API with its live middleware behavior, lazy default symbols/text/named documentation and existing recorded final text replay. Preserve existing Workflow bundle/run contributions, durable preparation, external-effect callbacks and structural/harness contracts. Do not add new repository forwarding or remove its held consumer implementation prematurely.

Affected boundaries: core execution lifecycle, contextual API exports, CLI command/REPL/isolated child assembly and Syntax output. Focused evidence covers one initialization per execution, fresh state and joined teardown, failures before policy/body, default provider absence, explicit isolated-child setup, contextual Syntax consistency and completed Syntax replay. Reuse execution scopes, Syntax renderers/catalog selection and current journal operations. Redesign setup timing and live descriptive delivery; discard no unaffected installation contributions.

### U4: generated metadata and current URL identity schema

Include accepted GeneratedForm metadata on owning declarations and resolved definitions, ComponentAnswerRequest.answer(definition), core validation/binding and https://executable.md/ identities without revisions. Update every affected current writer, reader, host and provider fixture together. Remove older identity/schema compatibility from this affected boundary. Reuse implementation provenance and request lifetime enforcement. Do not add automatic generated admission, new component kinds, a second registry, static request generation metadata or context restoration. The current read/write host selection can remain until U5, deriving metadata from owning declarations rather than duplicating it.

Affected boundaries: core declarations, fixed defaults, host registration, provider resolution, generated admission records and their readers. Focused evidence covers per-form read/write identities, exact selected implementation binding, copied metadata granting nothing by itself, open/settled provider requests, repeated/loaded-copy providers, current-schema refusal and existing nested journal order. Preserve unsupported generated definition-kind refusals; metadata does not silently expand supported component kinds. This increment must keep the current reader/writer and all shipped host assemblies consistent, with no newly introduced revision-selected schemas or compatibility readers.

### U5: generated host selection and remaining evaluation removal

Include Component.generated, ordinary/default/custom host composition, private capture before policy, declared form validation and the accepted removal of the old two-profile count error. Replace the remaining full read/write contract tables. Remove frozen generated fetchTimeout in favor of Config, generic Workspace snapshot observation/membership checks, and static exact-request authorization in favor of terminal Permissions for each actual request. Preserve host-specific destination/method/header restrictions as runtime policies, the current generated vocabulary of ordinary/Workflow hosts, descriptive Syntax narrowing, replayed completed results and existing external reconciliation.

Affected boundaries: CLI run/REPL/Plan/isolated-child host profiles, Workflow evaluation assembly, core generated admission and Syntax projection. Focused evidence covers absent/invalid selections, custom host selection retained by the ordinary default, no automatic union, middleware transformations before I/O, actual runtime URL policy, effective timeout, existing generated invocation forms and removal of generic snapshot coupling. Workflow still owns actual snapshot storage/restoration/forks. Remove generic evaluator adapters and legacy builders that no longer have consumers, retaining useful normalization and journal helpers.

### Consumer: reuse the preserved #902 implementation

After all upstream increments land, rebase the preserved branch and remove repository-function arguments reaching runXmd and isolated children, retire repl-repositories.ts and the generated-access wrapper, and install the existing repository/recording setup function through Execution.init in each executing entry's scope. Use one Files middleware for authored/generated operations. Preserve accepted lease ownership/teardown, ordinary Results, passive history, entry isolation and positional journal behavior. Do not reopen unrelated selection, Git-host/Issue or reviewed lease areas.

Focused evidence remains the accepted public source/compiled REPL journeys, interruption on both sides of result recording, ordinary File/Dir cost against equal live-run fixtures, no replay I/O/inventory, middleware answers and the affected isolation/lease regressions. The Planner audits the preserved ten evidence rows against this contract and replaces only affected rows. Historical provider, native lease and journal work is reusable where it meets the accepted contracts; whole-checkout recovery, File-specific identity routing, duplicate generated I/O adapters and function forwarding are discarded.

### Main usability and review gates

Every increment updates its specifications to its actual shipped behavior and leaves ordinary runs, Workflow and supported runtime startup usable. Do not split a schema writer from its reader or merge an unusable provider/host half. Existing forms, identities and selection paths may remain until the increment that replaces them; do not introduce temporary public forwarding, parallel schemas or extra setup APIs. The held #902 is not delivered between upstream increments.

No implementation revision is approved by this grouping. Each eventual exact revision requires Architect review, Product Owner review, focused feedback evidence, delivery verification and explicit merge approval. Existing repository test-selection and feedback/delivery rules apply. No tests, implementation, commits, publication or GitHub changes were performed for this assessment.

## Current next action

The new Planner prepares a separate U1–U5 prerequisite plan and a bounded U1 Implementor handoff using the [Planner handoff](upstream-repository-prerequisite-stack-planner-handoff.md). The interface, product-verification and grouping interviews are complete; no member-level decision remains open. The previous Planner retains ownership of the existing consumer plan, #902 handoffs and later repository work. Supply that Planner with the upstream integration contract rather than overwriting those artifacts. Preserve all implementation and receipts. Keep #902 held until it consumes the landed reusable interfaces and removes forwarding. Approval of this architecture or grouping is not approval of an implementation, delivery or merge.
