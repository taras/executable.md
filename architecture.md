# Architecture guidelines

Rules the engine's core mechanics must satisfy. The spec says what the
language does; this file binds what any implementation may do. Rules are
invariants; the inventory at the end says what is built.

## Terminology

Terms are locked here. Two rules:

1. Only use concepts and words described here or already defined in the spec
   and code.
2. If a concept or term is missing, ask for permission before using it; using
   it requires adding it here first.

Existing documents and code get aligned to this section retroactively.

| Term | Meaning |
| --- | --- |
| behavioral predictability | a plan as a program: ~80% deterministic, ~20% probabilistic |
| replay determinism | the journal doesn't lose the execution chain: replaying arrives at the same state, where execution can continue |
| replay | using the durable journal to restore the recorded portion of a document execution without repeating durable effects; after the recorded entries are consumed, execution may continue live |
| divergence | reserved for replay: a replay that departs from the recorded journal |
| middleware | applied by the lexical structure, used by runtime execution |
| workflow run | a workflow being carried out with its progress and outcome recorded durably; document executions perform its work, while ongoing effects remain scoped to the document execution in which they run |
| document execution | one evaluation of a root document initiated through `execute()`, producing one output stream and one completion result while reading and appending a durable journal; its ongoing effects belong to the Effection scope in which the evaluation runs |
| run ID | an opaque stable identifier assigned to a workflow run; it associates the run's durable records and effects, remains unchanged for the life of the run, and supports equality only |
| base | the Git revision supplied to choose a workflow run's starting repository state |
| pinned commit | the commit obtained by resolving a base once; it remains the workflow run's starting repository state even as the run creates descendant commits |
| expansion | one logical evaluation of an authored executable element within a document execution |
| expansion ID | a deterministic identifier for one logical expansion; restoring or retrying that expansion preserves the ID, while a distinct evaluation requested by the document receives another |
| Git capability | the contextual interface through which workflow infrastructure queries the Git repository associated with the current working directory |
| printed error | an error printed into the document (`ErrorSegment`); data, not control flow |
| failure | an error that propagates (`ComponentFailure`, `DocumentationError`) |
| error mode | what an undecided error in a region becomes: `print` (printed into the document), `output` (fails the document execution; `<PrintErrors>` can print instead), `throw` (fails the document execution) |
| attempt | one execution of a retried operation or region |
| raise | where an error no middleware converted is decided: printed or failed, per the error mode; observed exactly once, where raised |
| blocker | execution needs input (auth, a human answer); not a failure |
| suspension | a durable wait: a crash restarts into the same wait |
| loaded copy | one independently evaluated instance of a package, such as the copy bundled into the binary or a separately installed dependency |

## Three axes

The UX has 3 axes: determinism, resilience and debuggability. If we pull too
far in one direction, the others suffer. Errors are inevitable in a system
that deals with IO and has any amount of probabilistic behavior.

Determinism is two properties:

- **Behavioral predictability** — a key product feature: generate a plan as a
  program where ~80% is deterministic and ~20% is probabilistic.
- **Replay determinism** — the journal doesn't lose the execution chain:
  replaying the journal arrives at the same state, where execution can
  continue.

## Workflow runs

Core retains one document-execution entry point: `execute()`. A host that needs
workflow-run metadata installs `useWorkflow({ base })` in the child scope that
owns one document execution. The installation applies ordinary
`Execution.document` middleware, so the durable journal is active before the
workflow run is created or restored and before the root document is imported.
A later document execution, including one that continues the same workflow
run, gets a new child scope and a new middleware installation. Workflow
metadata is durable; the middleware and every ongoing effect remain
scope-owned.

Installing the middleware alone creates no workflow run. On the first live
document execution, the first durable operation installed by the middleware
allocates an opaque run ID using cryptographic randomness, resolves the supplied
base to a commit, and durably records one value:

