# Architecture guidelines

## Reading this architecture

Read this document to understand the rules every engine implementation preserves.
Start with a document running, then follow its execution, failures and retained
state. The detailed boundaries explain what an implementation may do; the
terminology and construct inventory are references after those ideas are clear.

The documents have different jobs:

- This architecture owns implementation invariants and resource lifetimes.
- [The language specification](specs/executable-mdx-spec.md) owns authored syntax,
  observable behavior and conformance. Feature specifications refine their own
  interfaces; the route table below points to them.
- [The vision](specs/markdown-agents-vision.md) explains product direction and is
  non-normative. [Decisions](specs/decisions.md) preserve history and consequential
  rationale, including changes to earlier decisions.
- [The contribution guide](AGENTS.md) owns preparation, verification and review.

| Question | Start here | Interface and evidence |
| --- | --- | --- |
| What runs, and can a diagnostic journal continue it? | [A document running](#a-document-running) | [Plan diagnostic journal](specs/plan-command-spec.md#the---journal-file) and [workflow continuation](specs/workflow-workspace-spec.md#9-replay-and-continuation) |
| What does partial or completed replay restore after a write, read and delete? | [Replay and effect transactions](#replay-and-effect-transactions) | [Workflow replay](specs/workflow-workspace-spec.md#9-replay-and-continuation) |
| Who owns a native Agent handoff, and what if its executable changes? | [Native Agent sessions](#native-agent-sessions) | [Native ownership](specs/native-agent-session-launch-spec.md#ownership-and-concurrency) and [build binding](specs/native-agent-session-launch-spec.md#executable-build-binding) |
| When does an installed structural region run, and who cancels it? | [Installed structural syntax](#the-installed-structural-syntax-boundary) | [Structural interfaces](specs/executable-mdx-spec.md#declared-structural-syntax) and [SR conformance](specs/executable-mdx-spec.md#tier-sr--expanding-installed-structural-syntax-53) |
| Why can Plan retry a refused candidate but stop on cleanup failure? | [Typed candidate recovery](#typed-candidate-recovery-around-evaluate) | [Plan failures](specs/plan-command-spec.md#failures) |
| Which rules are current, and which explain earlier choices? | [Changing these rules](#changing-these-rules) | [Decisions](specs/decisions.md) and [vision](specs/markdown-agents-vision.md) |

## A document running

Consider a document that writes a file, reads its contents, then deletes it.
Each step has an observable result. At the end the file is absent, but the read
still describes the contents observed between the write and deletion.

An ordinary `xmd run` uses the caller's environment. Its `--journal` is a new
diagnostic trace, not input to a CLI continuation: another invocation starts a
new execution. A Plan is source for a program; producing or approving it does
not run it. The caller composes it with a run when execution is wanted.

A workflow instead retains the definition bytes, props, journal and filesystem
state under a run ID. Partial replay rebuilds the live resources needed to continue and restores
completed effects from their records, then performs the first unrecorded work.
It does not write or delete again merely because those steps are reached again.
A completed root returns its retained output and result without expanding the
document or attaching operational providers.

The journal is historical; the Workspace is the current filesystem frontier.
After the three steps above, replay restores the old read even though the file
is now absent. It never refreshes an observation against today's filesystem to
prove that the earlier effect happened. These distinctions govern
[effect transactions](#replay-and-effect-transactions),
[workflow lifecycle ownership](#workflow-lifecycle-ownership) and
[ordinary command retention](#foreground-commands).

## Shared rules

Start with the properties every execution shares: predictable behavior, scoped ownership and composition across independently loaded package copies.

### Three axes

The UX has 3 axes: determinism, resilience and debuggability. If we pull too
far in one direction, the others suffer. Errors are inevitable in a system
that deals with IO and has any amount of probabilistic behavior.

Determinism is two properties:

- **Behavioral predictability** — a key product feature: generate a plan as a
  program where ~80% is deterministic and ~20% is probabilistic.
- **Replay determinism** — the journal doesn't lose the execution chain:
  replaying the journal arrives at the same state, where execution can
  continue.

### State ownership

All state is scoped to the operation that owns it, so it is torn down when
the operation is torn down: created inside the operation it describes,
provided via context. No module-scoped registries — not as collections, not
hidden inside library objects that accumulate. One exception: metadata an
author declares at module evaluation, about a value the author owns, may live
on that value.

A callback registered with something outside the process — a listener on a
socket, a child process, a stream or a DOM target — is state of exactly this
kind, and the source it is attached to knows nothing about the operation that
attached it. The event arriving is not teardown: a cancelled wait is precisely
the case where it never arrives, and a losing race arm is one that will never
be told. So the owner detaches its handlers, on completion, failure, halt and
race loss alike, before it is considered closed, and an event delivered after
that reaches nothing and changes nothing. `local/require-scope-bound-event-registration`
holds source to it.

A Repository selection is composition data and is therefore replaceable: a
document may bind one, render one, hand one to a child, and construct one that
looks exactly like it. Nothing a repository provider does is authorized by the
value it was handed. What stays provider-owned, in the provider's own closure
for one document execution, is everything a selection is *not*: the advisory
locks on managed checkouts, the canonical Git identity each selection resolves
to, an ordinary run's live Push evidence, its invocation identity, and every
reconciliation key derived from them. A selection that the provider did not
mint, or one whose name, checkout path or identity was edited after it did, is
refused before Git or a service is touched.

### State across loaded copies

The binary bundles its own package code while components and integrations may
load another copy of the same package. Those loaded copies must be able to
compose: one can provide shared state that another reads.

Shared composition has two replaceable forms:

- Composition data uses an Effection Context with a stable, namespaced string
  name and a plain structural value. Independently constructed descriptors with
  the same name intentionally address the same binding.
- Contextual operations use a contextual Api with stable, namespaced operation
  names. Lexical middleware replacement is part of their contract.

Neither form is a permission boundary. Security enforcement, durable-effect
identity, and reconciliation never trust a same-named binding merely because
its value has the expected structure. They derive from execution-owned state
established before untrusted work begins or from parsed durable records. A
contextual observation may describe an execution; it cannot authorize it or
name its durable effects.

A private context name is not an exception to this. A descriptor built under a
name nobody else knows — a module-local one, a name carrying a fresh identifier
— is still a context, and reaching a capability through one is still reading
replaceable state to decide it. The same holds for a public answer that carries
an unreadable value: a registry record whose contents a handler cannot read is
still a record that handler can keep and hand back somewhere else, so what
cannot be read can still be transferred. A capability that must not move is held by
the execution and delivered as an argument, never looked up.

Metadata covered by State ownership's module-evaluation exception uses a
stable, namespaced string property when another loaded copy must read it. A
module-local symbol is unreachable to another loaded copy. A registry symbol is
reachable but unowned, and offers nothing a namespaced string does not.

A descendant may replace a same-named Context binding for its own descendants
under ordinary lexical rules. Private fields, constructors, symbols,
module-local identity, and private sentinels remain valid when no second loaded
copy needs to read the value. String names and metadata keys that cross loaded
copies are compatibility contracts; changing one is a breaking change.

Unreachable to another loaded copy and unreachable to a holder of the object are
different properties, and only the first is what a module-local symbol gives.
A symbol-keyed property is an ordinary property: `Reflect.ownKeys()` returns it,
a descriptor read returns its value, and `Object.getOwnPropertyDescriptors()`
copies it onto a look-alike — non-enumerable and frozen change none of that. So
a symbol names state safely and hides none. State a value must carry but its
holder must not reach belongs in a private field, or in membership of a set the
owner keeps; both are absent from every key list, descriptor, and copy. A
capability boundary that a handler holding the object could read across is not
one, whichever of the two properties it was reasoned from.

## Executing a document

Execution first acquires and selects source, then expands it under lexical bindings and ownership. The rules here distinguish authored identity from runtime scheduling.

### The root document a run is given

An `xmd run` starts from exactly one root document, and it comes from one of
three places: a path, standard input, or one `--eval` value. Which one is fixed
grammar — decided from the command form the caller wrote, before anything is
read — so a run never discovers its source part-way through preparation.

The command form is what separates the three, because a path and standard input
can be written the same way. `-` is the one filename the option grammar leaves
unwritable, so it reaches the reference grammar through the parser's own
unconsumed tokens: bare `xmd -` names that file, `xmd run -#Section` selects a
section of it, and only an invocation that explicitly names `run` with a
document argument of exactly `-` means standard input instead.

Standard input is the one of the three the shared CLI cannot reach for itself. A
process's own stdin is host-specific state, so each runtime-named entrypoint
supplies the operation that reads it, as a value passed into the CLI beside the
service installer, the upgrade assembly and the repository installer. It is not
a Context, a contextual Api, a public export, a syntax entry, a component or a
document capability: nothing an authored document can name reaches it, replaces
it, or asks it for a second read. The CLI calls it at most once per invocation,
and only for the one command form that selected it.

The parsed path and recovered reference remain separate until the grammar is
settled. Naming two roots refuses in either order before either candidate is
inspected or standard input is read. A `-` consumed as another option's value is
not a document argument; another command's `-` keeps that command's meaning,
and `--eval -` keeps its refusal.

Core represents the supplied source as `retainedSource("<stdin>", source)`.

What comes back is admitted through the existing supplied-source protocol rather
than a form of its own. The origin `<stdin>` and the exact text travel together,
which is what source positions, diagnostics, the root binding and the durable
root import all carry — so replay restores the retained source without reading
anything, and two different programs are two different roots without a second
identity field. `<stdin>` is an origin and never a path: no file of that name is
read or created, and every relative operation still resolves from the contextual
working directory.

Acquisition is the first thing the run does. The complete input is in hand
before document inspection, target and property preparation, Agent-stack or
provider setup, the secret-detection announcement, journal creation, root
admission and execution — so a host that cannot deliver a whole document reports
one fixed sentence, exits nonzero and has reached none of them. It happens
inside the run's existing deadline rather than opening a lifecycle of its own,
and a waiting read is cancellable: cancellation tears the reader down and stays
cancellation, never a read failure.


### Document targets

A root document addresses its own sections. The outline is discovered from the
document's static Markdown alone: only headings in the root flow are targets,
and a heading is addressable only when its text is statically rendered — a
heading generated inside a component, or one carrying an interpolation, has no
stable address, and neither does anything beneath it. Discovery therefore
parses a copy in which the scanner's top-level component spans are blanked,
because a Markdown parser reading raw XMD cannot tell a component's children
from the root flow.

A document's preamble is what precedes its outline — the source before the first
root-flow heading, whatever its depth. A document may open at a deeper level than
the one supplying its title, and an earlier section is a target in its own right
rather than preamble every other target carries.

Selection resolves exactly once, before the document expands and before any
authored effect runs. A selector may glob, but it must name exactly one catalog
entry: naming none and naming several are both failures, and two sections that
canonicalize to the same path stay two entries so the ambiguity is reported
rather than resolved arbitrarily.

The selector and the target it resolves to are different things, and only one of
them is identity.

**The exact canonical target is definition identity.** It is what ran, so it is
what a document execution records durably, what a targeted workflow definition
carries, and what a resumed run is checked against.

**A caller's glob is non-authoritative invocation metadata.** It describes what
a caller asked for — two callers may spell one request differently — and it
never substitutes for the exact target: it does not occupy the recorded
exact-target field, it never enters a workflow definition, and it is never
re-resolved against a newer checkout to decide what a resumed run means. A glob
is retained in exactly one place, a failed selection's structural record, and
only so that an ordinary failed execution can be reproduced.

The command line is the first consumer of that split. `xmd run` resolves a
selector while inspecting the document, then asks execution for the exact target
that resolved — so a file replaced between the two reads fails on the target the
run chose, rather than silently running whatever the glob would name now.

`xmd workflow start` is the second, and it is stricter because its answer is
retained. It resolves the selector once, against the exact bytes it is about to
retain, and stores only what core answered. A resume re-enters that section
without resolving anything again: the glob is gone, and the bytes it was
resolved against are the run's.

The workflow definition is the second. It optionally carries that exact target,
compares it with the rest of the descriptor, and validates it through core's own
canonical-target predicate rather than a rule the workflow package restates —
identity two packages define separately is identity they can disagree about. A
run of one section, a run of another, and a run of the whole document are three
different runs.

A resumed run re-resolves the current selector against the *recorded* content
and refuses to continue unless the outcome is the one recorded. A failed
selection is an outcome too, and is recorded and compared as one — otherwise a
journal left by a selector that matched nothing would answer a later request for
a section that does exist.

Validating that identity is **execution-owned**. Replay guards are composable
policy — a handler installed further out may decline to delegate — so identity,
which must not be negotiable, is not decided there. The execution owns the
journal it replays through and validates the recorded selection inside the read
itself, ahead of public guard policy, of a retained terminal result being
reused, of authored work, and of any append. The retained history it owns covers
every event that takes part in that decision, a recorded completion included, so
no event can present one identity to the validation and another to the run.

Three views of that history stay distinct. The **authoritative** one is what
admission validated and replay consumes, and it is immutable to policy.
Replaceable public policy reads an **isolated observation** of it, so a handler
composes freely without acquiring the enforcement the gate exists to withhold.
What a document receives is a **fresh mutable copy**, because a resumed binding
is ordinary data its own continuation writes to. Reusing a terminal result also
requires exactly one recognizable root import belonging to the coroutine whose
result is being reused.

Every public path validates in one order: parse the source, resolve the target,
compile schemas, then build the projected definition. A caller who named a
section the document does not offer hears that, rather than a complaint about a
schema they never reached.

A recorded selection is a closed protocol, and a record that does not satisfy it
is refused rather than delegated. "This event is not the root import" and "the
root import, malformed" are different answers: one continues, the other fails
before the recorded terminal result can be reused, without executing authored
work or appending history. The record carries the content it was taken from, so
the selection is verified against that content rather than merely parsed, and
reading it is total — every way journal-controlled data can refuse to be read is
the same refusal, carrying nothing the record supplied.

### The ordinary component prop boundary

An ordinary component's props are JSON, and one resolver decides that for both
Markdown and function components — before validation, and before anything
durable is written.

- **A successful `undefined` means the prop is absent.** The resolver leaves it
  out rather than giving it a value, so the schema answers it: an optional prop
  stays unset, a declared default is supplied, and a required one fails as a
  missing property with no body run. That is how one authored invocation can
  carry an optional identity a preceding result supplies later.
- **`null` is a value the author wrote.** It crosses the boundary as itself, and
  only a schema that accepts it accepts it. Absence is never widened to it, and
  never widened to a root a JSON round trip cannot describe: a function, a
  symbol and a serialization that threw stay the failure they were, as do an
  expression that threw and a name that is not bound.
- **The rule stops at the root.** Everything under it is the same native
  `JSON.stringify` round trip as before — an `undefined` object member is
  dropped, an `undefined` array entry becomes `null` — and no recursive
  normalizer of ours replaces it.
- **Deliberate bypasses stay bypasses.** A capture is separated before this
  resolver runs and receives the exact operand, `undefined` included; `<Let
  value>` binds by reference; a construct that evaluates an arbitrary operand
  keeps its own contract.
- **Absence is not durable state.** Prop resolution records nothing of its own.
  No resolved prop, validated prop, retained event or replay-restored prop holds
  `undefined`, and a replay reconstructs the same validated prop set through
  ordinary expansion.

### Expansion identity

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

Selecting a document target does not disturb any of this. Projection retains
the original source ranges and scans each one under its own origin, so a
retained element keeps the offset and line it was authored at, and with them
its expansion ID. Two runs of the same document under different targets
therefore agree on the ID of every element they both retain, and may share IDs
without sharing effects — run identity and workflow-definition identity are
what tell those runs apart.

### Definition-owned return state

A value body — a value root, or a Markdown component that declares `returns` —
selects its value with a `<Return>` its own flow reaches, rather than with a
direct top-level child. What decides whose declaration an element satisfies is
the body it was written in, which is the ownership `<Break>` already establishes
for the loop it exits.

One state exists per execution of one value body. `<If>`, `<Switch>`, `<Loop>`,
`<Each>` and `<Let>` keep the ambient one; a component invocation hides the caller's from the
invoked body, so a component's own `<Return>` satisfies its own declaration; a
`<Spawn>` passes none either, and the shared rule refuses the `<Return>` that
would have reached for one, so concurrent children cannot race to reserve a value
owned outside their `<All>`; a
nested value body installs a separate one, and both executions stand; and
content the caller projected restores the caller's, through a Markdown
`<Content />` and a function component's `content()` alike, with every
projection of one authored element restoring the same state. Dynamically scanned
Markdown and a foreign body receive none, so a `<Return>` there stays reserved
and never resolves a component named `Return`.

The first executed `<Return>` reserves the state before evaluating its expression,
so two returns racing through one body cannot both believe they were first. The
second fails the body, evaluates nothing, and the first value is not published —
there is no first-wins or last-wins fallback. A body that executes none settles
as a missing selection: the body ran and its flow reached no `<Return>`, which is
a structural outcome and carries nothing about what the author concluded. A
document that deliberately aborts, or that exhausted a bounded search, expresses
that as authored control flow with `<Fail>` and the sentence its author wrote.

**Selection is not a decision a document makes about itself.** A document's own
eval block reaches further than it looks: a named context by name, because
`createContext(name)` names the slot the engine would publish on, and an internal
module by file URL, because an eval block's imports are hoisted and resolved like
any other module's. Anything published contextually is therefore readable, and
any exported function acting on what was published is callable — a sealed carrier
in a context plus an exported `claim(carrier)` is forgeable however carefully the
carrier itself is sealed, because the document calls the engine's own helper with
the engine's own carrier.

So selection uses neither. The body that owns a value is a plain object whose
reservation, selection and settlement are closures over state nothing else holds, and
it reaches the `<Return>` that reserves it as an ordinary parameter of expansion —
down the call stack, which document code cannot read or replace. Ownership is
explicit at every site rather than ambient: a component invocation passes none,
so an invoked body is isolated; caller projection passes the caller's, so
projected content still satisfies the declaration its author could see; and
dynamically scanned markdown and generated fragments pass none. Both settlement
sites read the body their own expansion created and held as a local. Importing
the module that defines one gains a document nothing — it gets a body of its own,
connected to no execution — so a value still crosses its declared schema on the
way out.

Selection is not a permission and not durable state: it appends no journal event, a
partial replay reconstructs it while completed effects replay, and a completed
document replay reuses the retained result without expanding the body. `<Return>`
does not end the body, so later documentation runs and a later failure,
cancellation or teardown failure keeps its existing precedence.

### Structural branch selection

`<Switch value>` and `<Case>` are the engine's own syntax, not components, so
core owns what they mean and no repository file, registration or bundle can
supply either name.

A switch decides its whole structure from source before it evaluates anything.
Which props were written, that every substantive direct child is a paired
`<Case>`, that each case carries exactly one of a matcher or the bare `default`
word, and that at most one default is written and written last — all of it is one
shared rule that expansion and non-executing validation read. A malformed branch
therefore stops the selector too, including a branch no comparison would have
reached.

Only then does selection run. The selector is evaluated once, each non-default
matcher at most once in source order, and the first `===` match wins. Operands
are arbitrary JavaScript values evaluated through the expression evaluator rather
than through prop resolution, so `undefined` stays `undefined`, `NaN` matches no
case including one written `NaN`, `0` and `-0` are one value, and two objects
match only when they are the same object. With no match and no default, the
switch renders nothing and reports nothing.

The selected case is transparent. It expands inline into the region that holds
the switch, opening no binding scope, no observation boundary, no error mode and
no loop boundary: a `<Let>` it creates stays available after `</Switch>`, a
`<Return>` reserves the value body that owns the switch, a `<Break>` exits the
loop that lexically encloses it, and an error inside it is observed exactly where
inline content would be. Fallthrough does not exist, because expansion enters one
child list once.

The selected `<Case>` contributes its own expansion frame even though the
`<Switch>` consumed it, so corresponding children of two branches cannot share
one identity. Neither construct is durable state: they append no journal event, a
partial replay rebuilds the selection through ordinary expansion while completed
effects in the chosen branch replay from their own records, and a completed
document replay reuses the retained result without expanding anything.

### Concurrent spawned children

`<All>` and `<Spawn>` are the engine's own syntax, not components, so core owns
what they mean and no repository file, registration, bundle or Plugin can supply
either name. `<All>` runs its direct `<Spawn>` children at the same time and
waits for all of them. It takes no props, produces no value, and requires at
least two spawns — one alone is the sequential document it was already written
as.

The whole structure is decided from source before a child is constructed: the
paired forms, the absent props, the two-spawn minimum, that only blank text sits
between the spawns, that no `<Spawn>` is written outside its direct `<All>`, and
that no `<Return>` or `<Break>` inside a spawn reaches for an owner outside it.
One shared rule states all of it, and expansion, non-executing validation and
the generated-fragment preflight read the same result — so a malformed construct
starts no child anywhere, including in a fragment an Agent generated.

**Concurrent expansion shares immutable inputs and nothing else.** Every child
gets a binding environment and live overlay snapshotted from the one that
reached the `<All>`, an eval scope of its own, a fresh block counter, a private
output buffer, its own checked-failure ledger, a copied hide set and an
expansion path extended by its authored ordinal. Nothing merges back, so a name
one child binds or rebinds is invisible to its siblings and to the work after
`</All>`, and a resource it retains is released when it ends. The outer
`<Return>` and `<Loop>` owners are cleared at the boundary; a loop or value
component created wholly inside a child establishes its own.

**Durable identity comes from the source, never from the schedule.** The
existing durable structured-concurrency substrate is the implementation: in
source order, before any child starts, each `<Spawn>` receives one child
coroutine of the one that reached the `<All>`, and nesting produces the existing
hierarchical identity. Effects inside a child keep their ordinary descriptions
under that coroutine, so two children may derive the same local block id without
colliding, and work after `</All>` continues on the parent counter it would have
had without any child. Each successful child closes with the ordered `{ text, exact }` runs it
rendered. Exact presentation is a provenance recorded against the segment
objects expansion marked, and those segments do not cross the join — so the runs
are what carries it, live and on replay alike, and a retained close that does
not read as that shape fails the run instead of rebuilding part of a document.

**Output is authored order; the journal is completion order.** A child emits
into its private buffer, and `<All>` appends the renderings to its caller's
region only after every child has succeeded. Which child finished first may
decide when its records append and never what the document renders. A complete
replay reads the child closes and runs no spawned work; a partial replay
restores the children that closed and resumes only the unrecorded ones under the
same identities. Inserting, removing or reordering spawns is a definition change
and takes the existing divergence path rather than being reassigned by position
or completion time.

**Failure is the existing fail-fast join.** The first child failure fails the
`<All>`, cancels every unfinished sibling and does not return until all of them
have finished tearing down. No private buffer is emitted, records acknowledged
before the failure stay durable, and interrupted work is never recorded as
complete. Cancelling the parent takes the same ownership path, and no task,
subscription, retained resource or buffer survives its spawn. No scheduler, no
new record family and no document-visible concurrency control is introduced.

## Errors, output and commands

A document decides recovery through its structure. Output routing, retained evidence and process failure remain separate decisions.

### Two layers

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

### Probabilistic behavior is visible in the structure

Every source of probabilistic behavior is visible in the document's structure
(`sample`, `exec`, `<Retry>`) — at the construct that applies it, not at the
code it affects. Everything else is deterministic: same inputs, same behavior.

Known exception, to close: eval can reach `Date`, `Math.random` and the
network directly.

### Error propagation

An error, once decided, is one of two things:

- **printed error** — printed into the document; data
- **failure** — propagates until middleware handles it or the document
  execution fails

#### 1. Middleware wraps the work

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

#### 1a. One element's expansion can be surrounded

`Component.expand` offers an observer the whole of one executable element's
expansion: before resolution and props validation, through the accepted body
and its owned cleanup, to the acceptance of what it produced. Core issues a
request and the public chain composes around it; a handler delegates that exact
request once with `next(request)`.

The authority is the shape bound execution already uses. The request is branded
with a private field, so a copy carrying the same members is not it; the request
is spent once, so a repeated delegation runs nothing; and the settlement is
readable whether or not the chain returned normally, so a handler that catches
what canonical expansion raised has not rescued it. A handler that returns
without delegating refuses the work, and what a handler returns is ignored.

Observation reaches no outcome. Phases carry `Result<void>` and nothing else —
what the element produced, what it bound and which error identity core is
holding stay private — and a failure is reported as a detached, frozen `Error`
preserving the selected name, message and explanatory causes. Completion is
published only after the whole dispatch, middleware cleanup included, has
unwound and canonical acceptance is reconciled.

Each subscription is registered with the element's latest phase and then told
each change in order, ending after exactly one terminal observation. A reader
that is slow, absent or cancelled delays nothing and cancels nothing: execution
never waits for an observer, and a consumer that must see the terminal phase
belongs to an owner outliving the dispatch rather than to the handler's frame.

Every path that expands something an author wrote crosses this once: the
component paths, and the structural constructs `<If>`, `<Each>`, `<Loop>`,
`<All>` and `<Switch>`, plus the selected `<Case>`, the `<Else>` that runs and
each `<Spawn>` an `<All>` starts. An unselected branch expands nothing and is
told nothing.

#### 1b. Where a text's elements are, without running it

`inspectSource(text, kind)` answers where each recognized element's delimiters
are and what it is called. It is the scanner's own reading, collected by the
same walk that decides what a fence, an inline code span, a quoted `>` and a
tag-like expression are, so there is no second grammar to disagree with the
first — and a nested collector is committed only with the parse that found it.

A document's body boundary is read lexically, matching the installed
extractor's envelope rule without calling its value parser, so inspecting a
document interprets neither its header nor its body. Definition parsing asserts
the two boundaries agree.

#### 2. Decide once

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

#### 3. Error mode is lexical

The nearest error mode in the scope tree governs an undecided error. A mode
is a context value, so it reads from the document's structure (see Two
layers).

| Mode | An undecided error… | Installed by |
| --- | --- | --- |
| `print` | is printed; the document execution continues | `<PrintErrors>`; `printErrors(fn)` |
| `output` | fails the document execution; `<PrintErrors>` can print instead | every text root; every `<Output>` region |
| `throw` | fails the document execution, even inside `<PrintErrors>` | documentation; value roots |

Printing is asked for. A text root installs `output` for its whole body, so an
uncaught, undecided failure is the run's own outcome whether or not the document
declares `<Output>`. `print` is the low-level default the context carries
outside root execution — where direct expansion and component-level harnesses
read it — and inside a run it is what a printing boundary establishes for its
region.

The mode's name decides nothing on its own. `<Output>` selects which regions render,
and it selects nothing at a root that declares none; root settlement decides
what an uncaught failure means. That the two share one internal mode says they
settle a failure the same way, not that `<Output>` owns the decision.

Projections carry the caller's error mode; they never set their own.

#### 4. `<PrintErrors>` prints a failure

The nearest `<PrintErrors>` or `printErrors(fn)` turns a propagating
failure into exactly one printed error whose `cause` is the complete original
failure, and sets `print` for its region. `printErrors(fn)` is keyed to the
exact function object — nothing is shared by name. Inside documentation a
failure still ends the document execution — a hidden region gives the author
nothing to read.

A component's declaration speaks for the component. `<PrintErrors>` is written
by the author of the region it encloses and decides everything written there;
`printErrors(fn)` is written by the author of one component and decides what
that component does, never what a caller wrote inside it. Content a caller
projects keeps the mode of the region it is written in (rule 3), and a failure
of it the component does not recover from passes outward wherever that region
does not print.

**Describing a failure is not owning it.** A component that could not use its
caller's content may still have something worth saying about what it therefore
did not do — a file that was not written. Saying it does not move the decision:
the region that decided the failure still settles it, and the component's
sentence travels as an account of that decision rather than in place of it.
Only a decision the region has not made is the component's to make, which is
why content that merely *printed* its errors leaves the component free to
refuse on its own terms. The distinction is carried explicitly by the failure a
component throws, never inferred from what a cause graph happens to contain: a
component that recovers and then fails on its own terms owns that failure,
however much of the content's wreckage is still reachable beneath it.

#### 5. Raise decides by value

An error that emerges from the middleware is raised where it stands. Raise
has exactly two outcomes, decided by the region's error mode: printed, or
failed. At raise, middleware observes only — it sees each error exactly once,
where it was raised, and changes nothing. Control at raise belongs to the
mode, never to middleware.

Nothing becomes a printed error or a failure without being raised: whoever
creates an `ErrorSegment` raises it.

#### 6. An error is never a value

A binding (`as=`, `<Let as>`, `<Each as>`) refuses a body holding
a printed error. Holding a failure as data is asked for explicitly:
`<Result as>` binds the Effection `Result` shape — `{ok: true, value}` with
the value by reference, or `{ok: false, error}` — converting the failure
before any raise. Private buffers never merge into document output.

A command's exit status is not an error until something decides it is one.
`exec as=` binds the settled process outcome — the status and both channels the
per-exec boundary received — so a nonzero status is ordinary data and there is
no error to raise, in any error mode. What never reaches a settled status is
unaffected: a process that could not start, a timeout, cancellation, a
durability failure and a Files infrastructure failure are each the failure they
already were, and bind nothing. Buffering both channels for that binding is a
document-owned buffer and not a retention decision; what a run keeps durably
stays the trusted host's.

#### 7. A blocker is not a failure

A workflow run waiting for input — auth, a human answer, days if needed — has
not failed. Suspension is a durable effect: the journal records up to the wait,
the process may terminate, and a later document execution arrives back at the
same wait. An error that reveals a blocker (an expired login) reaches suspension
through middleware; waiting itself is never raised.

#### 8. Durability and Files infrastructure failures are outside the model

A durability failure ([language §6.11](specs/executable-mdx-spec.md#resuming-from-a-partial-journal))
says the journal no longer describes the document
execution. No middleware sees it; it is never the document's own outcome. A
backing-journal append failure is the same kind of boundary failure: it
preserves the adapter error as its cause, resumes no consumer with an
unpersisted success, and never triggers a compensating `Close`. The first
durability failure is shared by the root and every durable child. From that
point, durable entry fails with that exact error before replay or execution,
and the ordered append boundary rechecks it immediately before storage. Work
already executing may finish. Concurrent work that began earlier cannot be
undone, but its not-yet-started append is fenced. An unmarked backing-stream
rejection is a persistence failure regardless of the error class the adapter
throws. A pre-persistence policy rejection remains the policy's ordinary
document failure; the guarded stream marks that boundary before the backing
append and does not activate the fail-stop state.

A Files infrastructure failure is outside the model on the same terms. A
missing provider, a refused operation, and a provider that broke its own
contract are none of them things the document did or can act on, and printing
one would let every step after the file work run as though the file work had
happened. No middleware converts one, and no printing boundary prints one.

Both are discovered through one cycle-safe traversal of the whole cause graph,
and precedence is decided by kind rather than by position: a durability failure
first, then a Files infrastructure failure, then a documentation failure. The
selected failure comes back by identity, because a fail-stop that records "the
first error" has to record the one that happened.

The two kinds are *recognized* by different mechanisms, and the difference is
deliberate. A durability failure is recognized exactly as it always has been —
by class, against the failure types durable-streams exports — and that is
unchanged. A **Files** infrastructure failure is recognized structurally: a
stable tag on frozen data, the fixed diagnostic for its kind, and no cause,
never `instanceof`. It has to be, because the Files boundary is the one a
separately loaded copy of a package reaches across, where `instanceof` answers
false. Recognizing one is also a decision to let that exact object travel
onward, so a candidate carrying anything else — a raw message, a cause chain,
an extra field — fails the contract and is replaced by a fresh invariant rather
than preserved.

The traversal reads values it did not create, so every read in it is total: a
thrown Proxy or a failing accessor narrows what discovery finds instead of
replacing the failure being classified.

### Component invocation settlement

A component invocation owns projected content, body resources and retained eval
resources. Teardown stops those three stages in that order and attempts every
stage even when one fails. A body failure without teardown failure propagates
its original error. Teardown failure alone produces one `InvocationTeardownError`
containing every failed stage; when both fail, an `AggregateError` retains the
initiating body error first and one `InvocationTeardownError` second.

Fatal classification still searches the complete cause graph in the order
[durability, Files infrastructure, documentation](#8-durability-and-files-infrastructure-failures-are-outside-the-model).
This nested component boundary is distinct from [whole-document execution
settlement](#capability-backed-execution), where an existing ordinary document
failure outranks ordinary root-scope teardown. [Plan candidate recovery](#typed-candidate-recovery-around-evaluate)
adds its own condition: cleanup must succeed before a refused request can become
another Agent turn.

### Attempts

- The journal records every attempt in full; replay restores the outcome
  without re-executing.
- Rendered output shows the winning attempt plus a brief summary of failed
  ones; verbose rendering expands the detail.
- On final failure, the last attempt's partial output renders, then the document
  execution fails.

### Partial output

- A failing region keeps what it rendered: everything rendered before the
  failure stays in the document and reaches the output stream, not only the
  journal.
- Only work the document was going to render can reach the output: a binding,
  a value, or documentation that fails never adds its content.

### Outcomes and the journal

- A document execution that fails is still a complete record: replaying it
  restores the output and the failure without re-executing anything. Only a
  durability failure means the journal no longer describes the document
  execution.
- Object identity never crosses the journal: a live document execution reports
  the failure it caught; a replay reports what the record describes. The
  journal is parsed, never trusted — an unreadable record is refused, not
  coerced.

### Foreground commands

An executable block is a foreground child process. Its output reaches the reader
as the child produces it, before it exits, and each byte is displayed once: what
was forwarded is never rendered into the document again at completion.

A command's output passes through several hands, and where a run observes it
decides what "the command's output" means:

```
child → enclosing host stdio middleware → the per-exec boundary → this
document's display policy → terminal
```

**Middleware enclosing an execution is treated as preprocessing.** The process
stdio chain is a documented extension point: middleware installed around an
execution may consume, transform, redact, or redirect a channel before the run
receives it, and a host that does so is exercising its own ownership of its
own child processes. What it forwards is what exists as far as the document is
concerned.

What a run retains is therefore what its **configured execution environment**
forwarded. `xmd run --journal` is diagnostic persistence: it records what that
environment forwarded, not what a child wrote to its pipe, which nothing here
observes and nothing here guarantees. A workflow's process results are durable
within the environment the workflow authorized. Middleware enclosing an
execution — the host's own, and anything the host composed into it — may
preprocess that output before either sees it.

*Current limitation.* `Process.join()` may settle before the pumps and their
`Stdio` middleware finish, so output a child writes as the pumps settle may
never reach the boundary and may therefore be absent from what a run retains.
effectionx #244 owns that, and until its solution is integrated nothing here
guarantees pump-complete tail delivery or retention.
So transformed text is what a run captures and journals, consumed output is
absent from both, and output an enclosing handler forwards on the other channel
is recorded as that other channel.

**The per-exec boundary is where a run observes.** One wrapper is installed
before `Process.exec` begins, so a chunk forwarded while the child is being
started is received like any other rather than raced for. The snapshot is taken
when the current `Process` operation settles, and that is as strong as the tail
guarantee gets today: `Process.join()` may settle before the stdout and stderr
pumps and their `Stdio` middleware have finished, so output written as the pumps
settle may never reach this boundary. effectionx #244 owns the stronger
guarantee. "Exactly what the command produced" means, throughout this
repository, *exactly the bytes received here* — never a guarantee about what the
child wrote to its pipe, which no execution observes, and never a guarantee of
pump-complete tail delivery.

**A run's own display policies are downstream and change nothing.** `silent`, a
`<Let as>` region's suppression of terminal stdout, quiet runtime output for
a caller whose subprocess output is an answer, the command line's choice of
which stream a value root's diagnostics land on, and the terminal writers all
sit below the boundary. They decide what a reader sees; they never decide what
the run keeps. Not showing something and not knowing it are different decisions.

#### Routing, retention and failure

Three questions about a command are separate, and answering one never answers
another:

- **Routing** is what a reader sees. An ordinary block forwards both channels;
  a `<Let as>` region takes stdout into the captured value and leaves
  stderr diagnostic; `silent` displays neither. Routing answers "does this
  channel reach the terminal, and does anything else want it" — never "which of
  the host's streams does it land on". It is visible in document structure,
  never selected by a root-level presentation declaration or by which runtime is
  executing.
- **Retention** is what the run keeps. The host path that starts a run states
  it; nothing infers it from which stream implementation a journal happens to
  use, or from whether a pathname was named. A run that keeps no diagnostic
  record keeps the exit status alone, and the transient path never accumulates
  the bytes on their way past — a command that writes a gigabyte costs a
  gigabyte of nothing. A run that retains keeps both received channels in
  addition to whatever routing the document chose, because a display policy does
  not weaken an explicit audit record.
- **Failure** is neither. A nonzero exit is a checked failure: a printing
  boundary may decide how it is reported, never that the run succeeded anyway.
  Later executable work does not start, and the run fails without any
  `<Output>` declaration. `<Output>` governs rendered document selection only.

#### Authored recovery and checked failures

Recovery is the one exception, and it has a single origin: an
explicit error-handling construct written in the document. Nothing else confers
it: not `printErrors(fn)`, not a built-in printing boundary like `<TempDir>`,
not ordinary printing mode, not component failure middleware, and not a
component catching the `ContentError` its projected content raised. Those decide
how a failure of their own is reported; whether a command that exited nonzero
failed the run is not theirs to decide. A run that suffered an unauthorized
checked failure records it in an execution-owned ledger passed by value through
core's own calls, so an enclosing boundary that prints and returns cannot make
the run succeed, and no later work in any frame begins. `<File>` and `<TempDir>`
are covered by that rule like any other printing boundary: their own cleanup and
their own report still happen, and neither writes, replaces, or continues.

`<PrintErrors>` *recovers*: a region that says the failures inside it are
printed and the document continues. It is the only thing that says it. A root
asks for nothing, so a root gets the failure.

One other construct *contains* a failure instead, which is a different thing.
An invocation of `<Test>` keeps its checked failures to itself: the failure
becomes that test's failed result, the run's own record stays clear, the tests
after it still run, and the testing completion policy is what fails the run.
Keeping them is the whole of it — a contained failure is not re-raised into the
region the element was written in, because handing it outward is exactly what
the containment exists to prevent.

#### Canonical test containment

Canonical core owns that construct. `<Test>` is one of core's registered
defaults, and containment is granted while core expands that definition and at
no other time. Nothing nominates it: not a function another package supplies,
not a component name or registration origin, not a context, marker or metadata,
not the options or the request, not an installation. There is no public API that
accepts a component and confers containment, so there is nothing for a handler
to replace, counterfeit, or hand to itself.

What core does not own is testing. Activation, isolated bindings, the timeout,
how a failure is classified, what is recorded and how it is reported are
`@executablemd/testing`'s, supplied through a contextual operation core calls
from inside the invocation. That surface accepts no function, component name or
container, and cannot make another component contain a failure: it says what a
test does, while canonical core says which element is one. Its name is stable,
so a testing package loaded beside a second copy of core reaches the copy
expanding the document without either comparing the other's private function.

Being a default is what makes the rule hold at the edges. A repository `Test`,
or a package that registers the name, is selected ahead of core's — so core's
definition was not expanded, and the definition that was receives the ordinary
disposition, whatever it is called and whoever registered it.

Recovery travels by execution-owned structure: the element hands it to the
expansion of its own body as an argument, and expansion carries it to everything
the region causes — the branches, iterations, captures and answers written
inside it, the bodies of the components its elements invoke, and the content
those invocations project back, which the document wrote inside the region. It
reaches nothing else: a sibling after the region closes, a later invocation, or
a root all start outside it. Ambient replaceable state never decides it. Contexts resolve by name, so a separately
created context with the same name is the same binding, and anything able to
name one could otherwise turn a failed run into a successful one from outside
the document — which is precisely the decision a document's own text is
supposed to hold.

#### Testing activation and completion

Testing is owned whole. Activating it means owning where results are collected,
when the last staged one is flushed, and what the run settles to — so the two
things that establish it are the two that own all three: a `useTesting()`
session for one root execution, and a `<Testing>` element for a lexical subtree.
Registering the components is not one of them.

The public `testing` boolean and the recording middleware around it remain
composable policy, and stay useful as policy: a handler may narrow testing to
false, observe a result, refuse, and wrap recording. They are not activation
activation, and neither is a stable contextual or Api name — a name is the
routing every loaded copy shares, and treating it as the authentication would let
anything able to spell it declare a complete boundary. What a `<Test>` requires
instead is a conjunction of a private one-use request, a private live boundary
credential, and the acceptance record of a terminal created for that one call:
the same request-and-terminal division *Authoritative behavior* describes,
scoped to the smaller boundary. It is scope-owned and expires with the session
or the element that established it, so a retained credential from a finished
boundary activates nothing.

Canonical core enforces it, and the placement is the point. What a test *does*
arrives through public middleware a handler may legitimately answer without
delegating — that is how a second loaded copy supplies behavior — so a
requirement asked inside that chain is a requirement a handler can skip by never
letting it be asked. The decision is therefore taken by the invocation itself,
before the harness is minted and before the behavior chain is dispatched,
through a seam the testing package installs its guard on. Core supplies no
policy there: it dispatches through a private per-invocation terminal and
refuses an invocation whose decision was never taken, so blocking that chain
refuses the test rather than admitting it. With nothing installed the terminal
is reached immediately, which is what keeps core-only use of the behavior
surface working.

Every refusal raised while that decision is being taken is a configuration
failure of the composition rather than a test outcome — activation unproved, a
handler on the seam refusing with an error of its own, or a chain answered
rather than delegated. No result is staged, journaled, recorded or reported, the
body causes no effect, and the ordinary component-failure path fails the
document.

The identity cannot be the error's type, because refusing by throwing is
supported and what a handler throws is its own. It is applied by position
instead: core marks whatever escapes the decision dispatch, keeping the message
it arrived with — the refuser's own sentence is usually the actionable one — and
carrying the original as `cause`, so the search that walks causes still finds a
fatal infrastructure failure underneath.

Containment is what makes the distinction load-bearing rather than tidy. A
contained test failure becomes a document failure only through a session's
completion policy, and a composition that never established one has no such
policy — so a refusal absorbed as a test outcome would leave a run that ran no
test reporting success.

Canonical expansion keeps a refused decision away from every failure handler
itself, rather than asking one to decline it. That is a loaded-copy consequence,
not a preference: the mark is private, so only the copy that applied it can see
it — and that copy is the one whose own `<Test>` was expanding. A package
composed against a second copy of core would answer "not a refusal" about a
wrapper it did not apply and hand it to a handler, which is exactly the
containment being prevented. So nothing outside that copy is asked, no predicate
crosses a package boundary, and the refusal travels on unchanged, after the
fatal search and before any handler is dispatched.

#### Output security and host retention

Retained output crosses the pre-persistence secret gate exactly as any other
journaled field does, and the gate examines what the boundary received — after
enclosing middleware, not before. Two consequences follow, and both are
intended: a host may redact a credential upstream so that the material never
reaches the gate at all, and a host that introduces credential-shaped text
upstream is refused by the gate like any other run that would persist one.
Output that is never retained is never scanned, because there is nothing to
persist and nothing was accumulated for a scanner to inspect.

Which host paths retain is a property of the path, stated where the run starts:
`xmd run` and `xmd test` retain when the caller asked for a diagnostic trace and
keep nothing otherwise; a workflow retains, because it owns its journal and a
resumed procedure reads its process results back rather than re-running the
commands that produced them; programmatic execution retains unless its trusted
caller selects transient execution. A shared runner never decides this from what
it was given.

A channel is the operation the boundary receives bytes on, and nothing below it
reclassifies anything: no path hands one channel's bytes to the other channel's
operation, so the received channel is never restated and never has to be
recovered from a byte payload, from contextual state, or from state held for a
run whose channels are forwarded concurrently. A value root's stdout carries its
JSON result, so the command line shows a command's stdout on the stream the
result leaves free — visible, never mistaken for the result, and still recorded
as stdout, because stdout is what reached the boundary.

Forwarding, completion, cancellation and teardown belong to the executable
block's own Effection scope. Cancelling the block stops the child and the tasks
forwarding its output before the block settles.

### Contextual run configuration

Nothing has a timeout by default. Three contextual values bound three different
things, and each has exactly one consumer:

- the **run deadline** bounds one whole `xmd run`, preparation and execution
  together, and only the outer run boundary reads it. Its expiry is
  cancellation, so structured teardown still runs;
- the **exec default** is what an exec block resolves and hands to the Process
  operation, and only exec blocks and the built-in `timeout` modifier read it;
  and
- the **Fetch default** is what a Fetch resolves when its caller named none —
  including `<Fetch>`, which resolves it when the element declares no `timeout`
  and retains the effective milliseconds as part of the request it recorded.

An absent value is no timeout rather than a number the runtime chose, and no
operation falls back to a value another operation owns — an exec block never
inherits the run deadline, and a Fetch never inherits the exec default. What a
document declares locally overrides only the default it names, for the region
that declared it. A per-call value always outranks a configured one.

Layers outside these three keep their own defaults where a subtree needs one:
an agent prompt inherits what its enclosing provider declared, through the
agent layer's own Api rather than through the run deadline.

Verbosity is a fourth contextual value in the same place, and it bounds
nothing. It says whether the scope reading it renders verbose-only content, it
is false until something says otherwise, and the command line seeds it for the
run from the `--verbose` it already resolved. `<Verbose>` reads it where the
element was written, so a component that installs a nearer value changes what
its own content renders and nothing else: the ancestors around it and the
siblings after it read the value that encloses them, restored by ordinary
Effection teardown whether the content finished, failed or was cancelled. A
value that is not a boolean fails where it is read, before the body it would
have decided expands.

What the command line prints is not this value. The journal file, the event
echo on stderr, the observational output of a value root, and the testing
report's own verbosity stay with the host that owns those streams and read the
flag directly — so a document can decide what it renders and cannot decide what
the process presents. Contextual verbosity decides nothing: it takes no
part in durable identity, authorization, replay admission, retained-effect
ownership or journal identity, and no execution is admitted, substituted or
settled differently because of it.

## Workflow state and lifecycle

Retained workflow state makes an execution addressable and replayable. Storage, executor ownership and effects each enforce their own boundary.

### Workflow runs

Core retains one document-execution entry point: `execute()`. A host that needs
workflow-run metadata passes an `ExecutionInstallation` to `executeInstalled()`
for the one document execution it is preparing. The run is created or
restored by that installation's preparation, which canonical core invokes
inside the durable root — so the journal is active before the workflow run
exists, and the run exists before any document policy observes it and before the
root document is imported.
A later document execution, including one that continues the same workflow
run, gets a new child scope and a new middleware installation. Workflow
metadata is durable; the middleware and every ongoing effect remain
scope-owned.

Installing the middleware alone creates no workflow run. On the first live
document execution, the first durable operation installed by the middleware
uses the host-authorized requested run ID or allocates one using cryptographic
randomness and durably records one value:

```ts
interface WorkflowRun {
  readonly runId: string;
  readonly bundleHash: string;
  readonly targetPath?: string;
}
```

The workflow run exists once that value is durably recorded. A document failure
or cancellation after that point does not erase it. Failure before that point
creates no workflow run and the root document does not expand.

`WorkflowRun` is one closed shape carrying `runId`, `bundleHash` and the exact
target when it has one. It has no base and no pinned commit: a run starts from
exact retained bytes rather than from a repository state, so a member naming one
would be a statement about a repository the run never had. It neither creates nor
seeds a Workspace Repository. Each `<Repository>` inside the definition resolves
and pins its own optional Repository base, so one workflow may compose
repositories unrelated to the definition repository or to one another.

Read-only Git questions go through the contextual Git capability, which the
workflow run itself never asks:

```ts
interface GitQueryApi {
  resolve(revision: string): Operation<string>;
}
```

`GitQuery.resolve(revision)` has the semantics of
`git rev-parse --verify --end-of-options <revision>` in the contextual working
directory. Its default provider invokes the Git CLI; another provider may
replace it lexically. It lives in `@executablemd/git` with the rest of the
capability, and the workflow package calls none of it. Ordinary `execute()`
remains Git-independent, and so does starting, resuming, forking or exporting a
run.

**The workflow package imports no Git feature, and a retained run reaches no
repository either.** The CLI establishes a candidate from filesystem bytes, and
the retained lifecycle re-derives the source from the run's own store, so a run
genuinely needs none: there is no definition whose Markdown lives anywhere but
in the run that retained it, and therefore no source capability for a host to
supply.

Replay restores the recorded `WorkflowRun` without allocating another run ID or
invoking Git. The supplied bundle hash must equal the recorded one.

A host that has already created the run's storage record passes
`retainedWorkflowInstallation(run)` instead, with the exact frozen value.
Nothing is left for the execution to decide: it records that value through the
same `workflow_run` durable operation, allocates no identifier and resolves no
base, and every journal state — live, truncated and completed — requires the
recorded run to agree with the supplied run ID, bundle hash and exact target.
The host input may carry additional bookkeeping: installation projects these
named fields into the closed journal value rather than making bookkeeping part
of run identity. A journal that disagrees is not this run's journal, and the
refusal names the fields rather than their values.

`getWorkflowRun()` returns the frozen `WorkflowRun` for the current document
execution. Every call in one live execution returns the same object. It throws
outside a document execution a workflow installation was passed to, and it
exposes no journal, Git, workspace or continuation capability. Replay preserves
the field values, not JavaScript object identity.

The `@executablemd/workflow` package owns `WorkflowRun`,
`retainedWorkflowInstallation()`, `getWorkflowRun()` and the generic run,
storage, replay and Workspace boundaries. It owns no Git: repository
composition, the Git capability, issue and pull-request contracts and the
Git-host engine are `@executablemd/git`'s, and that package imports Workflow's
published extension boundaries rather than the other way round. It depends on
`@executablemd/core`, `@executablemd/durable-streams` and
`@executablemd/runtime`; core never imports workflow or Git. `xmd workflow
start` and `xmd workflow resume` are the CLI lifecycle, and they resume through
the run storage below. Ordinary `xmd run` carries the bundled Git Plugin, so
the repository vocabulary is available there without an operator naming it.

Git publishes on three subpaths, and which one a consumer imports from says
what kind of thing it is reaching for. `@executablemd/git/api` is the only
route to the contextual Apis — `Repository`, `RepositoryContext`, `Git`,
`GitQuery`, `PullRequestAPI`, `IssueApi`, `IssueTrackerContext` and `GitHost`
— together with their named interfaces, the identity each was minted under,
the base refusal each falls back to, the direct operations and accessors
consumers call, and the types those interfaces are written in. Those are the
seams: a consumer reaches one to call an operation and replaces one to answer
it. The root publishes the Plugin and its profile predicate, the component
registrations and definitions, the workflow installation, the durable effect
identifiers, the errors and the record parsers — what was said, rather than
who answers. `@executablemd/git/deno` publishes the host adapters that
implement the seams, and `@executablemd/git/credential-helper` is the
standalone program Git spawns as itself. An Api is published from exactly one
of these, not re-exported from the others, because a seam reachable two ways
is two contracts.

**Each Api is named for the operations it answers, and every identity is under
one `executablemd.git` prefix.** A consumer writes the vocabulary of the thing
it is doing rather than of the machinery behind it:

| Api | Identity | Operations |
| --- | --- | --- |
| `Repository` | `executablemd.git.repository` | `select`, `worktree`, `ambient` |
| `RepositoryContext` | `executablemd.git.repository.current` | `current` |
| `Git` | `executablemd.git` | `switch`, `add`, `commit`, `push` |
| `GitQuery` | `executablemd.git.query` | `resolve`, `root`, `format`, `read` |
| `PullRequestAPI` | `executablemd.git.pull-request` | `read`, `upsert` |
| `IssueApi` | `executablemd.git.issue` | `read`, `upsert` |
| `IssueTrackerContext` | `executablemd.git.issue-tracker.current` | `current` |
| `GitHost` | `executablemd.git.host` | `route` |

`Git` and `GitQuery` are two seams and never one. `Git` performs the four
authored durable transitions a document writes as `<Git.Switch>`,
`<Git.Add>`, `<Git.Commit>` and `<Git.Push>`, and what lifecycle they have is
the installed provider's. `GitQuery` asks read-only questions of the checkout
containing the contextual working directory and mutates nothing, so replacing
it answers questions rather than becoming a route to a transition.

These names and identities are a break from `@executablemd/workflow@0.12.1`,
taken deliberately and without compatibility aliases. A provider compiled
against an old identity intercepts nothing, and an import of an old name does
not resolve: two vocabularies for one seam is the outcome an alias would
guarantee, and a silent miss is what an old identity would produce. The
package-internal names that still read `Composition` — the provider
installers, the error classes and the serialized refusal names retained
history holds — are not this layer and did not move.

### Workflow Workspace

The command selects the environment; the document describes the procedure.
`xmd run` uses the caller's current environment and makes no restoration
promise. `xmd workflow` creates a workflow run with one implicit root Workspace. The same declarative components use contextual
capabilities in both modes; the workflow host supplies the stronger durability
and permission boundary.

Workspace identity belongs to the workflow run. A document path locates an
immutable definition but does not identify a previous run. A host-generated or
caller-selected run ID addresses `start`, `resume`, `status`, `history`,
`cancel`, `fork` and `delete`. Reusing a caller-selected ID is idempotent only
when every immutable creation input agrees.

One workflow-run database is the physical retention boundary for logically
distinct data:

```text
WorkflowRun SQLite
├── filtered journal events and effect results
├── versioned filesystem roots and content
├── Repository and Worktree metadata
└── Agent-session mappings
```

Co-location does not turn arbitrary filesystem content into journal or training
data. The journal security policy filters a value before insertion. Training
ingestion deliberately selects retained filtered history; it never receives the
whole database merely because the database is retained.

Repository, filesystem, process, Git-host and Agent behavior reaches production
code through contextual APIs. A provider adapter installs host behavior; shared
modules neither detect a runtime nor fall back to the caller's host when a
workflow capability is absent.

### Workflow run storage

A workflow run recorded only in the journal of the document execution that
created it can be found only by whoever already holds that journal. Retained
storage is what makes a run addressable: another process opens it by public run
ID and continues from durable data.

Shared code reaches storage through a contextual Api that names no provider, so
the lifecycle stays host-neutral. The Deno host installs its own from a
runtime-named entrypoint, and that entrypoint is the only place SQLite, run-ID
hashing, filesystem paths and host filesystem behavior appear. No shared module
imports them or detects the active runtime. The absence of a provider is
reported rather than answered with an empty store: a run that appears to start
and retains nothing has not started.

A storage handle is a lease owned by the scope that opened it. Lease teardown
makes that handle unusable without closing the run's physical connection or
invalidating another handle. The Deno provider owns the authoritative
SQLite/DOFS connection for each canonical workflow-run database path and closes
it at provider-scope teardown after its child scopes finish. The public handle
contains no raw connection association; the provider owns an exact-object lease
registration and refuses foreign, fabricated, closed, or stale handles before
they can reach SQLite.

#### Identity is separate from retrieval

Identity is the run ID, the whole workflow definition, and the normalized props.
Values are compared canonically, so props differing only in key order are the
same props. The comparison covers the bundle hash, the entrypoint, the whole
canonical source manifest, the component mapping and the exact target. The
descriptor carries no version and no kind: one shape is the only shape, so there
is nothing to dispatch on.

Everything a run accumulates is excluded from that comparison: status, stop
reason, retrieval metadata, timestamps, document executions and journal
records. A completed run asked for again is found, not refused.

Creation is therefore also lookup. A request describing the stored run answers
with it; a request differing in any immutable field is a different run wearing
the same ID and is refused. That is what makes a caller-selected run ID usable
twice without a separate idempotency concept. A refusal names the fields that
differ and never the values behind them.

Where a definition can be fetched from is retrieval metadata, not identity, so
a run that moves between hosts is the same run.

#### Discovery has one source of truth

A run's location is derived from its run ID, so discovery is arithmetic and no
second registry exists that could disagree with what is stored. The storage
root and the location it produces are host arrangement rather than durable
identity, which is why the run ID is also stored inside the run and checked
against the one requested. Storage holding a different run than its location
implies is a collision or tampering: it is reported as its own condition and
left unchanged.

#### What a run retains

A run retains its immutable identity, one of six statuses — `running`,
`suspended`, `interrupted`, `completed`, `failed`, `cancelled` — a nullable
stop reason, replaceable retrieval metadata, one document-execution record per
start and per resume, and the filtered journal. Document-execution records are
not attempts: an attempt is one execution of a retried operation or region and
remains in the journal.

A stop reason is a categorical host code or a reference to an already-filtered
journal event. Arbitrary exception text is never duplicated outside the journal
that filtered it.

WorkflowRun schema version 1 is complete in place. It contains the run records,
filtered journal, pinned Cloudflare DOFS version-5 structure, immutable
Workspace-root tables, current-root state, a non-null Workspace-root
association on every journal event, and the Repository and Worktree creation
records #293 added to it. A fresh run starts with one
content-addressed root manifest describing only the root directory, empty
retained manifest and blob reference sets, and the corresponding root-only DOFS
frontier.

`workflow_run` has **no `base` column**, and two tables hold the run's own
source: content keyed by its SHA-256 with its byte length, and one manifest row
per descriptor entry mapping a logical path to that hash. Content is retained as
BLOB bytes rather than as text or re-encoded JSON, and two paths holding
identical bytes reference one blob.

A new run is written at `user_version = 1`, and initialization never upgrades an
existing database. Recognition reads the application ID first, then the schema
version, and holds the whole inventory to its one declaration. Version 0 under
that inventory is corruption, any other version is unsupported, and an altered
or extra object is corruption rather than a migration candidate — there is no
earlier shape for a file to be recognized as.

Before a record is exposed, its retained source is re-derived in full:
the manifest equals the descriptor's `sources`, every referenced blob exists,
both retained lengths equal the content's own, recomputing each blob's hash
produces its key, no blob is unreferenced, and recomputing the bundle hash from
the retained manifest and mapping produces `bundleHash`. No reader returns a
partial bundle, and nothing falls back to the original file or the provenance.

A Workspace root is a complete, immutable filesystem checkpoint. Its canonical
format-1 JSON includes `/` and every reachable absolute POSIX path in UTF-8 byte
order, with kind, mode, observable mtime, file size and DOFS manifest identity,
symbolic-link target, and deterministic file-hardlink groups. The root ID is
the lowercase SHA-256 of `xmd-workspace-root\0v1\0` followed by those exact
canonical bytes. Mutable inode numbers, revisions, tombstones and cache state
do not participate in the identity.

The root tables are authoritative checkpoints; the DOFS node, dirent and chunk
tables are the live materialization of the current root. Files remain solely in
DOFS content-addressed blobs. Normalized root-to-manifest and root-to-blob rows
equal the root's transitive content exactly and prevent retained content from
being deleted. Opening a run validates every root and referenced manifest and
blob, then snapshots the live frontier read-only and requires it to equal
`current_root`. The schema structure, retained content, live/current comparison
and run row are read through one explicit SQLite snapshot. This recognition
transaction is not a caller-owned Workspace transaction and enables no DOFS
savepoints.

Recognition also requires every file entry in every retained root, including a
historical root, to declare the size held by its referenced DOFS manifest. A
root whose XMD identity and reference rows are internally consistent but whose
file size disagrees with DOFS is corrupt and not restorable.

Which status transitions are legal, and what a caller may do to a run in each
of them, is lifecycle policy applied above storage.

#### The journal is stored, not re-encoded

Journal events reach storage already filtered, through the existing
pre-persistence gate. Storage adds no second filtering policy: a rejected or
cancelled gate leaves nothing behind. A record is retained in the
representation the protocol produced and parsed back through the matching
reader, so replay reads what was written rather than a re-encoding of it.
Events replay in append order. An event's opaque identity is retained
separately from its physical position; the position orders replay and is not a
public identifier.

#### One database at a time, and a transaction a caller can hold

Operations on one run's storage are serialized, and each runs inside a
transaction. The Deno provider's per-path entry owns the one physical SQLite
connection, the one Cloudflare DOFS wrapper and Workspace filesystem, the
cooperative connection queue, and the savepoint allocator. Turns belong to that
entry rather than to a handle, so two leases for one run take turns instead of
contending — a host whose storage is reached synchronously would otherwise stop
while a second handle waited for a transaction the first one cannot resume to
finish. Different workflow-run paths have independent entries.

Each entry has an opaque generation identity created with the physical
connection. Reopening the same path after provider teardown creates a different
generation. Each top-level transaction has its own opaque identity and exact
active record, including its path, generation, authorized lease and public
transaction handle. Finishing invalidates that record before commit or rollback
can expose the connection to later work. Retained transaction handles and
tokens stay invalid across a later transaction on the same connection and
across a later provider generation.

A caller that must publish several changes together holds the transaction
itself and receives a handle for taking part in it. Enlistment travels with
that handle rather than with the storage, so work that never received one
cannot join by accident: an unrelated append waits for its turn and commits on
its own rather than being rolled back with a failure it had nothing to do with.

A transaction commits only once the work inside it has finished, including work
that is still unwinding when the body returns. Cleanup belonging to that work
appends through the same transaction, and a commit that happened first would
leave those appends to publish themselves outside it. Failure and cancellation
roll back everything the transaction did. Adapter-private Workspace work also
waits for its supplied scope to finish teardown before it performs the final
live/current validation.

A transaction opened inside another on the same storage is refused rather than
nested, as is an ordinary operation called from inside a transaction body.
The active-path context chain only detects and refuses that accidental nesting;
it never authorizes transaction or savepoint use. Authorization comes from the
provider-owned identities behind an adapter-private contextual operation, which
validates exact handle possession each time.

One monotonically unique allocator serves both synchronous Cloudflare DOFS
savepoints and Effection operation savepoints. The operation form receives an
`Operation`, runs it in a child scope, waits for every child and resource to
finish teardown, and only then releases. Ordinary failure rolls back to and
releases that savepoint while leaving the outer transaction usable. Synchronous
cleanup rolls an open savepoint back on cancellation or halt. A failure to
create, roll back, or release poisons the active transaction, so its top-level
owner cannot commit it.

Serialization is not a single-executor policy. Which executor may advance a run
is decided above storage.

#### Damaged storage is described, never replaced

Storage is parsed, never trusted, and every condition a caller can act on
differently is reported as itself: absent, conflicting, holding another run,
not this kind of storage at all, a schema version this build does not
implement, damaged, holding a record that does not parse, asked for with a
value that describes nothing, or unable to transact. Collapsing them would
leave a host guessing whether to create, refuse, or report damage.

Recognizing storage means holding its structure to the one this build writes,
not reading the names of its parts. Storage whose own header reports a version
it is not shaped like is damage rather than a version this build has not
learned. Storage is initialized only when it is pristine: something that merely
looks unused is not.

Complete version 1 is the first XMD schema. A database carrying the XMD
application identity with schema version zero is a partial initialization and
therefore damage, not a supported historical version.

Records are held to what they mean and not only to the types they are stored
in. A retained timestamp is an instant, a retained identity is not empty, and
normalized props are an object.

Nothing initializes, migrates, truncates, deletes or replaces incompatible or
damaged storage, and a lookup that finds nothing creates nothing. Messages
describe what failed without repeating retained props or journal payloads —
including their member *names*, which can carry a credential as readily as a
member value can.

### The workflow lifecycle

`xmd workflow start [--id=<run-id>] [--props-*=…] <definition>` and
`xmd workflow resume <run-id>` are the two commands. Both run in the foreground,
stream the document's own output to standard output, and report identity and
outcome on standard error as two stable lines — `workflow run: <run-id>` once
the run has been created or found, and `workflow status: <status>` once the
execution settles. Only a completed run exits zero: failed exits 1, suspended 2,
cancelled 3 and interrupted 130, so shell automation cannot mistake an
incomplete workflow for a finished one. A request the command refuses — bad
grammar, a missing run, an incompatible reuse, damaged storage, an unsupported
host — exits 1.

`start` establishes an immutable definition from **the bytes the caller named**.
Its argument is a document reference — a path, optionally followed by `#` and one
target selector — so the reference is taken apart before anything is resolved as
a path. It reads the supplied file once, derives the logical entrypoint from that
file's own NFC-normalized final segment, decodes it strictly, parses it, resolves
any selector through core against those exact bytes to the one canonical target,
reads the declared bundle from the root's own directory, and builds and verifies
the source-bundle descriptor — all before storage exists.

**The bytes that execute are the bytes the file held**, so a file outside a
repository starts, an untracked file starts, and a file edited since its last
commit runs what it says. Where the file sat is never identity: the containing
directory, the absolute path and the invocation working directory are retrieval
facts. Git is optional provenance, recorded as replaceable metadata when it is
cheaply available; failing to obtain it cannot fail a start, and nothing reads it
back to find the source.

`resume` executes the closure the lifecycle authenticated from the run's own
store and never rereads the candidate path. A file that is unreadable, not
well-formed UTF-8, not Markdown, whose selector resolves to nothing, or that
declares a component this command cannot read fails explicitly and before
storage exists; none of them creates a replacement run or an empty definition. A
workflow definition is one closed set of retained bytes, so the component search
path is empty and a repository component fails to resolve rather than resolving
to content beside the definition in a mutable checkout.

A root may close itself over a **component bundle** by declaring one in its own
frontmatter — `workflow.components`, a non-empty mapping from a component name
to a relative POSIX Markdown path beside the root. `start` normalizes that
declaration against the root's own directory, reads every member from beside the
root as exact bytes, takes each source's own domain-separated content hash as
its source hash,
parses each component before the run exists, and stores the bundle on the
definition as a `components` array in canonical order — so each declared path is
both the logical path the run retains and the file this host happened to find it
at. A root that declares nothing writes no `components` member at all, which
means "closed over no components"; an explicitly empty declaration is refused
rather than becoming a second spelling of it. A declaration may not declare structural syntax, a component the
engine supplies, or a name the host reserved, and the refusal names a component
only once the name has passed the grammar a document writes.

The bundle is identity, so compatible reuse compares the whole array: a changed
name, canonical path, source hash, or component set conflicts as `definition`,
and a run closed over a bundle is never the same run as one closed over none.
`resume` obtains the bundle under the executor lock and before the lifecycle
advances. It re-derives the bundle from the run's own retained BLOBs,
recomputing every source hash and the bundle hash from the bytes it holds;
nothing is read from a repository or from the files the run was started beside.
A component that changed, went missing, or became unreachable leaves the run's
records exactly as they are.

The bundle is also canonical resolution. It reaches canonical core as plain
immutable data on the `ExecutionInstallation` that already carries the run's
admission and preparation, captured by value before any installation, middleware
or document code exists. Resolution places it between reserved registrations and
ordinary registered defaults, so core's own components stay available and no
name they own can be taken back. Every selected member records one
`import_component` result of exactly `{ kind: "workflow", path, sourceHash,
content }`, and the installation contributes a journal admission that holds every
retained component import to that exact bundle before public document policy or
the root import. While a bundle is installed, `Component.importComponent`
middleware may observe, delegate, and refuse an import but cannot answer one:
canonical core keeps its own copy of the definition it produced and invokes that
copy, then compares the returned answer against it by own property descriptor —
never by serialization — so a synthetic answer, a replacement, and a mutation
each fail before the component is invoked, including one masked by a `toJSON()`
or by an accessor that answers twice.

Every actual execution opens or creates the run's database, begins a
document-execution record, installs the exact retained WorkflowRun, installs the
service denial before the root is imported, and — for a live or partial
execution — installs the logical working directory `/`, the transaction-bound
Files provider and that database's Workspace effect coordinator. It executes
against the database's own journal with the retained props and secret detection,
then finishes the execution record and publishes the run's status. A completed
run still replays, so its retained output and result are emitted, but it
attaches no Workspace provider or coordinator and performs no filesystem
mutation.

A failure retains `failed` and uses a journal stop reason when a retained event
identifies it, and a categorical host code otherwise; no exception text is
retained beside the journal that filtered it. Graceful foreground interruption
finishes the execution `interrupted` and exits 130. `suspended` is resumable;
`failed` and `cancelled` are refused by `resume`, and `completed` replays under
either command.

The initial host is Deno-local. The Deno entrypoints — source and the compiled
binary — install the local run store, beneath `~/.xmd/runs` unless
`XMD_WORKFLOW_RUNS` names another absolute directory. Node and Bun expose the
same grammar and refuse before creating or executing anything. The shared CLI
module imports no SQLite, no DOFS and no runtime detection: it asks a host
adapter to open storage and to attach a run's Workspace, and the entrypoints
decide which adapter exists.

The start/resume slice predated single-executor enforcement. Issue #367
replaced its opportunistic orphan closure with the lifecycle ownership below,
and no supported host advances a retained run without it.

### Workflow lifecycle ownership

Storage serialization decides who uses one connection next. It does not decide
who may advance a workflow run. A workflow executor must acquire one executor
lock before stale recovery, a document-execution begin, Workspace attachment,
journal replay, root import or authored work.

The provider-neutral lifecycle API routes acquisition and management requests
to a host. Routing through a contextual Api selects a provider and grants no
permission. Acquisition gives the workflow executor an opaque exact
`ExecutorLock` object registered by that provider for one run and one
acquisition. The provider checks the same object, its open scope, its run and
the expected retained lifecycle state inside every mutating transaction. A run
ID, database handle, structural look-alike, same-named context value or retained
token is admitted nowhere. Releasing or tearing down the executor lock
invalidates that object before another acquisition can mutate the run.

The executor lock is not a time lease. It has no duration, expiry, renewal,
heartbeat, watcher, generation record or liveness poll. The operating system
releases the local lock when the workflow executor exits.

The shared surface names outcomes and retained data, not a transport:

```ts
interface ExecutorLock {
  readonly runId: string;
}

type ExecutorAcquisition =
  | { readonly kind: "acquired"; readonly lock: ExecutorLock }
  | { readonly kind: "already-running" };

interface WorkflowForkLineage {
  readonly sourceRunId: string;
  readonly checkpointEventId: string;
  readonly checkpointWorkspaceRootId: string;
}

interface WorkflowInspectionSnapshot {
  readonly record: WorkflowRunRecord;
  readonly executions: readonly DocumentExecutionRecord[];
  readonly journalFrontier?: {
    readonly eventId: string;
    readonly workspaceRootId: string;
  };
  readonly currentWorkspaceRootId: string;
  readonly lineage?: WorkflowForkLineage;
}

interface WorkflowLifecycleSnapshot extends WorkflowInspectionSnapshot {
  readonly retrieval?: DefinitionRetrieval;
}

interface WorkflowDeletion {
  readonly removed: readonly ("run-storage" | "provider-sessions")[];
}

interface XmdArtifactFrontier {
  readonly sourceRunId: string;
  readonly finalEventId?: string;
  readonly currentWorkspaceRootId: string;
}

interface WorkflowArtifactIdentity {
  readonly identity: string;
  readonly frontier: XmdArtifactFrontier;
}

interface WorkflowArtifactSnapshot extends WorkflowInspectionSnapshot {
  readonly artifact: WorkflowArtifactIdentity;
}

interface WorkflowArtifactHistory {
  readonly artifact: WorkflowArtifactIdentity;
  readonly entries: readonly WorkflowHistoryEntry[];
}

interface WorkflowLifecycleApi {
  acquireExecutor(runId: string): Operation<Result<ExecutorAcquisition>>;
  inspect(runId: string): Operation<Result<WorkflowLifecycleSnapshot>>;
  list(): Operation<Result<readonly WorkflowLifecycleSnapshot[]>>;
  history(runId: string): Operation<Result<readonly WorkflowHistoryEntry[]>>;
  inspectArtifact(path: string): Operation<Result<WorkflowArtifactSnapshot>>;
  historyArtifact(path: string): Operation<Result<WorkflowArtifactHistory>>;
  cancel(runId: string): Operation<Result<WorkflowRunRecord>>;
  delete(runId: string): Operation<Result<WorkflowDeletion>>;
  export(request: WorkflowExportRequest): Operation<Result<WorkflowExportResult>>;
}
```

The two artifact operations are siblings of the retained-run pair rather than a
widening of it. A run ID names live lifecycle ownership in this host's storage;
a path names immutable evidence somebody is holding, and no run has to exist for
it to answer.

`WorkflowInspectionSnapshot` is what a run says about itself, and both forms are
it. The retained snapshot alone adds `retrieval`, because where a definition
could be fetched from now is a fact about the machine holding the run rather
than about the run; the artifact snapshot alone adds which artifact answered and
the boundary it was sealed at. Neither extends the other. That is what makes an
artifact's exclusion of retrieval a property of the type rather than a habit of
one projection: there is no such member to set. The path is never part of a
result either, so two copies of one artifact answer identically.

The executor lock's public fields describe it and never validate it. Lifecycle
transitions accept the exact object separately from their data
through an adapter-private provider operation, just as Workspace transaction
ownership is validated behind its provider-neutral selection. Inspection,
cancellation and deletion return immutable parsed values and no database,
stream, transaction or connection capability. `WorkflowDeletion` lists
categories actually removed; it contains no statement about external effects.

Acquisition has three observable outcomes: acquired, already held by a live
workflow executor, or a storage/authorization failure. The initial local CLI
reports the active workflow executor rather than following it. Once acquired,
lifecycle changes are compare-and-set transitions against the retained state
and unfinished document-execution record read in the same transaction.
Beginning an execution, finishing its record and publishing the run state are
therefore lifecycle transitions, not independent writes another command can
observe between.
For a new `start`, the begin transition initializes pristine storage with the
immutable run, retrieval metadata, empty Workspace, first execution record and
`running` state in one transaction. For a resumable existing run, it validates
the requested lifecycle action and inserts one execution record while
publishing `running`. A replay of an already completed or failed root instead
inserts its execution record while preserving that terminal run state: the
replay observes an outcome that already won and does not make the run mutable
again. The settlement transition finishes the record while publishing its
terminal or resumable status. Begin and settlement are separate transactions
enclosing the document execution, and each is atomic within itself.

An unfinished document-execution record found after acquisition belonged to the
previous workflow executor and is proven stale. If the run says `running`, the
new workflow executor first reconciles retained root history. A root Close
restores its canonical terminal state. Without one, execution recovery closes
the execution and publishes `interrupted` before beginning another. A
cancellation command that
acquired the executor lock instead finishes that exact stale execution and
publishes `cancelled` without beginning another. If the run already carries a
terminal state preserved during replay, stale recovery closes only that
replay's execution as `interrupted` and leaves the authoritative run state
unchanged. It never guesses staleness from a PID, timestamp, timeout or status
row.

An execution settlement has one workflow executor and one winner. Canonical
completion, failure, suspension and foreground interruption meet at the
execution-owned settlement boundary. A retained root Close proves canonical completion or
failure won before interruption or later lifecycle management. A cancellation
command never enters this competition: while another workflow executor holds
the lock it can only refuse, and after that lock is released there is no live
document scope left for another process to halt. Durability and Files
infrastructure failures retain their existing precedence. The winning execution
transition waits for
the document execution's complete child and resource teardown, then atomically
finishes its document-execution record and publishes the run state. Only after
that transaction commits may the host report the status and release the
executor lock. If settlement storage refuses, no unretained status is reported
and lock teardown leaves the run recoverable by the next proven workflow
executor.

Teardown is part of settlement evidence, not work performed after the outcome.
If teardown raises, the host does not report `suspended`: the
execution settles `failed` with a filtered journal reason when one identifies
the failure and a categorical host reason otherwise. Durability and Files
infrastructure failures still cross by identity and win by kind; if their
lifecycle transition cannot persist, no terminal status is reported. Every
finalizer is attempted before any such result is observable.

Retained lifecycle state gates every later acquisition before canonical
execution. A `failed` run carrying its root Close replays that recorded failure
for compatible `start --id`. A host-settlement failure with no root Close
reports the retained `failed` state and its categorical or filtered reason
without entering replay. A `cancelled` run reports its retained state without
entering replay under either command. None can be advanced under the same run
ID.

The executor lock remains in the trusted host's outer lifecycle scope; it is not
installed as a document provider. A completed replay may hold
the lock while recording its document-execution envelope, while the run remains
`completed` and cancellation remains refused. Canonical core returns the
retained result before preparation or root expansion. It attaches no Workspace,
Files, Service, Agent, process or external provider and performs no live durable
effect.

#### Local executor lock

The Deno lifecycle adapter acquires a non-blocking exclusive advisory lock on a
deterministic sidecar beside the run database. The open file and its lock belong
to the workflow executor's scope. The operating system releases the lock when
that process dies, which is the stale-execution proof the next acquisition
uses. The sidecar path and empty file are host arrangement: neither takes part
in run identity, the database schema, the journal or history. The exact
in-process `ExecutorLock` registered by the adapter is the private capability
validated by every mutation; no descriptor publishes it and no second process
can address it.

The lock file may remain empty after run deletion. Unlinking a locked sidecar
would let another process create and lock a different file at the same path
while the deleting workflow executor still holds its lock. An empty lock file
is not retained run state and is not reported as history or provider-session
data.

#### Read-only lifecycle inspection

Inspection has its own provider-neutral immutable snapshot surface. It returns
run metadata, ordered history and current root identity rather than a writable
`WorkflowRunDatabase` or an executor lock. `status`, `list` and `history` use
only that surface. They never invoke canonical execution, read through replay,
attach a Workspace, materialize a root, import a document, contact an Agent,
process or external provider, or append.

Two sources answer the same questions. `inspect(runId)` and `history(runId)`
address this host's retained storage; `inspectArtifact(path)` and
`historyArtifact(path)` address one sealed `.xmd` file. They are siblings rather
than one operation over a union: a run id names live lifecycle ownership —
something a caller may still advance, cancel or delete — while a path names
immutable evidence that left the machine which produced it, and collapsing the
two would make that difference a detail of a parameter. The artifact operations
verify the whole container before answering with any of it, reach no run store,
lock, Workspace, definition reader or external provider, and project the same
snapshot and history values plus the artifact's identity and committed frontier.
The path never enters the answer, so two copies of one artifact answer
identically. History is shared: both sources run the same projection over
ordered rows — authored source, cumulative forkability, inherited provenance —
because two mappings are how history quietly starts meaning different things
depending on where it was read.

The Deno provider first reads each retained database through its ordinary
read-only connection. A host crash may leave a hot rollback journal: that is a
healthy database one SQLite rollback away from the last committed state, but
SQLite cannot perform that rollback through a read-only connection. Only the
exact `SQLITE_READONLY_ROLLBACK` condition enters recovered inspection. Another
read-only failure is reported as itself rather than treated as crash recovery.

Recovered inspection acquires inspection recovery coordination and retries the
retained database read-only. If a write-capable owner recovered it first, that
ordinary source snapshot is the answer. If it remains hot, inspection copies
the database and its rollback journal together into a private scratch directory
while it holds the coordination, then releases the retained source and lets
SQLite recover the copy. The copy keeps the candidate's exact database name and
passes through the same strict schema, retained-content, live/current and
location recognition as an ordinary snapshot. Recovery discards only the
uncommitted transaction, so the resulting recovered inspection snapshot is the
committed state the retained database describes rather than a repaired or
alternative run.

Every write-capable connection to a retained workflow database holds the same
coordination for as long as it is open. SQLite recovers a hot journal on
whichever read first needs a page, and for a connection a host already has that
read can come at any moment, from a caller that knows nothing about any of this.
A hold that ended once the connection was open would leave exactly that read
free to roll the journal back while an inspection was copying the database and
the journal, so the two would describe different states. A connection therefore
owns the pair from the moment it opens until it closes, and a cached lookup
takes nothing because the connection it answers with is already holding it.

One consequence is deliberate: inspection of a crashed run waits while this host
has a write-capable connection to it open. That connection is the pair's owner
and is the very thing that may recover it. Deleting a run closes its connection
before recognizing it, so recognition never waits for a connection only the
deletion itself would close.
The coordination is separate from the executor lock, produces no public
capability, authorizes no transition and cannot make an inspector appear to be
a workflow executor. Its deterministic empty sidecar occupies a provider-owned
non-candidate namespace and may remain after run deletion like the executor-lock
sidecar; it is host arrangement rather than retained state.

Scratch state is owner-private, belongs to the inspection scope and is processed
one candidate at a time. Every success, failure and cancellation attempts its
complete removal during teardown. A successful snapshot is observable only
after removal succeeds. A permanent removal failure instead returns a typed
inspection-recovery storage error after every cleanup attempt; it identifies the
host-selected scratch location so the operator can remove it and never repeats
retained content. Cancellation remains Effection control flow unless cleanup
itself fails. Private non-candidate scratch may therefore remain only behind an
explicit cleanup failure. Inspection never retries removal indefinitely, starts
background cleanup or reports successful inspection while such residue is
known.

Discovery remains arithmetic over the one run-storage root; there is no list
registry. Each run contributes one database candidate. Exact advisory-lock
sidecar names occupy a distinct provider-owned namespace and are not candidates.
The Deno provider applies the same strict schema, retained-content and
live/current recognition as execution to the direct or recovered snapshot.
One absent, foreign, incompatible, damaged or unparseable candidate fails the
whole list request with its distinct condition. Healthy rows are not returned
as though they were a complete list, and every candidate remains unchanged.

Every public history entry is one retained protocol row:

```ts
interface WorkflowHistoryEntry {
  readonly eventId: string;
  readonly event: DurableEvent;
  readonly workspaceRootId: string;
  readonly source?: Readonly<SourcePosition>;
}
```

History includes Yield and Close rows, trusted preparations and root events, in
append order. The Workspace root is read from that row's existing
`workspace_root_id`. An authored durable operation carries its normalized
optional source in the stable namespaced
`EffectDescription["executablemd.source-position"]` field before the complete
event crosses the existing secret gate. History parses that field into
`source`; a Close or trusted-host event may have none. Source is non-identity
event data and never a location reconstructed from an expansion ID, current
definition or Workspace. A present field that does not parse is an unreadable
history entry, never silently treated as absent, and no value it held is quoted.

The JSON projection is lossless: it returns every entry above with the complete
already-filtered protocol event. Human history presents each Yield as a durable
operation rather than repeating the protocol word `yield`. It renders the root
Close as the run's canonical outcome footer instead of an otherwise empty
operation row. When structured execution produces child Closes, it associates
their terminal results with those child coroutines so their ordering remains
visible. A suspended, interrupted or cancelled run with no root Close instead
states that no canonical document outcome was recorded. Presentation never
removes an event from the JSON contract or synthesizes a journal event.

#### Portable XMD artifacts

An XMD artifact is a semantic export, not a renamed workflow-run database. The
exporter reads one committed retained snapshot and writes a separate sealed
container containing that snapshot, every retained Workspace root and byte it
references, and the workflow definition source closure. Host paths, lock
sidecars, rollback journals, open connections, retrieval metadata, credentials
and provider-owned session directories do not cross the boundary. The initial
container encoding is SQLite, but its tables and SQLite schema are private; the
public compatibility boundary is the versioned XMD artifact contract.

The source run stays authoritative for itself and is never moved into the
artifact. Export takes the executor lock before choosing the artifact frontier,
so a live workflow executor makes export refuse and no later committed event can
race the chosen frontier. Crash recovery, when required, operates on a private
copy under inspection recovery coordination. Export performs no lifecycle
transition and never changes the retained source.

what one XMD artifact states about every logical workflow Agent session that contributed
a retained Prompt: either complete portable evidence — the session and its compatibility
attributes, the provider, the bundle kind and compatibility identifier, the source and
bundled provider-session identities, the identity-allocation mode, the ordered provider
checkpoint tokens, and the Agent session bundle's length, hash and bytes — or an
explicit unavailable marker naming why. A session that retained no Prompt has none. It
is detached retained evidence about a conversation, never a live provider session and
never control over the host that produced it

Version 1 has two profiles. One holds no Agent portability content and is read
exactly as it always was: a session that contributed a retained Prompt may carry
no classification, and nothing is reconstructed for it. The other classifies
every such session exactly once, as Agent session portability evidence —
portable, with ordered provider checkpoint tokens and an Agent session bundle,
or explicitly unavailable. Which profile a file holds is decided only after its
manifest and identity have been verified, so a descriptor is never interpreted
out of content nothing has authenticated, and partial or mixed evidence is
corruption that yields no projection. Recognition is what exists: no run
captures a bundle, the exporter emits no such evidence, intrinsic forkability
still reports `agent-state-unavailable` for an Agent turn, and status and
history render no classification, token or bundle byte.

Semantic format, container and manifest are each version 1. Identity uses the
exact domain `xmd-artifact\0v1\0`; every other declared version is refused.
The workflow source closure is retained entry/content pairs, without a Git
closure.

Every command that consumes an XMD artifact opens it read-only and verifies its
complete artifact manifest before returning any partial answer. That manifest
determines the XMD artifact identity. A bytewise digest of the finished file is
reported separately for transport verification; neither digest is a signature,
so authenticity still comes from the channel that published the artifact.

An artifact grants inspection and history-fork input only. It is never resumed,
answered, cancelled, deleted as a run, or admitted as the writable storage for
an existing run ID. A history fork from it creates a new run ID, copies retained
state rather than sharing pages, records the artifact identity with the source
run and checkpoint, and passes through the same compatibility replay and
forkability checks as a fork from local retained storage. The artifact remains
byte-identical before, during and after the fork.

This split is the concurrency boundary between environments. Arbitrarily many
hosts may inspect the same bytes or fork independently because none of them can
advance the source identity. No SQLite lock can coordinate downloaded copies,
and the design never asks one to.

#### Cancellation control

Cancellation never reaches into a live document execution. The initial local
workflow runs in the foreground, so the process that owns its Effection scope
also owns the only supported way to halt it: foreground interruption. When the
advisory lock reports a live workflow executor,
`workflow cancel <run-id>` refuses without mutation and tells the caller to
interrupt that foreground process.
Ctrl-C performs orderly scope teardown, publishes `interrupted` and leaves the
run resumable; it is not explicit cancellation.

Without a live workflow executor, the management host acquires the executor
lock before any cancellation mutation. The exact executor lock is validated
inside the transaction that publishes `cancelled`. A stale `running`
execution is first checked for a retained root Close: a Close restores its
canonical completed or failed outcome and cancellation refuses; without one,
the transition finishes that exact
unfinished execution as `cancelled`. A suspended or interrupted run has no live
execution to halt and becomes `cancelled` directly. Success is returned only
after the lifecycle transition commits. There is no watcher, poller, control
descriptor, cancellation-request sidecar, acknowledgement protocol or
cross-process cancellation channel in this slice.

Cancellation follows one status matrix:

- `running` with a live workflow executor: refuse without mutation and direct
  the caller to interrupt the foreground process;
- stale `running` with no root Close: acquire the executor lock, finish the
  unfinished execution and publish `cancelled`;
- `suspended` or `interrupted`: acquire the executor lock and publish
  `cancelled` without starting a document execution;
- `cancelled`: idempotent success;
- `completed` or `failed`: refuse because their terminal outcome already won;
  and
- absent, foreign, incompatible or damaged storage: report that condition and
  change nothing.

Deletion also acquires the executor lock. A live workflow executor is refused;
a stale `running` record is proven stale before the exact run's database and
provider-owned retained records are removed. Only the empty lock file may
remain. Every non-live status may be deleted. The explicit run ID is the
confirmation boundary, so the command has no interactive prompt and no
wildcard. An absent run is reported rather than treated as an idempotent
deletion. Deletion does not report that it undid an external effect.

### Durable suspension

Suspension is an authoritative document-execution outcome, separate from
completion, failure, interruption and cancellation. `@executablemd/workflow`
exposes a provider-neutral operation with this contract:

```ts
interface WorkflowSuspensionRequest {
  readonly request: Json;
  readonly responseSchema: JsonObject;
}

function suspendFor(request: WorkflowSuspensionRequest): Operation<Json>;
```

The request says what is awaited and the schema says what value can resume it.
The caller supplies neither a suspension ID nor lifecycle ownership. The
trusted execution derives one suspension ID from the run and durable coroutine
position, so a component or middleware reaches the same logical wait across
replay and a different logical wait cannot receive its input.

The operation first publishes an ordinary durable `suspension_request` Yield.
Its description contains the suspension ID, request and response schema. Its
successful Result means only that the request publication committed; it does
not establish that the wait or answer completed. The complete event crosses the
existing secret gate and receives the current Workspace-root association in the
same way as every other nonmutating event. The run's stop reason references
that already-filtered event by ID, so request text is never duplicated into
lifecycle state. No third protocol event and no pending-request table is added.

After live publication or replay of that Yield, the operation invokes an
execution-owned suspension controller through a stable contextual API. That
named route is what lets a component's separately loaded workflow package reach
the controller installed by the binary's bundled copy. It is composition, not
admission: middleware may refuse or suppress the route for its descendants, but
no value it returns is a suspension answer and it cannot make `suspendFor()`
continue past an unanswered wait.

The shipped caller is the Elicitation provider the workflow host installs, so a
document asks for a durable wait by writing the `<Elicit>` it would write
anywhere. Two consequences follow from where that call has to sit. A workflow
run resolves `Elicit` to a registration of the host's own, which asks the
question and writes no durable record: the wait must be the outermost durable
operation at its position, because a request published inside an enclosing
durable operation takes the journal slot that operation never settles, and the
resumed execution replays the coroutine and finds the wrong entry waiting. And
the answer is therefore retained once, by the suspension protocol, rather than
twice. Public Elicitation middleware — an `<Answers>` region, or anything else
installed nearer — may answer the question or refuse it, and in both cases the
run it affected never suspended; continuation of a suspended run is retained
delivery state and nothing else.

The retained request at the execution's exact current durable position is what
authorizes entry. The controller derives the identifier for the position
immediately behind the caller's own, requires the presented one to equal it,
reads the Yield at that exact position, parses it as a suspension request and
requires it to describe what is presented. An identifier from a request earlier
or later in the journal, a reconstructed contextual API name, or a matching row
without the exact current position authorizes nothing.

Durable replay identity compares a type and a name, both public, so another
durable operation can reproduce the retained request and arrive at the same
position. Once the controller has validated the exact retained request, that
operation is observationally the same request to wait: it gains nothing
that calling `suspendFor()` with that request would not have. Package-instance
identity therefore does not take part in admitting a suspension. Requiring it
would make the public operation fail when the binary and a repository component
load separate copies of `@executablemd/workflow`.

With no delivered input, the controller reports the request to the workflow
executor and remains pending while that executor initiates an orderly halt.
`suspendFor()` also accepts no returned value as an answer in this state, so a
middleware handler that suppresses the controller can only leave its descendant
pending, as document code can already do; it cannot publish `suspended`, supply
an answer or continue past the wait. The operation throws no ordinary error and
produces no value; the halt leaves the root without a Close. The executor
observes the validated suspension notice as its separate settlement candidate,
waits for complete scope teardown, then atomically finishes the
document-execution record and publishes `suspended` before releasing the
executor lock.

A root without Close is valid partial history. On resume, earlier durable
effects and the request-publication Yield restore without executing or
appending. Ephemeral structure is rebuilt only as the definition reaches it;
provider attachments stay lazy, and a provider is never contacted for a
replayed effect. At the same suspension ID, absent input reports the same
notice, halts again and adds no second request event. The new document-execution
record may settle `suspended`; the request remains singular.

#### Typed answer delivery

Issue #300 builds typed answer delivery. Its boundary is the suspension ID and
the retained response schema. Delivery is an operation separate from execution:
`xmd workflow answer <run-id> <suspension-id> <json>` retains one value for that
exact wait and takes no executor lock, fetches no definition, attaches no
Workspace, inserts no document-execution record, appends no journal event and
changes no run status. A host offers a value only after the run is `suspended`,
its stop reason names a retained `suspension_request` event carrying that ID,
and the value satisfies the schema that request retained. The retained state and
the answer event it would become cross the same secret gate durable journal
persistence uses; `--no-secret-detection` disables that gate for one delivery.
Every refusal — duplicate, consumed, wrong run, wrong request, late, invalid,
cancelled-run and deleted-run — leaves the database unchanged, and neither the
rejected value nor a secret match appears in a diagnostic.

On a resumed execution, only authenticated retained answer state lets
`suspendFor()` publish a separate ordinary durable `suspension_answer` Yield and
return its value; a contextual handler's return value never publishes an answer.
Consuming the retained answer and appending that Yield are one database
transaction, so a crash before it commits leaves the answer pending and a
transaction that does not commit publishes nothing. Replay after that
transaction commits restores the recorded answer event without reaching the live
controller and without consuming or publishing again.

Scheduling — automatic resume, watchers, unattended iteration and remote host
selection — is #300's and is not part of this behavior. Nothing here waits on
it: a suspended run continues through `xmd workflow answer` followed by an
explicit `xmd workflow resume`.

This contract folds issue #322's suspension effect into #367. Issue #322 no
longer supplies a separate implementation prerequisite; its typed correlated
answer delivery remains with #300.

Issue #367 changes no durable schema shape. Single-executor enforcement uses only the
provider-owned advisory-lock sidecar, suspension uses existing filtered journal
and run-state records, and history reads the existing event-to-root association.
Issue #300's retained answer state does add a durable record, and it amends the
one schema in place on the same terms as every other amendment: one
`workflow_suspension_answers` table, no second version, no migration, and strict
recognition refusing every other shape.

Issue #293 amended that exact shape in place rather than introducing a second
version, and Repository and Worktree creation records joined it the same way.
This pre-release carries no persistence compatibility obligation: there is one
inventory, no migration and no upgrade path, so a database an earlier
development build produced is refused as damage rather than recognized as an
earlier shape. Strict recognition compares the amended declaration exactly.

A Repository record holds a Workspace-local name, the admitted credential-free
locator and its fingerprint, the requested base or its absence, the commit
pinned once at creation, the initial primary branch, the object format and a
stable Workspace-relative checkout path. A Worktree record holds its
Repository's name, its own name, the requested branch, the requested base or
its absence, the creation commit and its checkout path. Both are immutable
creation identity. Current HEAD, refs, index, checkout and linked-worktree
administration live in the versioned Workspace filesystem, so one selected
Workspace root recovers the Git state belonging to that frontier without any
unversioned "current commit" column to disagree with it. The locator is stored
beside the record rather than inside it: compatibility needs the bytes, while
the journal and the document receive only the fingerprint.

### Replay and effect transactions

Replay rehydrates the Effection tree. A completed durable effect restores its
recorded result without executing again. Ephemeral operations run again only to
rebuild live structure: attach the Workspace, enter lexical working-directory
scopes, attach providers and reattach an Agent provider only when live work needs one. A completed root
result returns without attaching any provider.

The Workspace stores the current frontier state. The journal stores the
historical execution that reached it. Replay never asks current state to prove a
past effect: a file written and later deleted is absent at the frontier, while
both completed effects still restore in order.

#### Live effect coordination

Structured durable operations accept an explicit provider-neutral live
coordinator. The default coordinator executes once, converts execution success
or failure to the existing durable protocol `Result`, calls the existing Yield
publication continuation once, and returns that same result only after
publication completes. The continuation publishes through the durable stream's
ordered append fence. A backing append failure activates fail-stop state and
raises `DurablePersistenceError` with the adapter error as its cause; it writes
no compensating `Close`, and catching it cannot admit later durable work. A
marked pre-persistence policy rejection remains an ordinary policy failure.
There is no generic durable validation hook: validation owned by a caller or
provider occurs before it constructs the durable effect. Replay, including the
replayed prefix of a partial run, bypasses the coordinator, execution and live
publication. Callback-based durable effects keep their existing path.

The shared Workspace durable-operation wrapper reads a contextual provider
selection explicitly. That replaceable API carries only a non-operational
selection identity: execution, publication, failure activation and journal
provenance never pass through that middleware. Provider selection
creates a one-use route and a separate opaque credential. The live call keeps
that credential out of its contextual invocation request and places the exact
executor, publisher and failure activator behind an execution-owned capability
that accepts only the credential. A provider installed by any loaded package
copy terminally consumes the route and invokes that capability directly. It
does not send inspection, execution, publication, failure or completion through
the contextual continuation. Enclosing middleware at either priority can
therefore route or refuse the initial request but cannot observe or acknowledge
an operational phase. No module registry or replaceable structural value
resolves provider or invocation ownership.

The execution-owned capability accepts execution and publication once and
records the exact `Result` only after the provider returns it from the completed
publication. The live operation ignores the contextual call's response as
completion evidence and resumes from that recorded result alone. A short
circuit or altered response therefore activates fail-stop before resume, while
an exception or substituted response after authoritative completion cannot
replace the published result. Foreign or substituted selectors and reused,
completed or stale calls fail before transaction work. Installing no provider
cannot leak execution or publication, and selecting Workspace coordination for
one operation does not enlist unrelated durable operations in the same scope.

The Deno adapter establishes the canonical module's journal provenance for each
WorkflowRun journal and retains that exact witness. The generic pre-persistence
guard is policy-neutral and returns an unproven wrapper; the trusted
secret-filter and execution-owned admission wrapping sites preserve provenance
explicitly, so a filtered journal — including one wrapped more than once — still
carries the witness its source carried. Before it opens a transaction, the adapter requires both the
exact proof executor and the journal provenance from the consumed invocation to
belong to the selected WorkflowRun. An in-memory stream, another run's journal,
a copied property, an ordinary guard, a custom look-alike, or a wrapper another
loaded copy tried to prove is refused before mutation or publication.
Inside the transaction, the provider's publication operation calls the
execution-owned publisher directly and returns only after that publisher records
the exact Result. The transaction body cannot return or commit on a contextual
publication acknowledgement.

#### Workspace-local transactions

Every Workspace-local expansion publishes one effect through one effect
transaction:

```text
BEGIN
  apply the filesystem, Git or metadata mutation
  publish the resulting logical Workspace root
  append the filtered journal result
COMMIT
```

All three changes commit or none does. Nested effects finish their transactions
before their parent's effect begins. Declarative Git operations, including
staging, switching and committing, operate on the same transactional Workspace
rather than invoking an untracked native Git side effect.

Successful effect coordination finishes the mutation scope, including child
cleanup, before capturing the resulting root. The Deno provider installs that
ordering for its Workspace effect operation: the mutation
savepoint, root publication, filtered routed Yield, and caller-owned transaction
commit form one boundary. The Workspace filesystem uses the pinned synchronous DOFS
entry points for its string and byte-array surface, so cancellation leaves no
eager promise or stream pull able to reach the connection after transaction
ownership ends. The transaction-bound Files provider selects that operation for
every document filesystem read, write and search, and the workflow lifecycle
commands install that provider.

#### External effects and Git-host mutations

An external provider cannot join that transaction. Prompt, Git push and pull
request effects derive a stable identity from the run and expansion, ask the
provider to perform or reconcile that identity, then append one local result
transaction. Replay adopts proven compatible completion, performs a proven
absence and refuses conflicting or permanently ambiguous state. Temporary
provider unavailability may be retried or suspended by explicit middleware; it
never authorizes a duplicate effect while completion is unknown.

Git-host mutations — Git push and pull-request upsert — share one
provider-neutral reconciliation of that boundary, so a new Git-host effect kind
supplies a request and a provider rather than a replay policy of its own. Prompt
is not one of them: it keeps its own Agent-provider contract. A live Git-host
attempt observes before it mutates, adopts a proven compatible completion,
performs a proven absence exactly once, and refuses conflict and permanent
ambiguity. A Git host need not implement every kind; one that does not refuses
from observation, before any remote work.

Reconciliation is reached through exactly one stable contextual operation, and
that is a deliberate correction rather than a simplification. An earlier design
selected a provider on one surface and coordinated the invocation on a second;
public middleware could read a credential from the first, take an invocation
capability from the second, and answer a phase itself, and the journal then
retained a completion no provider had produced. Two public surfaces that are
individually harmless composed into the power to settle a completion.

The single operation is request-only. Public middleware receives one frozen,
one-use routing request describing the complete detached request; it may read
it, refuse it, install narrower policy, or delegate it, and the value it returns
is ignored. It receives no credential, no capability, no answer operation and no
phase evidence, so there is nothing to combine. Each phase builds its own API
descriptor under that same stable name: sharing the name shares the middleware
chain, while owning the descriptor owns the default, and that default is the
invocation's own terminal. The selected provider's handler is installed at the
terminal end of the chain, so its continuation — a parameter of its own
generator — is the only route to that terminal. Through it the handler asks the
terminal to inspect the exact request, calls the provider, and submits the
answer. A handler that short-circuits, forges a return, substitutes or replays
the request, or reconstructs the stable name reaches the provider's handler or
the public refusing default, never the terminal.

The durable operation is named by a fingerprint of the complete detached
request, so a changed kind, input or natural key diverges rather than consuming
the result retained at the same position, and the provider's answer is parsed at
the terminal before the durable executor returns, so a raw payload becomes a
fixed protocol failure rather than journal content.

Some effects need live local state the frozen request cannot describe, and that
travels as an object-source attachment rather than as an input. A push needs the
Git objects its commit is made of and the destination it may reach; both are
built by the trusted host for one reconciliation, authenticated against the
retained identity they belong to, and held in the selected provider's closure.
Nothing about an attachment reaches the durable request, the natural key or the
routing surface, so what discriminates the effect stays the filtered identity a
journal may hold while what performs it stays where no replaceable code can
address it.

What an attachment grants access to is authenticated separately from where it
came from, because local state can name further local state: a Git object
database names further ones through its alternates chain, and a symbolic link
under it redirects a read before Git reports anything about it. Such a graph is
read in the consuming tool's own grammar rather than as text: Git unquotes a
C-style quoted alternates entry before resolving it, so a containment proof that
compared spellings could be satisfied by a decoy of that literal name while the
traversal went elsewhere. The graph a
provider could traverse is therefore proven contained on the live provider's
first use of the attachment — before any external observation, and on no other
path, so a completed replay reaches no provider and performs no such proof. A
graph that leaves what the run authenticated is a boundary failure: it publishes
no outcome, repeats no authored path, and activates fail-stop. It is rejected
rather than repaired, because editing authored state to make it acceptable would
publish from state the run wrote on the author's behalf.

That same contained source is what decides whether a branch may advance. A
destination naming another commit is not by itself somebody else's work: a
supervised run publishes one branch repeatedly, and the ordinary case is a
remote tip the commit being published was built on top of. So ancestry is proved
where the objects already are — inside the authenticated source, out of the
commits it already holds, by one local question whose only answers are ancestry
and divergence. A proven ancestor other than the commit being published is a
performable pre-state, published over by the same exact non-force refspec a
proven absence gets; an equal destination is adopted with nothing performed, and
is never an attested advance, because a commit is its own ancestor and observing
the destination at exactly this commit is what adoption is; and compatibility
that was not proved — a divergent commit, or one the source does not hold — is a
conflict. Nothing is
fetched to prove it, because an object retrieved to answer the question would be
evidence the question created, and a proof that reaches neither of its two
answers is infrastructure rather than a finding about the remote. The relation,
not the traversal that found it, is what the record keeps.

The Workspace transaction such an effect opens is read-only and is
closed before the host is observed: no transaction is held across the
Workspace and the external service, and reconciliation rather than a distributed
transaction is what makes an interrupted attempt reach the host once.

A provider that needs a program must also not inherit configuration the run
merely stores. A checkout's `.git/config` is retained document data, and several
ordinary settings in one name a destination or a program — a push URL, a URL
rewrite, a hook, a credential helper, an SSH command, a signing program. The
Deno push provider therefore runs its transport in a disposable repository of
its own that reads the selected checkout's object database through a read-only
alternate, and aims it at the exact private retained locator rather than at a
configured remote. The two settings that would otherwise choose how a remote
operation authenticates — `credential.helper` and `core.sshCommand` — are fixed
on the command line, where they outrank every configuration file, for every
invocation that transports to a remote.

#### Invocation-owned authentication

Authentication itself is the one live host input such an invocation borrows, and
it is not the same question as inherited configuration. Retained state says
which repository an effect belongs to; it must never say who the run is, because
an identity belongs to the machine a run is standing on and a run resumed
elsewhere authenticates as whoever is there then. So one live provider
invocation — a Repository creation, a Push reconciliation, a pull-request or
Issue call — opens one authentication session lazily, for its own exact retained
locator, after the admission checks that operation requires. Every native
command that invocation runs attaches that same session, so an observation and
the mutation it decided go out under one identity rather than two, and the
session is disposed with the invocation. A later attempt on an interrupted
request opens its own.

The initial GitHub PullRequest adapter obtains its live credential from
`GH_TOKEN`, then `GITHUB_TOKEN`, then the host's `gh` login.

The trusted Deno host adapter retains one HTTP credential in memory for one live
provider invocation and exposes it only to that invocation's own Git and helper
children, through private child-process environment. A provider-owned helper is
what Git runs, and it answers one exact locator, so a redirected transport
receives nothing and fails closed — and the transport declines to follow a
redirect at all, since Git would otherwise carry a credential it already holds
to a destination this run never authorized. `store` and `approve` reach no ambient helper
or store; `erase` for the exact locator writes a fixed, nonsecret marker, which
is how a refused identity is told from an absent one. Both are authentication
unavailability, never an invalid locator. The containment is only worth what the surface around it allows: a substituted
Git host sees every invocation, and an authenticated one carries the attachment
the credential travels in. So the published Deno entrypoint offers a Workspace
attachment that accepts what a host owns and nothing that could observe or
become that host; the broad options stay inside the package.

Infrastructure is only what the adapter
watched fail: starting acquisition, installing the launcher, reading the marker
for any reason but its absence, and removing what it made. The absence of a
signal from the helper proves nothing — there is no readiness, preflight or
channel to it — so an acquired credential with no rejection keeps the ordinary
transport classification rather than acquiring a new one.

A session opened for one locator never authorizes another, nothing about one is
retained, and a completed replay opens none at all because it performs no remote
operation to attach one to. A missing or rejected credential is ordinary live
refusal: it proves no absence and adopts no completion, and a transport that
carries an identity attempted with no mechanism to prove one is refused under
its own word rather than as a locator that names nothing.

Only an answer the terminal accepted decides the effect. A conflict, a permanent
ambiguity and a temporary unavailability so accepted publish the effect's failed
result and replay as the same fixed local failure, rebuilt from its closed name
rather than recognized by identity across loaded copies. Everything else that
can raise before an answer is accepted — routing middleware, the provider
handler, the provider's own body, an unsupported effect kind — publishes nothing
and activates fail-stop under one fixed cause-free failure that repeats none of
what was raised. The attempt decides which of the two it has by the identity of
the failure it authored itself, never by a name or a class received from
replaceable code: otherwise a handler could retire an effect as conflicted
without a Git host ever being asked. Fail-stop rather than a bare refusal,
because a live operation that appended nothing would leave the next one to
append at its position.

#### Issue effects

An authored PullRequest `number`, when present, is a positive integer. Its
[feature contract](specs/workflow-workspace-spec.md#75-pull-request) owns the
remaining props, result and publication-evidence refusals.

An Issue read returns `{ url, title, description, tags, assignee }`; an upsert
returns exactly `{ url }`. These are the [closed feature results](specs/workflow-workspace-spec.md#103-issue-effects),
not Git-host reconciliation records.

Issue creation is a separate boundary, and not that one. Everything above is the
Git-host contract: a shared state machine, one request-only surface, phases, and
a private terminal that is the only thing able to author an outcome. `<Issue>`
has none of it, and none of it is missing.

An Issue provider does not necessarily own a Git repository — Atlassian issue
tracking owns none — so an Atlassian issue could not truthfully execute or
persist as a Git-host effect. `<Issue>` therefore reaches its own stable
contextual operation, `executablemd.git.issue`, whose members are
`read(url, options)` and `upsert(issue, options)`, and journals its own durable
effect type, `issue_effect`. What is Issue-owned, and therefore an Issue
compatibility boundary, is that API name, the two normalized requests, the
idempotency key an upsert derives, the results and the effect type.

The difference is not only which name is called. A Git-host provider is selected
by the reconciliation and answers through a terminal it cannot address directly,
because the state machine is shared and the journal may hold only what that
terminal accepted. An Issue provider is ordinary middleware: it composes
`IssueApi.around(...)`, reads the request it was handed, and either handles it or
delegates it untouched. It answers that question independently for each member,
so recognizing a read is not recognizing an upsert. There is no registry, no
resolver, no host-side URL resolution, no phase protocol and no terminal. What would have been the state machine's job is
the middleware's instead, because knowing whether an issue already exists is
knowledge about one service rather than about external effects in general, and a
shared machine would have to be told it by every adapter that disagreed.

So the Issue boundary keeps little for itself: it derives an idempotency key
from the canonical target and the run's own effect identity, wraps one call
durably, validates that what came back is a URL and nothing else, and retains
it. Replay answers from the journal without calling the operation at all. What
it does not promise is that the service was touched once — observing before
mutating, adopting a compatible issue, creating once, recovering an interrupted
creation and refusing conflict and ambiguity all belong to the middleware, and
the key is what this side hands over so the middleware can make it true.

An IssueTracker URL is canonicalized before use. Credentials, a query and a
fragment are refused rather than stripped, so normalization cannot silently
turn the authored target into another request.

Which external system an issue is requested in is lexical context, and whether
that target is authorized is the provider's. The nearest tracker supplies a
canonical target URL and an optional provider discriminator; the adapter-private
ceiling installed beside the credential decides whether that target may be
reached at all. A tracker narrows within the ceiling and can never widen it,
which is what keeps a replaceable context from being a grant.

Without a discriminator each provider matches its own URLs; with one, only the
provider of that name may act, which is how a self-hosted deployment is
addressed. Once middleware matches it owns the answer: it never delegates
afterwards, and nothing catches its refusal to try somebody else, because a
search is how a document that named one service quietly reaches another. A
destination every provider delegated reaches the operation's own base error.

Every committed journal event references the current logical Workspace root.
Only committed event boundaries are checkpoints. A history fork copies the
selected root and the roots the inherited prefix names into the new run, replays
the inherited prefix under a compatible modified definition and appends new
history under a new run ID. It never rewinds external branches, pushes, pull
requests or provider state.

#### Git-host evidence reads

A Git-host evidence read addresses one canonical pull-request URL, without
inferring a Repository. It returns a bounded collection only after every page
has been read and parsed; transport, pagination and shape failures never become
an empty or partial array. The provider may authenticate its request, and the
host's read ceiling is checked before opening that authentication session.

Reading what a Git host holds is not reconciling what it owns. A reconciliation
exists to mutate a remote at most once across interruption, and everything it
carries — the natural key, the pre-state, the observe-then-perform pair — is
there to decide whether an attempt already landed. A read decides nothing of the
kind: repeating it is safe, and a completed one restores from the journal. So a
Git-host evidence read is an ordinary durable effect, and the machinery that
makes a mutation exactly-once is deliberately absent rather than reused where it
would only add a second identity to keep in agreement.

What such a read must not do is answer partially. A collection the host
completed and a collection nobody could finish reading are opposite facts, and
only one of them is `[]`; a truncated list would report the first while meaning
the second, so an incomplete walk fails the read and retains no array at all.
Both questions about a pull request — what it holds, and what it should say —
are asked of one surface, and a provider is ordinary middleware around it. That
is the Issue surface's topology, adopted deliberately: an adapter recognizes the
URLs it can act on and delegates the rest, and once it matches, its validation
and its refusal are final. A refusal ends the request rather than starting a
search for another provider, because a search is how a document that named one
service quietly reaches a different one.

The bound here is the operator's `allowed` list, checked before a session is
opened, a credential is read or anything is sent. It bounds reads alone: an
upsert names a branch this run published rather than a URL a document wrote, and
what admits it is this run's own matching Push evidence, which no configuration
grants or withdraws. "Permission ceiling" is the word for the bound; what an
operator writes is the list of places this host is allowed to reach.

A replayed effect that has to name what it asked for reads the moment it asked
from. A Push names its request out of the checkout, and a run that publishes one
branch repeatedly has moved the Workspace on by the time it is resumed — so each
completed Push is reconstructed from the root its own journal event was appended
against, which is the association the run made when it wrote that event, rather
than from the frontier the run reached. That reconstruction is a read: the
historical root is materialized, exported from, and discarded on every path out,
leaving the current root, the retained roots, the metadata and the journal
exactly as they were. It decides only which question is asked, because the
request it produces still has to be the one that position asked before the
retained record answers it.

#### Retained effects and history forks

An external effect is judged by its retained record rather than by its type. A
completed Git-host reconciliation record replays without contacting a provider,
so a fork inherits it and the remote is mutated once; the record keeps the
identity it was written under, and the effect at a position the history already
holds a record at is named by that identity, while every live attempt is named
by the run performing it. The identity is established when the engine
admits the run's retained snapshot and is published beside the run, so every
physical copy of the workflow package reads one answer. What authorizes live
execution is not that answer: a coroutine that walked away from retained history
it never consumed performs no Git-host effect for the rest of its run — the
engine's own account decides it, at every position after the divergence — so
removing or replacing the transported identities can only make the effect replay
correctly or refuse. It belongs to the exact retained event it
came from, at the position that event occupies: records are offered in order,
a call may take only the next untaken one and only when it asks exactly what
that record answers, and a request named by a retained record that reaches live
execution performs nothing rather than performing under another run. A Git-host event that settled into no such record
leaves the remote's state unestablished, and that checkpoint is not forkable.

A fork inherits the source's normalized props as its baseline; explicit
generated arguments add to or override them, and the merged set is validated
against the candidate definition before anything is created. Those props are
what the compatibility replay runs under, what the run retains, and one of the
terms a reused fork ID is compared on.

A fork writes two records for itself and inherits the rest. Its own
`workflow_run` record is what its journal is held to, and its own root import is
what makes the run a run of the definition the caller named — that record holds
the document's text, so inheriting the source's would run the source's document
whatever was asked for. Everything after them travels unchanged, keeping its
public event ID, its filtered result, its authored position and its Workspace
root, and carrying the source run and source event it came from. Retention moves
with the fork: once the fork commits, deleting the source leaves its prefix and
its selected root exactly as readable as they were.

Compatibility is decided before any storage the host would recognize as the new
run exists. The candidate replays the inherited prefix against a staged copy of
the fork — the whole run, assembled where nothing discovers it — and the replay
ends at the checkpoint, before the first live effect, rather than after it. A
divergent candidate leaves no fork. After it succeeds, one transaction commits
the run, its lineage, the inherited prefix, the copied roots, the selected
current root and the first document execution together.

### Local Workspace topology

The local workflow host owns SQLite directly in Deno and reuses Cloudflare's
DOFS filesystem layer behind the provider-neutral Workspace boundary. One
authoritative provider-owned connection entry serves each canonical workflow
database path until provider teardown. The journal and DOFS adapter use that
same SQLite connection; Cloudflare's synchronous initialization transactions
become uniquely named savepoints inside XMD's caller-owned transaction. Those
savepoints and operation-spanning savepoints share one allocator and cannot
collide or release one another. After a savepoint successfully rolls back and
releases, the shared rollback path invalidates both caches on the authoritative
DOFS wrapper before outer transaction work resumes. A second long-lived DOFS
connection is not a coherent reader because provider
caches may retain negative entries across another connection's commit.

Complete schema version 1 retains the canonical empty Workspace root and its
root-only live frontier initially. It retains arbitrary canonical roots and can
materialize one privately through the authoritative connection. Capture runs
inside the caller-owned transaction. Restoration runs in a nested savepoint,
clears the authoritative resolution and blob caches, and resnapshots to the
selected identity before release. Private Workspace transaction bodies finish
their child teardown before final live/current validation. The Workspace effect
coordinator also finishes its mutation savepoint scope before it invokes
capture.

Separately, every unsuccessful caller-owned transaction attempts top-level
SQLite rollback and then
invalidates both caches on the provider-owned DOFS wrapper while it still holds
the serialized connection turn. This includes body failure, cancellation,
teardown or final-validation failure, and commit failure. The surviving wrapper
therefore cannot answer from uncommitted positive or negative cache entries
after SQLite has restored the prior frontier.

Retained roots, manifests and blobs remain indefinitely. Cloudflare garbage
collection is not in the production closure and is never invoked. The provider
exposes no public history selection at this layer; a fork's root copying is a
lifecycle transaction above it. Its
coordinator combines one mutation, immutable-root publication and one filtered
journal result atomically, and the transaction-bound Files provider is what
routes a document's `<File>` and `<Glob>` to it. `xmd workflow start` and
`xmd workflow resume` install that provider around each execution.

The coordinator treats only errors produced through its private filesystem
adapter's documented path and mutation refusals as journalable operation
failures. It rolls their savepoint back, keeps the prior current root, and
commits one failed protocol Yield. Connection, savepoint, content, capture,
routing, filtering, insertion, teardown and commit failures roll back the outer
transaction and activate the durable run's first-failure fence. Cancellation is
control flow: it publishes no failed result. The durable coordinator contract
supplies a provider-neutral failure activator so a provider can retain that
first infrastructure failure by identity; the default coordinator does not use
it and keeps its existing behavior.

Losing the host is not one of those outcomes, because nothing runs to handle
it. No cleanup, commit or rollback happens after the process dies: the
operating system closes its connection and releases the locks it held, and the
interrupted transaction is left for the next write-capable source connection to
recover. Read-only lifecycle inspection may instead recover a private copy under
the coordination described above; it never takes recovery away from that next
source owner. The mutation, the immutable root, the current-root pointer and the
routed event have all been written by then, and recovery exposes the last
committed state and none of them.

That is the same boundary every other reader already observes rather than a
second rule for crashes. A second connection sees the last committed state for
as long as the writer's transaction is uncommitted, so a crash publishes
nothing that was not visible before it. What a later process finds is that
committed state — the filesystem, the current root, the retained roots and
references, and the ordered journal with its event identities and root
associations — from which it performs no recorded effect again and can
materialize any retained root.

The Deno journal adapter routes an append ordinarily when no destination is
bound. A publication may instead bind one exact transaction destination for its
own lexical scope after the existing secret gate. The route validates the
database lease, connection generation, transaction identity, token and open
state before delegating to the existing `transaction.journal`; it contains no
insertion SQL of its own. A nested route for another run delegates past itself,
and `readAll()` always follows ordinary replay without routing or secret
filtering. The provider-owned ordinary destination and each publication-local
routed destination are terminal `{ at: "min" }` handlers, so an enclosing
loaded copy with the same stable contextual name cannot suppress an append or
run ahead of exact-token validation.

The initial topology requires neither writable FUSE nor native subprocess
access and does not bundle `workerd`. A Cloudflare-hosted or workerd-backed
provider may install the same contextual contract without changing documents or
lifecycle commands.

Worker JavaScript is outside the initial local capability set. Worker Shell is
inside it: one `just-bash` invocation runs in a Deno Worker through Cloudflare's
Workspace filesystem adapter. The host begins one immediate SQLite transaction
and one effect-local mutation savepoint. Success releases the savepoint, appends
the already-filtered result and commits. Failure, timeout, cancellation and
Worker termination roll the mutation savepoint back, append the failed result
and commit. A host crash rolls back the still-open transaction entirely.

Every Worker filesystem request carries the effect identity and a
per-invocation token. Missing, foreign, cancelled, completed and stale requests
are refused. Cancellation must be able to forcefully terminate a CPU-bound
interpreter; graceful Worker shutdown alone is insufficient. Worker Shell
exposes no native executable or host PATH and is not described as POSIX or
native Bash.

### Replay-safe live services

An attached service belongs to the document execution that attaches it. The
host owns port selection, process spawning, XMD service handshake
authentication, supervision and teardown. Shared runtime code reaches that
behavior through the provider-neutral `API.Service`; it never imports a host
process or networking API.

The service publishes a frozen loopback endpoint as a live binding. Live
bindings form an overlay on the component's durable eval bindings: `ephemeral
eval` reads both and may add live bindings atomically, while ordinary `eval`,
code-block interpolation and journal serialization read durable bindings only.
A live binding cannot shadow a durable binding, and a durable value cannot be
replaced by a live one.

Service attachment and `ephemeral eval` execute again during partial replay so
the current process and middleware chain are reconstructed. A completed
document replay returns its recorded result without expanding the document and
therefore starts no service. Ordinary durable eval transforms a block and
validates its declared exports against the live overlay before constructing its
durable effect. A collision therefore has no eval `Yield`; compatible partial
replay remains aligned, while retained history containing a now-incompatible
successful eval is rejected by the existing replay guard or divergence path.
Every root and child termination checks its retained subtree before appending a
`Close`. The replay index tracks which coroutine identities the current
definition uses, so a completed retained child is not mistaken for aligned
history merely because it already has a `Close`. Durability failures take
precedence over ordinary termination even after the last retained `Yield` was
consumed. If collision handling terminates immediately,
`TerminalDivergenceError` retains the collision as its cause and the history
receives no terminal event; restoring the compatible definition can still
replay it.

`xmd workflow start` and `xmd workflow resume` install the non-delegating
`useWorkflowServiceDenial()` provider inside each execution scope, before the
root document is imported — in the same place `xmd run` installs its host
service adapter. The provider prevents a workflow from reaching an inherited
host adapter, because a run-owned durable service requires stable identity and
reconciliation rather than an execution-owned live process.

## Files and repositories

Document filesystem operations cross a provider boundary. Ordinary managed checkouts have a different lifetime from a workflow filesystem checkpoint.

### The document filesystem boundary

Contextual routing is not permission. `API.Files` decides *which* provider
answers a document's file operations; what a provider is allowed to do is
decided by the provider, from identities the contextual layer cannot supply.

The Api's operations are whole semantic acts — read this path, replace this
path, ensure this directory exists, remove this path, list what these patterns
select — rather than steps a caller sequences. Every operation is mandatory on
the host and workflow providers; the terminal for an absent provider remains
fail-closed, and separately loaded copies compose through the Api's stable
namespaced name.
The one preliminary operation, `checkFilePath`, is deliberately weak: pure path
arithmetic, no filesystem access, and it returns nothing usable. `<File>` calls
it to decide whether a write's children may expand, and the later write repeats
the same admission from the same authored path. Nothing is handed between them,
so a check that was skipped or answered elsewhere authorizes nothing.

Directory placement is one semantic act of its own. `<Dir>` gives
`ensureDirectory` the enclosing working directory and the path the author
selected; a relative path is resolved against that directory and an absolute
path keeps the component's existing meaning and is used as written. The
provider recursively creates a missing target, accepts an existing directory
without replacing or clearing it, and refuses a final or intermediate
non-directory with structural failure data that carries no resolved path or
platform diagnostic. Success carries Unit rather than a path or handle.

`<Dir>` performs that ensure before it installs the target as `Env.cwd` and
before its content begins. A refusal therefore runs no content. Once the ensure
succeeds, content expands with the target as cwd and the component's scope
restores the enclosing cwd on success, failure and cancellation; restoration
never deletes the directory. The Repository selection in scope is unchanged —
Dir places content in a directory and selects no Repository.

The mandatory `API.Files.deleteFile` operation owns removal.

Removal is one of those acts, and it is mandatory: a provider does not omit it
and let a document reach the host instead. Its success is Effection's `Unit`,
carrying no value at all, which is what makes "a deletion hands back no receipt"
a property of the boundary rather than a convention of the component that calls
it. Absence is that same success — a path that already names nothing is what the
document asked for — while every directory is refused, an empty one included,
because a nonrecursive removal of one means different things on the runtimes
this project ships to and on the pinned Workspace filesystem, and classifying
the entry first is what makes those differences invisible.

A **final symbolic link** is removed as the link. Resolution therefore stops at
the parent prefix and puts the authored last segment back unresolved: resolving
it would follow the link and remove something the document never named, while
not resolving the parent would miss a directory link leading out. A working
directory that names itself is classified directly rather than through its
parent, which is otherwise outside it.

The two providers make different containment guarantees, and both are stated rather
than implied:

- **`xmd run`** resolves document paths in the caller's own filesystem. The
  ordinary file operations refuse empty, absolute, and lexically escaping paths
  without touching the filesystem, and refuse an observed outward symlink once
  resolution can see one. Directory ensure is the placement exception above:
  it accepts the exact absolute target `<Dir>` already accepts and resolves a
  relative target from the enclosing cwd. It creates directly and enlists in no
  transaction, so directories it created persist after the component and the
  document end — including when later content fails or is cancelled — and a
  recursive attempt is never rolled back or removed by teardown. These guarantees
  hold while the host namespace is stable; this is not a sandbox, and closing
  the replacement window would require a native dependency this project does
  not take.
- **A workflow run** resolves document paths in the run-owned Workspace's
  logical filesystem, inside the caller-owned transaction. A document path
  never becomes a host path, so there is no host namespace to replace. An
  absolute Dir target is an absolute logical Workspace path, never a host path.

Neither guarantee covers a native command a document runs.

The workflow provider's operations are durable effects. A read, a write, a
directory ensure, a deletion and a search each carry a description derived from
the current expansion, the operation and the resolved logical path, so one
authored element is the same effect across replays and a document edited to name
another target is a different one. `checkFilePath` is not among them: it is
lexical admission, it performs no effect, and it appends nothing.

A mutation, the immutable root that results from it, and the filtered journal
result share the one caller-owned transaction. Recursive directory creation is
inside one savepoint and one `workspace_file` effect: successful creation or
existing-directory adoption publishes the resulting root with the recorded
success, while a documented refusal rolls every directory created by the
attempt back and publishes the refusal against the unchanged root. An ordinary
refusal from any mutation follows that rule, so the retained outcome describes
a Workspace that is exactly what it was, and the reason that crosses the
boundary is selected from the shared vocabulary rather than derived from
anything the filesystem said. Replay restores those recorded outcomes without
performing the mutation, opening a transaction or consulting the current
frontier, which is why a create/delete/create history replays in order — and why
a completed ensure does not create again. A cancellation between a mutation and
its commit publishes nothing, so continuation performs it once against the
retained frontier. A temporary directory is refused outright: the provider has
no host directory to hand out, and falling through to the caller's would be the
uncontained filesystem the boundary exists to prevent.

Failure data crosses the boundary as a plain frozen object under a stable tag,
carrying a reason from a fixed vocabulary and the phase it came from. No
message, errno code, resolved path, temporary name, or symlink target crosses.
Consumers parse that data before reading a field; a write whose data does not
validate is a provider-contract failure rather than a commit state to invent.

### Ordinary repository ownership

An ordinary execution borrows persistent checkout bytes through invocation-owned
resources. Releasing the execution releases its locks and evidence; it preserves the
checkout. These rules complement the [repository
interface](specs/workflow-workspace-spec.md) and [workflow effect
transactions](#replay-and-effect-transactions).

#### Managed checkout reuse

An ordinary Repository or Worktree selects a managed checkout under `~/.xmd/repositories`,
addressed by a digest of its whole identity and described by a closed version 1 sidecar
written by exclusive temporary sibling plus atomic rename only after the checkout is
complete and verified. The slot is entered under an exclusive non-blocking advisory lock
held for the whole document execution, so a second process is refused rather than made
to wait and a self-closing Worktree captured with `as` stays protected while a
later sibling `<Dir>` and an interactive Session use it. Reuse compares creation
identity alone — the immutable request, the recorded creation facts, the canonical
checkout and common directory, the object format, the admitted `origin` and the
creation commit still being present — and never HEAD, the current branch, the index or
the working tree, which are the mutable work the checkout exists to preserve; a conflict
refuses and leaves every byte where it was, and nothing resets, switches, cleans,
fetches, moves, replaces, repairs or deletes. A metadata-free slot is adopted only after
the stricter pre-exposure state is proved — exact owner and locator, the branch and base
this request resolves to, the creation commit still being HEAD, the object format,
linked-worktree registration where applicable, and nothing in the slot but the checkout
— and refuses otherwise. Written outside a lexical `<Repository>`, a Worktree belongs to
the ambient Repository; outside a Git checkout it refuses locally and names how to run
inside one.

#### Local transitions and Git identity

Ordinary local Git operations perform the same authored transitions the workflow
performers perform — named branches only, explicit Add pathspecs, index-only Commit, no
implicit stage or push, and the same fixed provider Git configuration that disables
hooks, signing, file-system monitors and repository-supplied helper programs — directly
against the authenticated selected checkout. A commit records the invoking user's own
effective Git identity, captured from the trusted host by the first `<Git.Commit>` that
needs it and read back off the written object — a run that commits nothing asks the host
nothing about who it is; a host that can name no identity refuses `<Git.Commit>` and names
the commands that fix it rather than writing the workflow identity into somebody's
repository, and every other component stays usable. They enlist in no transaction, roll
back nothing and replay nothing, and a failure promises neither. Which checkout one runs
in is decided by the Repository selection in scope and the contextual working directory,
resolved through the provider's own invocation-owned checkout registry rather than
through anything the selection says about itself.

#### Publication evidence

An ordinary Git.Push keeps the same observe/adopt/fast-forward/refuse rules and the same
isolated transport aimed at the checkout's admitted `origin`: a destination proven
absent is published once, one already naming this exact commit is adopted, one holding a
proven ancestor is published over by the same exact non-force refspec, and a divergent
or unreadable one is a conflict, with an unreachable host never read as absence. It
reconciles no Git-host effect and retains nothing. After a verified performed or adopted
publication it stores one private evidence entry — the authenticated Repository
identity, canonical checkout root, origin, named branch, destination ref and exact
commit — in the provider instance's own closure. A checkout with no admitted
`origin` refuses before a credential, a session or a transport exists.

#### Pull-request admission

Ordinary PullRequest upserts and evidence reads share the URL matching, host ceiling,
response normalization and low-level GitHub reconciliation, and differ in lifecycle and
admission. A read is performed afresh every execution and retained nowhere. An upsert
authenticates the Repository selection and the contextual checkout, reads the current
named branch and commit, and requires the exact matching entry this provider instance
already holds — a Push for another checkout, Repository, origin, destination, branch or
commit is irrelevant, a later Push of the same destination supersedes the earlier entry,
and missing or conflicting evidence is a local refusal before a credential is opened.
Nothing crosses executions: a new run and a new `--journal` run each start with a new
invocation identity and empty evidence, and copying a Context value, a component result
or a previous trace file grants nothing. Within one invocation the attempt happens at
most once; across a process interruption there is no exactly-once guarantee.

#### Issue identity

An ordinary Issue reaches the same configured transport under the same host ceiling,
with no durable envelope: identity is this execution's own opaque invocation identity
together with the engine's expansion identity, so an upsert presents an idempotency key
a provider can carry and a second run is a new request rather than a resumption. Absent
or out-of-ceiling configuration installs no matching provider and sends no credential
and no request.

#### Lazy provider resources

The Deno source entrypoint and the compiled binary install the live provider for
`xmd run`, parameterized by the same credential-helper assembly the workflow host
uses. It reads no configuration: `XMD_WORKFLOW_GITHUB_ISSUES` and `XMD_WORKFLOW_GITHUB_PULL_REQUESTS` belong to the GitHub
adapter inside `@executablemd/git`, which reads and validates one when an invoked GitHub-backed
operation needs it, so a run that opens no pull request and files no issue reads
neither. Installing the provider acquires nothing at all — no managed root, no lease, no
Git session, no identity, no ambient discovery; each of those is acquired by the first
operation that needs it and kept for the rest of the execution. A nested `<Execution host="run">`
child receives a fresh instance — its own invocation identity, leases and Push evidence
— so nothing it publishes authorizes its parent or a sibling. The outer `xmd test`
command installs none — it is not a run profile, and a nested `<Execution host="run">` child
assembles one for itself rather than inheriting what its parent declined. Node and Bun
register the vocabulary and install no operational provider, so every repository
operation reports an absent provider before a lock, a credential, a subprocess or a
request exists.

#### Ambient discovery

The ambient Repository is the repository an ordinary `xmd run` was started inside,
discovered when the first element asks for one — never at installation — from the
invocation's starting directory, and remembered for the rest of the execution including
when there is none. Its identity is the canonical common Git directory and its selected
checkout is the canonical checkout root, so starting in a linked worktree names the same
repository as starting in the primary checkout while Git operations still act on the
worktree. A workflow run has none.

#### Managed bytes

A managed checkout is a Repository or Worktree an ordinary `xmd run` created under
the host root `~/.xmd/repositories`, addressed by a digest of its whole identity, described by a
closed version 1 sidecar written beside it, and held for one document execution by an
exclusive non-blocking advisory lock. It survives every execution: nothing deletes,
resets, cleans, fetches or repairs one.

#### Commit identity

Ordinary Git identity comprises the invoking user's effective Git author and committer
name and email, read from the trusted host's own environment and configuration by the
first `<Git.Commit>` that needs one — never at installation — and kept in the provider's
closure for the rest of the execution, including when the host can name none. A run that
commits nothing never asks. It is used for an ordinary `<Git.Commit>` and nothing else,
because that commit lands in the caller's own checkout; a workflow run keeps its one
fixed identity, whose whole purpose is that retained Git state does not depend on whose
machine made it. It is not a prop, a Context value, a component result or a middleware
answer, and nothing else about the environment is borrowed with it — hooks, file-system
monitors, signing programs and repository-supplied credential helpers stay disabled by
the same fixed command-line configuration. A host where Git can name no identity refuses
`<Git.Commit>` with an actionable sentence rather than substituting the workflow one;
every other component is unaffected.

#### Invocation identity

An ordinary invocation identity is a fresh opaque random value the document execution's
repository provider mints for itself and keeps in its own closure. It is not a prop, a
Context value, a component result, a middleware answer, a lifecycle ID or a retained
record, and it is neither addressable nor reusable; live Issue and pull-request
idempotency and reconciliation keys are derived from it together with the engine's own
expansion identity.

## Agents and generated work

An Agent proposes source; trusted execution admits and performs it. Session continuity, generated admission and Plan recovery have distinct owners.

### Native Agent sessions

A native handoff gives one exact retained conversation to the provider UI. Its
construction identity, executable compatibility and live owner are separate facts. Read
these rules together with the [native launch
interface](specs/native-agent-session-launch-spec.md) and [ACP provider
contract](specs/acp-client-spec.md).

#### Handoff, construction and executable compatibility

A native session launch prepares one durable coding-agent session from the rendered body
of `<Session.Launch>` and hands the provider's native UI the terminal for that exact session,
then continues the document after it exits. The body renders completely first and only
what it rendered crosses as the instruction layer; the launch performs no model turn
except an adapter's declared materialization turn, which runs at most once, only for a
conversation the launch just created, and only with that adapter's fixed prompt; it
takes the run's foreground-terminal lease before an agent is resolved. A host with no
applicable terminal refuses without probing for an installed CLI. A session is
constructed once, by one of two mechanisms, and its create-once construction route says
which.

Where the provider returns the identity, the ACPX provider creates the session, installs
the layer at creation, releases ACP ownership before the spawn, and marks its handle
stale so a later `<Prompt>` reattaches.

Where the adapter names its own sessions, it allocates the identity inside ownership
before any process exists, the native process creates the session under that name from a
private mode-0600 instruction file, and ACP creates nothing — the instruction text
reaches neither argv nor environment, and the file is removed on success, failure and
cancellation alike while ownership is still held.

Neither route converts into the other, and which one governs is chosen by the first
operation that consumes the placement rather than by the `<Session>` that made it: a
fresh `<Session>` publishes no route and establishes nothing, so a `<Session.Launch>` nested
inside one constructs the session it placed, while a first subscribed `<Prompt>`
publishes ACP-first before it ensures and keeps that account even if the turn that
follows is never accepted. An established route is validated eagerly by a later
`<Session>`, and a launch meeting a published ACP-first route refuses before an
identity exists. A `<Session>` or `<Prompt>` meeting a bound client-allocated route
attaches under the route's exact identity; a legacy unbound route or an unavailable
attachment capability refuses before a turn and creates no substitute conversation.

Phases are retained as `agent_session_launch` records under one expansion identity — `prepared`
before ownership is released, then `materialized` where an adapter required a
materialization turn, then `detached`, then `exited` — so a completed replay
launches nothing, a replay holding only `prepared` proves the handoff never began and
may still create under the retained identity, and one holding `detached` resumes and
never falls back. The public route carries an opaque one-use launch request and answers
nothing; the right to run and retain a phase is delivered to the installed provider
directly, so neither a returned completion nor a rebuilt request authors a launch.

Every operation that can act on an advertised session takes exclusive ownership under
one natural key first, through a coordinator the host built and passed in; contention
refuses instead of queueing, and an owner that never proved it stopped leaves a recovery
tombstone.

A host that cannot establish session ownership refuses every advertised operation. Every
advertised build-bound adapter also requires the construction route store and executable
observer, regardless of who chose the identity; missing host assembly refuses before
provider work. Every private setup or child-creation failure is normalized to
`process-creation-failed` with fixed provider-owned text, carrying no path, argv, environment or host
message. No launch path discards persistent provider state.

A session whose adapter pins a build is bound to that one build, whichever side named
it: the build is observed inside ownership before an identity is allocated or a provider
session is created, the binding is published with the bound route — V2 for
client-native, V3 for ACP-first — and retained beside the prepared record, the native
child runs the exact observed path in place of the launcher name, and every later
create, resume, attachment and incomplete replay reobserves and compares before a
process, an ensure or a turn.

A `<Session>` or `<Prompt>` meeting a bound client-native route attaches to it: it
reobserves the build, requires any retained provider arrangement to assert that same
conversation, calls ensure with the route identity as `resumeSessionId`, and requires the
provider to report that identity before a turn — refusing on missing capability, build
drift, missing history or a differing assertion without creating a substitute
conversation.

ACP runtimes are partitioned by resolved agent command and binding, each handle is
closed by the partition that created it, and a bound partition is torn down when its
last handle closes.

A legacy V1 client-native route keeps exactly the released native-only behavior and
never attaches, and a legacy V1 ACP-first route refuses an agent whose adapter binds a
build rather than gaining the current executable.

Native launch is available under the host scope described here. Its initial delivery was
recorded on 2026-08-22 in `5542c921bb8145458dc5f2446a61a1082a916f41` (#517/#518), extended by #519 and #561; Deno and
the compiled binary assemble the host — coordinator, route store and executable observer
— and Node and Bun keep the same advertised names while assembling none of it, so every
advertised operation refuses before provider work; `claude` is advertised for native
launch after passing the client-allocated gate at Claude Code 2.1.241 on macOS arm64
(#520) and separately for client-native attachment after passing the native-to-ACP
marker gate (#561); `codex` is advertised for native launch after passing the
provider-returned gate at `codex-cli 0.153.2` on macOS arm64 with the vendored `@agentclientprotocol/codex-acp`
1.6.2 snapshot that asserts the App Server thread on the response `_meta` (#755),
which costs one fixed `codex-materialization.v1` turn because Codex writes the rollout `codex resume <id>`
reads at a thread's first turn. That tuple is the compatibility point the advertisement
stands on rather than an allowlist: admission accepts one canonical `codex-cli x.y.z` line,
so another canonical version is admitted while bare, malformed, ambiguous or multi-line
output refuses; exactness belongs to the session, whose accepted string becomes its
retained executable binding and is reobserved and compared before every later create,
resume, attachment and incomplete replay, so continuing a session across releases is not
offered. Reading the ACP session id as the native identity stays forbidden; `Agent.AddDir`
is unbuilt.

#### Session configuration and inspection

A `<Session>` says which model and effort level its conversation runs under, in exact
provider ids, and no other element does. `Agent.session()` continues to route only a name or
opaque placement; configuration is not a middleware argument. Each provider installation
owns one private registration closure for its exact lifetime. An opaque placement
carries an unreadable reference to its operation-local issuance, including optional
frozen configuration and durable component identity; `with({ name })` preserves it, another
placement substitutes its own, and a raw string or directly returned raw Session selects
no configuration.

The directly delivered provider coordinator accepts the final live placement once and
completes it with the provider's exact Session plus either fresh state or one stable
established-session configuration operation. Fresh completion performs no configuration
work; established completion applies and verifies eagerly, and the returned canonical
value is sealed into one opaque frozen session use selected lexically for nested prompts
and launches.

The owner refuses a different operation for an already registered exact Session,
registration or lookup after teardown, and copied or foreign placements and uses;
teardown drops its registrations after provider finalizers. No Context, module registry,
public Agent operation, middleware-readable member, return value or Session property
exposes the owner or operation, and the provider retains no desired-settings
association.

A string passed to `useConfiguredSession()` creates one operation-local placement with no durable
component identity.

Middleware may observe, refuse or reroute whole Sessions. The final routed value decides
the operation: an authentic configured use applies and verifies its own settings;
another authentic use applies its settings; a raw Session, name or absence is
unconfigured; and a copied or foreign configured session use refuses before provider
work. The journal records only the verified configuration the final route actually
started under, never an earlier lexical request.

Settings are applied under the Session's existing serialization and ownership — read,
apply model, refresh for that model's effort choices, apply effort, verify exact
equality — before a turn or native UI.

Omission performs no configuration read or write.

An unavailable option, unsupported capability, rejected write, mismatching readback or
unverifiable restoration fails before the turn, restoring model first and reporting the
original rejection; a restoration nobody can verify makes that exact Session unusable
for the rest of the run.

A prompt that started and a successful launch preparation retain one canonical
`configuration`; a configuration refusal and an unconfigured operation retain none.

Completed replay contacts no provider, and an incomplete configured launch reapplies
that canonical value to the exact retained Session or fails.

Released launch `requestedModel` and observational `model` strings are
compatibility-reader inputs only: valid values are discarded, malformed values refuse,
and neither can configure replay.

A final configured provider-returned launch verifies before materialization, detach and
native UI; a final configured client-allocated launch refuses before route, identity,
private file or process, while middleware that routes an unconfigured Session receives
the unchanged unconfigured contract.

`Agent.options()` reports provider-ordered, grouped choices through one scoped unretained
inspection session that sends no prompt and creates no XMD execution, journal or durable
session, and `xmd agent options` renders them as text or version-1 JSON.

Session configuration was delivered on 2026-09-21 in `c77a4b882fb528663137cb04552cec90a569d18a` (#828/#829); ACP
translation lives entirely in `@executablemd/acp`, and no ACP or ACPX type crosses into core.

#### Provider identity

A provider-native session identity is the identity an agent asserts for its own durable
session state, distinct from the logical XMD session key and from the ACP/ACPX record
identity. Only an asserted one crosses a handoff; XMD never infers that a string a
native CLI would accept is one.

#### Inert placement

A pending session placement is an exact provider-issued `Session` capability carrying
where a logical session will live and which agent it is compatible with, and nothing
more: no construction route, no provider handle, no resumable identity. A fresh
`<Session>` produces one, and the first consuming operation chooses how the session is
constructed.

#### Materialization

Session materialization is the transition that makes a placement's chosen route and its
backend history resumable. ACP-first materialization happens only when the backend
reports that it accepted the session's first turn; client-native materialization is the
native launch's existing retained construction. Nothing else promotes a placement — not
a returning ensure, a first output, a terminal result, a checkpoint token, an error code
or a diagnostic.

#### Established sessions

An established session is a placement whose immutable construction route and durable
provider or native identity both already exist, and which is therefore validated
eagerly: reattached, compared against its retained history, and refused when either is
missing or names another conversation.

#### Instruction placement

The instruction layer consists of the provider-native session, system or developer
instructions a launch installs before the native UI accepts its first user turn. It is
not a user message, and it is not conversation history.

#### Foreground ownership

A foreground-terminal lease is the one exclusive hold on a document execution's
foreground experience. A root native launch holds it for one inherited terminal. A host
with no terminal refuses it, and no second root launch can hold it concurrently.

#### Launcher

A native launcher is the host-owned seam that reserves the foreground terminal, flushes
what that terminal has pending, starts one native UI there, and reports its terminal
status and nothing else. It is not `exec`, whose children are piped, captured and
journaled.

#### One-use requests

A launch request is the frozen, one-use value public launch middleware routes. It
carries the facts of one launch and `with()`, and nothing that can settle one.
Identity is object identity: a rebuilt look-alike describes the same ask and is admitted
nowhere.

#### Launch coordination

Core delivers an agent launch coordinator to the provider factory it installs, as an
argument that factory closes over. It validates the routed request, runs each absent
phase once, cross-checks and retains what comes back, and derives the result. There is
no reader for one, no context holding one, and no request member carrying one.

#### Session ownership

A session coordinator is the host-built capability that answers who owns one logical
agent session right now, across processes. It is passed directly into the provider that
needs it and is deliberately not contextual: a decision document middleware could
replace is not one. Acquisition never waits.

#### Construction routes

A construction route records how one logical agent session was first constructed —
through ACP, or under an identity XMD chose — as strict create-once durable state beside
the coordinator's own records. It answers a different question from ownership and grants
no right to act: the coordinator remains the one live owner. A route never converts, and
a session ACP already established is recorded as ACP-first rather than reclassified.
Three closed schemas are readable: legacy `session-route.v1`, build-bound client-native
`session-route.v2`, and build-bound ACP-first `session-route.v3`. New bound construction publishes
V2 for client-native or V3 for ACP-first. Legacy V1 records are never upgraded in place:
a V1 client-native route admits native resume only and never ACP attachment, while a V1
ACP-first route refuses an adapter that requires build binding.

#### Build identity

An executable build binding records which build of a provider executable accepted a
session, as a schema, an adapter-canonical version and the lowercase SHA-256 of the
canonical executable target. Equality is exact over all three, so a matching build
reached at another path is the same build and a changed build at the same path is not.
It contains no path: a path says where a build was, which stops being true, and names
host layout besides.

#### Executable observation

An executable observer is the host-built capability that resolves a launcher command
through the host's real execution environment, canonicalizes the target, requires an
executable regular file, hashes that target and asks that same file its version. The
host passes it directly into the provider like the coordinator beside it. It is
deliberately not contextual: executable validation decides which retained history may be
accepted, and a resolver document middleware could replace could point the observation
at one binary while the run spawns another.

#### Attachment

Client-native attachment joins a conversation a native process constructed, through ACP,
under the identity the route already names. It is attachment, never conversion: the
route stays client-native, `resumeSessionId` receives that exact identity, and the provider's
canonical assertion must equal it before the first turn. Attachment is advertised
separately from native launch, because handing a session to a native UI and later
joining it prove different things.

#### Identity provenance

Identity provenance records who chose a provider-native session identity: the provider
returned it, or the client allocated it before the provider existed. This provenance is
retained rather than inferred, because after the fact both are just a string in the
record. A released record written before the distinction existed reads as
provider-returned, which is the only compatibility inference.

#### Proving release

Quiescence is the one-use acknowledgement an ownership body gives. It does not mean "I
finished" — it means nothing this owner started can still act on the session, which is
why a handoff that could not release its handle never gives it.

#### Unproven release

A recovery tombstone is an ownership record left active because its owner never proved
it stopped. A crash releases the kernel lock and not this, and no pid, elapsed time,
released lock or empty transcript clears it.

#### Provider partitions

A provider partition is one complete, independently owned agent-provider state —
runtime, store, managed sessions, queues, coordinator, teardown — selected by the one
installed factory at each dispatch. Production is the single-partition case of the same
path; holding a partition grants work, never permission.

### Agent permissions and generated XMD

A workflow Agent receives no Workspace, checkout, materialized root, host path
or additional directory. Its process starts in a fresh empty directory the host
owns, configured with no MCP servers. That directory is provider-owned, never
enters logical or durable identity, and is removed with the attachment. The host
requests an empty native tool allowlist and installs a permission path that
denies every native request and fails the turn that asked, without reaching the
public permission chain. This is the V1 permission ceiling; the portable proof
that every provider exposes no ambient tool is tracked separately and does not
widen it. `xmd run` keeps its caller-selected Agent permission behavior.

What a turn was allowed to do is retained beside what it said, and the two are
recorded by different things. A permission policy decides every request inside
its scope without deferring outward, so nothing installed inside one — and
nothing installed inside the turn, below a policy a host put around the execution
— can see the decision it makes. The Agent middleware installed with the
Agent itself, outside every policy installed after it, owns both sides of this.
Each `Agent.prompt()` call is given a private ledger and the cold stream it
returns is wrapped, so every event that call produces is read with that ledger
in place and a request raised while it is read inherits that ledger and no
other. A component installs nothing to be audited. The observer reserves a
place, delegates once, and copies the outcome that comes back into that place, so
concurrent turns keep their own audits and two overlapping requests keep the
order they were asked in. A place nobody completed — a policy that raised, a turn
torn down while a request waited — is published as nothing rather than as a
denial somebody invented. The ledger names a destination and confers no authority
to answer anything.

The only thing a workflow Agent receives is the rendered content of an authored
`<Prompt>`. It proposes an information request, or a change, by returning XMD. The
trusted workflow host passes that exact response to the constrained
generated-XMD evaluator, which performs admitted components as ordinary durable
effects against the authoritative Workspace.

Evaluate produces exactly the fragment's ordinary rendered output. It neither
observes component return values nor invents a second result channel. A
generated fragment captures values with ordinary `as` bindings and renders any
structure it wants through ordinary pure components such as `Json`. A bound
`Fetch` response therefore reaches the next Agent turn only when the fragment
chooses to render it. An admitted mutation likewise contributes only what its
authored fragment renders; its own durable effect record remains the account of
what it did.

An admitted effect names its durable operation after the invocation the engine
handed it, through the invocation authenticator this execution delivered to the protected
`<Evaluate>` body it built (*Capability-backed invocation identity*). Nothing
else carries the capability: an Effection Context is addressed by name, a contextual
Api handler installed outside an invocation answers ahead of the engine's own,
and a definition or registry answer is a value a handler may keep from one
attachment and hand back inside another. Two effect sites sharing one
durable name would each replay the other's admitted fragment, and an
implementation running under another attachment's identity would commit against
its own run's storage under that attachment's expansion.

An admitted element runs canonical core's own ordinary component, and the
operation it performs is the ordinary one. For a while it did not: a profile
stated a *capability* whose body core closed over operations the host handed it,
so a generated read reached a filesystem nothing in the document's scope could
observe, transform or refuse — and a generated `<Dir>` scoped its content
through a cursor the evaluator owned rather than through the contextual
environment. Both are gone. A fragment's operations now cross contextual
`API.Files` and `API.Fetch` like every other caller's, which means the middleware
an authored read crosses, the provider the host installed, and the effective
`Permissions` of the consuming scope all apply to them.

What the profile states is admission: which names, which spelling of each, which
requests an admitted `<Fetch />` may perform, and the execution's lifetime — an
admitted implementation refuses once the execution that captured it has ended.
A host hands the profile no operation at all, because there is no second
filesystem for it to hand. What a fragment may *do* is then the ordinary
question asked of any caller: the provider that is installed, and the policy of
the scope the element runs in.

The narrowing these changes record is the one that still stands — an entry
authorizes one component under one spelling, and what that spelling runs as is
the owning declaration's to state. **A run suspended under an earlier record
shape refuses to resume rather than silently receiving a grant nobody compared**:
a continuation resumes only under the exact identities and spellings it was
admitted with.

`<Prompt>` is one Agent turn. The host hides no Agent loop inside it. Ordinary
authored Markdown owns iteration with `<Loop max>`, branches on whether a reply
is another information request or a final proposal, and makes exhaustion an
explicit document failure. `<Evaluate>` is canonical core's own protected
component, reserved ahead of every host and author tier, so the name means the
same thing in every execution and no registration, repository file, bundle
member, declared Markdown component, import handler or second loaded copy
answers for it. A host does not supply the component; it supplies the
*ceiling*, as one `ExecutionInstallation.evaluation` profile captured by value
before any installation runs. An execution accepts one and refuses two, and one
that was offered none has no evaluation at all — which `<Evaluate>` says when it
is written rather than at startup.

The document writes the program as `text`, or renders it as paired content:

```mdx
<Evaluate text={program} allow={["read"]} />

<Evaluate allow={["read"]}>
  <Plan>Read the changelog and report the version.</Plan>
</Evaluate>
```

The two are disjoint — an element stating both is stating the program twice, and
is refused rather than resolved by precedence. A paired producer renders under
the *narrowed* syntax reference, so an agent asked to write a fragment is told
what a fragment may contain rather than what the surrounding document may write,
while keeping the producer's own operational permission: narrowing what may be
*named* is not narrowing what the producer may *do*. The closed schema accepts only `text` and `allow`;
every profile refuses `source` and `program`.

Within one run a logical Agent session is identified by the Agent/Session
expansion identity the engine derived, and by nothing else. The authored
`<Session name>` is descriptive, so two sibling `<Session name="review">`
elements are two sessions. The name travels the compositional public chain,
where a handler may observe or change it; the identity travels inside an opaque
placement the element routes, readable only through the coordinator delivered to
the installed provider. It reaches the placement from the invocation capability
the engine minted, never from the expansion context. That placement is bound to the element that opened it
and is good for one use, so a handler cannot keep the first element's placement
and route it for the second — both would otherwise resolve to the first
element's identity.

The mapping is a row in the run's own database, committed in the run's own
transaction: one that could commit while the run did not would describe a
session the run never had. It records the provider, the resolved agent command
and the fingerprint of the session policy the session was created under as
compatibility attributes — changing any of them refuses reattachment rather than
addressing a second mapping — together with the provider's asserted durable
identity. Cwd and provider placement are never compatibility inputs. What stays
beside the run on disk is the provider's own session store and one empty working
directory per session; both are disposable.

The order is placement, then the backend's acceptance of the session's first
turn, then the provider's canonical, tagged assertion of a durable identity,
then the mapping commit — and only then is anything that first turn produced
exposed to the document.

Placement is inert. A `<Session>` says where a session will live and which agent
it is compatible with; it creates no provider session, contacts no backend and
writes no row. The session comes into existence when the first subscribed
`<Prompt>` starts a turn the backend accepts, through the one handle that
ensured it, and acceptance is reported by the adapter rather than inferred from
what the turn then produced.

Occupancy of a key in the provider's own store is not an assertion: it says
something is there, not what conversation it is. A record the provider holds for
a first turn nobody accepted is exactly that — occupancy — so it asserts nothing,
no mapping is committed for it, and the next attempt creates rather than
resumes.

An interruption before the mapping commits is reconciled only from one canonical
provider assertion — exactly one, for that identity. A missing assertion, an
assertion conflicting with what is retained, one that replaced it, and more than
one at once each refuse. Once the mapping has committed, a restart compares the
provider's current assertion against it before continuing, and reattaches only
when the kind and the value both still agree. No refusal substitutes a new
session or a reconstructed transcript while reporting continuity.

Cancellation owns both sides of a live step. It stops the Prompt stream or the
generated-XMD evaluation, completes provider and evaluator teardown, and removes
the disposable directory before the attempt settles. Already committed session,
Prompt, admission and effect records remain valid; an uncommitted read or
mutation may run again under the same retained admission, on its own
component's ordinary transaction and retry terms. A final proposal is the
retained result of its Prompt. Any later execution of its mutations crosses the
separate mutation-proposal admission rather than an Agent channel.

Generated XMD is untrusted input. The evaluator preflights the complete fragment
before its first effect and admits only explicitly allowed, already-resolved
component identities. It refuses eval and exec blocks, imports, native
execution and arbitrary JavaScript execution. Ordinary `as` bindings,
structural language constructs and data expressions composed from JSON literals
and fragment-local binding references remain available; pure components such as
Json consume those values without effect permission. Generated bindings neither
import caller values nor escape the fragment. The evaluator retains the exact
filtered generated source for replay, history and deliberate training
ingestion. An incomplete evaluation can continue from retained source without
invoking the Agent again; a completed bounded information request reproduces its
rendered findings without repeating reads.

Admission is built for the always-on trusted composition table and both effect
classes, and its ownership splits in two.
**Core** owns the mechanics behind `@executablemd/core/host`: parsing the
candidate fragment, walking all of it before the first effect, resolving each
admitted name **and authored form** to the exact pinned definition and identity
the host supplied rather than to anything a component search path, a
registration or a bundle would answer, recording one ordinary `generated_xmd`
durable admission before the first generated effect, and replaying that
admission and everything already committed without performing it again. It
reuses the same witness a component bundle does — canonical execution issues one
for the answer it produced and verifies it at the call site — so
`Component.importComponent` middleware may observe or refuse a generated import
and cannot answer, replace or mutate one.

**The trusted host** owns the ceilings, as values it holds and passes: which
retained Workspace roots exist and which one is selected, which pinned
identities are in the `read` table and which in the `write` table, which
authored forms each is admitted for, and which exact requests each may perform.
Generated source receives none of those values, and nothing contextual carries
them.

An authored `allow` selects a canonical, non-empty, duplicate-free subset of
the closed classes `read` and `write` from what the host already installed;
omitting it selects `read` alone, so a document that states no class asks for
read effects alone. It narrows and never grants: it cannot mint an identity, add
a root, authorize a destination, attach a credential or widen a request, and a
class the host stated no table for is refused before the candidate is parsed.
`allow` and bindings are independent: effect selection does not restrict the
language's ordinary fragment-local `as` behavior or pure composition.

**A name is not a form.** A component whose two spellings do different things is
two identities, so one name holds two entries with disjoint form domains and one
shared implementation: `<File />` resolves only to the pinned read identity and
`<File>…</File>` only to the pinned write identity. That choice is made in
preflight from the scan, before the first effect, so a form the selection holds
no exact entry for refuses the whole fragment. Overlapping forms or two
definitions under one name are a malformed host table rather than an ambiguity
settled by table order.

Which identity was admitted is preflight's and is not answerable by anything
else, and the body the admitted component runs is held to that same decision by
the same mechanism an authored element is: canonical invocation-form dispatch
(*Capability-backed invocation identity*) enters the body for the form the scan
recorded, and the admitted invocation is checked against the form its identity
was chosen for before the component runs, refusing before any provider is
reached when the two disagree. That check reads the engine's own account of the
element — not `Component.hasContent()`, not the method on the object the
component was handed, and not the trusted wrapper the evaluator answers the
import with, which collects what a read returned and is not the form dispatcher. So
an admitted reading `<File />` does not become a write and an admitted writing
`<File>…</File>` does not become a read, however many times something is asked.

The standard Deno workflow profile's write table is three entries, in the order
it states them: core's paired `<File>`, the paired `<Dir>` the bundled Git
Plugin asks for — the same implementation canonical core owns, under the
identity core's own declaration offers that spelling as a write, so the grant
and the authored component cannot drift — and core's self-closing
`<File.Delete>`. What the Git Plugin decides is that a workflow run admits the
name at all; an ordinary run admits none. A host's own extensions come after
them. Selecting `write` intentionally authorizes Dir's
persistent recursive directory creation as well as the mutations File and
File.Delete perform. Each is the ordinary component and crosses `API.Files`
into the run's transaction-bound provider, so an ensured directory is retained
by the same `workspace_file` effect an authored Dir publishes. The evaluator
adds no mutation API, transaction or receipt of its own. A write-enabled
fragment that only ensures a directory renders nothing unless the fragment
authors output around it. Local Git, Git-host, issue,
process, eval and exec, native-command, credential and external-write effects
are outside the class.

The versioned Dir origin is a grant boundary, not a symbol decoration. The
former `@executablemd/workflow/composition#Dir` identity authorized lexical
placement that created nothing; it does not authorize the persistent mutation.
A continuation whose retained write table names that former identity is refused
before generated execution instead of inheriting a broader grant. Read-only
admissions never selected the write table and remain unaffected.

That order is retained identity rather than presentation. A continuation is
compared against the entries position by position, so adding the deletion
identity to the table refuses a continuation that was admitted under the former
two-entry one — before any generated effect, and deliberately: a run resumed
under a wider grant than it was admitted with is the thing the comparison
exists to refuse. A read-only admission never selected the write table and is
unaffected.
`<Evaluate>` neither prompts nor approves: approval is authored control flow
before the write-enabled element, and a branch not taken leaves no admission and
no mutation.

A refusal names the construct class and echoes no part of the candidate — in its
diagnostic and in what it retains alike, because the decision is recorded
either way. That holds for a request the candidate malformed as much as for one
outside the admitted set: the component reports a bad URL, header or timeout by
quoting it, so a generated request is normalized behind a boundary that keeps
the class and drops the diagnostic. The host's own ceilings are not generated
text and are normalized before the admission, so a host that states a request it
cannot mean is told which one. Admission is the line: before it nothing of the
candidate is retained, and after it the exact source is retained on purpose.

A retained admission is a grant, and a resumed run is held to it. Durable
replay matches an effect by its type and name, and what a description carries
is stored rather than compared, so the normalized policy is retained in the
admission's own result and a continuation checks it before one generated
component is invoked or one effect is performed. The check holds two kinds of
term differently, on purpose. The admission's Workspace roots and selected
root are an **as-of-admission retained basis** over a set the run's own
progress legitimately grows — every committed mutation retains another
immutable root and advances the authoritative current root — so the basis is
asked for by membership: every admission root and the admission's selected
root must still be retained, and the root the run now stands on must be a
retained one, while additional roots and an advanced current root change
nothing the admission was granted under. A run that no longer retains an
admission root has lost the history the grant was made over and is refused
before generated work. Every non-root term — the class selection, the
admitted spellings, and the normalized request ceilings — compares whole and
exactly, in canonical order. The retained policy holds one row per admitted
spelling: the name, the authored spelling, the absolute
`https://executable.md/` identity that spelling runs under, whether canonical
core supplies the body or the ordinary import chain answered for it, and which
effect table admitted it. So a reader comparing two admissions can say which
spelling of which name moved, and no host has to agree with another about how
to spell anything — the identity is stated by the declaration that owns the
implementation, where `<File />` reads under
`https://executable.md/components/file/read` and `<File>…</File>` writes under
`.../file/write`. There is one such record shape, marked as itself: a record
an earlier build wrote — the untagged #369 one, or the tagged one whose
identities were an origin, a component key and a revision — is refused as
unreadable history before the admission it would have restored performs
anything, rather than being migrated or read in part. An updated implementation
offered under the same identity is not a changed grant, because between
executions that is a newer build of the component the admission named. The run's
own ceiling table is keyed by the entry itself rather than by anything
describing one, so two entries that look alike each keep their own admitted
requests. Only the tables the selection reached take part, so changing a write
table a read-only admission never drew on changes nothing it was granted
under. Deciding the
fragment inside that durable effect is what makes this hold: a continuation
restores what was admitted without consulting the current candidate at all, so
what expands is the source this run admitted rather than whatever a later caller
is holding.

The admission and every durable effect the admitted fragment performs are
yielded inline by the owning document expansion, in authored order and ahead
of the expansion's later effects, so one durable sequence accounts for the
admission, each nested generated effect, and whatever the document does next.
A partial continuation is offered that same sequence: the admission and every
completed nested read or mutation restore from their retained records without
another live execution or root publication, and the run continues to the next
unrecorded position. The existing `scoped()` around generated expansion keeps
owning its middleware, cancellation, and teardown. The evaluator is an
ordinary `Operation` and is not wrapped in `ephemeral()` — [DEC-034](packages/durable-streams/specs/DECISIONS.md#dec-034-ephemeral--explicit-escape-hatch-for-non-durable-operations-in-workflows) reserves
that adapter for intentionally non-durable Operations, and an operation that
can yield durable effects is not one — which is conformance, not the
continuation correction: exact journal order is preserved with or without such
a bridge, and the reproduced resume failure was the former exact root
comparison rejecting the run's own progress.

An XMD-mediated HTTP read is how a network-denied Agent is given external
information: the authored document performs the read with `<Fetch>` and the
retained response reaches the prompt as data. That does not raise the Agent's own
ceiling. A generated fragment may name the pinned `Fetch` identity only when the
host admitted it, and then only for a request that normalizes — scheme, host,
path, method, headers and effective timeout alike — to one the host stated
exactly; anything else is refused before `API.Fetch` is reached. A repository
component that takes the name `Fetch` is not that identity and acquires no
admission from it.

`<File>` is admitted only in its self-closing read form. The component reads
when it has no content and writes when it has some, so the two forms are two
identities and the constraint travels with the pinned one, decided in the
whole-fragment preflight rather than inside the component after earlier elements
have run.

Mutation-proposal admission and workflow-bundled Markdown component admission
remain unbuilt. Directory registration is not among them: a workflow Agent is
given no directory to register.

#### Sealed evaluation entries

A paired Evaluate producer uses an execution-owned one-shot projection that
bypasses public `content()` and `tryContent()` middleware. It renders under the
narrowed syntax reference while retaining its own operational permission.
Evaluate declares no `printErrors` boundary; its public refusal keeps throwing.

An entry states what is behind a name in one of exactly two ways, and neither carries a
function. A *capability* names the component canonical core supplies for it: capture
answers with core's own ordinary definition — the same `<File>`, `<File.Delete>`,
`<Dir>`, `<Glob>`, `<Fetch>` or `<Elicit>` an author writes — held to the execution's
lifetime, with the component's own form dispatcher travelling beside it so canonical
selection enters the body the scan chose. The operation it performs is therefore the
ordinary one, through contextual `API.Files` and `API.Fetch`, under the provider the
host installed and the effective `Permissions` of the consuming scope; the host hands
the profile no operation of its own.

A capability states what it binds wherever the ordinary component does because it *is*
the ordinary component, so an admitted `<Glob />` is the value component the ordinary
one is — sharing its props, return contract, source rules and sanitized failure
sentence, refusing a missing `as` and an unusable pattern before the search, and
resolving its paths against the contextual working directory.

One name runs one component, so a name admitted for capabilities owned by two different
components refuses at capture. An admitted `<Fetch />` is the one entry with a ceiling:
the element is classified against the entry's exact admitted requests, performs the
admitted one rather than its props, and that ceiling is installed as an ordinary
`Permissions` restriction for the invocation, so a contextual transformation that moves
the request off it is refused by the terminal rather than sent.

A *component answer* names an implementation the ordinary import chain resolves, and
states only the identity a provider must have registered for it; canonical execution
resolves that name once — before the root import and before any document code, through
the complete ordinary `Component.importComponent` chain and a private terminal that
writes no record — and asks the identity owner about the exact final answer in one call.
That call answers with the registered identity *and* core's own copy of what was
registered, taken when the identity was registered: the check and the thing kept are one
result, so nothing downstream reads the chain's object a second time and an answer whose
members read differently on each read cannot pass a check with one reading and be sealed
with another. The identity is then compared whole, and the copy — not the answer — is
sealed behind the same revocation.

One name states one identity, however many forms and tables hold it: two entries under
one name are the two spellings of one component and share one lookup and one sealed
implementation, while a second identity for that name, or a name held as both a
capability and a component answer, refuses at capture rather than letting assembly order
decide.

Provider installation and the right to answer one occurrence are separate: installation
receives a registrar that installs import middleware, and every invocation of that
middleware receives a fresh request fixed to the exact name, position, provider
installation, origin and resolution-window object it was asked under. Only that request
may register an identity, and it states the answer plus key and revision without
restating the name. Canonical execution closes the request synchronously when its
handler returns, fails or is cancelled; an outer request remains live while it delegates
and may register a replacement after the inner handler returns. Enclosing resolution
still closes in its own `finally` on success, fallback, failure or cancellation. A
registration therefore requires the execution, request and exact current window to
remain active, the request's fixed name to match that window, and that provider
installation not to have stated a different answer in the window.

Identification takes the expected window explicitly and accepts only a registration
recorded for that exact object and name, so a stale request cannot answer a later
same-name resolution or retag itself while another name is live.

The installation is reusable: one provider may answer several admitted names and
repeated resolutions through distinct requests. All of this state is held in ordinary
private closures — no Context, shared symbol, public brand or module-global registry —
and an unidentified middleware replacement remains a valid ordinary import answer
outside fragment evaluation.

A capability entry also states the exact version-1 identity strings it succeeds, which
is the only thing a released untagged record reconciles against; a component answer
states none. A capability-only profile performs no such lookup at all.

Resolution happens at capture and never again: a fragment runs the sealed snapshot, a
continuation resolves once more in its own capture and reconciles before any effect, and
a provider still answering when a fragment resolves its admitted name is answering a
generated import, which only canonical execution answers.

A trusted layering control may enter one package bootstrap through an inherited layer
and an execution-local one — documentation, registrations and the provider together —
and the repeat is additive: the outer entry observes and delegates rather than
registering a second identity for an implementation that already states what it is, and
a non-identical documentation overlap on one owner and component still refuses at the
child collection boundary, before the root import and therefore before the provider is
asked at all.

#### Workflow Agent capability selection

The workflow profile selects ACP-only capability explicitly: it advertises
neither native launch nor client-native attachment. It supplies no machine
session coordinator, construction-route store or executable observer. A workflow
session belongs to a run; the machine-wide ownership account describes a
different boundary. Deleting a run removes its mapping row and provider-session
directory and reports the categories removed.

#### Typed candidate recovery around Evaluate

Plan composes ordinary `<Let>` and `<Evaluate>`. There is no deadline, no output
budget and no bounds record: the composition adds recovery, not limiting, and an
ordinary invocation without it behaves exactly as it does today.

The composition owns the genuine invocation and projects its content through
canonical core's private projection. Neither public content middleware nor an
operation supplied by another loaded copy can author that projection. The
generated admission and effects retain occurrence-owned identities in the
existing ordinary durable sequence. The caller supplies no context, stream,
cursor, coroutine ID or durable owner. This is execution-owned invocation
routing, not a persistence capability.

The composition owns the live projection with Effection structured cancellation:
it establishes cleanup before resources can outlive the operation, and it
settles the child's success or failure only after that teardown. A private
invocation settlement callback reports cleanup failure before a recoverable
outcome can escape, so a cleanup failure always wins over a candidate retry.
This is local to the composed projection and does not change ordinary
execution's failure precedence. Caller cancellation remains cancellation.

See [component invocation settlement](#component-invocation-settlement) and
[whole-document execution ranking](#capability-backed-execution) for the two
surrounding boundaries.

Admission and generated effects use ordinary durable publication: each event is
persisted before its operation resumes. A safe refusal does not erase completed
effects. The projection and its structured teardown finish before Evaluate
returns or later parent work begins; interruption restores completed effects and
resumes at the first unrecorded effect.

Execution checks the closed evaluation records before completed-root reuse and
before public replay middleware can decide anything. Their structural
fingerprint binds the exact root source and inputs, candidate source, read
selection, ordered profile identities and forms, protected Syntax identity,
lexical reference and filesystem scope/policy identity.
Custom symbols providers state an immutable `identity`; captured Files state a
frozen `{ scope, policy }` `replayIdentity`. These identify permission, not today's
documentation, file contents or paths. Records contain data only, never providers,
live references, projection handles or callables.

Completed replay performs fresh installation and identity attestation, then
restores historical rendered output without repeating fragment bodies, Syntax
documentation lookups, File reads or Glob traversal. Missing or invalid current
attestation refuses before those effects. It does not reuse an expired attestation
or refresh information to validate history.

One narrow namespaced classification identifies the normalized recoverable
generated-request refusal and carries only a safe reason. Stale admission or malformed
retained history, and terminal setup, runtime, provider, persistence, secret and
cleanup failures, are not that classification and are never recovered.
Normalization reads the namespaced descriptive tag across loaded copies rather
than matching messages, and a plain `GeneratedXmdError` is not a recoverability
marker. Public Evaluate still throws; only the trusted surrounding operation
turns the one recoverable class into retry context after settlement.

### Plan information requests

Plan produces a program, Run executes a program from the host/CLI, and
composition decides whether and when a planned program runs.

Write `<Plan session="optional-name">…</Plan>` to author source in an ordinary
document. The shared writer frame uses `~/.xmd/plan/sessions` as its default
host root and one structural check, `validateDocumentStructure`, for draft,
admission and final-host validation. [The Plan contract](specs/plan-command-spec.md#the-plan-writer-profile)
owns directory placement, lifetime and the three validation times.

#### Delivery status and standing of this amendment

The current contract is below. Its earlier delivery sequencing is retained as
[Plan information-request history](specs/decisions.md#dec-017-plan-information-requests--delivery-history).
The [Plan specification](specs/plan-command-spec.md) owns the authored interface
and product verification.

#### One authorship workflow, one ordinary profile

Plan authorship obtains component documentation, file contents and matching file
paths through read-only generated XMD. The loop belongs to packaged `<Plan>`:
`xmd plan` and `<Plan>` in an ordinary `xmd run` use the same workflow. A complete
Plan remains inert source throughout classification, review and approval.
Reading information is not execution of the program being authored.

The command hosts supply the same ordinary evaluation profile before their
executions begin. Its always-on composition table admits core's exact `<Json />`.
Its read table admits canonical self-closing `<File />` and `<Glob />`, and exact
canonical protected self-closing `<Syntax />`. Its write table remains paired
File and self-closing File.Delete. The ordinary run's
write-enabled evaluations retain their existing behavior. Plan information
requests select only read:

```mdx
<Evaluate text={agentResponse} allow={["read"]} as="information" />
```

The complete Agent response is the generated program text. A literal child of
Evaluate instead runs while producing that text and is not this request
boundary. No Syntax-specific parser replaces generated-XMD admission.

The host installs the profile, not Plan. A component cannot install, replace or
widen its execution's captured profile. Shared Plan consumes the enclosing
profile; it introduces neither a Plan-private profile nor a child document
execution. Another trusted host's explicit profile remains authoritative and is
never replaced by Plan. Missing required installation is a host setup failure,
not a recoverable Agent mistake. This amendment changes the ordinary command
hosts, not the workflow host's independently installed profile.

The constrained coding-Agent session remains separate. It receives prompt data,
not native filesystem tools, a caller checkout, additional directories or a
permission escalation channel. An admitted XMD read is the ordinary `<File>` or
`<Glob>` on the ordinary contextual route — the installed provider, the
middleware around it and the effective `Permissions` of the consuming scope —
and it uses the ordinary run's contextual working-directory rules rather than
the Agent's empty session directory.

The writer frame refuses no read. The packaged workflow is trusted source and
reading is how it decides what to propose, so `checkFilePath`, `readTextFile`
and `globFiles` are absent from its refusal table rather than denied and
re-permitted for one phase: a read before, during or after an information
projection, and one from a concurrent trusted workflow task, are the same
ordinary operation, and an enclosing read restriction still denies all of them
before target I/O. What the frame does refuse is every way of changing
something — write, delete, directory ensure and temporary acquisition — plus
Process, Fetch and Service, wherever they are asked from. What bounds the text
an *agent* supplies is the generated admission it runs under: a draft is
unexecuted text, and an information program enters public read-only
`<Evaluate>` under the host's admitted vocabulary and complete preflight.

#### Protection, admission, selection and documentation

Canonical protection fixes which implementation answers for a name canonical
core owns. Five names are in that tier: Syntax, Evaluate, File, File.Delete and
Dir. Selection answers them above the repository, default and host tiers, and
the final `Component.importComponent` answer is verified against the copy
canonical execution retained — so a registration, a repository file, a bundle
member, a declared Markdown component, a middleware replacement and a
definition from a second loaded copy are each refused where they are made.

The two groups differ only in where the implementation comes from. Syntax and
Evaluate are built per execution from an invocation authenticator that execution
minted, because each is handed a site canonical execution built for it. File,
File.Delete and
Dir are ordinary components whose bodies reach the filesystem through
contextual `API.Files`, so each is one definition built once per loaded copy of
core and answered with as it stands — which is also the definition the
generated-XMD write table pins, so an authored element and an admitted
generated one invoke one implementation. Owning those three names fixes no
provider: Files middleware still answers, transforms, delegates and refuses
every operation they perform.

The host profile admits that exact implementation and self-closing form to
generated XMD. The authored `allow` selects an already-installed class as a whole; it
neither selects individual entries nor grants anything absent from that class.
Plan's read selection never selects write. A generated request cannot widen it
by naming Evaluate, writing another `allow`, or requesting documentation.

The enclosing lexical SyntaxReference carries the future-run documentation
index. Evaluate narrows availability against the union of the profile's trusted
composition table and the selected effect tables without discarding that index.
The ordinary profile's composition table contains the exact core Json
definition. It is always available inside generated XMD and carries no effect
operation. Bare generated Syntax lists Json beside the admitted read vocabulary:
Syntax, File and Glob under the ordinary profile. Named Syntax returns only the
requested documentation and marks components outside that vocabulary unavailable.
Availability of File does not admit its paired write form. Describing a
component neither imports it nor grants its effects.

Bindings and structural constructs are engine-owned language syntax and require
no profile entry. Every built-in construct is available inside a generated
fragment with its ordinary semantics — `Content`, `Output`, `Return`, `Let`,
`Each`, `If`, `Else`, `Switch`, `Case`, `Loop`, `Break`, `All`, `Spawn`,
`PrintErrors`, `Answers` and `Answer` — decided by the same source rules ordinary validation
and expansion read, so a construct means one thing whether a person or an Agent
wrote it. Preflight dispatches a reserved name to those rules before the
admitted table is consulted, which is why a construct is never reported as a
component the host withheld; a construct the generated root supplies no context
for, a stray branch, and a `<Break>` outside every `<Loop>` fail with their
ordinary structural rule instead.

Preflight walks every branch, every `<Case>`, every iteration body and every
nested region before the first effect, so a prohibited component in a path the
run never takes refuses the whole fragment with no read performed, while every
effectful component a construct reaches stays held to the selected permission.
What a value decides stays at runtime: a condition, a matcher, a computed `max`
and a failing read are evaluated where they always were.

Binding ownership is stated per region. Component children do not escape. An
`<Each>` body is a fresh scope holding the enclosing bindings and the item, and
nothing it binds survives it, because that body may run no times at all — only
`<Each as>` joins the enclosing scope. The alternatives of an `<If>` and the
`<Case>` branches of a `<Switch>` are checked from one incoming snapshot, so no
alternative supplies a binding to another; the union of what they can produce
becomes visible afterwards, which keeps reading a binding only one arm makes a
runtime failure rather than a preflight refusal. Each `<Spawn>` under an `<All>`
is checked from that same incoming snapshot and contributes nothing back, which
is the binding contract the children actually run under. `<Loop>`,
`<PrintErrors>` and `<Let>` bodies read and write the enclosing environment. Constructs keep their
exact spelling in the retained source, never join the retained named-component
list, and change no record version.

A trusted host may add another pure component only by placing
its exact definition and stable identity in the composition table captured
before execution. It is not inferred to be pure from its name, documentation or
absence from an effect table. Names and forms across composition and effect
tables obey the same conflict checks as effect entries, and continuation
reconciles the selected composition identities with the rest of the admitted
surface.

Each evaluation receives a fresh narrowed protected-body route. It closes with
the evaluation, before another Agent turn. Continuation verifies current
canonical identity and retained structural identity before rebuilding a route.
Same-name replacements, copied functions, middleware substitutions, another
loaded core copy and expired routes do not inherit protection. No protected
function, live profile, provider or capability handle enters durable history.

#### Classify the response before doing anything with it

Initial drafting, structural repair and review revision share one non-executing
classifier. A response is a draft when its first body block, after optional
lexically closed frontmatter and whitespace, is a non-empty level-one heading.
Both ATX and Setext headings qualify. Closed but invalid YAML followed by that
heading remains a draft; structural validity belongs to CheckDraft and repair.

An unterminated frontmatter envelope, no first H1, or a body block before the H1
makes the entire response an information candidate. Admission still decides
whether it is executable. Review-explanation responses are outside this loop.
No classifier strips fences, repairs source, executes a draft or replaces the
exact bytes delivered after approval.

#### Compose reads and render findings

One information response can bind several admitted reads and explicitly render
the result it wants to return:

```mdx
<Glob include={["**/AGENTS.md"]} exclude={["node_modules/**"]} as="paths" />
<File path="README.md" as="readme" />
<Syntax names={["Elicit", "File"]} as="syntax" />
<Json value={{ paths, readme, syntax }} />
```

Glob keeps its existing required `include`, optional `exclude` and value-returning
contract. With `as` it binds a sorted, deduplicated array of relative file paths
and renders no text. Generated evaluation supports ordinary fragment-local
bindings, structural constructs, declarative expression props over those
bindings, and pure components. It imports no caller bindings and exports none.
Executable fences,
imports and effectful components outside the selected permission remain refused.

Core exposes Glob through the same captured Files-capability path as File,
including captured glob operations, identity, authored form and revocation. It
does not call ambient Files middleware as a fallback. No Plan-specific discovery
parser or replacement Glob component is involved.

Evaluate renders the generated fragment exactly as ordinary XMD renders it. It
does not inspect component results or synthesize an observation collection. A
component written without `as` contributes its ordinary output; a component
written with `as` binds its result inside the generated fragment and contributes
no output of its own. Bindings are ordinary language constructs, remain local to
the fragment, and may be composed through pure components. An Agent that wants
structured findings authors that structure explicitly:

```mdx
<File path="package.json" as="package" />
<Syntax as="syntax" />
<Json value={{ package, syntax }} />
```

`Json` is a pure renderer, not an effect class. `allow` restricts effectful
component permission; it does not remove language constructs, fragment-local
bindings, or pure composition. Plan captures the fragment's rendered output with
ordinary `Let` and sends that text to the next Agent turn. Empty Glob matches are
an ordinary successful `[]` binding; they reach the next turn only if the
generated fragment renders them.

Generated expression props use a declarative data-expression subset rather than
the ordinary trusted-document JavaScript evaluator. The subset contains null,
string and boolean literals; finite JSON numbers, including a leading minus
directly attached to a numeric literal; fragment-local binding identifiers;
arrays and objects recursively formed from those values; and object shorthand
for a binding. Exponent overflow refuses. The leading minus belongs to the
number grammar; every other unary expression, call, constructor, operator,
assignment, spread, computed property, template and global access refuses in
whole-fragment preflight. Core parses this existing expression syntax with Acorn
and interprets the accepted nodes against the fragment's current binding
environment; it does not invoke `new Function()`. This is one reusable
untrusted-data boundary, not behavior special to Json.

Complete-fragment preflight rejects an unauthorized effectful name or form and
an unsupported executable construct before any read begins. File writes and
deletion, network, credentials APIs, tools, processes, Agents, elicitation and
services are not in the selected read table.
A later runtime read failure can follow an earlier successful read, but the
failed request supplies no partial findings to a later turn.

#### Recovery composes around Evaluate

Evaluate keeps its existing public props and its existing throwing behavior. It
gains no `limits` prop, and the evaluation profile gains no deadline and no
output budget. A profile states permission and nothing else.

Information requests add **no local deadline and no rendered-output size limit**.
Ordinary component behavior and the host's own limits are what bound the work,
and the command's existing `--timeout` continues to bound the whole planning
invocation. A request that reads a large file is an ordinary large read.
[#788](https://github.com/taras/executable.md/issues/788) owns a general
`<Timeout>` component as independent future work; this design deliberately adds
no one-off Plan timer and does not depend on that issue.

What Plan composes around the public component is recovery, not limiting:

```mdx
<Let as="findings">
  <Evaluate text={agentResponse} allow={["read"]} />
</Let>
```

Plan owns one fixed recovery policy: after the child's structured teardown it
turns the one narrow, typed generated-request refusal into retry context and rethrows
every other failure unchanged. That policy is Plan's alone. It is not another
evaluator, another document root, a special Evaluate result, or a new public
XMD component, and it adds no public `<Try>`, `<Catch>` or `<Finally>` surface.

One Plan invocation permits eight information requests total across drafting,
repair and revision. Successes and safe refusals each spend one. They neither
consume nor reset the ten-draft and three-repair budgets. The ninth candidate is
not evaluated and no next Agent turn starts. Review explanations do not spend
this budget.

#### Failure and settlement

Public Evaluate continues to throw. One narrow exported classification lets the
surrounding composition separate a generated-request refusal from
everything else. It carries only a safe normalized reason, is recognizable
across loaded package copies through the repository's stable namespaced
descriptive tag, and confers no permission to recover. Matching message text or
treating every `GeneratedXmdError` as recoverable is invalid.

After successful teardown, malformed candidate XMD, unauthorized names or forms,
declarative expression, binding, construct, form and prop errors, invalid Syntax
requests, invalid glob patterns, and ordinary read failures such as missing or
unreadable files become actionable refusal context. No refusal masquerades as
successful Evaluate output. Reasons contain only safe normalized diagnostics,
not raw host errors, resolved paths or secret material.

Caller cancellation, the command's `--timeout`, stale input or admission,
corrupt history, absent or broken providers, a Files provider that throws or
answers with malformed infrastructure data rather than an ordinary `Err`,
installation failure, journal failure, secret rejection and unexpected runtime
failure stop authorship without another turn. A failure during cleanup is
terminal even when the request refusal would otherwise permit a retry, so
settlement must expose that distinction before Plan normalizes a refusal.
Existing execution reconciliation, which can preserve an ordinary document error
ahead of ordinary teardown failure, is not evidence that this narrower contract
already holds.

The request owner acquires resources only after their cleanup is established,
owns every task and listener, and closes its capture and protected route before
returning success or refusal. No detached evaluation survives a later Prompt.
Cleanup of the whole Agent session still belongs to the enclosing Plan frame,
not to each information request.

#### Durable ownership and continuation

The Plan invocation owns request ordinals. The existing Agent response record
owns the exact candidate source, ordinary durable component records own the work
the fragment performed, and the authored `Let` binding owns the rendered
findings supplied to the next Prompt. Evaluate introduces no parallel
observation or result record.

Evaluation and its internal admission/read records use occurrence-owned
identities in the existing execution's ordinary durable sequence. This is
journal composition, not a child document execution or profile installation.
Canonical execution supplies invocation identity and protected routes; no
caller-controlled DurableContext, stream, cursor, coroutine ID or durable owner
participates. Plan does not install a transient execution around its content.

Each admission or effect record is appended before its operation resumes and
becomes ordinary replay history immediately. Evaluate does not stage, hide,
publish or discard another component's records and changes no persistence
contract. Two Evaluate occurrences cannot consume one another's retained work.

A completed request replays without another Agent turn, fragment body, Syntax
lookup, File read or Glob traversal. Re-entry needed to validate structural
identity is not permission to repeat those effects. Interrupted work resumes
through ordinary replay: completed effects restore and the first unrecorded
effect runs. The generated projection and its structured teardown complete
before Evaluate returns and before later parent work begins. No incomplete
rendered findings are presented to the next Agent turn.

Replay admission verifies both successes and refusals before any completed
invocation or root is reused. The fingerprint binds source, selected classes,
ordered admitted identities and forms, lexical documentation-reference identity,
and filesystem scope/policy identity. There are no bound values to compare.
It uses stable structural identity, never function serialization or replaceable
context state. Extra effect-description fields alone do not enforce comparison.
Changing any bound fact is stale before another turn or read. Absent, malformed
or inconsistent records fail closed, including a retained refusal for different
source. Authoritative checks cannot be skipped by public replay middleware.

Unchanged completed findings remain historical information. Replay does not
refresh documentation, file contents or directory listings to compare them with
today's world. A different admitted provider/reference identity is stale; a
historical answer is not silently recomputed. The command's `--journal` remains
write-only JSONL and starts fresh; continuation belongs to enclosing durable
uses of the shared Plan component.

#### Product interfaces

The [Plan interface owner](specs/plan-command-spec.md#information-request-messages-and-disclosure)
contains the exact Agent instructions, follow-up/refusal messages, progress and
help disclosure. Admission and settlement above explain why those messages
follow teardown and the execution-owned secret check.

#### Product verification

The [Plan acceptance matrix](specs/plan-command-spec.md#acceptance) owns PI1–PI12
and their incomplete-implementation controls, alongside the command and
component journeys. The current architecture defines the invariants those
journeys demonstrate; it carries no second product-verification matrix.

#### Delivery order and deferred access policy

The delivery sequence is [historical](specs/decisions.md#dec-017-plan-information-requests--delivery-history).
The current implementation uses one shared ordinary profile, ordinary generated
structural constructs and the packaged Plan loop described above. Later
question-based Syntax selection (#787), a general Timeout (#788), workspace
selection and approval policy (#777), path-replacement hardening (#227) and
separate evaluation work (#679) do not change the current contract.

## Resolution and extension

Composition selects behavior, while canonical execution retains the decisions that middleware cannot replace. The following boundaries spell out that division.

### Authoritative behavior

**Authoritative** behavior decides what an execution *is*: whether it runs at
all, what history it may replay from, what options it runs under, and what it
settles to. **Non-authoritative** behavior observes, narrows, refuses, or adds —
it can stop something from happening and can make a success into a failure, but
it cannot bring an execution into being, substitute one, or rescue one.

Public middleware is non-authoritative by construction. `Execution` and
`ReplayGuard` handlers compose lexically, and a handler installed further out
may answer without delegating — so anything they could decide would be decided
by registration order. They may refuse; they may not complete.

#### Capability-backed execution

`Execution.init(): Operation<void>` establishes live dependencies once in each
existing execution-owned scope. Its public default is no-op; middleware installs
ordinary package behavior and delegates. Core invokes it after copying trusted
host contributions and arming their revocation, before provider/installation
callbacks, documentation capture and public execution policy. Setup receives no
installation array, request, entry identifier or receipt and creates no second
execution owner.

Initialization failure prevents policy, root import and body. Failure and
cancellation join partially acquired teardown before the invocation settles.
Ordinary descendants inherit initialized state; concurrent executions and REPL
entries own distinct state. Completed handle observation initializes nothing.
An isolated run child reinstalls the selected host/Plugin middleware after cwd
assembly; arbitrary parent handlers do not cross that isolation. REPL Agent
attachment and durable preparation are owned and ordered elsewhere, and
initialization neither replaces nor reorders them.

Canonical core is authoritative for document execution. It invokes the stable
`Execution` middleware through a private, per-invocation same-name Api whose
instance-owned default handler is the authoritative terminal. A stable name
shares the middleware context, so every public handler — including one installed
through another loaded copy's descriptor — composes exactly as it always did;
what a name does not share is the default handler, and that is where the decision
sits. The exported `Execution.execute` default always refuses, so calling it
with a captured request settles nothing.

`Execution.execute` middleware is handed an opaque `ExecutionRequest` and
returns nothing: it may
inspect the options, narrow them, register an additive completion policy,
install contextual behavior, refuse by throwing, and delegate. The document is
run afterwards, by the invocation that issued the request, under the options the
canonical terminal recorded.

Terminal acceptance stores a detached, immutable structural snapshot of the
options: the containers are copied and frozen while the operational identities
inside them — the selected `DurableStream`, each modifier factory — are carried
across unchanged. The chain unwinds before the document runs, so an outer
handler that delegates and then edits what it delegated changes only its own
data. Replacing options before delegating, through `withOptions()`, remains the
supported path.

Each invocation owns a child scope, held by one structured owner task, and
**settlement closes it** — on success, on failure, and on cancellation alike.
Contextual behavior an installation establishes is visible to the document and
to its teardown, isolated from a concurrent invocation, and absent from the next
execution in the same host scope. The final `Result` is published only after
that scope has finished tearing down, so a caller continuing on the completion
continues after cleanup, and a completed handle carries no live scope.

A document outcome and an invocation-teardown failure are kept apart until the
scope has closed and then ranked, never replaced: a durability failure wins from
wherever it came and is returned by identity, then a Files infrastructure
failure on the same terms, then an existing document failure, and only a success
is converted by teardown. Every finalizer runs, exactly once, before the result
is observable. Once a handle exists, teardown contributes to its `Result` rather
than escaping as a thrown completion. Canonical
core constructs the one authoritative handle; it exposes the inner execution's
replay-safe output directly rather than bridging it through a second channel.

The request is the capability, and it is **one-use**. It carries a private
reference to one invocation; a reconstructed look-alike, a superseded request, a
foreign invocation's request, and a second delegation are each refused with a
fresh, cause-free `ExecutionProtocolError`, before any journal read, expansion
or append. Reaching the end of the chain without consuming the request is the
same refusal.

#### Capability-backed document expansion

The same division holds for `Execution.document`, with one structural
difference: the `execute` chain records the options and **unwinds before** the
document runs, while the `document` chain **surrounds** canonical document
execution. A handler is therefore running while the document is, which is why
its reach has to be bounded on more than one side.

A handler is handed an opaque `DocumentRequest` and returns nothing. It may read
the props (`request.props`), narrow or replace them (`request.withProps()`,
which supersedes the request it was derived from), install contextual behavior
the document will inherit, refuse by throwing, and delegate. It cannot produce a
document. Canonical core runs the expansion through a private, **per-expansion**
same-name Api whose instance-owned default is the terminal, keeps the outcome
that terminal produced, and publishes only that; whatever a handler returns is
ignored. The exported `Execution.document` default always refuses, so calling it
with a captured request expands nothing and consumes nothing.

The request is one-use and belongs to one expansion. A reconstructed look-alike,
a request a later `withProps()` superseded, a request another expansion issued —
including one still live in a concurrent invocation — a request already
delegated, and any value that is not a request at all are each refused with a
fresh, cause-free `DocumentProtocolError`. A refused delegation consumes neither
the request nor the expansion, so the handler may recover and delegate a valid
one.

A refusal stops what has not happened yet; it does not unwind what has. An
invalid delegation authorizes no root import, no expansion and no authored
effect — and the durable root still records the refusal as its own terminal,
because that is what the run turned out to be. A second delegation adds no
second expansion, import or authored effect, while the work the first valid
delegation already did stands. A preparation refusal prevents every later
preparation, all document policy, the root import and every authored effect,
while durable effects earlier preparations completed stay retained and are not
rolled back; the root records the refusal as its terminal.

A failure raised before the root import is whatever a handler or a preparation
threw, which is to say: anything. Describing it is therefore total over unknown
and hostile values, and the boundary is a specific one:

- **Nothing is coerced.** `String(value)` is a call into whatever the value
  decides `Symbol.toPrimitive` means.
- **No member is read without tolerating a refusal**, and that includes
  classification itself: `instanceof` consults a `Proxy`'s `getPrototypeOf`
  trap, and prototype and own-property checks are calls into the value too. A
  member that will not be read is simply absent.
- **A trap failure never replaces the failure being handled**, never escapes,
  and never stops the bound terminal from being written. Text a trap planted
  does not reach the result, the journal, the diagnostic, the stack or the
  cause.
- **Diagnostics obtained safely from an ordinary `Error` — its name, its
  message, a string cause — are recorded.** That is what makes a replayed
  failure describe the one that happened, and what is recorded stays subject to
  the journal's existing security boundary like any other recorded value.
- **A value that will not describe itself is recorded under a fixed core-owned
  name and message.**

What crosses the completion boundary as itself is decided by **provenance, not
inspection**. Inspecting an untrusted value cannot establish that publishing it
is safe: an accessor or a `Proxy` trap may answer harmlessly while core is
looking and throw when the caller reads the same member afterwards, so a value
that passed inspection is only a value that behaved once. Publishing it would
move the trap into whoever reads the result.

So an ordinary value thrown by public `Execution.document` policy or by trusted
durable preparation is **always** converted into a core-owned error built from
the total description above — which keeps whatever the failure gave up safely,
and can be read as often as anyone likes.

Only a durability or Files infrastructure failure crosses by exact identity, and
those are not converted at all. Everything else the completion publishes is a
value this run constructed.

A canonical protocol refusal keeps its classification and its original
diagnostic, and it does so **without** publishing the object middleware saw.
Provenance says where an object came from; it does not say what the object still
holds. A handler can catch the very refusal the expansion raised, replace its
members with throwing accessors, and rethrow the same object — still core's
object, no longer core's diagnostic. So the expansion records the *reason* it
refused beside the identity it raised, and the completion publishes a fresh
`DocumentProtocolError` built from that reason. The returned object is never
read. The record is private to the expansion — no brand, stable name, shape,
ambient state or module-scoped registry carries it.

Reuse is authorized by the **complete** form core writes here, not by the
binding alone. Core reaches this position only by failing, so a recorded success
carrying a copied binding is a record it could not have produced. Admission
parses the whole terminal — one recorded completion, on the root coroutine, with
no root import, an outer settlement core returned rather than threw, an inner
result whose status is `err`, the canonical failure shape — including the two
places core writes the same message — and exactly one
well-formed binding agreeing with the requested root. Every other form is the
fixed cause-free unreadable-root diagnostic, and nothing planted in journal data
escapes through it.

A terminal core creates *before* the root import carries a binding to the exact
root source and target it was about. Core builds that binding from the root
source this execution was given and parses it on the way back in; nothing a
host, a document or a middleware package supplies can reach it. Root-history
admission validates it before any terminal is reused, so an identical execution
replays the recorded failure — running no preparation, no policy, no import
and no authored work, and appending nothing — while a different root source or
target is refused, and a missing, malformed, duplicated or conflicting binding
fails closed. A partial history is re-entered: a preparation that already
recorded a durable effect finds it retained and restores it rather than
performing it again, and a refusal that follows records a fresh terminal. A history with no recorded completion is unaffected: it continues
live, and preparation runs again through the ordinary durable protocol.


Terminal acceptance stores a **detached** structural copy of the accepted props:
objects and arrays are recursively copied and frozen, `"__proto__"` is carried
as an ordinary data member rather than assigned, and no container the caller
still holds is retained. Anything that is not JSON, and any object that resists
being read, is refused as a `DocumentProtocolError` built here rather than
rethrown — so neither a hostile trap's message nor the value that produced it
reaches the caller.

Detachment reads caller-controlled objects, which means it runs caller code: a
getter, an `ownKeys` trap and an array's own accessors each get a turn while the
copy is being built, and any of them may call `withProps()` and return normally.
So lineage is verified **again** on the far side of detachment, before
acceptance is recorded. A request superseded from inside its own detachment is
refused, consuming neither it nor the replacement, and the replacement settles
the expansion normally.

The canonical outcome and a failure raised **after** delegation are kept apart
until both exist, and then ranked on the same terms an invocation is ranked
against its teardown:

1. a durability failure wins from wherever it came, by exact identity;
2. otherwise a Files infrastructure failure wins, on the same terms;
3. within one kind the earlier failure wins, and canonical execution is always
   the earlier one;
4. without a fatal failure, an existing ordinary canonical failure remains
   unchanged; and
5. only a canonical success is converted by an ordinary later policy failure.

A failure canonical execution raised is authoritative whether or not middleware
lets it propagate: catching it and returning normally leaves it exactly as
final. A refusal *before* delegation, and a document-protocol violation, fail
normally — there is no canonical outcome for them to be ranked against.
Cancellation keeps structured teardown semantics and is never reported as an
ordinary policy failure.

#### Capability-backed bound commands

`exec as="name"` turns a command's exit status into data, so two facts decide
what a document ends up believing: that the block is bound — which is what
holds its chain to the built-in exec terminal and the built-in `timeout` — and
what the process settled to. Neither is block data.

`Component.applyModifiers` and `Component.codeBlock` are supported override
surfaces, and what passes through them is middleware's to rewrite or to answer.
So a bound block is asked for through `applyBoundModifiers`, with a one-use
request canonical core issues and consumes. The request retains the authored
modifier chain and the block context; both are frozen when it is issued. Public
middleware composes around the operation on the same terms it composes
anywhere: it may observe the request, refuse by throwing, and delegate. It
cannot produce the command. Canonical core authorizes and composes the retained
chain and runs it against the retained context, so a rewritten, mutated, copied
or fabricated request — and a `codeBlock` handler answering with another block —
runs nothing rather than running something else. The outcome goes to the
expansion that issued the request rather than through the operation's return
value; a handler that does not delegate leaves the command unrun and nothing
bound; and a failure canonical execution raised stays raised whether or not a
handler catches it.

Where canonical execution and the middleware around it each failed, the two are
ranked on the terms an invocation is ranked against its teardown: a durability
failure wins by exact identity wherever it arose, then a Files infrastructure
failure, then the earlier canonical ordinary failure. A later ordinary failure
replaces only canonical success.

Authorization inside that chain is by factory identity, not by registered name.
A registry answers a name with whatever was registered under it, so admitting
`timeout` or `exec` as words would let `ExecuteOptions.modifiers` substitute the
middleware a binding contract names. Ordinary blocks are unaffected: a document
still reaches a registered modifier by name, a replaced `timeout` included.

#### Capability-backed invocation identity

A component that names a durable operation after itself decides which retained
record a replay restores, so two invocations arriving at one name each replay
the other's work, and an implementation running under somebody else's identity
commits against its own storage under their expansion. A decision like that
never trusts replaceable state (*State across loaded copies*), and every channel
a component could *read* one from is replaceable: a context is addressed by
name, a contextual Api answer is composed by whoever installed a handler, and
the registry is an answer a handler may keep from one attachment and hand back
inside another, record and all.

So nothing is read. A trusted host **declares** to the execution which of its
components name durable work, on the terms every other trusted-host value
travels: read once and copied before any installation runs, so what may name
durable work is fixed before installed code, middleware or a document exists
(*Trusted host orchestration*). The execution mints one domain per declared
component, calls that component's factory with the domain's **invocation
authenticator**, and registers what the factory returns through the ordinary path — validated like
any registration, and activated only once that batch has committed, so a refused
registration leaves an invocation authenticator that answers for nothing. It
exists as the argument of that one call: not published, not named, not reachable from a
document, and not derivable from anything a handler holds.

**The invocation carries one readable fact, for the same reason.** How the
element was written — `<C />` against `<C>…</C>` and `<C></C>` — is a property
of the invocation rather than of the surroundings it runs in, and a component
whose two spellings select different *effects* is choosing with it. The
contextual `Component.hasContent()` answers the same question through the
composable chain, where the outermost handler answers first and may answer
differently on each call; a caller that checks it and then invokes something
which asks again has verified nothing, because the two are separate dispatches.
So `ComponentInvocation` reports the authored form directly: synchronous,
immutable, projecting nothing and spending no identity, held as owner-kept state
inside canonical core and reachable only through the object the engine minted.
There is no context, map, registry entry or exported lookup beside it, and
implementing the method does not make an object an invocation — durable identity
remains the private field an invocation authenticator recognizes.

Reading the method is not authenticating the object, and neither is a component
able to authenticate it. A component is handed whatever its caller passes, so a
wrapper can mint an object literal carrying a method of that name and every
check expressible against the shape is one a forger satisfies by construction.
And a reader that recognized an invocation by private state would recognize only
the copy of core it was imported with — while a component can be loaded from
disk beside its own copy, which is what the compiled CLI does for
`--include`. Copy-local authentication and caller-visible behavior are the
two wrong ownership sites.

So **invocation-form dispatch** owns it: the canonical, engine-owned association
between one exact selected definition, the authored form from the scan, and the
only body that form may enter. A form-sensitive component declares which bodies
it has — form-insensitive, self-closing only, paired only, or two selected by
form — and canonical core turns that declaration into a dispatcher, in the copy
performing the execution. The bodies stay behind it and never travel on an
import answer. A call enters one only when the invocation is an object this copy
minted, the issuance is live and in its own frame, and canonical resolution
selected this dispatcher for that import; otherwise the component's own refusal
is raised, before its body, `Env.cwd`, its content, or a provider.

Core's `<File>` is dual-form, core's `<File.Delete>` is self-closing only, and
core's `<Dir>` is paired only. Each is irreversible in one
direction: a `<File />` reported as content-bearing would render an empty string
over the file the document wrote a read for, and a paired `<File.Delete>`
reported as self-closing would remove the path its children were written beside.
Neither is reachable, because neither component reads the form.

`ComponentInvocation.hasContent()` stays what it was for observation — a fact
about the element, readable across loaded copies, and the only thing a component
importing nothing at all has. It is not an effect permission.

The contextual operation stays exported and composable, and every other
component still reads it. That is not a statement that the remaining readers are
safe. Eleven of them branch on it, and the branch decides more than how to
render: `<Issue>` selects a read against an external upsert, `<Repository>`,
`<Worktree>`, `<TempDir>` and `<IssueTracker>` decide whether a context or a
working directory is installed for their descendants at all, `<Git.Add>`,
`<Git.Push>`, `<Git.Switch>` and `<Json>` turn a content-bearing invocation into
a refusal, and `<Git.Commit>` and `<PullRequest>` decide what body is committed
or published. Each reads the contextual answer, so middleware may alter the
effect, the guard or the retained data each of those branches decides, and this
invocation boundary makes no stronger guarantee for them.

**Which domain an invocation is in is decided by what resolution selected, not
by the name that was asked for.** An authored name is what a document wrote, and
what it resolves to is decided by tiers, registrations and middleware, so a
matching name says nothing about which registration answered. What settles it is
the selection itself, recorded where it is made:

- expansion opens an **execution-private import frame** before it asks the
  public import chain anything, and hands it to the terminal it builds for that
  one import;
- canonical core resolution records, inside that frame, the exact name it was
  asked for and the exact implementation it selected — the function object this
  execution built from the host's factory, by identity;
- the frame yields a domain only when exactly one canonical selection happened
  in it, for the name expansion asked, and it selected that execution's own
  trusted implementation;
- an import nobody delegated, one delegated for a different name, one delegated
  more than once, one whose name a registration shadowed, and one that selected
  any other implementation each yield no domain.

Nothing about this travels on the answer or through the chain. A public
definition, a registry answer, a Context and a contextual Api carry no
provenance and no permission: what a handler decides is which implementation
runs, and an implementation running where canonical resolution did not select it
names nothing. Nested and re-entrant frames stay contained, because a frame is
opened per import and settled the moment that import answers, however it
answered; and a replay decides the same way, against this execution's own
factory-created implementation rather than against anything a previous run
recorded.

**A frame is owned by the import's own terminal, not by an Effection scope and
not by the execution.** `<All>` gives two `<Spawn>` children imports in flight at
the same time, so "the frame this selection belongs to" can be neither "the last
one anybody opened" nor "the one opened where this code happens to be running".
Each import creates its own frame and its own `Component` Api descriptor whose
core `importComponent` handler closes over that frame; the engine asks through
that descriptor, and the selection is recorded by the terminal `next` reaches:

- the descriptor carries the same stable Api name as the public one, so it
  receives the same installed middleware in the same order — **a stable name
  shares middleware, and shares no terminal authority**;
- the resolution that terminal performs is the execution's own, handed to
  expansion as an internal argument beside the execution environment rather than
  on it, and carried by every recursion that can invoke a component — so a
  component body, a branch and a spawned child resolve the way their execution
  does, while an expansion driven directly and a generated fragment are handed
  none and answer through the ordinary public chain;
- middleware may observe, delegate, replace or refuse the answer, and may run
  `next` in any descendant scope: `next` still terminates in the terminal that
  dispatch was created with, so delegating through a scope of its own keeps the
  identity;
- sibling spawns resolve through different descriptors, so one spawned child's
  selection cannot land in another's frame, and closing or cancelling one
  neither clears nor authorizes the other;
- nesting is unchanged and needs no stack: an inner authored import is its own
  dispatch with its own terminal, so the outer one is neither shadowed nor
  inferred from scheduling;
- a handler that starts an import of its own by calling the public operation is
  making a **separate** import, not delegating the authored one — it may resolve
  normally, and it grants the authored import no identity; and
- two selections in *one* frame — a handler delegating twice — still yield no
  domain, which remains the safe direction.

The frame is a closure and nothing else: it is in no map, under no key, and
reachable only from the dispatch that opened it. Nothing is published, keyed or
read from — not a scope, not a context, not a token, and not a durable coroutine
id, which non-journaled expansion does not have. A counterfeit descriptor made
with the same Api name changes only what is asked through that counterfeit; it
cannot become the terminal of the engine's own call. Live expansion and replay
decide this the same way.

Canonical answer windows are owned the same way and by the same kind of value —
an explicit object rather than a scope — but serially: component answers are
resolved in one capture phase before any document expands, so one window is open
at a time. Each provider request captures that window object before its handler
runs, a publication presents it back explicitly, and a handler delegating through
a descendant scope answers the resolution it was opened in. A provider publishes
the definition and nothing else: which identity and effect each of its spellings
runs as is on that definition, declared by whoever owns the implementation, so
there is nothing beside it for a reader to reconcile. One installation may
answer more than one import with the same definition — a reusable provider owns
one object and a publication is per window — and a second, *different* answer in
either still refuses. Concurrent document imports happen after capture, with no
window open at all: such an import may be answered as ordinary middleware, and
acquires no admitted identity.

The engine then mints one issuance per invocation, carrying that domain — or
none — the authored name for what a refusal says, and the frame the body is
about to run in. An invocation authenticator answers only for an issuance that
satisfies all of it:

- **its own execution's**, still running — an implementation kept past teardown,
  or built by another attachment, answers for nothing;
- **in its own domain** — an implementation belonging to another component, or
  running where resolution selected something else, names nothing here;
- **live** — an issuance kept from an element that has finished names nothing;
- **not projecting** — expanding its own content is the only way anything is
  nested inside an invocation, so an invocation names nothing while it does,
  which is what refuses a live ancestor's issuance routed into its content;
- **in this frame** — an issuance belonging to another invocation of the same
  component, running concurrently in a frame of its own, names nothing here;
- **unspent** — one invocation names one durable operation.

An import wrapper may forward the genuine invocation, which is ordinary
delegation and stays supported. Everything else refuses, and none of the
refusals depends on a value a handler can carry: middleware may replace what a
name resolves to, keep an implementation, and hand a whole registration record
back inside another execution, and what an invocation may name still comes from
the execution that minted it and the resolution that selected it.

#### Capability-backed nested execution

A Markdown test may run another document as a real root — its own root import,
its own journal, its own scope and teardown. Nothing else may, and the boundary
is not a name: a repository `Test.md`, a package registering `Test`, a component
called `Execution`, and every middleware installed anywhere are all outside it.

The harness is minted where the same decision is already made for a checked
command failure. Canonical core recognizes its own `<Test>` definition
structurally, and an invocation of *that* definition mints one opaque harness,
scoped to the invocation. The object carries a private field, so nothing can
construct one, and it expires when the invocation is dismantled, so nothing can
keep one. Each nested execution spends a single-use authorization derived from
it; a second spend, and a spend after the test has finished, are refusals.

**The harness is delivered, never published.** There is no reader, no exported
accessor, and no context holding one: a capability reachable by name is one
every same-name context, every loaded copy and every component running
inside a test can take, and contextual surfaces here are policy and composition
only. A trusted host attaches a **test harness installer** to the execution — a
plain function it holds and passes, beside its admissions and preparations — and
canonical `<Test>` calls it, inside the invocation, with that invocation's
harness. What the receiver does with the capability is close over it: the
definitions that can run a child are the ones that were created with it in
scope, registered in the invocation's own frame where they shadow a refusing
default for exactly that test's body. Nothing asks for the capability, so
nothing is refused a request for it; a document whose host attached no installer
has no nested-execution capability anywhere in it.

The installers reach `<Test>` through a context, because a component function is
reached through the engine and there is no other way down. That context carries
no capability — it holds the host's functions, and calling one requires a harness
only canonical core mints — and it is branded, so a value planted under the same
name is refused rather than delivered to. A shadowing attempt therefore ends
with no harness installed, which is the safe direction.

The harness asks a **host profile** for its child through a request, and for the
reason every other capability-backed surface here does: a handler given the
child could answer without delegating, and its invented answer would *be* the
child — no root imported, no journal written, and an assertion body passing
against nothing. The trusted provider is attached as a value before untrusted
installation, middleware or document code begins, captured by the test-harness
installer, and closed over by the authorized definitions canonical `<Test>`
registers for its body. A public handler may read the immutable profile, refuse
by throwing, and delegate the exact request once. It cannot replace target,
source, props, action or journal policy, and it never receives the provider.
Only the invocation's own terminal reaches the captured provider, and only the
outcome that provider reported is published.

Binding is the same kind of invocation-owned capability. `<Execution>` receives
from the engine a private binding channel for its exact invocation: it answers
whether `as` was written and accepts one early publication of the child outcome
before the assertion body expands. It exposes no name and no environment, and it
does not travel through the public `Component` Api, Context, props, component
metadata or a stable name. Public component middleware therefore cannot turn an
unbound failed child into test data, suppress publication, or make assertions
observe a synthetic completion.

The child's scope does not descend from the document that ran it. That is not
isolation for its own sake: a child is a *root* execution, and everything the
outer document installed — its testing session and its one-execution guard, its
output routing, its service adapters, its contextual providers — is contextual
and would otherwise be inherited. Ownership is unchanged: the outer invocation
destroys the child's scope, so cancelling or completing the test halts the child
and waits for its teardown before the test proceeds.

Configuration is installed before the child's root is imported. The harness
reads its own children in two passes: a scan that expands the declaration prefix
and stops where assertion content begins, and — after the child is over — the
ordinary pass in which the declarations answer with what they observed and the
assertions run. A component declaration is recognized by the definition it
resolves to, so a repository component of the same name is ordinary content and
the scan ends where it is written. A structural declaration is recognized only
where canonical grammar owns it; a same-named repository file cannot become
one.

Journal configuration and journal observation are separate. A run without a
diagnostic declaration retains nothing and allocates no journal because output
was displayed; observation grants no retention, and asking to observe a journal
nothing selected is malformed configuration that fails before the root import.

A `run` child may receive deterministic Agent behavior and elicitation answers
through two more declarations in that same prefix. `<TestAgent>` contains only
its `<TestAgent.Scenario>` declarations there, and `<Answers>` contains only its
`<Answer>` matchers. Each wrapper may appear at most once for one `<Execution>`.
They reuse the existing TestAgent scenario and Answers matcher contracts; this
placement changes where those declarations apply, not what either language
means. `<Answers delegate={true}>` is refused in this position: a test that
supplied answers does not fall through to the run profile's live WebForm.
The TestAgent declaration is recognized only when ordinary resolution selected
the package's exact definition; a repository `TestAgent` is ordinary assertion
content and configures nothing. Answers is core's reserved structural syntax,
so a same-named repository file never becomes its declaration.

The declarations belong to that exact child. They are parsed and detached
before the host-profile request is issued, installed before the root import,
and discarded only after the child and its provider teardown finish. A sibling
`<Execution>` receives a fresh TestAgent partition and a fresh answer set, even
under the same canonical `<Test>`; a session never continues from one child
into another. Cancelling the owning test halts the child and waits for both
providers to finish before any assertion or sibling proceeds.

What crosses the boundary is frozen test data: normalized scenario
declarations, behavior-document sources and answer matchers. No Agent provider
factory, Elicitation middleware, Context value, Api handler,
`ExecutionInstallation`, controller or scope crosses it. The trusted host
profile consumes that exact data and constructs the deterministic providers
inside the isolated child scope. Public host-profile middleware may inspect or
refuse the immutable request on its existing terms; it cannot replace the
configuration, construct a provider or publish a child outcome.

A TestAgent declaration installs the same controlled Agent provider, native
launcher and complete seven-word Agent surface that `<TestAgent>` supplies to
an ordinary test, including the execution-declared `<Session>` identity. An
Answers declaration installs its matcher provider nearer than the run profile's
WebForm and never delegates an unmatched request to it. Without either
declaration, the run profile behaves exactly as it does without this feature;
nothing installed in the outer test crosses the isolation boundary implicitly.

These declarations do not reserve or seal any child component name. The child
keeps ordinary `host="run"` resolution: repository components may shadow
`Session`, `Prompt` and the other Agent defaults. The declarations configure
the provider the selected first-party components can reach; they do not force
those components to be selected. A host that needs a closed first-party
orchestration establishes that separately as part of that host's own execution
contract.

A controlled `<Plan>` may author an exact scenario label that the test host
alone maps to Plan's derived conversation identity. Declaration selection uses
the label; runtime state remains keyed by the opaque identity and child. This
adds no matcher or fallback to ordinary TestAgent sessions.

Scenario source, provider-private behavior journals and answer configuration do
not enter the child journal. A selected first-party Prompt or Elicit still
records its ordinary durable result through the child's production journal and
secret gate, so replay reaches neither deterministic provider.

#### Trusted host orchestration

A **trusted host** is the code that decides what an execution is for — a CLI
entrypoint, a workflow runner — as distinct from the document, the components it
expands, and the middleware packages composed around it.

A host attaches requirements to one execution through
`@executablemd/core/host`: `executeInstalled(options, installations)`, where an
installation carries `admissions`, the components whose implementations name
durable work after their own invocation, and an optional `install()`. Admissions
and declared components are
copied and frozen **before** any installation runs, so what ends up
authoritative is fixed before any installed code, any middleware and any
document code exists. Each runs inside the execution's own journal read, on the
retained snapshot, in capture order, stopping at the first refusal — ahead of
root-history admission, `ReplayGuard`, terminal reuse, authored work and any
append.

Admissions are refusal-only functions: they receive the retained history, return
nothing, and never receive a `next`. They travel as values the host holds and
passes — not through a context, an Api, a stable name, structural metadata or
module-scoped state — which is why a separately loaded package composes here by
handing over a closure rather than by agreeing on a name, and why no middleware
can read, transport or remove the collection.

A declared component travels the same way and for the same reason. What the host
supplies is a factory, not an implementation: the execution calls it with the
invocation authenticator it minted for that component, so the capability is delivered as the
argument of one call the execution makes, and what a document, a component or
middleware can reach afterwards is the implementation alone (*Capability-backed
invocation identity*). A host that declares none has no component that can name
a durable operation after its invocation, which is the safe direction: core's
own `<Session>` is declared this way rather than registered with the other agent
words, so a document run by a host that never mentioned it has no `<Session>` at
all.

#### Trusted durable preparation

An installation may also carry a `prepare` hook — `DurablePreparation`, the
trusted durable work a host performs *inside* the durable root. It is read
exactly once and captured by value at the same moment admissions are, and the
collection is copied and frozen, so replacing or removing the property from
inside `install()` changes nothing. It travels as a value on the same terms an
admission does, and is reachable through no context, Api or name.

Preparations run in installation order, stopping at the first refusal, **after**
retained-history admission and **before** any public `Execution.document`
policy, the root import, and every authored effect. They are `Workflow`
operations, so what they record is journaled: on a completed terminal replay the
durable root is already settled and no preparation runs at all, while on a live
or partial continuation they run and record through the ordinary durable
protocol — an effect an earlier preparation already completed is restored from
its retained record rather than performed again.

#### The weak journal-provenance association

Journal provenance is the one further exception, and it is deliberately narrow.
The canonical durable-streams module keeps the association between a stream and
its witness in a module-local `WeakMap` keyed by exact stream object identity.
It qualifies only while every one of these holds:

- the association carries a non-operational, equality-only witness and grants
  no append, read, execution, publication or reconciliation capability;
- keys are exact objects held weakly, the association cannot enumerate them,
  and it cannot keep a stream alive or outlive that stream;
- the association is unreachable through structural properties or stable
  contexts, and a separately loaded package copy can neither read nor transfer
  it;
- establishment and transfer occur only through the canonical module's
  `establishJournalProvenance()` and `preserveJournalProvenance()`, one fresh
  witness per stream, with duplicate establishment refused;
- transfer happens only at a trusted wrapping site — one installed before any
  code the journal's content could influence, delegating to the exact stream it
  was handed. A document execution's journal passes through two: the secret
  filter and the execution-owned admission wrapper. That second wrapper holds a
  resumed run to its recorded root selection and, in the same read, applies
  whatever an installation required of the history through its `admissions` —
  workflow-run identity among them. Requirements are contributed to it rather
  than wrapped around it, so no wrapping site is added and none of them is
  reachable by middleware. Each transfers only what its source already had, so
  an unproven journal stays unproven; and
- it retains no execution, lifecycle, journal content or provider state.

The exception exists because the exact-object, anti-forgery and loaded-copy
boundary *is* the provenance contract: public structural metadata would be
forgeable and copyable, and weak keys make the association's lifetime
subordinate to the streams that own it. A scope-owned alternative would thread
new state through core, durable execution, secret wrapping and Workspace
coordination; a wrapper-private one could not refuse duplicate establishment on
an arbitrary stream. Neither adds a security property this lacks, and both
enlarge the trusted surface.

This exception authorizes only the canonical `JournalProvenance` association
described here. It creates no general eligibility test for module-scoped state;
any other exception requires its own explicit architecture decision.

### The Plugin boundary

A **Plugin** is trusted code installed before an execution imports a root
document. XMD bundles exactly one, `@executablemd/git`, and an operator adds more with a
repeatable `--plugin <specifier>`. The bundled value is statically imported
rather than resolved, so a distribution carries it whole and nothing can
substitute it; it is activated for `run`, `plan`, `syntax` and the workflow
actions that execute a document — `start`, `resume` and `fork` — and for nothing
else. `xmd test`, `upgrade` and a workflow management action carry no Plugin
they did not ask for.

`git` is a reserved *host selector*, not a package name: writing `--plugin git`
names the value the profile already holds, resolves without loading a module,
and is a no-op however many times it appears. A module that merely uses the
same Plugin name is not that value — it loads like any other specifier and is
refused as a duplicate.

Beyond that one prefix this is still the only extension boundary XMD has: no
manifest, no Plugin version, no capability bag and no central runner context a
Plugin reaches through.

**A Plugin is a value, not a registration.** It carries a name and, optionally,
one `install(request)` operation:

```ts
export default Plugin({
  name: "@example/reviews",
  *install(request) {
    if (request.command !== "run") {
      return undefined;
    }
    yield* useExampleComponents();
    return { components: yield* exampleDeclarations() };
  },
});
```

The value is plain structural data, and deliberately unbranded. A selected
module ordinarily resolves its own copy of `@executablemd/core`, and a brand, a
symbol or an `instanceof` check would split that copy from the canonical
execution and silently drop everything the Plugin installed. What makes two
copies agree is the stable, namespaced contextual Api names below.

**A selected module's default export is the Plugin.** One unambiguous export
means a library package can publish its Plugin as its default while keeping
every named export it already had — which is exactly what
`@executablemd/code-review-agent` does.

**Admission reads a value; it does not rebuild one.** What a host admits is the
object the module exported, so a Plugin keeps members this boundary does not
read and its `install` keeps the receiver its own module gave it — an
implementation written as a method and reading `this` behaves here exactly as it
does when its own package calls it.

**What an install contributes** is one `PluginInstallation`, or `undefined` for
a command the Plugin is not active in: exact Markdown components, structural
syntax, the handler that expands it, and journal admissions. Those are the
existing acts of infrastructure, reached through the boundary the host already
had — a Plugin composes an `ExecutionInstallation`, it does not get a new one.
Feature facilities are deliberately absent: a Plugin that needs repositories,
sessions, GitHub or upgrade services imports that feature package's own `/api`.

**Trusted, not sandboxed.** Loading a selected module runs its top level, and
that happens before anything can look at what it exported. Selected Plugin code
can execute whatever the surrounding runtime permits. The engine refuses a
*malformed*
Plugin — a module exporting no default, a default carrying no name, an `install`
that is not callable, two selections using one name — and it refuses them
before any `install()` runs and before a root document is read. It constrains a
well-formed one not at all, and none of this is a permission boundary.

**How a module is reached is the host's.** The shared command holds a loader the
runtime entrypoint supplied and calls it once per specifier, exactly as it holds
the standard-input reader: reaching a module means a dynamic import and host
package resolution, and neither belongs in shared orchestration. All four
entrypoints supply one adapter today because the four runtimes genuinely resolve
and import the same way, and nothing anywhere asks which runtime is running.

**Selection is explicit.** Nothing scans the repository, `node_modules`, a
package manifest, the root document or the component search path. A package
that happens to be installed does nothing until it is named; a path inside the
current repository is valid when the operator wrote it; a remote URL is refused,
because this boundary fetches no code. Specifiers resolve from the invocation's
own captured working directory rather than from the CLI module, so a global
install, an npm install and a compiled binary agree about what one name means.
V1 performs no ambient or document-declared discovery — that is a decision about
what V1 does, not a guarantee that discovery can never be added.

**Order composes and never arbitrates.** The bundled Plugin installs first
where the profile carries it, then the selections in occurrence order, and the
first Plugin installed is the outermost middleware wrapper.
Position decides nothing else: two Plugins
reserving one Plugin name, one component name, one structural construct or one
documentation contribution are refused at admission, exactly as two trusted
hosts already were.

**The lifetime is the command's.** The complete command runs inside the scope
the Plugins installed into, so a failure or a cancellation part-way through the
list unwinds the earlier Plugins, reads no root and starts no document, under
ordinary structured-concurrency teardown and its existing failure precedence.
An isolated nested `<Execution host="run">` inherits none of it and installs the
same Plugin *values* again in its own scope, with command `run` — which is what
makes a run child of `xmd test` the run profile while the test root is not.

#### Ordinary repository vocabulary

The bundled Git Plugin declares twelve ordinary shadowable defaults:
`Repository`, `Worktree`, `Git.Switch`, `Git.Add`, `Git.Commit`, `Git.Push`,
`PullRequest`, `PullRequest.Reviews`, `PullRequest.Comments`,
`PullRequest.Checks`, `IssueTracker` and `Issue`. Dir is core-protected and
remains available without this Plugin. One declaration array serves execution,
syntax inspection, Plan validation/generation and executing workflow actions.
A Workspace attachment installs providers and durable state, not vocabulary.
Declaration alone starts nothing: no provider, repository discovery, lock, Git
process or credential read. A repository component may shadow any of these
ordinary defaults.

#### Command declaration ownership

Command declarations contain everything one command declares, in one order and under one
discriminant: the exact Markdown components *and* the structural syntax the selected
Plugins declared, then whatever the calling surface declares for itself. Both arms,
because both are what a name means here — a catalog holding only the Markdown half would
let `xmd syntax` and `<Plan>`'s validation describe a language a run does not have.
The command builds the value once so that an ordinary run, a nested `host="run"` child,
inspection and `<Plan>`'s validation cannot describe four different vocabularies.

#### The three contextual APIs a Plugin composes through

Each is a value-returning contextual Api: the terminal answers with what the
execution would use on its own, and a Plugin wraps that answer.

**The key is namespaced; the name is not.** They are published under
`executablemd.core.plugin.document`, `executablemd.core.plugin.root-metadata`
and `executablemd.core.plugin.active-plugins`, and a consumer still writes
`Document`, `RootMetadata` and `ActivePlugins`. The key is the whole of what two
loaded copies have to agree on, so it carries the owning package and the
boundary rather than a bare word another package could also pick: an Api built
with the name `Document` elsewhere addresses a different context, and cannot
intercept, replace or observe this one.

`Document` is the root's content, and it is an operation —
`document(): Operation<string>` — because deciding what to wrap a document in is
work: a Plugin may read its configuration or ask where it is standing, and it
delegates with `yield* next()`. Its terminal answers with the exact text
`"<Document />"` — the placeholder canonical core projects the already parsed
and target-selected root into. A Plugin returns Markdown containing that
placeholder wherever the original document belongs, and canonical core scans
that envelope once and splices the root's own parsed segments in at each
placeholder. The segments are the ones the root was parsed to, at the offsets,
lines and paths they were authored at, so an element's source position and its
expansion identity are what they would have been with no Plugin at all; splicing
rather than nesting is also what keeps the root's own top-level `<Output>` a
top-level child and its `<Return>` in the value body's flow. With no middleware
the envelope is exactly the placeholder and the execution runs the definition it
imported, so there is nothing for a run whose Plugins compose no middleware to
observe — which the bundled Git Plugin does not. A middleware may
delegate more than once, and nothing caches or counts: each placeholder projects
the document again.

An authored `<Document />` is an ordinary element. Only the envelope canonical
core scanned is read for placeholders; the root's own segments are spliced in as
parsed values and are never walked, so a document that writes the name reaches
ordinary component resolution and finds no component there.

`RootMetadata` is the root's ordinary `meta` record and nothing else. Its
terminal answers with the record the root's frontmatter declared, and what a
Plugin returns is detached and frozen before the execution reads it. It cannot
reach `props`, `required`, `returns`, target selection, or the metadata of any
imported component.

`ActivePlugins` is the frozen ordered list of the Plugin values installed for
this command. It is installed before the first `install()` runs, so every
Plugin — including the first — and every later consumer read the same list.

Execution, `inspectDocument` and non-executing document validation compose a
root through one shared path, so what a caller is told a document declares is
what the document will run as, and a wrapper whose own structure a document
could not write is diagnosed on the same terms the document would have been.

**No durable protocol changes.** There is no Plugin event, no Plugin-set
identity and no generic Plugin record. The root import, the declaration records
and every existing encoding are byte-identical, and a Plugin whose future
middleware must reject an incompatible retained history supplies an explicit
`JournalAdmission` rather than having one inferred from its name.

#### Where a consumer imports from

`@executablemd/core/api` publishes exactly the consumer surface: `Plugin`, the
three contextual APIs and their direct operations, and the contract types the
accepted interfaces are written in. `@executablemd/runtime/api` publishes the
existing `Config` Api a Plugin reads timeouts and verbosity through, and
`Permissions`, which a scope installs middleware around to permit less than its
host does:

```ts
import { Permissions } from "@executablemd/runtime/api";

yield* Permissions.around({
  files: ([operation], next) => (operation === "write" ? false : next(operation)),
});
```

Two members, `files("read" | "write")` and `fetch(input, init?)`, both answering
`true` until something says otherwise. A restriction returns `false` to refuse
and otherwise delegates the unchanged arguments, which is what makes
restrictions intersect: the answer is the whole chain's, so a scope nested
inside a read-only region cannot permit a write by answering `true`. Returning
`true` early is the one thing a restriction must not do, because it answers for
every enclosing scope as well. A decision is synchronous — there is nothing to
wait for in reading a policy the installing scope already holds, and the answer
stands immediately before an effect.

The question is asked by the implementation that performs the operation,
immediately before its first I/O: the `API.Files` provider for the six semantic
filesystem operations and the `API.Fetch` terminal for a request. That is after
every contextual transformation, so what is permitted is what would actually be
performed rather than what was first asked for. It mediates those semantic
operations and nothing by implication — `API.Fs`, subprocesses and Git host
operations are not covered, and a `true` answer supplies no capability.

What a *host* does stays on `./host`. `Markdown({…})`, `sourceDigest` and
`Structural({…})` construct what is declared to an execution, and
`parsePluginValue` is how a distribution admits an untyped module export — all
four are the trusted-infrastructure boundary, and a Plugin reaches them there
because a Plugin is trusted code. Both packages keep every root export they had;
`/api` is additive.

### The declared Markdown boundary

A trusted host may ship first-party Markdown, name it, and hand it to one
execution. Everything about it is decided before the root document is imported.

**A declaration says what it is, and `Markdown({…})` is how it says it.** A host
describes its asset and the constructor returns a fresh shallow declaration
carrying `kind: "component"`, written *after* the description, so an input that
carries a kind of its own is overwritten rather than believed. Every declaration
this repository owns is built that way.

It is the canonical construction and a convention, not a gate. The declaration
type is an ordinary structural one, so a caller can still write the object out
by hand and no constructor can stop one — which is why the discriminant is
defended where it matters rather than where it is written.

It is a constructor and nothing else. Nothing is validated, hashed, copied
deeply, frozen or admitted there: the digest stays the host's own statement
about its bytes, and the schemas, arrays and private declarations that go in are
the same objects that come out. Copying belongs to capture, which happens before
any `install()` runs, and checking belongs to admission.

Admission reads the discriminant before it reads any other member, because
everything else a declaration carries is a statement *about* exact Markdown —
reading one of those from a value that never said it was Markdown is already
treating it as Markdown. A declaration stating a kind this version does not
know, or stating none, is refused before the root document is imported. The earlier
`"markdown"` discriminant is unknown here, not a compatibility alias.

**The declaration is held to its own bytes.** The host states the kind, the
name, the origin, the source and its SHA-256, and may state the props schema,
the return and the accepted forms. Canonical core parses that source and refuses
the declaration when the digest is not the digest of those bytes, when a stated
schema is not the schema they declare, when the forms are not canonical, when
the name is not a component name or is structural syntax, when one name is
declared twice, or when a reserved registration already reserves it. A build that
ships different bytes under a declared name therefore fails where it is
installed rather than where a document happens to write the name.

**The name is reserved, not offered.** Resolution places a declared component in
the same host tier as a reserved registration, above the workflow component
bundle, repository files and every registered default — and below the canonical
protected tier, which is the engine's own reservation rather than a host's. Two reservations
on one name are refused rather than ordered, so the tier never chooses. A
repository `Policy.md`, a bundled `Policy`, an ordinary registration and another
loaded copy of the host package can none of them answer for a declared `Policy`;
and a host that declares a name canonical core owns is refused at admission,
before the root import.

**Invocation is canonical, for the declared names.** A declaring execution
imports through the same retention a bundled one does: canonical core keeps its
own copy of the definition it produced and invokes that copy, then compares the
answer that came back against it by own property descriptor.
`Component.importComponent` middleware may observe a declared import, delegate
it and refuse it by throwing; it cannot answer one, replace one, or change one
before it runs.

That closure is a property of the name. A workflow component bundle closes every
import its run makes, because a run is a run of one pinned tree. A declaration
closes only what it declares — the component and its private closure — and every
other name in the execution stays the ordinary open import it has always been.
Declaring one asset does not take component substitution away from every
document the host runs.

**Every declaration is read once, before any installation runs.** Capture reads
the kind before any other member and immediately refuses an unknown kind. For a
known kind, the invocation retains that discriminant and its arm's members —
factory bound, arrays and schemas copied — on the same terms as admissions and
the bundle. The branch and the retained kind therefore come from one read, even
if a later read would answer differently. A schema is copied rather than
referenced because it is a whole object graph, and holding the caller's object
would leave the contract mutable after capture. A host that hands a declaration
over and then replaces a member of it, or mutates a schema it still holds, has
replaced nothing.

**The private closure is lexical and expansion-scoped.** A declaration's private
components are minted exactly like the identity components a host declares —
one domain, one invocation authenticator, revoked when the execution is torn
down — and then registered nowhere. Its body carries its own closure; ordinary
component bodies clear the caller's private closure. Canonical core offers a
private component for the duration of one import, from the closure the segments
being expanded carry, and the resolver takes it once. Projected caller content
restores the caller's frame and closure, so a `<Content />` inside a declaration
gains no callee-private names but retains the caller's own lexical private names.

Eligibility belongs to the authored occurrence rather than to the name. What a
private import may invoke is the object canonical core produced inside that ask,
so an answer a handler retained from a legitimate private import authorizes
nothing at a later site — and because neither the name nor the current execution
is what is checked, it authorizes nothing under an alias, inside a copy of the
definition, after the invocation that produced it is over, or in a later
execution that declares no Markdown at all. A run that has ended authorizes
nothing. What is restricted is the implementation the closure built, recognized
wherever an answer would become something the engine invokes; a definition a
handler wrote carries a different function and stays the open import it always
was. And a private name written where no offer was made
resolves to nothing before the workflow bundle, the repository or any
registration can answer for it — one decision, shared by execution, inspection
and validation, so a repository file under a private name is described by none
of them and runs nowhere.

**The journal records the asset, not a lookup.** A declared import records one
of two closed shapes — `{ kind, origin, digest, content }`, and the same with
`exact: true` for a component the host declared as rendering a program's source
— and a private one records exactly `{ kind: "declared-private", origin }`. A
continuation reads all of it as hostile data, verifies the recorded origin,
digest, bytes and disposition against what this run declares, and reads no file:
a host that no longer declares the name, that declares different bytes under it,
or that publishes those bytes a different way, refuses rather than continuing
somebody else's Markdown. A recorded private import refuses unless the element
asking for it is inside the same declaration.

**Exact source is a provenance, not a property.** Whether bytes are published as
a program's source or presented as prose is decided from two things no answer
can write: that canonical execution authorized the import for a name this
execution closed, and that the host's own admitted declaration for that name
states it. A definition carrying the disposition metadata, a segment arriving already marked, a
frontmatter key and a middleware answer are each data that reached the engine
from somewhere, so none of them decides it — an ordinary
`Component.importComponent` handler answering an open name with a definition
stating the disposition publishes prose, exactly as a repository file of that
name does.

The record of which segments an expansion produced as source belongs to the
execution that made it and is handed down **by value** on canonical core's
private execution environment. Not through a context: a context resolves by name,
and a name is not a secret, so a component could build one, reach the record and
answer that everything is exact. It is released with its execution, reaches no
public entrypoint, and marks nothing on the segments themselves.

#### The review graph is the mechanism's first whole consumer

`<Plan>` declares one component. The code-review agent declares thirty-five, and
reserves six registrations beside them, which is what the boundary looks like
when a complete program graph moves into an installation.

**Why it moved.** The review and repository-analysis components were Markdown
and TypeScript files in `.reviews/`, and every entrypoint reached them through
checkout-relative component includes. That made the component graph a property of
the checkout being reviewed: a pull request could add a file named `Finding.md`
and the review would run the branch's own copy while reporting on it. A review is
precisely the program that must not be answerable by its subject.

The five review and analysis tasks and the two Actions workflows now pass no
component include at all, and the retired definitions are gone. What stays in
`.reviews/` is this repository's own review programs and the sensor
configuration, journals and runtime state they read and write — inputs and
outputs, not component definitions.

**Who owns it.** `@executablemd/code-review-agent` does, and
`packages/code-review-agent/src/review-components.ts` is the only assembly
boundary. The Markdown lives at `src/documents/components/` and
`src/documents/policies/` and is read from that module's own URL, so one lookup
is correct in a source checkout, a published npm package and a compiled binary
with no checkout at all. The read goes to the Effection filesystem directly
rather than through `API.Fs` or the document-facing `Files` provider, both of
which are middleware a running document could compose around — a review whose
own components could be answered by the document under review would have moved
the problem rather than solved it.

**Two tiers, one meaning.** The thirty-five Markdown components cross as
declarations, carrying the packaged bytes, a stable origin naming the package and
the asset rather than a path, and the digest of what that build shipped. The six
TypeScript components — `CommentReviewData`, `CommentReviewState`, `Doctor`,
`OxlintDiagnostics`, `RepositoryInventory` and `ReviewContext` — cross as
reserved registrations. The mechanisms differ in what they carry and agree in
what they mean. Moving only the Markdown would have left shadowable exactly the
six components that run processes, read credentials and reach the network.

**Where it is installed.** Through the Plugin boundary, as the Plugin an
operator selected — by package where it is installed, or by path. Nothing in the
CLI names the package, and a command that selected nothing has none of the
forty-one names. Once selected, one installation per command serves every
surface that describes or validates the vocabulary: ordinary non-testing
execution, the registry `xmd syntax` and structural validation enter, `<Plan>`'s
internal admission validator, and `xmd plan`'s candidate validation. A Plan is therefore
checked against the vocabulary the later `xmd run` supplies, rather than a
narrower one that would refuse a program the run would have accepted, and the
three checks inside one Plan command consume one retained assembly rather than
reinstalling and re-reading every packaged asset.

The Plugin reserves the forty-one names for the commands that can run a review —
`run`, `syntax`, `plan`, and a `workflow` action that executes a document — and
returns nothing for the rest. `xmd test` at its root is a different profile and
gains none of it; the nested `<Execution host="run">` child it can launch
installs the same Plugin values again with command `run` and gains all of it.

**What it does not change.** Ordinary inclusion and repository discovery are
untouched. A caller's own component of an unreserved name resolves as it always
did; only these forty-one names are spoken for. The reserved names do include generic
ones — `Format`, `Pattern`, `Threshold`, `Instruction`, `Sample` — which is the
intended consequence of the anti-shadowing contract rather than an oversight, and
a collision with another host name reservation is refused at assembly rather than settled by
order.

**One deliberate duplication.** The package ships its own copies of `Sample.md`
and `Instruction.md` rather than pointing at `packages/core/components/`, so the
graph a review runs is complete in one package. A regression holds the copies
byte-identical to core's, which makes a future divergence an explicit decision in
the code-review package instead of something that happens to one of them.

### The installed structural syntax boundary

The [declared structural syntax interface](specs/executable-mdx-spec.md#declared-structural-syntax)
owns `Structural` and `ExpansionRequest`; [SR conformance](specs/executable-mdx-spec.md#tier-sr--expanding-installed-structural-syntax-53)
provides its behavioral evidence. This section owns installation, demand and
producer lifetime.

A trusted host may declare a structural construct and the regions written
directly inside it — syntax the engine has no branch for — on the same
`ExecutionInstallation` its exact Markdown crosses on, in the same `declarations`
list. Those declarations are the one source selection, inspection and
non-executing validation read.

Admission validates every declaration before a root document is read: a valid
name and non-empty origin, canonical forms, a compilable schema, syntax examples
and description, and content meaning stated as prose or `null`. It also refuses
engine-owned or protected names, existing reservations, duplicates and private
closure collisions. The construct/region and handler rules below apply to the
whole admitted batch.

**A pair is one installation, and a host is held to that too.** An installation
that declares structural syntax supplies the handler that expands it, and one
that supplies a handler declares syntax for it. Canonical execution refuses
either half alone before it reads a root document — and a host assembling
installations of its own, from Plugins, is held to the same rule where it builds
the assembly. That second place is not a convenience: `xmd syntax` and
non-executing validation read declarations *without* handlers, by design, so a
half-installation that reached them would be advertised to a writer and accepted
in a Plan, and refused only when a run finally tried to expand it. One rule,
`incompleteStructural`, decides both.

**A pair is declared, never assembled.** A structural declaration states its
name, origin, accepted forms, props schema, authored syntax examples,
description, what its content means, and whether it is the construct itself
(`parent: null`) or a region of one (the construct's name). What a construct
accepts is derived from the regions that named it, so the accepted regions and
the declarations describing them are one fact rather than two lists that can
drift. A region whose construct this execution does not declare, a region of a
region, a pair split across two installations, and a construct with no region
are each refused before the root document is read.

**The installation that declares a construct expands it.** The same
installation supplies one `expand`, read once and bound at capture beside the
declarations it belongs to, and held on the admitted catalog entry.
Declarations with no handler, and a handler with no declarations, are each half
of something that could admit syntax it can never expand, and both are refused
at admission. The association is a field of that entry rather than an entry in
a registry, a contextual slot or a second dispatch protocol, so the only way to
reach a handler is to hold the catalog canonical core built.

**The name is reserved on the declared-Markdown terms.** A declared construct
answers ahead of the workflow component bundle, repository files and every
registered default, and never over the engine's own structural table or the
canonical protected tier. One name is declared once across both arms and across
installations: a duplicate, a collision with declared Markdown, a collision with
a private closure name, and a reserved registration already holding the name are
configuration failures refused where they are installed rather than precedence
questions resolved by order.

**Placement is decided from source.** A construct holds whitespace and the
regions it declares and nothing else; a region is written directly inside its
own construct and is an error anywhere else; a self-closing construct has no
regions and is accepted when that form is declared. The analysis is pure and
shared, so what non-executing validation accepts and what canonical expansion
accepts cannot come apart, and reading it evaluates nothing, invokes no handler
and expands no region body.

**One kind, two shapes.** A selection, an origin and an inspection result all
report `structural`, because that is what each of them is. Which one it is shows
in what it carries — the engine names the `construct` from its own table, an
installation names the `origin` that declared it — so there is no second
discriminant and ownership is never read out of a name's text. An installed
construct never enters the branch that belongs to the engine's table.

**The symbols stay version 2.** A construct and each of its regions contribute
one entry to the structural category, sorted by code point beside the engine's
own and carrying the declared forms, props schema, placement, syntax examples,
description and origin. The two structural entry shapes are a closed union: an
engine entry keeps exactly the fields it always had, neither shape can inhabit a
component entry, and no category, order or existing member changed — so a
version-2 reader is owed nothing new.

**`Structural({…})` is how a host builds one**, on the terms `Markdown({…})`
already set: a fresh shallow declaration with `kind` written after the
description, validating nothing, compiling no schema, copying nothing deeply and
freezing nothing. Capture and admission are the defenses.

**Dispatch is generic.** Expansion asks the catalog about a name after every
branch the engine owns and before any component import: core holds no branch for
an installed name, and adding one would make the boundary a list of the
constructs somebody happened to ship. An admitted construct takes the installed
path, an admitted region reached on its own is misplaced and refuses through the
shared analysis, and everything else is the component import it always was. An
expansion carrying no execution environment declares nothing and reaches none
of this.

**The handler is entered once, with everything already settled.** Placement
first, then the authored form of the construct and of every accepted region —
each against its own declaration, because a region declares the forms it accepts
and does not inherit its construct's — then `as` and `slot` —
engine-owned, so a valid `as` binds nothing and never becomes a prop, because a
construct renders through its regions and returns no value. Then the construct's
expression props are evaluated in the occurrence's own lexical environment and
validated against its schema, and then every accepted region's, in authored
source order. A failure anywhere in that sequence is the occurrence's failure at
the position it was written, and the handler is not entered — so a construct
whose last region names an impossible prop runs none of the first.

What crosses is a frozen copy: the authored name, origin, form and position, the
validated props with their declared defaults, and one region object per accepted
child. No segment, children array, recursion function, counter, ledger, schema
or execution environment is reachable from it. The handler is invoked directly
inside a
scope of its own — no context is consulted and nothing is published — and that
scope is what owns whatever it starts.

**A region is an operation, not output.** `ExpansionRegion.expand()` acquires a
fresh resource each time it is called, and each subscription owns one producer.
Authored work is gated on demand: a handler that holds a region runs none of its
body, one that subscribes without reading runs none of it either, and each
`next()` is what permits the next segment's work and delivers exactly one chunk.
A delivered chunk buys nothing beyond itself — the producer waits for a further
live demand before the next segment runs, so what has not been asked for has not
happened.
Nothing buffers output — a channel or an output queue would accept a send and
let the body run ahead of the reader — while a queue of *consumer* demand is
what orders concurrent reads.

Chunks carry rendered text and the exactness the execution's own record decides,
through the same predicate the root emits with; a field planted on a segment
decides nothing. Region output never passes through `DocumentOutput`, is never
journaled, and the construct itself renders nothing, so what a document shows is
whatever the handler does with what it read.

**Lifetime belongs to the invocation.** Leaving the handler's scope — returning,
failing, or being cancelled — halts every producer it entered and waits for
them before the occurrence settles, so a body blocked on demand cannot outlive
the construct that asked for it. A body that fails after producing output
delivers its prefix under the same demand discipline and then raises the
original failure object on the next read — including the output one authored
segment appended before failing partway through, which is the reader's whether or
not the segment that produced it finished. Cancellation stays cancellation and
never becomes an ordinary failure.

### The canonical protected tier

Resolution already had a protected tier — a reserved registration, or exact
Markdown a host declared. Both of those are *a host's* name reservation, made by whoever
assembled the run. Above them sits the engine's own, and a name in it means the
same thing in every execution: whichever host built it, whichever package
registered what, and whatever the repository holds.

Five names are in it: Syntax, Evaluate, File, File.Delete and Dir.
`<Syntax />` describes the vocabulary of the site it is written at, and a description of a run's vocabulary that anything in the run
could answer for is a description of nothing — the value of the answer is
exactly that nobody but core produced it.

**It is not a registration.** A registration is an answer a registry gives for a
name, and a registry is something a nested scope layers over, a host installs
into, and a handler can keep a record from and hand back somewhere else. So the
tier is the resolver's own table, consulted after structural syntax and before
every host or author tier, and consulted unconditionally: no option a caller
passes — or leaves out — puts a repository file, a bundle member or a
registration in front of it.

Collision is refused where each name reservation is made, so the tier never has to choose:
a registration under the name is refused atomically at registration, a host's
declared Markdown and a workflow bundle member are each refused at admission
before the root import, and a repository `Syntax.md`, `Syntax.ts` or directory
candidate is never probed for because selection has already answered.

**Invocation is canonical.** For Syntax and Evaluate, the execution mints one
identity domain per component, calls its factory with that domain's invocation
authenticator, and registers what comes back nowhere. File, File.Delete and Dir
instead use the fixed, deeply frozen ordinary core definitions built once per
loaded copy. Their bodies still reach contextual Files and effective Permissions;
protection fixes the implementation and grants no filesystem permission. Import is closed for exactly those names, on the terms a
declaration's names are closed: `Component.importComponent` middleware may
observe the import, delegate it and refuse it by throwing, and what it cannot do
is answer one — a witness is issued where canonical execution produced its answer
and verified where the component is invoked, and core's own copy is what runs.
Every other name in the execution stays the ordinary open import it has always
been.

**Protection is about the answer, not about power.** Canonical expansion hands a
protected body its lexical syntax reference and the internal operations its
site owns. `<Evaluate>` receives the captured evaluation profile, its paired
content projection and an operation that derives a child protected route for
exact admitted definitions. None is published through a context, component API,
import answer or public host input.

Protected lookup uses exact function identity. The execution's route projects
an already routed source onto a wrapper without exposing the body; an
unprotected source projects nothing. Profile sealing projects the first wrapper
onto the full execution route. `<Evaluate>` derives a fresh child route seeded
only with its selected sealed definitions, and passes that route and its narrowed
lexical `SyntaxReference` internally to generated expansion. Generated import
projects its form/result wrapper only within the child route. Canonical dispatch
issues the invocation in the routed body's original domain and applies generated
form checks and read-result collection around either kind of body. Authored
imports still require their own settled selection frame; a routed function
cannot repair a missing or multiply selected domain. Paired producers retain
their lexical site route and operational permission.

A trusted provider may therefore delegate canonical self-closing `<Syntax>`,
which canonical core publishes for itself, and have it admitted as a component
answer. Its default bare form reports the admitted vocabulary; its named form renders the enclosing authoring documentation with
narrowed availability. Verified protected documentation provenance survives
sealing even when the delegating provider has a different origin. That
provenance is descriptive data and never a callable lookup key.

Routes, projection edges, bodies, domains, callable sets and site operations
belong to one live execution. Child closure and execution teardown invalidate
retained operations. A same-name function, structural clone, independent wrapper,
unadmitted definition or implementation another loaded copy built gains no
route. Durable records keep their existing structural identities, forms, source,
profile inputs and results; they contain no callable permission. Continuation
rebuilds routes from the resuming execution's own verified answers.

Syntax accepts only a self-closing form and one optional closed `names` prop.
A paired spelling, unknown prop, empty or duplicate list, or non-string member
refuses before authentication or a read. Ordinary `as` captures the rendered
text and emits nothing. A cancelled symbols read completes teardown and commits
nothing.

**The named form is a second question.** Bare `<Syntax />` answers *what may I
write here*. `<Syntax names={["Elicit"]} />` answers *how do I use this one*, and
the two read different inputs on purpose. The reference therefore carries a
pair: what may **execute** at this site, which the bare form reports, and the
**enclosing authoring symbols**, which named selection reads. At a root they are
one set. Under a trusted evaluation boundary that narrows execution they are
not, and each rendered entry states whether it is available in the current
evaluation — so a nested author can be told how a component works where they may
not run one, without being left to infer that documentation implies permission.
#713 installs that boundary; this stack supplies and proves the seam.

The documentation itself is the owning package's. Every registration boundary
that contributes public components keeps a `components.md` beside itself — core,
its Agent registrations, the CLI, testing, web and repository composition — with
a contribution derived from the same declarations it registers, so adding a
component demands documentation rather than relying on a hand-kept list.

**A package's bootstrap installs its registrations and its documentation
together**, through one stable namespaced `Documentation` middleware, so a host
that bootstraps a package gets both from one call. Canonical core is the
terminal, and every wrapper delegates before appending its own — which is why
composition order decides how the list reads and nothing else. Canonical
execution collects **once**, after the trusted host's bootstrap and before the
root import or any document code, and snapshots the answer field by field. So a
document or component that composes around the Api afterwards composes into a
chain nothing reads, two executions assembled in sibling scopes each read their
own, and two contributions that *disagree* about one owning package and
component name refuse at collection, whichever order supplied them. Collection
is the boundary that catches them because it is the only one every execution
passes through: a document that writes bare `<Syntax />`, or none at all, builds
no index and would otherwise run to completion on an assembly nobody validated.

**A contribution is four values** — the owning package, the asset identity, the
exact documentation text and the component-name set — and equality covers all
four, by value rather than by object identity, with a name set carrying no
order. A repetition of that same value adds nothing and succeeds: one package's
declarative vocabulary is deliberately entered at more than one layer — a
nested run installs the same bundled Plugin again in its own scope, and an
evaluation host the same way, because the inner scope may be the only one a
document sees. The inner scope descends from the outer, so both
wrappers sit in one chain, and collection folds them to one — keeping every
layer's registrations and one documentation value. Comparing the asset alone
would instead coalesce two bootstraps that genuinely disagree and silently keep
whichever ran first.

**Collection classifies duplicates, not the helper a bootstrap happened to
use.** The middleware namespace is public, so a package may compose it directly
and hand back two value-identical contributions rather than going through the
convenience helper; that assembly is exactly as valid. Canonical collection
therefore snapshots the composed chain by value, folds every completely
identical contribution, and only then classifies what is left — so correctness
does not depend on which spelling a package chose.

A different owner is unequal but is not by itself a conflict, because
documentation joins by component name *and* origin — two packages may each
document a same-spelled component. Disjoint component sets from one owner
coexist for the same reason.

The alternative — a host-maintained list of every package's documentation, kept
beside a host-maintained list of every package's registrations — is two lists
that drift, and they did: a nested run registered `<WebForm>` and then reported
it undocumented, because one list had been updated and the other had not.

Assets are located from
their own module's URL rather than the working directory or `--include`, and
every distribution loads the same bytes; one shared entrypoint builds the
complete index and refuses a missing, unknown or duplicated section before any
distribution is produced. One validated index serves `<Syntax names={…}>`, `xmd syntax Elicit` and
#678's release reference, so three surfaces cannot describe one component three
ways. It joins by name *and* owning package: a repository `Elicit.md` has a
repository origin, which names no package, so the built-in's prose is never
attached to it. A first-party component with no
section, a heading naming something the package does not supply, one appearing
twice, and one that is not a component name each refuse the whole index rather
than producing a partial one — a reference with a hole in it cannot be told from
one whose components have nothing to say. The no-documentation sentence is for a
**custom** component instead, which no package governs and which takes its prose
from its own document's body when it has any.

**It says so in the symbols.** A protected component reports its own origin
kind, `protected`, rather than borrowing `registered` with `reserved: true`. The
two answer a reader's actual question — *could I supply this name myself?* —
oppositely: a reserved registration is a host installing something under a name
it wants kept, so it can be absent from another run, replaced by a different
host, or refused when two hosts reserve it, and none of that is true here. A
workflow bundle member gained its own kind for the same reason: reported as a
`repository` path it read as a file the reader could edit, when it is the exact
blob `sourceHash` names, fixed when the run was defined. Both are why the symbols
are version 2 rather than an addition to version 1 — a version-1 reader was
promised a closed set of origins, and the honest fix adds to that set.

The durable record follows the ordinary rules. Selection itself records
`{ kind: "protected" }` and nothing else: there is no path, no origin to look up
and no implementation to serialize, so the record says only which tier answered
and replay asks the running execution for the implementation it built. An
execution that built none refuses rather than resolving the name again, because a
replay that fell back to the ordinary tiers would run whatever is offered under
that name today. Each occurrence then authenticates against the identity this execution minted,
performs one `syntax_symbols` read, and retains a closed value carrying exactly
one member — `{ symbols: string }` for a successful rendering, or
`{ refused: non-empty string }` for a named selection canonical core refused.
Both are durable values, because a failure crossing the durable boundary is
rebuilt without its class; the component interprets the value only after
publication succeeds, so a retained refusal means the same thing live and on
replay while a publication failure prevents interpretation and stays terminal. A
continuation hostile-parses that record and answers from it without consulting
the filesystem, the registry, the bundle, the host or the lexical reference
again; existing `{ symbols }` histories remain readable, and a missing,
additional, mistyped, empty or simultaneous member is stale input rather than a
component failure, and refuses
before output or binding. Two authored occurrences are two identities and two
reads, and repeated reads of one binding read nothing again.

### The syntax symbols boundary

`xmd syntax` answers what a document may write here, and answering must cost
nothing. The boundary that makes that true is one operation that decides nothing.

**One symbols, two projections.** Core produces a `SyntaxSymbols` — version 2, a
fixed three-category tuple, entries sorted by name — and the Markdown and JSON
renderers each take that value. Neither renderer discovers anything, and
neither parses the other's output, so the two formats cannot describe different
environments. JSON is the canonical, lossless projection and belongs to the CLI;
Markdown is written for a person and labels a schema it cannot faithfully
summarize rather than inventing a type for it.

**The Markdown renderer is core's**, because two things print it: the command,
which describes an environment nobody is running, and canonical `<Syntax />`,
which hands the same text to a document that is running. One renderer is what
makes those the same bytes for the same site; two that agreed by hand would be
one release away from telling an operator and an agent different things about
one profile.

**A declaration set is admitted on execution's terms, or not at all.** The
identity components a host would declare to an execution are read here without
an execution existing, so the question "would this run" has to be asked from the
one place that answers it: two declarations of one name are refused, and each
declaration's name, origin, schemas, captures and forms are held to the check
registration performs. Both checks live in one function each, used by the
execution that builds implementations from a set and by the inspection that only
reads it, so a set admissible to one is admissible to the other. Describing an
environment no document could run in would be describing a run that cannot
happen.

**A declared Markdown component is described from the same declaration.** The
exact Markdown a host would declare to an execution is admitted here on
execution's terms too, and each declared name contributes one complete entry
under built-in, reporting `declared-markdown` as its source kind and the
declared origin and digest as its origin. Its private closure contributes
nothing: those names are not syntax a document may write, so a set of symbols
that listed them would describe an environment that does not exist.

**Live descriptions compose through Syntax.** Core exports `Syntax` and
`SyntaxApi` from `@executablemd/core/api`. Its `symbols` and `text` properties
are `Operation<SyntaxSymbols>` and `Operation<string>`; callers yield the
properties without parentheses. `documentation(names)` is an Operation-valued
method. Defaults are reusable lazy Operations, so each live read starts fresh
work. Default text renders the effective contextual symbols through the shared
Markdown renderer. Middleware may answer, delegate or transform these views.

The execution-derived private reference supplies the fallback. It is built from
the selection inputs that execution captured before any installation,
middleware or document code ran: the includes it resolves against, the registry
it started with, the identity components and exact Markdown its host declared,
and the component bundle it is closed over when it has one. A bundled name is
described from the pinned bytes already in hand — nothing is imported, executed,
or read from a file to describe one — and reported at the canonical
repository-relative path that blob has in the commit, which is where a reader of
a workflow run looks for it. It is bound as the Api's fallback rather than as
inner middleware, so it does not shadow an enclosing host profile.

`useSyntax(source)` from `@executablemd/core/host` binds a host's lazy complete
descriptive profile and snapshots the documentation contributions already in its
calling scope. It installs ordinary symbols and documentation
providers at `min` without reading the source. There is no installation-member
count rule for descriptive providers.

Standalone Plan enters the ordinary run profile's declarative bootstraps and
installs this helper before its constrained authorship execution. Its source
inspects captured target registry/declaration inputs lazily, so named metadata
also describes the program it is preparing. An embedded Plan keeps its enclosing
profile. CLI inspection uses the same bounded declarative assembly and helper,
without running execution initialization or operational providers.

Named documentation retains the enclosing catalog for metadata and long-form
text and reads effective contextual symbols once for availability. Each
occurrence resolves its authoring basis once; its default symbols provider
reuses that basis rather than inspecting a moving root twice. Later occurrences
resolve independently. A symbols filter can hide an entry from the bare view
while named documentation still explains it as unavailable. Text-only
middleware changes neither structured symbols nor named lookup.

Generated producer and body scopes narrow symbols through ordinary middleware
while keeping the enclosing named-documentation owner. Leaving those scopes
restores the enclosing view. Synthetic answers that do not delegate perform no
default inspection. Descriptions register, resolve and authorize nothing, so a
custom view may describe a forbidden name without admitting it, or hide an
admitted name without disabling it.

The protected Syntax component records the final middleware answer inside its
existing durable live callback. Completed replay restores that final text
without consulting any live symbols, text or catalog provider. Its authenticated
invocation, safe canonical named refusal, publication and secret gate remain
separate from descriptive composition.

**Inspection is observation, never execution.** Producing symbols installs
only the declarative registration layer selection needs. It does not enter
`execute()`, construct a durable stream, install a Files, Service, Agent or
elicitation provider, start testing, reserve the terminal, mint an invocation
invocation authenticator, call an identity component's factory, or expand a body. `<Session>` is
described from the plain declaration a host would make; the factory that names
durable work is reached only by a real execution.

**Selection stays where it is.** Enumeration contributes *names* — from the
structural table, from the effective registrations, and from repository paths
that invert the dotted-name mapping — and every unique name then goes through
the same `selectComponent()` decision execution uses. Tiers, include order,
candidate order, repository override and registered fallback are therefore not
restated anywhere, and a repository component that overrides a default appears
once, under user-provided, with its repository origin.

**A partial set of symbols is never presented as a complete one.** A missing include is
ordinary absence. An include that exists but cannot be enumerated fails the
whole request: a non-directory, an unreadable tree, a symbolic link where a
directory was named, and a *selection-relevant* symbolic link to anything other
than a file. Traversal never follows a link to a directory, so refusing is what
stops the symbols silently omitting everything beneath one. The diagnostic names
the configured include and the logical entry, never the resolved host path.

**Relevance is the link's own logical path**, because that path is what probing
would have had to walk. A link is classified when its path is one of the
candidate spellings, or when every segment could be a name segment and the link
could therefore be an ancestor of one. A link behind a lower-case, dotted or
hidden prefix is ignored: no component name produces a probe through that
prefix, so what the link leads to cannot hide an implementation execution would
have selected — and refusing it would fail the default `["components", "."]` in
any ordinary package repository, whose `node_modules` is full of directory links
no name reaches.

**Documented forms are canonical and checked.** A declaration says which
authored forms a component accepts, and the spelling is closed: omission means
both, and the only arrays are `["self-closing"]`, `["paired"]` and
`["self-closing", "paired"]`. One spelling per meaning is what lets two entries
be compared without being normalized, so an empty array, a reversed pair, a
repeated member and a form no invocation has are refused where the declaration
is made — at registration and at the identity declarations inspection reads,
because a declaration refused in only one of those places is refused only when a
document happens to run. What a component accepts and what it says it accepts
come from one value: a dispatcher's forms are read off its own `FormDeclaration`,
and a component that refuses a form in its own body declares the form that
leaves.

**Documentation is descriptive metadata and nothing else.** `description`, `as`
and `context` take no part in expansion, resolution, validation, permission or
the journal. For a Markdown component they are ordinary frontmatter: a string is
copied, and any other value stays in `meta`, fails nothing and documents
nothing. First-party declarations hold themselves to a stricter rule — every one
states a description and decides explicitly whether `as` and `context` apply —
which is a discipline inside those packages, not a requirement on anyone else.

### The document validation boundary

Validate a supplied document as authored program structure before any part of it
runs. The operation receives one `RootDocumentSource`, root props, contextual
working directory and includes, the current component registry, and the same
plain identity-component declarations syntax inspection receives. Those values
are the declarative execution environment: validation never runs an
`ExecutionInstallation`, calls an identity factory, installs an operational
provider or reconstructs a CLI host to learn what names mean.

**Validation follows source, not execution reachability.** It applies ordinary
target selection to the root, scans that selected projection, and follows normal
component selection through every resolved Markdown definition the authored
invocations discover. The root is first; newly discovered definitions enter one
FIFO queue in their first-invocation order. Every invocation in each source is
checked in source order, including one inside authored control flow and children
beneath an origin-only TypeScript component. The validator neither evaluates a
branch nor predicts whether a component will project its children. A definition
cycle therefore terminates the source walk and is not itself a validation
failure unless a shared authored rule already makes it one.

**A path's bytes are read once; each view of them is parsed and scanned once.**
Reading and interpreting are separate, because one file can owe the walk more
than one answer. An ordinary component selection carries no target and asks for
the whole Markdown definition. A root asks for the projection its own selector
named. An untargeted root's body *is* the whole file, so it is that path's
full-definition view as well, and a name resolving there finds it already
scanned — which is what makes a root invoking itself terminate. A targeted root
projection and the full definition a component selected are two distinct views
of one path, each parsed and scanned once, from bytes read once. Letting a
projection stand in for the definition would answer for sections the root never
selected.

**A static answer never stands in for a runtime value.** Resolution, authored
form, engine-owned body shape and other structural rules run whenever their
answer does not depend on evaluating document code. Full props-schema validation
runs only when every schema-visible prop is static. A declared capture keeps the
same schema bypass it has during execution. A dynamic schema-visible expression
or an origin-only TypeScript contract makes an otherwise acceptable invocation
not statically checkable; validation does not partially solve JSON Schema around
the unknown value. A definite independent failure still wins, so an invalid form
does not become opaque because another prop is dynamic. An invocation is valid
only when every applicable check is statically proven, invalid when any such
check proves a failure, and otherwise not statically checkable. Opacity alone
does not make the document invalid.

**A declared Markdown component is checked as the contract it declares.** The
declarations syntax inspection reads are read here too, admitted the same way,
and an invocation of one is held to its parsed props, forms and return mode
exactly as a registration's invocation is. Its body is not walked: those bytes
are the host's, an author cannot change them, and the names only they may write
resolve nowhere else — so reporting on them would report a document's author for
the engine's own asset.

**A structural answer is the same walk without the run's values.** One
operation validates a document against the props a run would supply; the other
validates the source alone and skips only the root's own props check. Everything
else — the source walk, component selection, forms, body shape, bindings,
captures, returns and the diagnostic catalog — is one traversal and one rule set,
so a root that declares required props is structurally valid and invalid to a
run that supplies none, and the two answers cannot come to disagree about
anything else.

**Parsing stays one language rule.** Validation uses the scanner and definition
parsers execution uses. Component-like text that scanner treats as text remains
text, and spread attributes retain their execution meaning. A stricter MDX
grammar is a change to execution and validation together, never an extra parser
used only to approve generated source. Component selection, declaration
admission, schemas, forms, body rules, targets and source positions likewise
come from their execution definitions. If a check needs extraction from
expansion, both callers use the extracted rule; validation does not copy it into
a second catalog.

**The answer is versioned data.** Version 1 returns the document outcome, one
ordered invocation record per authored site, and one ordered diagnostic array.
An invocation records its name and position, the selected origin when one was
resolved, and exactly one of `valid`, `invalid` or
`not-statically-checkable`. An invalid record points into the diagnostic array;
an opaque record names `dynamic-props`, `origin-only-contract`, or both as its
reason. Diagnostics carry one closed code, a message, the source position and
component when applicable, and the existing normalized schema issues when a
schema failed. The closed version-1 codes distinguish unreadable and invalid
source, invalid target, frontmatter, props and returns declarations, unresolved
and ambiguous components, invalid invocation form and body shape, props,
binding, capture, return usage and structural usage.

Ordering is part of that answer: the root precedes definitions from the FIFO
source walk, positions order records within one source, and the closed diagnostic
code order breaks a tie at one position. A source failure ends only the checks
that require the source or definition it prevented; the validator emits no
speculative follow-on error. The document outcome is invalid exactly when a
definite diagnostic exists. The stable codes and normalized schema issues are
what an ACP generator or another host consumes; neither parses the message.

**Observation performs no document effect.** Validation may read the supplied
root and selected Markdown definition files. It does not evaluate an expression,
render or project component content, invoke a component, create or read a
journal, run a command, prompt, elicit, start an agent, or perform a filesystem
operation the document authored. Those prohibitions are one boundary rather
than a test fixture's list of components: adding a component cannot make
validation effectful.

## The private REPL composition kernel

`packages/cli/src/repl/` is a private CLI feature, not a package boundary and
not part of `@executablemd/core`'s surface. Its layers are one direction:

```text
DurableEvent[] → frozen ReplModel → resolved view → keyed descriptions
              → one mounted Freedom tree → a frame
                        ↑
            typed semantic actions, target ancestry → root
```

The Journal is the only durable truth, and history terminates at `ReplModel`:
projection detaches every value it retains and freezes it, so nothing below
holds a `DurableEvent` and nothing above can change one. Route resolution is
pure and answers with the exact objects that model holds.

### Sequential entries over one physical journal

One execution is one append-only stream, and entries are ranges of it. A segment
begins at the root `import_component` admission and ends at that root's `Close`;
only the final one may be unfinished. Each live execution is given a private
view over exactly its own segment, so a repeated root name and a reused
coroutine id cannot correlate across entries — the view reads only its range,
delegates every append to the physical stream, updates what it believes only
after that append is acknowledged, and refuses to write at all once its segment
is closed or is no longer the final one. No physical offset reaches Core; the
command's own observer holds the acknowledged prefix and computes the resulting
marker. This partitioning is private to the CLI: `DurableStream` is unchanged
and there is no physical-offset API.

The whole prefix is partitioned and validated before any entry is projected, and
a malformed boundary refuses the model whole rather than yielding a partial
catalog — work before the first admission, a nested or repeated admission inside
an unfinished segment, a close with no open segment, work between a terminal
close and the next admission, a second unfinished segment, or a segment the
one-entry reader cannot read.

Entry keys are `entry-1`, `entry-2`, and so on, from immutable admission order;
they are not Journal markers. The first entry keeps every marker spelling it
ever had, so every location written before this existed still resolves, and
later entries namespace their segment-local markers with their key. Projection
converts between the two at that private boundary, and Core sees only the
segment-local history it already understands.

Values cross between entries through one trusted-host input: `executeInstalled()`
takes the root environment's initial bare bindings beside the source, exported
from `@executablemd/core/host` and from nowhere else — not a Context, component,
middleware answer, document prop or durable record, and not on ordinary
`execute()`. Core parses, name-validates and recursively copies the whole record
before any installation or document code runs, and the detached values are
ordinarily mutable inside the execution that receives them. The REPL derives
that record only from values durably retained before the new entry's admission,
so replay derives the identical record from the identical bytes.

The session owns at most one entry task. Starting another needs two separate
facts — the preceding entry has a retained terminal close, *and* its task has
completely torn down and joined — because observing a terminal outcome is not
the same as the work being over. There is no queue: a submission that arrives
before both hold is refused, having started nothing, and teardown stops a
pending one from starting rather than appending on its behalf. Settled segments
are projected and never replayed; only an unfinished final segment is given back
to Core to continue.

A location is resolved against the retained history before a session opens.
Opening one starts or resumes the execution, and replay past the retained prefix
appends — so a route naming a scope or drawer the file never held is answered
from the records already on disk, where being wrong costs nothing. Resolution
takes one fact the model cannot hold: whether this process is asking a question.
A waiting question is the one thing a Journal never records, so neither
`settled` nor the recorded elicitations distinguish a history that is about to
ask from one that never will, and a live drawer resolved from a history alone
would replay a whole execution to mount nothing. It defaults to *not* asking, so
a caller that cannot say refuses. The overlay's
output is announced on its own stream, because it is the one thing a frame shows
that leaves no record for anything else to observe.

`specs/repl-spec.md` describes the product this assembles. The runtime-named
`{deno,node,bun,compiled}-repl.ts` modules state their own platform's data
directory, identifier and filesystem operations; nothing under `repl/` names a
runtime.

### Navigation is the whole file; content is one prefix

Every pane reads the selected prefix. The History band and its drawer are the
explicit exception, and the only one: they read a thin summary of the *whole*
validated file — a marker and a kind per retained position, plus the head —
because the positions after the selected one are where a reader can go next.
No label, source, name, value, outcome detail or observation is in it, so
nothing a later position holds reaches a reading of an earlier one.

Both halves come from one acknowledged event array per wake: the full file for
the summary, the requested marker for everything else, through the projector's
existing whole-file validation. The full model is discarded from child
reachability rather than kept, so nothing downstream can walk to a later entry
through it, and navigation is never assembled by appending to a selected
model. A later malformed segment refuses the whole reading even for an earlier
marker — the alternative is stale navigation standing beside a prefix that
still looks plausible.

The session hands both halves over together, as one reading, and the root
carries that one value through resolution, paint and resize rather than asking
again for either half. It has to: the root reads the terminal's size between
resolving a frame and composing it, that read suspends, and a record can be
retained while it does. Content taken before it and navigation taken after it
would describe two different files on one screen. A resize recomposes the
reading that was resolved at a new size, never at a new snapshot.

When that reading cannot be built at all — a record this process wrote and can
no longer read — the root draws the refused view, the same screen a cold open
of the same file shows. That is a different outcome from a route that does not
resolve at its position: there, a reading still stands and the reason is said
beside it. A refusal has nothing to stand beside, so nothing is left on the
screen pretending to be current.

The head is derived on read from retained facts and from work this session
owns, never from a body's return, a recorded root Close, a component badge or
the selected content. It changes while the file stands still, so it publishes
through the wake the session and the controller already send; History adds no
stream, timer or clock. The inspected action row keeps its historical
restrictions: navigation is the exception for the band, not for capabilities.

### What one REPL command settles before it draws

The command line is read, the Agent configuration is settled, and then one
immutable profile is assembled in the command's own scope: the selected Plugins,
the Agent identity components, the packaged `<Plan>` declaration and the ordinary
evaluation ceiling, with the settled permission mode beside them. The program
takes that one profile and nothing else, so what an entry may resolve, what
ceiling a generated fragment runs under and how a permission request is answered
are facts about the command a person invoked rather than about the entry they
typed. The profile carries data and installations, never authority: no stack,
provider, Plan writer, live request or scope reaches the application model, the
route or the Journal through it.

The `<Plan>` the REPL declares is the packaged Component `xmd plan` runs, and the
ceiling around a returned program is the shared ordinary profile — whose write
table holds paired canonical `<Elicit>` beside `<File>` and `<File.Delete>`, so a
generated program may ask before it writes. That entry is a pinned capability
rather than a name the fragment resolves: preflight selects it where an
`<Elicit>` occurrence appears under a `write` selection, and the body it selects
is core's own `<Elicit>`, closed over before any document code runs. No component
name is resolved for it, so a same-name repository, registered, declared,
middleware or separately loaded definition inherits no grant and never runs, and
an execution that never writes the element resolves nothing. Only the interaction
is contextual: the pinned body asks through the Elicitation Api lexically in
scope, which is what lets the REPL drawer answer a generated question and an
`<Answers>` region answer it without anybody being asked.

Permission composes outermost-first: Core's own audit observer, then this
session's authoritative policy, then whatever the document and provider
installed, then the base denial. One private ledger per inherited Prompt scope
holds what was granted, and a retained audit is read rather than answered. The
live overlay, the application and the terminal have one owner each — the session,
the root transition boundary and the screen — and every ending cancels and joins
that owner rather than appending on its way out.

Ownership in the model is read from the Journal and from nothing else. An
import's retained selection says where its scope's source came from — a path for
a component read from somewhere, the retained origin for one the host declared —
and that origin is the path the effects inside it are recorded against. A
generated fragment has no file, so the work inside it names the admission it was
decided under, and the scope that admission created is what owns it: the
identity chooses the candidate, and journal order and coroutine ancestry only
say whether that candidate could be its owner — an admission that happened afterwards,
or on work the effect is not part of, owns nothing however recently it ran. Two
sequential fragments are therefore sibling scopes, work in a fragment's spawned
descendants belongs to that fragment, and concurrent siblings are independent of
which finished first. A record naming a source this prefix never admitted, one it
admitted twice, or two sources at once is refused rather than attached to a
guessed owner.

### Keyed composition and mounted ownership

Composition is keyed. A parent describes its complete child set; the reconciler
judges all of it before mutating any of it, adds and updates before removing,
then sets canonical order, and acknowledges the offer only after that commit.
Identity is parent, key and type, so redescription preserves a node and its
running lifetime while a changed key or type replaces it. Freedom owns the one
mounted lifetime tree and the one focus store, and a component's capabilities
live in its own node's `NodeData` — an absent description therefore leaves no
node, no input, no focus, no frame contribution and no output anywhere.

A component is constructed synchronously inside the commit and may own ongoing
work in its node's scope; a render body owns nothing. Normalized host input is
decided once, at the host, which names a target and an event shape and never an
action; the tree walks that target's own ancestry, and the first node to handle
the event produces the typed action the root acts on. An event nothing handles
is an explicit failure.

Freedom is vendored from a pinned unpublished commit under
`packages/cli/src/repl/vendor/freedom/`, as a pristine copy and a patched copy
whose every difference belongs to one named patch. See its `PROVENANCE.md`.

### One chronology, and the authority that answers it

The Sessions reading is one list, not two appended: every Prompt this process
observes takes a slot when it is scheduled and keeps it through publication, so
a turn that becomes durable stays the same mounted node in the same place, and
concurrent Prompts that publish out of order do not reorder each other. The
slot, its order and its live key are process-local — no route, model, Journal
record or public Core Api carries one.

A Prompt's sequence number is local to the execution that recorded it, so it
restarts with every entry and two entries may each hold sequence `0`. Turns are
therefore ordered by entry admission first and by sequence within that entry,
and uniqueness is required only inside the owning entry. Both retained and live
turns carry their entry beside their scope, and a publication is correlated by
the pair — a durable Prompt name says where it was written, so two entries
running one source hold the same name at the same position, and correlating by
the name alone shows one turn twice and the other not at all.

Sessions stays one execution-wide chronology grouped by the provider's session
key and by nothing else. Selecting an entry changes which transcript is being
read and never which conversations are listed.

Filtering is by the conversation key a provider actually issued; an authored
`<Session>` name is not one. Selecting or clearing changes `route.session` and
nothing else, and background Agent work never changes it.

A pending request is a fact on the turn that is waiting. Arrival mounts it and
does nothing else. Activating it records that request's opaque key in
process-local state — never in the location — and opens the Sessions-only
`+permission` drawer; the reducer decides and `program.ts` alone holds the
authority that answers, so the drawer closes only when the request is really
settled and a stale, unknown or unoffered action settles nothing. A retained
permission audit is an inert reading, and a historical prefix has no live
requests to answer.

Both readings are windowed at the layout region that will place them, rather
than described whole and clipped: only what the window holds is described, so
only that is mounted, focusable, drawn and pointable. A window moves from the
position its frame is drawing rather than from the number stored, because a
resize changes what a window holds and a delta added to a stale number would
spend a press on state nobody can see. The canonical location is bounded the
same way and for the same reason: in a narrow frame it shares one region with
every control on the screen, so it takes at most three rows and says what it is
not showing. Their window controls and
the two surface controls stay outside the moving window. A narrow frame mounts
one routed outlet and both surface controls, so the outlet the route did not
select is absent everywhere — `mounted()`, the frame, the target map — while the
way to it is not.

Whether a pointer may activate a row is decided by what the row is, not by how
its key is spelled: a control answers Enter, so a pointer on it asks for the
same thing, and a line has nothing to activate. Keys carry provider session keys
and field names, so a rule about spelling would have taken the pointer away from
a conversation or a field whose name happened to look like something else.

### From a frame to a terminal, and back

Below the tree, one more direction — and it begins before anything is mounted:

```text
one resolved reading → candidate rows + a layout manifest
                     → measure (empty viewports)      ← the engine answers
                     → admit (rows, whole controls)
                     → reconcile exactly the admitted set
                     → draw → bytes → the terminal
                              ↓
                     element id + geometry → the live node it came from
                              ↑
   bytes → normalized key or position → target → the same ancestry walk
```

**The engine places; this boundary only states constraints.** Profiles, column
widths, the drawer's integer rectangle and the footer's seven rows are product
facts declared once; where a row lands and how many rows a region holds are
answers the engine gives. Nothing computes a cell coordinate or a capacity
twice, because a question asked in two places is a question answered two ways.

**Measurement comes first, and it is not a frame.** The application builds inert
ordered candidates and a paired manifest from one semantic reading, and the
measuring pass draws that manifest with every scrolling viewport genuinely
empty — surrounding headings, both window controls and complete action labels
included, so the room it reports is the region's rather than whatever is
currently overflowing it. That pass mounts nothing, publishes no target,
advances no revision and acknowledges nothing. Capacity is the measured viewport
height, floored and bounded at zero; a region the engine measured nothing for
holds nothing, because "no window means show everything" is how a list comes to
describe rows the frame cannot place. Width-dependent text — the canonical
location, a transcript row, a failure reason — is absent from the pass that
answers how wide its region is, since a growing column takes its minimum from
its widest child and one unbounded row would make the column wider than its
share. Each row then states that measured width, so a row can neither widen its
column nor publish a hit box reaching into the next one — and its label is
fitted to that width, because a rectangle bounds a box and not its characters:
the engine draws the text it is given and clips none of it. Fitting is by part
rather than a cut at the end, since the end is where a row says what it is
*about*. A name nothing in this product bounds gives up its columns first; where
the row's own vocabulary will not fit either, the fact the row exists to carry
survives whole and the name keeps what is left in front of it, because a state
cut in half says something untrue and two rows that are only their state are two
rows a reader cannot tell apart.

**Admission decides what exists.** One pure adapter clamps the
application's own offsets against the measured capacity, selects the visible
range, and admits action controls as a contiguous priority prefix — stopping at
the first control the row cannot hold whole, even where a later narrower one
would fit, because a row that reordered itself between two sizes would move the
control somebody was reaching for. An explanatory sentence is not a control, so
the row shortens it instead of dropping it. Only the admitted set is offered to
the tree: a row outside a window and a control the row cannot hold are not
described at all, so neither is a cell, a pointer target or a keyboard stop.
The same admission reaches the reducer, so a scroll moves from the clamp the
screen is showing rather than from a number a resize or a filter left behind.

Placement is still presentation and tells the tree nothing about meaning:
resizing changes which rows are admitted, never the identity of a row that
remains, the selection, a model object or an action. Four sizes are decided —
wide, medium, narrow, and a refusal below the narrow minimum that recovers when
the window grows — and a control the refusal hides is drawn nowhere and
therefore targetable nowhere.

Only mounted nodes are drawn. Each rendered frame carries an immutable map from
the element the layout engine measured to the live node that asked for it, and
that map is valid for exactly the tree revision that produced it: a pointer
resolved against it travels with that revision's number, so a pointer from a
frame the tree has moved past, one naming a node that has since gone, and one
landing behind an open modal all reach nothing. A target exists because an
admitted box mounted a live control — bounds alone cannot establish it, since
the engine reports a clipped child's whole rectangle and says nothing about what
was painted. Resolution is half-open on both axes, because the engine's own hit
test includes a box's trailing edge and every row of a stacked list would
otherwise be assigned to two neighbours. A bound that is not whole cells is
refused rather than rounded: the engine produces fractional geometry wherever
something is centred or sized by a share, and a rounded hit box disagrees with
the text underneath it. A pointer that does resolve becomes the same normalized
event a key produces and walks the same ancestry, so clicking a control and
pressing Enter on it are one action.

An open drawer is one floating, opaque rectangle over the body and above the
footer. The background is coverage rather than style: an element without one
lets what it covers show through from wherever its own text stops, so the blank
interior of a short modal line would still be the transcript underneath it. The
engine's pointer capture narrows the engine's own hit test over that rectangle
and is not containment — whether a dispatch may reach a node behind the modal
is the reconciler's to refuse, and it refuses with capture off.

Text is its own member of that normalized union, not a key with a payload: a
named key — submit, dismiss, traverse, erase — is a command whoever handles it
recognizes, and text is content that goes wherever content goes. It carries what
the terminal decoded, so shifted, accented and multi-byte characters arrive
already assembled, and a newline inside a paste arrives as one. A chord carries
a letter in its physical key code, and reading that code would type the letter
somebody held Control with, so a chord is dropped whole — payload included.

**One renderer owns two engines, and they are not interchangeable.** The engine
emits a complete redraw after any update that is not a no-op, so telling it a
size it already has throws away the diff the next committed frame is computed
against — and the size is restated before every frame rather than only on a
resize event. The engine diffs every render against the previous one on that
instance, whoever asked and whatever was done with the bytes — so a render
taken only to read geometry back becomes the front buffer the next committed
frame is compared against, and the committed frame then emits only the
difference from a frame nobody ever saw.
Measured: a Sessions reading filtered from twelve rows to two left the
thirteenth still reading `conversation 11`. One instance therefore only
measures, the other alone owns committed display state, both are told the same
size, and they are acquired once and reused for every frame. Only a capacity
refusal replaces an instance — the one that refused, at the size the frame was
laid out for. The installed engine exposes no disposal, so ownership ends by
releasing the references with the renderer's scope rather than by calling a
cleanup API that does not exist.

Everything a caller may hold is copied out of the engine the moment it arrives —
the bytes, every published bound, the whole target map — because the engine
hands out a view into its own memory and an `info` that the next render
invalidates. An older frame therefore keeps answering exactly what it answered.
Recovery changes nothing above it.

Placement at narrow describes and mounts only the surface the route selected.
The unselected surface has no node, cell, frame-map entry, focus stop or pointer
target; both surface controls remain available, and application and journal
state are retained. The inspection reading is different, and is not described there at all: a
narrow frame has no inspection region to put a binding row or a recorded answer
in, and a row described into a region that does not exist is mounted, focusable
and placed nowhere — a Tab stop drawing no cell and a pointer target behind
nothing. So an answer given at a narrow size restores focus to the entry that
owns the record rather than to the record's own row, and the catalog's own
process-local offset moves only as far as it takes to show that entry. What is
selected and which route is showing are unchanged by any of it: this is what the
frame offers, not what the reader chose.

Presentation time has one owner. There is a single acknowledged frame stream:
holding a subscription is what asks for frames, an advance waits until every
subscriber has **applied** the last timestamp — receiving one is not applying
it, because drawing with a timestamp suspends — and a tree with no subscriber
schedules no timer at all. A cancelled subscriber's demand goes with it and its
acknowledgement never arrives, because it did not finish the frame it held. An animation spanning components belongs to their
nearest common mounted ancestor, whose lifetime is the animation's; nothing
below it keeps a clock of its own. The stream carries presentation time only —
Journal records, model selection, routes and execution pause state are outside
it. Measurement sits inside the frame a subscriber is already holding, and the
measurement an action needs before it can move a window subscribes to nothing
and acknowledges nothing: it is a question about geometry, not a frame. If the
terminal's size moves while a frame is being prepared, that preparation is
abandoned and rebuilt for the size that is actually there, because a measurement
taken at one size and a draw at another is how a window comes to show rows the
frame cannot place. Every preparation is revalidated, with no last attempt that
skips the check: the rebuilding is bounded per frame rather than overall, and a
frame whose whole budget went to preparations the terminal outran releases its
subscription without applying the timestamp and defers to the next frame.
Presenting the measurement a terminal has already contradicted would put stale
geometry on the screen and publish targets naming rows nobody can see, and
ending on it would be a command that cannot be resized — so it does neither.

A frame that cannot be drawn ends the screen. A refused subscription, a refused
reconcile and a refused render all raise, because the scope that owns the
terminal is the only thing that restores its modes: a command that kept raw mode
and the alternate screen while showing a picture it can no longer update has
taken the terminal and stopped saying anything.

The terminal itself is a contextual Api, and a runtime-named adapter installs
it. Shared code never asks which runtime it is on; it asks whether a person is
at it, and for the size, bytes
in, bytes out, raw mode and resize notifications. Whether there is a terminal is
settled before any path is formed or any history created, so a piped invocation
refuses instead of leaving an execution nobody can open. Whoever opens the terminal
registers the release of each of those before taking it, so a cancellation
between the two still gives the terminal back — and every exit, whether the run
finished, refused, failed, was cancelled or reached end of input, stops the
reader, removes every listener, restores the modes and writes the final reset
exactly once.

### What the screen teaches, and what leaving it costs

Presentation guidance, visual emphasis and the contextual status a person reads
are derived process-local state. They are computed from the mounted tree and the
resolved view on the way to a frame, they are in no location and no record, and
replay neither produces nor consumes them. A screen that explained itself
differently would still be the same execution.

**What a row means is decided once, where the facts are.** The application
assigns each row one immutable presentation role, and separately whether it is
selected and whether it is being read as history, from the typed reading that
produced it — a record's kind, an entry's terminal status, the resolved route.
Nothing infers a role from a finished string, a path suffix or how a key is
spelled, so arbitrary document and provider text is drawn as ordinary prose
whatever words it happens to contain. Candidates and boxes carry those facts
beside the text and the control identity; they carry no mounted node, no Journal
record and no focus authority, and the manifest holds no focused node.

A private module maps a role and those two flags to a colour, a weight and a
surface. It is pure: no operation, no contextual Api, no Journal access, no
mutable state and no export beyond this feature, so a role owns nothing that can
outlive the frame that computed it. The palette lives there and nowhere else.

**A row whose characters mean different things carries runs.** A run is plain
immutable view data — a string and the name of a role — issued by the composition
module and concatenating to exactly the text the row draws. The ops builder emits
one text operation per run *inside the one element the row was measured as*, so a
row reading as several things is still one node, one bound and one pointer target:
a child per token would publish a hit box for every delimiter on the screen. Runs
apply only when they spell the text being drawn; a row whose mounted node
contributed something else is drawn as one stretch under the row's own role.

A second private module says what the characters of the two readings this screen
shows verbatim are: executable Markdown source, and a serialized JSON value. It
classifies one line at a time, because a cell is a row and a classifier carrying
state across rows would be answering about a document. It is pure and
presentation-only — it validates nothing, evaluates nothing and rewrites nothing,
and every run it returns concatenates back to the line it was given. JSON is
classified from a value this product had already parsed or from a reading a caller
knows is JSON, never from a guess that arbitrary provider or document text looks
like JSON.

**Keyboard focus is not a fact about the reading**, so it arrives later. After
reconciliation the commit boundary passes the actual focused mounted node's id to
the ops builder for that frame alone, matched by exact mounted identity and
discarded with the ops it decorated. Focus adds weight and never geometry, and it
takes no foreground away: a row's own roles say what its characters are, and the
focus colour belongs to the marker in front of the row, which is a run of its own.
Selection keeps an independent surface. Neither repairs, stores or grants focus.

**One builder decorates both passes.** The measurement pass and the committed
pass run through the same op builder, so pane edges, surfaces and headings
participate in measurement and a measured region cannot disagree with the region
drawn into it. A pane's own edges are not part of the room inside it: a bordered
pane carries a border-free content box, and rows are built to the width the engine
reports for that box rather than to the pane's outer bound. A drawer's own
decoration is held to the same rule: the rule along the top of its rectangle and
the one-cell inset on each side are elements of that rectangle, so the content
window is measured at what they leave and admission answers from that measurement
rather than from the undecorated rectangle. The renderer stays
model-blind — it receives ops and geometry, classifies no row text, and no
production string carries an escape sequence.

Placement owns where things are, and the footer's seven rows are fixed in one
order: the contextual status and action row, the five History rows, and the draft.
Each is stated as geometry rather than inferred from a list's length, because the
one thing on that screen that is not a mounted cell is the History band — its
labels come from the model, so nothing else can say where it goes, and a renderer
left to place it on its own put it at the terminal's origin over the sidebar. A
control the row cannot hold whole is left out of the frame entirely, so what a
pointer can reach and what a person can see are the same set.

Leaving is lifecycle control, and the one semantic action that settles nothing.
It answers no question, decides no permission request, and appends no close,
cancellation or audit: an entry whose root never closed stays unfinished, because
that is what the file says about it. The command-owned scope is returned from
rather than torn down from inside, so the session, the observer, every entry task,
the reader and the frame subscription are halted and joined by the unwind that
return causes — no host exit call, and no halt left unjoined. The route it prints
drops the drawers only a running process could have mounted, because a location
naming a waiting question is one nothing can reopen.

**What the screen says the execution is doing is read from two halves.** The
projected history answers what the file holds; this process answers what it is
still doing. Neither is sufficient alone, and the gap between them is a real
state rather than a rounding error: a root close is appended when a document
settles, while the task that produced it is still unwinding, so a reading that
took `settled` for "ready" would offer the next entry into a teardown that has
not finished. The session's existing liveness reaches the view for that reason
and no other, and the two are resolved into one value — because the sentence a
person reads and the decision about whether a standing refusal still applies are
one judgement, and two places deciding it separately is how a screen comes to
announce that the next entry may start directly above a refusal explaining that
the last one has not finished.

That value is derived presentation, like the guidance beside it: computed on the
way to a frame, in no location member and no record, produced and consumed by
nothing durable. It is also what decides when a refusal expires. A refusal the
readiness gave is true of a moment, so it is dropped once a submission would be
admitted; a refusal of a document that cannot be admitted, or of an answer a
schema rejected, is true of the thing itself and stays. Telling them apart cannot
be done by class — a separately loaded copy has its own, and `instanceof` answers
no across the boundary — nor by `name`, which is writable and so can be worn by
any failure at all. The session marks its own refusals with a namespaced,
non-enumerable own property at the point of raising, carrying the sentence it
normalized, and the screen reads both the classification and the text back from
that mark: authenticating one while displaying the other would show text the
session never said.

A recorded failure's reason is presented the same way and bounded the same way.
The parsed message is already in the model; what the transcript adds is a row for
it beside the compact outcome, flattened to one line and cut to the region it is
drawn in, introduction included. A reason is whatever failed, and what failed may
be a compiler: bounding only the message hands an over-wide row to a narrower
column, where the renderer cuts it again and takes the mark that said it was
shortened with it.

Permission announcement follows the same rule in the other direction: the fact
that a request is waiting is presentation, and the authority that answers it is
Sessions'. Saying where a request is answered moves no route, opens no drawer and
takes no focus. And a frozen prefix reads none of it — not the running entry, not
the waiting question, not the pause capability — because a prefix is a reading of
the file and the live head is not part of that file's past.

**Terminal input is an owned stream, and that ownership is what makes leaving
possible.** A runtime supplies the REPL's input as an Effection `Stream` whose
resource holds the native reader, and it registers that resource's release before
it acquires anything — so a scope cancelled between the two leaves nothing
attached. The release actively cancels the read that was outstanding and waits for
the cancellation, which is why teardown needs no further keystroke; it is
idempotent, it is never fired and forgotten, and once it has completed no reader,
listener, task or unsettled promise remains. End of input closes the stream
normally, a read that fails raises as a terminal failure, and an owner cancelling
is neither of those — it is the absence of both. Terminal modes stay with the
screen that owns them and are restored exactly once.

The previous design handed over an `AsyncIterable` and released it with the
iterator's own `return()`. That is queued behind the very `next()` it has to end,
so a command that decided to leave while a read was outstanding finished only when
the person pressed one more key — which they had already stopped doing. A capability
that can only *ask* to be released is not ownership.

Each runtime spells its own reader and nothing else: Deno and the compiled binary
share one surface, and the two Node-shaped hosts share a helper that takes its
standard input by value, so no portable module detects a runtime to decide how to
read a terminal.

Which surface owns which drawer is one rule with one implementation. Decoding,
encoding and resolution all consult it, so a route is refused where a caller is
deciding whether to adopt it rather than at the moment something asks for its
canonical spelling: resolution that accepted what encoding refused is how an
adopted route came to raise out of the render path and end the command. A live
question's drawer belongs to the Entries surface, at the live head, for the entry
still running, while this process actually holds the question — and activating the
row that announces one is what crosses to that surface. Nothing crosses on its
own: arrival announces and repaints, and that is all it does.

This command installs no foreground launcher, no browser elicitation and no
readline permission handling, reads no runtime global, and adds no durable record
family of its own: what it retains is the ordinary events any other run writes.

### The whole of it, and where the pieces are

```text
DurableEvents -> frozen ReplModel -> resolved immutable view
  -> keyed Freedom tree -> semantic layout -> tty frame
  -> typed action back to the root
```

| module | what it owns |
| --- | --- |
| `model.ts` | projecting one validated Journal prefix into a frozen model |
| `route.ts` | the location grammar, and resolving one against a model |
| `journal.ts` | the retained NDJSON stream and the repository over a root |
| `session.ts` | admitting entries in turn, reopening one history, and the live overlay |
| `entries.ts` | partitioning one physical journal into entry segments, and the private stream view over one of them |
| `expansion.ts` | pausing and continuing expansion over the public seams |
| `elicitation.ts` | the one question shape this REPL presents |
| `description.ts` | opaque immutable descriptions and the closed action boundary |
| `reconcile.ts` | reconciling descriptions into one mounted Freedom tree |
| `handoff.ts` | the acknowledged commit boundary |
| `navigation.ts` | every retained position and the head, as the one reading taken at the whole file |
| `history-rail.ts` | the five-row History band, placed from engine measurements |
| `source-reading.ts` | one entry as output and then source, with what each element is doing |
| `presentation-text.ts` · `presentation-style.ts` | what the characters of a reading are, and the colours it is drawn in |
| `fitting.ts` | engine-measured widths, and the rows a reading is cut into |
| `layout.ts` | deterministic placement at four sizes |
| `renderer.ts` | drawing the mounted tree, and the frame map |
| `frame.ts` | the one acknowledged frame stream |
| `input.ts` | normalizing bytes into the closed event union |
| `terminal.ts` · `terminal-host.ts` · `screen.ts` | the terminal Api, its portable half, and the one owner of its modes |
| `components/` · `application.ts` | the screens, and the one state transition boundary |
| `storage.ts` · `program.ts` | where histories live, and the command as one scope |

## Terminology

Terms are locked here. Two rules:

1. Only use concepts and words described here or already defined in the spec
   and code.
2. If a concept or term is missing, ask for permission before using it; using
   it requires adding it here first.

Existing documents and code get aligned to this section retroactively.

"Authority" is not one of these terms. Each boundary it once covered is named
for what it actually does: canonical resolution, admission, configured
permission, ownership, coordination, publication, execution, or definitive
settlement. Two serialized spellings keep the older word because their bytes are
a compatibility contract, not a description: the durable `LaunchFailureClass`
value `"directory-authority"`, which a retained launch record is parsed against
by exact match, and the Files invariant category `"authority"`, which crosses
loaded copies and is matched the same way. Renaming either would break replay
and categorization rather than clarify them, so both stay exactly as written.

| Term | Meaning |
| --- | --- |
| behavioral predictability | a plan as a program: ~80% deterministic, ~20% probabilistic [Reference](#three-axes). |
| replay determinism | the journal doesn't lose the execution chain: replaying arrives at the same state, where execution can continue [Reference](#three-axes). |
| replay | using the durable journal to restore the recorded portion of a document execution without repeating durable effects; after the recorded entries are consumed, execution may continue live [Reference](#replay-and-effect-transactions). |
| divergence | reserved for replay: a replay that departs from the recorded journal [Reference](#replay-and-effect-transactions). |
| REPL history | the immutable ordered execution records the REPL reads from the durable journal and projects into `ReplModel`; the History surface presents this read model and is not itself a journal [Reference](#the-private-repl-composition-kernel). |
| middleware | applied by the lexical structure, used by runtime execution [Reference](#two-layers). |
| workflow run | a workflow being carried out with its progress and outcome recorded durably; document executions perform its work, while ongoing effects remain scoped to the document execution in which they run [Reference](#workflow-runs). |
| document execution | one evaluation of a root document initiated through `execute()`, producing one output stream and one completion result while reading and appending a durable journal; its ongoing effects belong to the Effection scope in which the evaluation runs [Reference](#workflow-runs). |
| workflow definition | one closed retained source-bundle descriptor: `hashAlgorithm`, `bundleHash`, `entrypoint`, `sources`, optional `targetPath` and `components`. It carries no version, kind, Git base or pinned commit; exact target and component mapping participate in identity. [Source and identity](#identity-is-separate-from-retrieval). |
| source bundle | The exact retained entrypoint, source manifest and optional component mapping from which a workflow executes. [Owning rule](#identity-is-separate-from-retrieval). |
| logical path | a portable identity inside a source bundle, never a host filesystem path: NFC Unicode scalar values, `/`-separated, without leading or trailing separator, NUL, C0 control, DEL, backslash or `#`, and without an empty, `.` or `..` segment, compared case-sensitively by its UTF-8 bytes. The containing directory, the absolute path and the invocation working directory are retrieval facts and never identity [Reference](#identity-is-separate-from-retrieval). |
| workflow component bundle | the closed set of authored Markdown components a workflow root declares. A bundle maps each name onto a logical path the same source bundle retains. It is both definition identity and canonical resolution: the names it declares resolve to its exact retained sources and to nothing else [Reference](#the-workflow-lifecycle). |
| declared Markdown component | Exact first-party Markdown a trusted host declares to one execution. [Owning rule](#the-declared-markdown-boundary). |
| private component closure | A declaration-owned set of implementations available only at eligible lexical occurrences of its own body. [Owning rule](#the-declared-markdown-boundary). |
| retrieval metadata | replaceable, credential-free information about where a workflow definition can be fetched from now; it takes no part in run identity and is reauthorized by the host before use [Reference](#identity-is-separate-from-retrieval). |
| stop reason | why a workflow run or a document execution stopped: a categorical host code, or a reference to an already-filtered journal event [Reference](#the-workflow-lifecycle). |
| run ID | an opaque stable public identifier generated by the host or selected by an authorized caller; it associates the run's durable records and effects, remains unchanged for the life of the run, and has no semantics beyond equality and lifecycle addressing [Reference](#workflow-runs). |
| Repository base | the optional Git revision from which one named Repository initializes its primary checkout [Reference](#ordinary-repository-ownership). |
| Repository selection | Provider-minted composition data naming a repository and checkout, never permission. [Owning rule](#ordinary-repository-ownership). |
| ambient Repository | The lazily discovered repository enclosing the invocation working directory [Full contract](#ordinary-repository-ownership). |
| managed checkout | A persistent authenticated checkout with execution-owned locking [Full contract](#ordinary-repository-ownership). |
| ordinary Git identity | The live invoking-user identity captured only when a commit needs it [Full contract](#ordinary-repository-ownership). |
| ordinary invocation identity | An opaque provider-owned identity unique to one ordinary execution [Full contract](#ordinary-repository-ownership). |
| pinned commit | a Repository's creation commit, resolved once from its optional base and stable while its descendants run. A workflow source definition has no base or pinned commit. [Reference](#ordinary-repository-ownership). |
| document target | an addressable static heading in a root document's own Markdown flow, named by the canonical path of heading labels that reaches it; selecting one executes the preamble, each ancestor's own content, and that heading's complete subtree [Reference](#document-targets). |
| Prompt | a person's original request, in ordinary natural language. `xmd plan` takes exactly one [Reference](#plan-information-requests). |
| Plan | An inert executable Markdown program produced from a Prompt, with a descriptive title and readable steps. [Owning rule](#plan-information-requests). |
| plan command document | The packaged value-root adapter through which the Plan command obtains approved source. [Owning rule](#plan-information-requests). |
| packaged `<Plan>` Component | The one first-party Markdown program that owns Plan drafting, repair, review and source emission. [Packaged component contract](specs/plan-command-spec.md#the-packaged-plan-component). |
| Plan writer profile | The fixed host assembly in which the packaged Plan authors source. [Profile and resource lifetimes](specs/plan-command-spec.md#the-plan-writer-profile). |
| upgrade command document | The packaged streaming text root that owns release selection, consent, refusals and reports. [Owning rule](#construct-inventory). |
| upgrade assembly | what one runtime-named entrypoint states about the `xmd` that is running: its provenance, reported version, invoked executable path, platform, architecture, release target when the release publishes one, and — for an eligible compiled macOS or Linux host alone — the factory for the four phases an installation needs. It describes how this `xmd` is running, never how its files arrived [Reference](#construct-inventory). |
| release identity | the invocation-local opaque identifier `<Upgrade.Releases>` mints for each release it admits. Holding one is what authorizes downloading that release, and nothing outside that one invocation's private admission map can read, extend or forge it. A download mints an upgrade candidate identity in the same way, and that candidate advances `downloaded → verified → committed` exactly once [Reference](#construct-inventory). |
| expansion | one logical evaluation of an authored executable element within a document execution [Reference](#expansion-identity). |
| expansion ID | a deterministic identifier for one logical expansion; restoring or retrying that expansion preserves the ID, while a distinct evaluation requested by the document receives another [Reference](#expansion-identity). |
| Git capability | the contextual interface through which `@executablemd/git` queries the Git repository associated with the current working directory [Reference](#workflow-runs). |
| Git host | an external service that owns remote Git repositories and associated collaboration objects such as branches and pull requests. GitHub is one Git-host adapter. A Git host is distinct from the local Git capability and the trusted workflow host, and from an Issue provider [Reference](#replay-and-effect-transactions). |
| Issue provider | an external service that owns a collection of issues. GitHub and Atlassian Cloud are Issue-provider adapters. It is a separate boundary from a Git host because an Issue provider need not own a Git repository, and one that does not cannot truthfully persist as a Git-host effect [Reference](#issue-effects). |
| Issue tracker | what a lexical `<IssueTracker>` names: a credential-free URL for the container new issues are created in, together with an optional explicit provider discriminator. An upsert requires one and takes its discriminator only from it; a read needs none, because the URL it was given is the identity. It is replaceable composition data; it requests a destination and grants nothing [Reference](#issue-effects). |
| canonical target URL | the normalized form of an Issue tracker's URL. One destination has one spelling, which is what durable identity, the natural key and every provider comparison use [Reference](#issue-effects). |
| provider discriminator | the stable lower-case name of an Issue provider. Stated on a tracker, it names the only provider allowed to handle the request; omitted, each installed provider matches the URLs it recognizes [Reference](#issue-effects). |
| printed error | an error printed into the document (`ErrorSegment`); data, not control flow [Reference](#error-propagation). |
| failure | an error that propagates (`ComponentFailure`, `DocumentationError`) [Reference](#error-propagation). |
| error mode | what an undecided error in a region becomes: `print` (printed into the document), `output` (fails the document execution; `<PrintErrors>` can print instead), `throw` (fails the document execution) [Reference](#error-propagation). |
| attempt | one execution of a retried operation or region [Reference](#attempts). |
| raise | where an error no middleware converted is decided: printed or failed, per the error mode; observed exactly once, where raised [Reference](#error-propagation). |
| blocker | execution needs input (auth, a human answer); not a failure [Reference](#error-propagation). |
| suspension | a durable wait: a crash restarts into the same wait [Reference](#durable-suspension). |
| suspension ID | an opaque stable identifier derived by the trusted workflow execution for one logical suspension request; replay preserves it and only equality and input correlation are public [Reference](#durable-suspension). |
| delivery | Retained input for one exact durable suspension, separate from resuming or publishing its answer. [Owning rule](#typed-answer-delivery). |
| answer publication | appending the durable answer event that records what ended one durable wait; performed by the resuming document execution, never by a delivery [Reference](#typed-answer-delivery). |
| answer consumption | marking a retained delivery spent; it commits in the same transaction as the answer publication it belongs to, so neither can be observed without the other [Reference](#typed-answer-delivery). |
| workflow executor | the live host invocation that advances or settles one workflow run [Reference](#workflow-lifecycle-ownership). |
| executor lock | the scope-owned, non-blocking exclusive host lock that permits at most one workflow executor for a run [Reference](#workflow-lifecycle-ownership). |
| stale execution | an unfinished retained document execution found after acquiring the executor lock proves its previous workflow executor is gone [Reference](#workflow-lifecycle-ownership). |
| inspection recovery coordination | provider-private cross-process exclusion between copying a crashed run's database-and-journal pair for inspection and opening the retained database write-capably for SQLite recovery; it grants no executor or lifecycle ownership [Reference](#read-only-lifecycle-inspection). |
| recovered inspection snapshot | an immutable lifecycle snapshot read from a private scratch copy after SQLite rolls that copy's hot journal back to the retained store's last committed state; the retained database and journal are not changed [Reference](#read-only-lifecycle-inspection). |
| XMD artifact | one immutable portable evidence file with the `.xmd` extension, containing one workflow run's committed retained state at one artifact frontier together with its workflow definition source closure; it is neither a live run store nor permission to continue the source run [Reference](#portable-xmd-artifacts). |
| artifact frontier | the exact committed lifecycle snapshot, journal boundary and current Workspace root an XMD artifact records [Reference](#portable-xmd-artifacts). |
| workflow definition source closure | the exact root Markdown source and every source in its declared workflow component bundle, the retained bytes re-derived from the run's own store. Retrieval metadata, provenance and a repository checkout are not part of either [Reference](#portable-xmd-artifacts). |
| artifact manifest | the canonical versioned inventory of every semantic record and retained byte in one XMD artifact, excluding its own derived identity and physical container layout [Reference](#portable-xmd-artifacts). |
| XMD artifact identity | the lowercase SHA-256 of an XMD artifact's artifact manifest; it identifies the evidence independently of its host path and physical encoding and is retained as the source identity of a history fork made from that artifact [Reference](#portable-xmd-artifacts). |
| Agent session portability evidence | Verified portable session checkpoint tokens and bundle bytes, or an explicit unavailability classification. [Owning rule](#portable-xmd-artifacts). |
| provider checkpoint token | one opaque value a provider issued for one completed Agent Prompt, retained in Agent session portability evidence beside the event it belongs to. It says where a conversation reached; it is not a credential, is never derived from event position, transcript text, another token or a provider head, and no ordinary presentation renders it [Reference](#portable-xmd-artifacts). |
| Agent session bundle | the opaque bytes a provider captured one Agent session as, retained under that session's key in an XMD artifact. Nothing scans or scrubs them: a bundle may hold transcript text, tool state, secrets a conversation repeated and the exporting host's own paths, and it carries the confidentiality of the whole retained Workspace [Reference](#portable-xmd-artifacts). |
| Workspace | the provider-neutral, run-owned environment that supplies retained filesystem, repository, process and working-directory capabilities to a workflow [Reference](#workflow-workspace). |
| document filesystem | the files a document names in its own text, reached only through `API.Files`; distinct from the host paths the engine's own control plane reads [Reference](#the-document-filesystem-boundary). |
| Files provider | the installed implementation of `API.Files` for a document execution: the host provider under `xmd run`, a transaction-bound provider under a workflow run. There is no default, and no provider falls back to another [Reference](#the-document-filesystem-boundary). |
| stable host namespace | the condition the host Files provider's containment is stated under: no other process replaces a directory, symlink, junction or reparse point between the moment a path is observed and the moment it is used [Reference](#the-document-filesystem-boundary). |
| Files infrastructure failure | a Files provider that is absent, that refuses an operation, or that broke its own contract; fatal like a durability failure, and never a printed error [Reference](#the-document-filesystem-boundary). |
| ephemeral | a replay classification for an operation, context or attachment that runs again to reconstruct live execution; its result is not substituted from the journal and it owns no durable workflow state [DEC-034](packages/durable-streams/specs/DECISIONS.md#dec-034-ephemeral--explicit-escape-hatch-for-non-durable-operations-in-workflows). |
| live binding | an execution-owned value reconstructed ephemerally for the current document execution; it is visible only to constructs that explicitly consume the live binding overlay and never enters interpolation or the journal [Reference](#replay-safe-live-services). |
| attached service | a scoped host process that publishes its authenticated loopback endpoint through the XMD service handshake protocol and remains supervised for the lifetime of its service attachment [Reference](#replay-safe-live-services). |
| effect transaction | the single atomic SQLite transaction that publishes one Workspace-local mutation together with that effect's journal result [Reference](#replay-and-effect-transactions). |
| external effect | an effect whose provider-owned outcome cannot participate in the Workspace SQLite transaction and therefore requires a stable identity and provider reconciliation [Reference](#replay-and-effect-transactions). |
| XMD-mediated HTTP read | one bounded, non-mutating HTTP request an authored document performs through the contextual Fetch capability, whose detached response is retained as an ordinary durable observation. It is distinct from an Agent's own network permission, which it does not grant, and from a reconciled mutating external effect: it performs no reconciliation, so an interruption before its record commits may repeat the read [Reference](#replay-and-effect-transactions). |
| Git-host evidence read | A complete bounded observation of one canonical pull-request URL, retained as an ordinary durable effect. [Owning rule](#git-host-evidence-reads). |
| object-source attachment | Invocation-private authenticated local Git objects and destination supplied to one reconciliation. [Owning rule](#replay-and-effect-transactions). |
| checkpoint | a completed journal boundary associated with the logical Workspace root visible after that effect [Reference](#replay-and-effect-transactions). |
| history fork | a new workflow run that replays a compatible journal prefix and continues from its checkpoint and Workspace root under a new immutable document definition [Reference](#replay-and-effect-transactions). |
| loaded copy | one independently evaluated instance of a package, such as the copy bundled into the binary or a separately installed dependency [Reference](#state-across-loaded-copies). |
| authoritative behavior | behavior that decides what an execution or effect *is* — whether it happens, what it may replay from, and what it settles to. Non-authoritative behavior may inspect, narrow, refuse or add a failure, but cannot bring an execution into being, substitute one, or rescue one [Reference](#authoritative-behavior). |
| testing harness | the testing-only construct through which one canonical `<Test>` invocation runs another document as a real document execution under a selected host profile; it is not component composition and is unavailable to any element core did not recognize as its own `<Test>` [Reference](#capability-backed-nested-execution). |
| host profile | a named production assembly a trusted host offers a testing harness — `run` today — reused after argument parsing rather than restated; a host that cannot offer one refuses rather than approximating it [Reference](#capability-backed-nested-execution). |
| execution outcome | what one nested document execution ended as, as the harness publishes it: a settlement carrying the exact completion `Result`, or, for a workflow attempt, a durable suspension carrying the run and suspension identities. A suspension is neither success nor failure [Reference](#capability-backed-nested-execution). |
| trusted host | the code that decides what an execution is for — a CLI entrypoint or a workflow runner — as distinct from the document, the components it expands, and the middleware packages composed around it [Reference](#trusted-host-orchestration). |
| native session launch | Construction and ownership handoff of one durable session to its provider-native interactive UI. [Owning rule](#native-agent-sessions). |
| provider-native session identity | The provider conversation identity, distinct from XMD and ACP identifiers [Full contract](#native-agent-sessions). |
| pending session placement | One operation-local placement before its first consumer constructs a session [Full contract](#native-agent-sessions). |
| session materialization | The backend acceptance that makes a new conversation available to native resume [Full contract](#native-agent-sessions). |
| established session | An immutable route and asserted conversation identity [Full contract](#native-agent-sessions). |
| instruction layer | Provider-native instructions installed before user content [Full contract](#native-agent-sessions). |
| foreground-terminal lease | The exclusive execution-owned right to inherit the foreground terminal [Full contract](#native-agent-sessions). |
| native launcher | The host adapter that launches a provider UI and reports only its status [Full contract](#native-agent-sessions). |
| launch request | One immutable routing request that cannot author a launch completion [Full contract](#native-agent-sessions). |
| agent launch coordinator | The host-delivered capability that validates and retains launch phases [Full contract](#native-agent-sessions). |
| session coordinator | The host-delivered cross-process owner of one logical conversation [Full contract](#native-agent-sessions). |
| construction route | Create-once durable provenance of how a logical session was constructed, separate from its live owner. [Owning rule](#construction-routes). |
| executable build binding | The exact canonical provider version and executable digest accepted for a session [Full contract](#native-agent-sessions). |
| executable observer | The host-delivered observation of the executable that will actually run [Full contract](#native-agent-sessions). |
| client-native attachment | ACP attachment to the exact conversation constructed by a native process [Full contract](#native-agent-sessions). |
| identity provenance | Who chose the provider-native identity [Full contract](#native-agent-sessions). |
| quiescence | Acknowledgement that nothing the former owner started can still act [Full contract](#native-agent-sessions). |
| recovery tombstone | Retained active ownership that a crash alone cannot clear [Full contract](#native-agent-sessions). |
| provider partition | One independently owned provider runtime, store, session set and teardown [Full contract](#native-agent-sessions). |
| `JournalProvenance` | a non-operational, equality-only witness that a live publication stream descends from the exact journal backend a provider selected for one workflow run; it grants no append, read, execution, publication or reconciliation capability, and is meaningful only because the provider retains the witness it established and later requires exact equality [Reference](#the-weak-journal-provenance-association). |
| result object | the value a component binds instead of failing: `{ok: true, value}` or `{ok: false, …}`, whose failure members the component declares [Reference](#construct-inventory). |
| syntax symbols | A versioned description of the structural and selected component vocabulary for one directory and host profile. [Owning rule](#the-syntax-symbols-boundary). |
| execution environment | One execution-private bundle passed by value through canonical expansion. [Owning rule](#capability-backed-invocation-identity). |
| syntax reference | The execution-owned lexical description of what may be written at one site. [Owning rule](#the-syntax-symbols-boundary). |
| run profile declarations | the component registrations a first-party package makes, held as plain values apart from the middleware, providers, activation and launchers its installer also arranges. The installer registers exactly those values and inspection reads exactly those values, so what a run installs and what the symbols report cannot drift [Reference](#command-declaration-ownership). |
| Plugin | Trusted explicitly selected code installed before a root document is imported. [Owning rule](#the-plugin-boundary). |
| document envelope | Plugin-composed Markdown into which canonical core splices the parsed root at `<Document />` placeholders. [Owning rule](#the-three-contextual-apis-a-plugin-composes-through). |
| active Plugins | the frozen ordered list of Plugin values installed for one command — the bundled Git Plugin first where the command's profile carries it, then the operator's own in the order they wrote them — published before the first `install()` runs so that every Plugin and every later consumer read the same list. It is a description of what is installed and grants nothing [Reference](#the-plugin-boundary). |
| command declarations | One ordered value describing the exact Markdown and structural vocabulary a command offers. [Owning rule](#command-declaration-ownership). |
| origin-only | the inspectability of a component whose contract could only be learned by loading it: a repository TypeScript module, whose schemas live on its exports and whose top level would run. Such an entry carries name, category, origin and source kind, and no contract field at all — an absent contract is stated, never rendered as an empty one [Reference](#the-document-validation-boundary). |
| definition-owned return state | Ephemeral value-selection state owned by one execution of one value body. [Owning rule](#definition-owned-return-state). |

## Construct inventory

Status is measured against main.

| Construct | Does | Status |
| --- | --- | --- |
| `xmd syntax` | Describes the production run-profile vocabulary without execution, as deterministic Markdown or version-2 JSON. [Construction and observation](#the-syntax-symbols-boundary); [named documentation](#the-canonical-protected-tier). | Built. |
| `<Syntax />` | Renders the lexical vocabulary or requested component documentation under canonical protection. [Forms, capture, documentation and retained reads](#the-canonical-protected-tier). | Built; evaluation narrows the lexical execution reference. |
| document validation | validates one supplied root projection and the recursive Markdown source closure normal component selection discovers, returning deterministic version-1 document diagnostics and `valid`, `invalid` or `not-statically-checkable` invocation outcomes without evaluating document code or installing operational host behavior [Invariant](#the-document-validation-boundary). | built on the #654 stack |
| `xmd plan` | Produces exact approved Plan source through the packaged adapter and shared Plan component, then delivers it to one exclusive sink without running it. [Command grammar](specs/plan-command-spec.md#command-grammar), [profile](specs/plan-command-spec.md#the-plan-writer-profile), [progress](specs/plan-command-spec.md#watching-a-plan-being-written), [journal](specs/plan-command-spec.md#the---journal-file) and [final admission](specs/plan-command-spec.md#structural-host-validation-and-the-artifact). | Built. |
| `<Plan>` | Authors one exact-source Plan inside the enclosing execution, using the same fixed writer profile as the command. [Packaged component](specs/plan-command-spec.md#the-packaged-plan-component) and [language contract](specs/executable-mdx-spec.md#53-import-durableimportcomponent). | Built; no delivery, custom root, policy prop or replacement selector (#536). |
| `<Switch value>` / `<Case>` | chooses one branch by comparing a value with `===`. `<Switch value={status}><Case value="ready">…</Case><Case default>…</Case></Switch>` decides its whole case structure from source before evaluating anything, then evaluates the selector once and each non-default matcher at most once in source order, expands the first `===` match — or the final default, or nothing — inline and transparently, and appends no journal event [Invariant](#structural-branch-selection). | built on the #692 stack |
| `xmd upgrade` | Runs one packaged streaming policy document that may replace an eligible standalone binary after verification. [Policy](specs/upgrade-command-spec.md#the-packaged-document-owns-the-policy), [host admission](specs/upgrade-command-spec.md#the-runtime-neutral-host) and [atomic replacement](specs/upgrade-command-spec.md#download-verification-and-replacement). | built on the #659 stack |
| `<PrintErrors>` / `printErrors(fn)` | prints failures [Invariant](#4-printerrors-prints-a-failure). | built on main |
| `<Fail message>` | Raises the authored failure at its invocation, with recovery owned by the enclosing structure. [Authored failures](specs/executable-mdx-spec.md#682-stopping-deliberately-fail). | built on the #659 stack |
| `<Let as="name">` | Binds rendered content or an exact by-reference value in the existing environment; source choice precedes execution. [Binding](specs/executable-mdx-spec.md#65-prop-validation). | built on the #527 stack |
| `<CodeBlock value={…} />` | Renders a supplied string inside a safe fence, preserving its exact value through return and capture. [Forms and validation](specs/executable-mdx-spec.md#619-showing-text-as-a-code-block-codeblock). | built on the #658 stack |
| `<Verbose>…</Verbose>` | Renders content only under a true lexical verbosity value; CLI diagnostics remain host presentation. [Verbosity](specs/executable-mdx-spec.md#620-verbose-only-content-verbose). | built on this stack |
| `<Json value={…} />` | Renders a captured value through native two-space JSON serialization without changing its operand. [Validation, failures and exact capture](specs/executable-mdx-spec.md#612-json-in-both-directions-json-parse-and-safeparse). | built on the #452 stack, with ordinary text capture enabled by #666 |
| root failure settlement | a text root installs the fail-capable `output` mode for its whole body, so an uncaught, undecided failure is the document execution's own outcome, whether or not the root declares `<Output>` [Invariant](#3-error-mode-is-lexical). | built on the #453 stack |
| `<Output>` region `output` mode | an undecided error fails the document execution [Invariant](#3-error-mode-is-lexical). | built on main |
| `<Output>` rendering selection | chooses which regions of a body render, and buffers a root that declares one; it decides nothing about failure [Interface and evidence](specs/executable-mdx-spec.md#69-component-declared-output-output). | built on main |
| `Expansion` / `getExpansion()` | describes the current logical element expansion [Invariant](#expansion-identity). | built on main |
| `Component.expand` | Observes one complete element expansion without deciding its outcome or delaying execution. [Expansion observation](#1a-one-elements-expansion-can-be-surrounded). | built on this stack |
| `inspectSource()` | Locates executable delimiters using the engine scanner without interpreting source. [Source inspection](#1b-where-a-texts-elements-are-without-running-it). | built on this stack |
| document targets | catalogs a root document's addressable static headings, resolves one selector to one exact target, and projects the document to it before expansion [Invariant](#document-targets). | built on the #412 stack |
| document-aware `xmd run … --help` | describes what one document declares and every target it addresses, each as a full document reference with the description its section states, by inspection alone [Interface and evidence](specs/executable-mdx-spec.md#document-targets). | built on the #463 stack |
| standard-input root documents | Acquires one whole source document from standard input only for explicit `xmd run` with the exact `-` document argument. [Root grammar, cancellation and retained origin](#the-root-document-a-run-is-given). | Built. |
| targeted `xmd run` | reads a file argument as a document reference and executes the one exact target its selector resolved to, replacing the selector before execution rereads the file [Invariant](#document-targets). | built on the #412 stack |
| targeted workflow definition | a workflow definition optionally carries the exact canonical document target, which takes part in definition identity and in compatible reuse but not in the source-bundle hash [Invariant](#document-targets); [Interface and evidence](specs/workflow-spec.md#the-document-target-a-run-is-a-run-of). | built on the #412 stack; `xmd workflow start` takes a document reference and resolves any selector through core against the bytes it is about to retain |
| source-bundle workflow definition | retains exact source bytes under logical paths, with domain-separated source hashes, lengths, bundle hash and optional exact target/component mapping. [Definition identity](#identity-is-separate-from-retrieval) and [source retention](#what-a-run-retains). | Built; one descriptor and live schema version 1, with no migration. Artifact-backed fork remains unbuilt. |
| installed structural syntax | Declares a construct and its regions together with their expansion handler. [Installation, demand and lifetime](#the-installed-structural-syntax-boundary). | built on the #806 stack |
| declared Markdown component | Reserves exact first-party Markdown and its lexical private closure for one execution. [Capture, import and replay](#the-declared-markdown-boundary). | Built; packaged Plan and the review graph use the declaration boundary. |
| workflow component bundle | Retains a closed mapping of component names to the definition source bundle. [Workflow lifecycle](#the-workflow-lifecycle). | built on the #301 stack; the full adversarial implementation loop and its scheduling remain unbuilt (#300), and generated XMD admits no bundled Markdown component (#369) |
| `getWorkflowRun()` | reads the run the current execution is associated with [Invariant](#workflow-runs). | built on the #366 stack |
| `retainedWorkflowInstallation()` | associates one document execution with a run storage already created, requiring exact journal agreement. It resolves no revision and names no Git feature, and a run retains the bytes it executes, so nothing afterwards reaches a repository for its source [Invariant](#workflow-runs); [Interface and evidence](specs/workflow-spec.md#3-where-the-run-is-prepared). | built on the #366 stack |
| `GitQuery.resolve()` | verifies and resolves one Git revision expression contextually [Interface and evidence](specs/workflow-spec.md#7-the-git-capability--moved). | built on main |
| workflow run storage | creates or compatibly finds one run by public run ID, retains its identity, state, document executions and filtered journal, and validates immutable Workspace roots through one provider-owned connection entry [Invariant](#workflow-run-storage); [Interface and evidence](specs/workflow-spec.md#9-retained-run-storage). | built on the #365 stack; the CLI lifecycle reaches it on the #366 stack |
| caller-owned storage transaction | publishes several changes, including journal events, in one transaction nothing else enlists in [Invariant](#one-database-at-a-time-and-a-transaction-a-caller-can-hold). | built on main |
| live durable-operation coordinator | explicitly coordinates structured live execution with existing Yield publication while leaving replay and callback effects unchanged [Invariant](#live-effect-coordination). | built on the #365 stack |
| Workspace coordination API | fails closed by default; replaceable context routes only a one-use provider selection, while the selected provider directly invokes an execution-owned credentialed capability for execution, publication and failure activation [Invariant](#live-effect-coordination). | built on the #365 stack; the Deno provider installs an adapter-private atomic handler |
| shared Git-host reconciliation | Reconciles Git push and pull-request upsert through one request-only boundary whose private terminal alone settles the retained outcome. [Invariant](#external-effects-and-git-host-mutations); [Invariant](#issue-effects). | Built on #297; Push (#370) and PullRequest (#295) consume it. Issue (#296) has its own middleware boundary. |
| explicit WorkflowRun journal route | binds one already-filtered publication to one exact active transaction and otherwise uses ordinary serialized journal storage [Invariant](#local-workspace-topology). | built on the #365 stack |
| `API.Service` / `startService()` | creates an authenticated, supervised loopback service attachment through a provider-neutral operation [Invariant](#replay-safe-live-services); [Interface and evidence](specs/executable-mdx-spec.md#attached-service-api). | built on main |
| foreground command routing and retention | forwards a child's channels live, captures stdout for a `<Let as>` region, and retains output only when the host asked for a record [Invariant](#foreground-commands). | built on the #441 stack |
| `exec as="name"` | binds one command's settled outcome — exit status, stdout and stderr — as an ordinary mutable binding; the block displays neither channel, renders nothing, and a nonzero status raises nothing. Only the built-in exec terminal and the built-in `timeout` may compose one, authorized by factory identity rather than by registered name, and asked for through a capability-backed request public middleware composes around but cannot issue, consume twice or answer [Invariant](#capability-backed-bound-commands); [Interface and evidence](specs/executable-mdx-spec.md#36-foreground-execution-capture-and-retention). | built on the #447 stack |
| testing harness (`<Execution>`) | runs another document as a real root under a production host profile, authorized by canonical `<Test>` alone: declarations installed before the root import, child output displayed progressively and collected only when asked, journal retention selected independently of observation, and the outcome published by the invocation's own terminal through a request public middleware composes around but cannot answer [Invariant](#capability-backed-nested-execution); [Interface and evidence](specs/testing-spec.md#nested-executions). | built on the #454 stack for `host="run"`; the workflow profile and `<WorkflowRun>` are unbuilt, and a host that offers no workflow profile refuses them |
| nested run-profile Agent and elicitation declarations | Configures one isolated run-profile child with frozen TestAgent scenarios and non-delegating Answers, preserving ordinary component shadowing. [Invariant](#capability-backed-nested-execution); [Interface and evidence](specs/testing-spec.md#nested-executions). | Built on #641; controlled Plan label routing added by #728. |
| `Config` run deadline / exec default / Fetch default / verbosity | three independently owned contextual timeouts, absent unless configured, each read by exactly one consumer, and contextual verbosity — a boolean that is false unless configured, seeded by the command line and overridable for a lexical subtree, bounding nothing and deciding no permission [Invariant](#contextual-run-configuration). | built on this stack |
| Agent session configuration (`<Session model effort>` / `Agent.options()`) | Applies and verifies exact provider model and effort settings for the final routed session; inspection starts no turn. [Full contract](#native-agent-sessions). | Built; [provider availability and compatibility](#native-agent-sessions). |
| native session launch (`<Session.Launch>` / `launchAgentSession()`) | Hands one durable session to its provider native UI, retaining construction and build compatibility through interruption. [Full contract](#native-agent-sessions). | Built; [provider availability and compatibility](#native-agent-sessions). |
| `<Fetch>` | performs one XMD-mediated HTTP read through contextual `API.Fetch`, admitting the whole request before transport, and retains the normalized request and the detached response as one `fetch` durable observation; capture decides whether a status is data or a failure, and the trusted host's destination ceiling sits below the component [Interface and evidence](specs/executable-mdx-spec.md#618-reading-over-http-fetch). | built on the #456 stack; a generated fragment may name the pinned identity only for a request the trusted host stated exactly, on the #369 stack |
| `API.Files` | routes every document filesystem operation to the installed provider, with no host default and structural failure data. Its mandatory semantic operations include `ensureDirectory`, which recursively creates or adopts one directory and returns Unit; separately loaded copies compose through the stable Api name [Invariant](#the-document-filesystem-boundary). | built on the #227 stack; directory ensure added by #643 |
| `<File.Delete path>` | Removes one file or final symlink through Files; absence succeeds and directories refuse. [Filesystem semantics](#the-document-filesystem-boundary), [canonical form dispatch](#capability-backed-invocation-identity) and [generated write admission](#agent-permissions-and-generated-xmd). | built on the #567 stack |
| host Files provider / `useHostFiles()` | resolves document paths in the caller's filesystem, containing them while the host namespace is stable; its directory ensure accepts Dir's existing absolute target or resolves a relative one against the enclosing cwd, recursively creates or adopts it directly, preserves existing contents, refuses a non-directory before content and never rolls back or deletes created directories; installed by all four CLI entrypoints, so Dir remains operational under Node and Bun [Invariant](#the-document-filesystem-boundary). | built on the #227 stack; directory ensure added by #643 |
| transaction-bound Files provider | resolves document paths in the run-owned logical Workspace inside the caller-owned transaction; directory ensure is one durable `workspace_file` mutation whose recursive creation, resulting root and recorded success commit together, whose documented refusal rolls its savepoint back, and whose replay restores the record without creating again [Invariant](#the-document-filesystem-boundary); [Interface and evidence](specs/workflow-spec.md#10-the-document-filesystem-of-a-run). | built on the #366 stack; directory ensure added by #643 |
| `service=<binding>` | publishes the attachment's endpoint into the live binding overlay for its invocation [Invariant](#replay-safe-live-services); [Interface and evidence](specs/executable-mdx-spec.md#attached-service-api). | built on main |
| `ephemeral eval` | reconstructs live middleware and bindings without a journal entry [Invariant](#replay-safe-live-services); [Interface and evidence](specs/executable-mdx-spec.md#43-durable-and-live-binding-environments). | built on main |
| `useWorkflowServiceDenial()` | provides a non-delegating workflow service denial provider, installed inside every start and resume execution scope [Invariant](#replay-safe-live-services). | built on the #366 stack |
| `xmd workflow start` / `xmd workflow resume` | starts or resumes a workflow run from the CLI, under the Deno entrypoints only [Invariant](#the-workflow-lifecycle); [Interface and evidence](specs/workflow-workspace-spec.md#3-workflow-lifecycle). | built on the #366 stack; both acquire #367's executor lock before any lifecycle transition |
| implicit workflow Workspace | retains provider-neutral filesystem, repository and attachment state by run ID [Invariant](#workflow-workspace); [Interface and evidence](specs/workflow-workspace-spec.md#5-workspace-structure-and-identity). | document filesystem built on the #366 stack and Repository/Worktree composition on the #293 stack; process capabilities unbuilt (#218) |
| `<Repository>` / `<Worktree>` composition under a workflow run | names a Git repository and its linked checkouts inside the run-owned Workspace, installs each as contextual working directory, and retains creation identity beside the retained Git bytes [Interface and evidence](specs/workflow-workspace-spec.md#6-repository-and-worktree). | built on the #293 stack, Deno provider only |
| `<Dir path>` | Creates or adopts its target before content, scopes cwd without changing Repository selection, and restores cwd without deleting created directories. [Invariant](#the-document-filesystem-boundary); [Interface and evidence](specs/executable-mdx-spec.md#6132-entering-a-directory-dir). | Directory-creation contract added by #643; host and workflow Files providers. |
| transactional Git effects (`Git.Switch` / `Git.Add` / `Git.Commit`) under a workflow run | publish local Git mutations with their journal result; the enclosing Repository and the contextual working directory select which retained checkout one runs in, and neither observation admits anything — the observed record is compared with the retained row and the directory with the checkouts that row holds, so a failure of admission, of retained state or of an unrecognized native condition fails the run instead of publishing a result [Invariant](#workspace-local-transactions); [Interface and evidence](specs/workflow-workspace-spec.md#7-git-operations). | built on the #294 stack, Deno provider only |
| `Git.Push` under a workflow run | Publishes or adopts the selected named branch through authenticated non-force reconciliation. [Authored contract](specs/workflow-workspace-spec.md#74-push) and [effect mechanics](#replay-and-effect-transactions). | built on the #370 stack, Deno provider only |
| `<PullRequest>` under a workflow run | Upserts the exact published branch and returns stable evidence only after this run proves matching Push history. [Props, results and refusals](specs/workflow-workspace-spec.md#75-pull-request); [positive-integer number and reconciliation](#issue-effects). | built on the #295 stack, Deno provider only |
| repository composition vocabulary | Declares twelve ordinary shadowable defaults without installing an operational provider. [Names and profile ownership](#ordinary-repository-vocabulary). | built on the #643 stack |
| `<Repository>` / `<Worktree>` composition under an ordinary run | Selects an authenticated persistent checkout under an execution-owned exclusive lock [Full contract](#ordinary-repository-ownership). | built on the #643 stack, Deno and compiled only |
| local Git operations (`Git.Switch` / `Git.Add` / `Git.Commit`) under an ordinary run | Performs explicit local transitions against the authenticated checkout without rollback or replay [Full contract](#ordinary-repository-ownership). | built on the #643 stack, Deno and compiled only |
| `Git.Push` under an ordinary run | Publishes or adopts a non-force branch result and keeps invocation-private evidence [Full contract](#ordinary-repository-ownership). | built on the #643 stack, Deno and compiled only |
| `<PullRequest>` and its evidence reads under an ordinary run | Reads current evidence or upserts only after this invocation proved the exact matching Push [Full contract](#ordinary-repository-ownership). | built on the #643 stack, Deno and compiled only |
| `<Issue>` under an ordinary run | Calls the configured Issue provider using this execution and expansion identity [Full contract](#ordinary-repository-ownership). | built on the #643 stack, Deno and compiled only |
| ordinary repository provider assembly | Assembles a fresh provider per ordinary execution, acquiring each resource only when needed [Full contract](#ordinary-repository-ownership). | built on the #643 stack |
| `<Issue>` under a workflow run | Reads or upserts an Issue through its independent middleware boundary. [Forms and retained results](specs/workflow-workspace-spec.md#103-issue-effects); [tracker normalization, routing and provider responsibilities](#issue-effects). | built on the #296 stack; GitHub middleware, Deno host |
| workflow lifecycle inspection and control | reads status/list/history without advancing a run, recovering a private copy when a crashed source needs rollback; enforces the executor lock, refuses live cancellation, cancels non-live runs under that lock and deletes retained state [Invariant](#read-only-lifecycle-inspection); [Invariant](#cancellation-control). | direct read-only inspection and control built on the #367 stack; coordinated recovered inspection built on the #513 stack, Deno provider only |
| XMD artifact export, inspection and fork source | Seals one committed frontier into immutable version-1 evidence for read-only inspection and future history-fork input. [Artifact identity and compatibility](#portable-xmd-artifacts) and [inspection APIs](#workflow-lifecycle-ownership). | Export, total verification, status and history built for Deno; artifact-source fork remains unbuilt. |
| Agent session portability evidence in an XMD artifact | classifies every logical Agent session that contributed a retained Prompt as portable — with ordered provider checkpoint tokens and an opaque Agent session bundle — or as explicitly unavailable, as two content kinds inside the existing version-1 manifest and identity [Invariant](#portable-xmd-artifacts); [Interface and evidence](specs/xmd-artifact-spec.md#25-agent-session-portability-evidence). | specified by `specs/xmd-artifact-spec.md` §2.5; the closed union, both content kinds and the complete post-identity profile verifier are built on the #621 stack, Deno provider only. Provider bundle capture, Agent-aware export, intrinsic Agent-aware inspection and artifact-backed fork are unbuilt |
| historical authored source | retains an authored durable operation's normalized `SourcePosition` beside its identity, and history parses it or refuses the entry [Invariant](#read-only-lifecycle-inspection); [Interface and evidence](specs/workflow-workspace-spec.md#42-history). | built on the #367 stack |
| history fork | creates a new run from one compatible checkpoint and retained Workspace root, under a new immutable definition and normalized props [Invariant](#retained-effects-and-history-forks); [Interface and evidence](specs/workflow-workspace-spec.md#11-history-forks). | built on the #368 stack, Deno provider only |
| workflow Agent session | Uses inert placement and authenticated first-turn mapping under the run-owned no-native-tool profile. [Session mapping](#agent-permissions-and-generated-xmd). | built on the #302 stack, with the explicit ACP-only selection from #561; the portable proof that an adapter honours an empty tool set is tracked by #496 and does not widen the ceiling |
| generated-XMD admission | Preflights and retains one generated fragment under exact selected identities/forms and request ceilings. [Admission and continuation](#agent-permissions-and-generated-xmd). | built on the #369 stack, continuation basis amended by #589; core owns the mechanics and the workflow policy wrapper is internal |
| `<Evaluate>` | Runs untrusted fragment text or paired-produced text under one captured host ceiling; whole-fragment admission, local data expressions and ordinary rendered output remain distinct from provider permission. [Admission and sealed entries](#agent-permissions-and-generated-xmd). | built on the #302 stack, extended by #369 |
| generated mutation proposals | Admits filesystem change proposals through the selected generated write table and ordinary component transactions. [Invariant](#agent-permissions-and-generated-xmd); [Interface and evidence](specs/workflow-workspace-spec.md#mutation-proposal-admission). | Built on #369/#567, with persistent directory creation added by #643; legacy Dir grants refuse, and Git/process/credential/external-write classes remain excluded. |
| Deno-local DOFS provider | owns one authoritative SQLite/DOFS connection per run path, captures arbitrary canonical retained roots, privately restores them, and atomically coordinates one Workspace mutation with its filtered Yield [Invariant](#local-workspace-topology). | built on the #365 stack; public document filesystem effects and the CLI lifecycle route to it on the #366 stack |
| scoped Worker Shell | executes `just-bash` through the Workspace adapter inside a Deno Worker [Interface and evidence](specs/workflow-workspace-spec.md#104-worker-shell). | containment and effect-transaction POCs complete (#351, #357); production integration unbuilt |
| `<Retry max timeout>` | retry a region until it completes [Invariant](#1-middleware-wraps-the-work). | defined, unbuilt |
| `suspendFor()` | publishes one filtered suspension request, settles `suspended`, releases the executor lock, and re-enters the same wait without duplicating it [Invariant](#durable-suspension). | built on the #367 stack |
| `xmd workflow answer <run-id> <suspension-id> <json>` | retains one schema-validated value for one retained wait, taking no executor lock and changing no run state [Invariant](#typed-answer-delivery); [Interface and evidence](specs/workflow-workspace-spec.md#typed-answer-delivery). | built by #300 |
| `suspension_answer` durable effect | ends a wait from retained delivery state, publishing the answer and consuming that state in one transaction [Invariant](#typed-answer-delivery). | built by #300 |
| `<PullRequest.Reviews>` · `<PullRequest.Comments>` · `<PullRequest.Checks>` | read the reviews, comments and checks a Git host already holds for one numbered pull request, completely or not at all [Invariant](#git-host-evidence-reads). | built by #576 |
| workflow scheduling (watchers, unattended iteration, remote host selection) | — [Invariant](#typed-answer-delivery). | #300 |
| `<Result as>` | binds `{ok: true, value}` or `{ok: false, error}`; a failure becomes a bound value, not a raise [Invariant](#6-an-error-is-never-a-value). | defined, unbuilt |
| error middleware (JS api) | retry · suspend · decline [Invariant](#1-middleware-wraps-the-work). | defined, unbuilt |

`<Retry>` composes with validation by nesting: a `<Parse>` failing inside
fails the attempt — "retry until it parses" is two existing ideas.

## Changing these rules

Spec, tests, and mechanics move together, in the same PR. If a workaround
cluster grows around one of these rules, file the missing primitive instead of
building the cluster.
