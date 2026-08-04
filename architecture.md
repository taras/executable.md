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
| replay determinism | the journal doesn't lose the execution chain: replaying arrives at the same state, where execution can resume |
| divergence | reserved for replay: a replay that departs from the recorded journal |
| middleware | applied by the lexical structure, used by runtime execution |
| printed error | an error printed into the document (`ErrorSegment`); data, not control flow |
| failure | an error that propagates (`ComponentFailure`, `DocumentationError`) |
| error mode | what an undecided error in a region becomes: `print` (printed into the document), `output` (fails the run; `<PrintErrors>` can print instead), `throw` (fails the run) |
| attempt | one execution of a retried operation or region |
| raise | where an error no middleware converted is decided: printed or failed, per the error mode; observed exactly once, where raised |
| blocker | execution needs input (auth, a human answer); not a failure |
| suspension | a durable wait: a crash restarts into the same wait |

## Three axes

The UX has 3 axes: determinism, resilience and debuggability. If we pull too
far in one direction, the others suffer. Errors are inevitable in a system
that deals with IO and has any amount of probabilistic behavior.

Determinism is two properties:

- **Behavioral predictability** — a key product feature: generate a plan as a
  program where ~80% is deterministic and ~20% is probabilistic.
- **Replay determinism** — the journal doesn't lose the execution chain:
  replaying the journal arrives at the same state, where execution can
  resume.

## Two layers

Error handling has two layers:

1. **Lexical structure** — the document applies context, in two forms:
   context values (`<Output>` sets the `output` error mode) and middleware
   (`<PrintErrors>` installs failure printing; `<Retry>` installs
   retry middleware).
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
- **failure** — propagates until middleware handles it or the run fails

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
  goes, until middleware handles it or the run fails.
- A printed error does not propagate. It is printed into the document — data.

A decision is final in both directions: nothing turns a printed error back
into a failure, and nothing resumes past a stop — re-executing a whole region
as a new attempt is not a resume. Reacting is allowed: anything that can see
a printed error may raise a new failure in response, decided once at its own
raise point.

### 3. Error mode is lexical

The nearest error mode in the scope tree governs an undecided error. A mode
is a context value, so it reads from the document's structure (see Two
layers).

| Mode | An undecided error… | Installed by |
| --- | --- | --- |
| `print` | is printed; the run continues | the root; `<PrintErrors>`; `printErrors(fn)` |
| `output` | fails the run; `<PrintErrors>` can print instead | every `<Output>` region |
| `throw` | fails the run, even inside `<PrintErrors>` | documentation; value roots |

Projections carry the caller's error mode; they never set their own.

### 4. `<PrintErrors>` prints a failure

The nearest `<PrintErrors>` or `printErrors(fn)` turns a propagating
failure into exactly one printed error whose `cause` is the complete original
failure, and sets `print` for its region. `printErrors(fn)` is keyed to the
exact function object — nothing is shared by name. Inside documentation a
failure still ends the run — a hidden region gives the author nothing to
read.

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

A run waiting for input — auth, a human answer, days if needed — has not
failed. Suspension is a durable effect: the journal records up to the wait,
the process may terminate, restart arrives back at the same wait. An error
that reveals a blocker (an expired login) reaches suspension through
middleware; waiting itself is never raised.

### 8. Durability failures are outside the model

A durability failure (§6.11) says the journal no longer describes the run. No
middleware sees it; it is never the document's own outcome.

## Attempts

- The journal records every attempt in full; replay restores the outcome
  without re-executing.
- Rendered output shows the winning attempt plus a brief summary of failed
  ones; verbose rendering expands the detail.
- On final failure, the last attempt's partial output renders, then the run
  fails.

## Partial output

- A failing region keeps what it rendered: everything rendered before the
  failure stays in the document and reaches the output stream, not only the
  journal.
- Only work the document was going to render can reach the output: a binding,
  a value, or documentation that fails never adds its content.

## Outcomes and the journal

- A run that fails is still a complete record: replaying it restores the
  output and the failure without re-executing anything. Only a durability
  failure means the journal no longer describes the run.
- Object identity never crosses the journal: a live run reports the failure
  it caught; a replay reports what the record describes. The journal is
  parsed, never trusted — an unreadable record is refused, not coerced.

## State ownership

All state is scoped to the operation that owns it, so it is torn down when
the operation is torn down: created inside the run it describes, provided via
context. No module-scoped registries — not as collections, not hidden inside
library objects that accumulate. One exception: metadata an author declares
at module evaluation, about a value the author owns, may live on that value.

## Construct inventory

Status is measured against main.

| Construct | Does | Status |
| --- | --- | --- |
| `<PrintErrors>` / `printErrors(fn)` | prints failures | built on main |
| `<Output>` region `output` mode | an undecided error fails the run | built on main |
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