```ts
interface WorkflowRun {
  readonly runId: string;
  readonly base: string;
  readonly pinnedCommit: string;
}
```

The workflow run exists once that value is durably recorded. A document failure
or cancellation after that point does not erase it. Failure before that point
creates no workflow run and the root document does not expand.

Base resolution goes through the contextual Git capability:

```ts
interface GitApi {
  revParse(revision: string): Operation<string>;
}
```

`Git.revParse(revision)` has the semantics of
`git rev-parse --verify --end-of-options <revision>` in the contextual working
directory. Its default provider invokes the Git CLI; another provider may
replace it lexically. Workflow initialization calls it with
`${base}^{commit}`, which verifies that the result is a commit and returns its
full object ID. Starting a workflow run fails before root expansion when Git
cannot be invoked, the working directory is not a Git repository, or the base
does not resolve to a commit. Ordinary `execute()` remains Git-independent.

Replay restores the recorded `WorkflowRun` without allocating another run ID
or invoking Git. The supplied base must equal the recorded base. Git is not
consulted to compare the current value of a moving branch with the pinned
commit.

`getWorkflowRun()` returns the frozen `WorkflowRun` for the current document
execution. Every call in one live execution returns the same object. It throws
outside a document execution associated with `useWorkflow()`, and it exposes no
journal, Git, workspace or continuation capability. Replay preserves the field
values, not JavaScript object identity.

The `@executablemd/workflow` package owns `WorkflowRun`, `useWorkflow()`,
`getWorkflowRun()` and the Git capability. It depends on `@executablemd/core`,
`@executablemd/durable-streams` and `@executablemd/runtime`, whose contextual
`exec()` and `cwd()` the Git provider invokes; core never imports workflow or
Git. The CLI adds the `xmd workflow run` and `xmd workflow continue` lifecycle
together with the durable lookup that continuation requires. Ordinary `xmd run`
remains unchanged.

## Expansion identity

Core describes the executable element currently being expanded:

```ts
interface Expansion {
  readonly id: string;
  readonly name: string;
  readonly position?: Readonly<SourcePosition>;
}
```

`getExpansion()` returns the same frozen snapshot throughout one live
expansion. `name` is the authored tag name, independent of which repository,
registered or built-in component resolves it. `position` is the opening tag's
source position, including its workspace-relative path when known; dynamically
rendered markup may have no position. A nested expansion temporarily replaces
the contextual expansion and returning restores the enclosing one. Calling the
operation outside an executable element expansion throws. The snapshot exposes
no props, bindings, projected content, selected component definition or live
scope.

An expansion ID is derived from the root document and structural expansion
path. It uses no process-global counter, time, randomness or scheduling order.
Replay, continuation, retry attempts and restoration of the same loop
iteration preserve it. Different authored elements, loop iterations,
projections, component expansions and root documents receive different IDs.
The ID is opaque and supports equality only. Two workflow runs may contain the
same expansion ID; a durable effect that needs workflow-wide identity uses the
run ID and expansion ID together. Replay preserves the snapshot's fields, not
JavaScript object identity.

`Expansion` and `getExpansion()` belong to `@executablemd/core`, so ordinary
document execution receives expansion identity without installing workflow
middleware.

## Two layers

Error handling has two layers:

1. **Lexical structure** — the document applies context, in two forms:
   context values (`<Output>` sets the `output` error mode) and middleware
   (`<Retry>` installs retry middleware). `<PrintErrors>` uses both: it sets
   `print` for its region and installs printing middleware.
2. **Runtime execution** — execution runs under the context applied by the
   enclosing structure.

Code inside a region doesn't see the context that governs it. A block inside
`<Retry>` doesn't know it's being retried. Behavior reads from the enclosing
structure, not from the affected code.

## Probabilistic behavior is visible in the structure

Every source of probabilistic behavior is visible in the document's structure
(`sample`, `exec`, `<Retry>`) — at the construct that applies it, not at the
code it affects. Everything else is deterministic: same inputs, same behavior.

Known exception, to close: eval can reach `Date`, `Math.random` and the
network directly.

## Error propagation

An error, once decided, is one of two things:

- **printed error** — printed into the document; data
- **failure** — propagates until middleware handles it or the document
  execution fails

### 1. Middleware wraps the work

Error handling, retry and suspend behavior is controlled by middleware applied
by the lexical structure. Middleware holds the operation, so it can run it
again. When the operation errors, middleware may:

- retry it — including after fixing what failed (a new token, a changed input)
- suspend, wait for input, then retry
- bind it — `<Result as>` converts the failure into a bound `{ok: false, error}`
- decline — the error emerges at raise

Middleware converts an error into success and prevents the raise: the output
shows no error at all, and the attempts live in the journal. The set of
actions is closed so every one is journalable.

```md
<RefreshLogin>            <!-- applies auth middleware for everything inside -->
  <Agent name="claude">
    <Prompt text="..." /> <!-- fails: auth expired. The middleware suspends,
                               reaches the user, gets a token, retries.
                               Execution continues. A crash while waiting
                               restarts into the same wait. -->
  </Agent>
</RefreshLogin>
```

### 2. Decide once

An error no middleware handles is decided exactly once, where it is raised,
by the region's error mode — and the two outcomes move differently:

- A failure propagates by throwing up the scope tree, tearing down as it
  goes, until middleware handles it or the document execution fails.
- A printed error does not propagate. It is printed into the document — data.

A decision is final in both directions: nothing turns a printed error back
into a failure, and execution does not continue past a stop — re-executing a
whole region starts a new attempt. Reacting is allowed: anything that can see a
printed error may raise a new failure in response, decided once at its own raise
point.

### 3. Error mode is lexical

The nearest error mode in the scope tree governs an undecided error. A mode
is a context value, so it reads from the document's structure (see Two
layers).

| Mode | An undecided error… | Installed by |
| --- | --- | --- |
| `print` | is printed; the document execution continues | the root; `<PrintErrors>`; `printErrors(fn)` |
| `output` | fails the document execution; `<PrintErrors>` can print instead | every `<Output>` region |
| `throw` | fails the document execution, even inside `<PrintErrors>` | documentation; value roots |

Projections carry the caller's error mode; they never set their own.

### 4. `<PrintErrors>` prints a failure

The nearest `<PrintErrors>` or `printErrors(fn)` turns a propagating
failure into exactly one printed error whose `cause` is the complete original
failure, and sets `print` for its region. `printErrors(fn)` is keyed to the
exact function object — nothing is shared by name. Inside documentation a
failure still ends the document execution — a hidden region gives the author
nothing to read.

### 5. Raise decides by value

An error that emerges from the middleware is raised where it stands. Raise
has exactly two outcomes, decided by the region's error mode: printed, or
failed. At raise, middleware observes only — it sees each error exactly once,
where it was raised, and changes nothing. Control at raise belongs to the
mode, never to middleware.

Nothing becomes a printed error or a failure without being raised: whoever
creates an `ErrorSegment` raises it.

### 6. An error is never a value

A binding (`as=`, `<Capture as>`, `<Each as>`) refuses a body holding
a printed error. Holding a failure as data is asked for explicitly:
`<Result as>` binds the Effection `Result` shape — `{ok: true, value}` with
the value by reference, or `{ok: false, error}` — converting the failure
before any raise. Private buffers never merge into document output.

### 7. A blocker is not a failure

A workflow run waiting for input — auth, a human answer, days if needed — has
not failed. Suspension is a durable effect: the journal records up to the wait,
the process may terminate, and a later document execution arrives back at the
same wait. An error that reveals a blocker (an expired login) reaches suspension
through middleware; waiting itself is never raised.

### 8. Durability failures are outside the model

A durability failure (§6.11) says the journal no longer describes the document
execution. No middleware sees it; it is never the document's own outcome.

## Attempts

- The journal records every attempt in full; replay restores the outcome
  without re-executing.
- Rendered output shows the winning attempt plus a brief summary of failed
  ones; verbose rendering expands the detail.
- On final failure, the last attempt's partial output renders, then the document
  execution fails.

## Partial output

- A failing region keeps what it rendered: everything rendered before the
  failure stays in the document and reaches the output stream, not only the
  journal.
- Only work the document was going to render can reach the output: a binding,
  a value, or documentation that fails never adds its content.

## Outcomes and the journal

- A document execution that fails is still a complete record: replaying it
  restores the output and the failure without re-executing anything. Only a
  durability failure means the journal no longer describes the document
  execution.
- Object identity never crosses the journal: a live document execution reports
  the failure it caught; a replay reports what the record describes. The
  journal is parsed, never trusted — an unreadable record is refused, not
  coerced.

## State ownership

All state is scoped to the operation that owns it, so it is torn down when
the operation is torn down: created inside the operation it describes,
provided via context. No module-scoped registries — not as collections, not
hidden inside library objects that accumulate. One exception: metadata an
author declares at module evaluation, about a value the author owns, may live
on that value.

## State across loaded copies

The binary bundles its own package code while components and integrations may
load another copy of the same package. Those loaded copies must be able to
compose: one can provide shared state that another reads.

Shared composition has two replaceable forms:

- Composition data uses an Effection Context with a stable, namespaced string
  name and a plain structural value. Independently constructed descriptors with
  the same name intentionally address the same binding.
- Contextual operations use a contextual Api with stable, namespaced operation
  names. Lexical middleware replacement is part of their contract.

Neither form is an authority boundary. Security enforcement, durable-effect
identity, and reconciliation never trust a same-named binding merely because
its value has the expected structure. They derive from execution-owned state
established before untrusted work begins or from parsed durable records. A
contextual observation may describe an execution; it cannot authorize it or
name its durable effects.

Metadata covered by State ownership's module-evaluation exception uses a
stable, namespaced string property when another loaded copy must read it. A
module-local symbol is unreachable to another loaded copy. A registry symbol is
reachable but unowned, and offers nothing a namespaced string does not.

A descendant may replace a same-named Context binding for its own descendants
under ordinary lexical rules. Private fields, constructors, symbols,
module-local identity, and private sentinels remain valid when no second loaded
copy needs to read the value. String names and metadata keys that cross loaded
copies are compatibility contracts; changing one is a breaking change.

## Construct inventory

Status is measured against main.

| Construct | Does | Status |
| --- | --- | --- |
| `<PrintErrors>` / `printErrors(fn)` | prints failures | built on main |
| `<Output>` region `output` mode | an undecided error fails the document execution | built on main |
| `Expansion` / `getExpansion()` | describes the current logical element expansion | built on main |
| `useWorkflow()` / `getWorkflowRun()` | associates one document execution with a workflow run | defined, unbuilt |
| `Git.revParse()` | verifies and resolves one Git revision expression contextually | defined, unbuilt |
| `xmd workflow run` / `xmd workflow continue` | starts or continues a workflow run from the CLI | defined, unbuilt; ships with durable lookup |
| `<Retry max timeout>` | retry a region until it completes | defined, unbuilt |
| suspension effect | suspend durably | defined, unbuilt |
| `<Result as>` | binds `{ok: true, value}` or `{ok: false, error}`; a failure becomes a bound value, not a raise | defined, unbuilt |
| error middleware (JS api) | retry · suspend · decline | defined, unbuilt |

`<Retry>` composes with validation by nesting: a `<Parse>` failing inside
fails the attempt — "retry until it parses" is two existing ideas.

## Changing these rules

Spec, tests, and mechanics move together, in the same PR. If a workaround
cluster grows around one of these rules, file the missing primitive instead of
building the cluster.
