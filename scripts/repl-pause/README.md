# Pausing one execution subtree

[#841](https://github.com/taras/executable.md/issues/841), under the REPL quest
[#827](https://github.com/taras/executable.md/issues/827). Two slices, asking two
different questions, and the second one supersedes nothing in the first.

- **Slice 1 — the middleware seam.** Can middleware around an Api hold a live
  subtree while its owner and siblings stay responsive? Answered below under
  *The answer*, against a synthetic Api.
- **Slice 2 — the REPL-owned design.** Are XMD's *existing* execution, component
  and REPL-owned expansion surfaces enough for a REPL to pause one **real**
  document execution, with no new core pause API? Answered under
  *Slice 2* at the end. The verdict is **REVISE**.

- **Slice 3 — the lifecycle matrix.** Every deferred row, against the real
  execution, plus the two rows that need a state the REPL design never reaches.

**The conclusion is [`RESULT.md`](RESULT.md).** Read that first; this file is the
working record behind it.

Run the evidence:

```bash
deno task test scripts/tests/repl-pause-gate.test.ts   # 23 cases, three suites
deno task repl:pause                                    # slice 1's representative trace
deno task repl:pause:seam                               # what Effection 4.1.0 does not publish
deno task repl:pause:xmd                                # coverage inventory and lifecycle trace
```

## The answer

**Middleware around an XMD-owned Api can hold every descendant continuation that
is an invocation of that Api, and nothing else.** That is enough to pause an
execution at *step* granularity, and it is not enough to pause an arbitrary
running continuation.

Both halves are proven, and the second one is the finding. The question #841 asks
— "can middleware prevent *every* descendant continuation from progressing" — has
the answer **no**, with a precise boundary rather than a flat refusal.

### What the seam does provide

`createApi()` plus one `Scope.around()` on the target execution scope gives all
of this, on the published surface, with no registry and no `pausePoint()` in
fixture code:

- **Installation is by ownership, and inheritance is not maintained — it is how
  dispatch works.** Effection keeps the decoration in a context on the scope it
  was installed on, and `Api.invoke` resolves `scope.get(api.context)?.handle ??
  core`. A descendant two levels down resolves the decorated handle; the
  independent sibling resolves the core. The trace shows the gate holding
  `s2(childA)` and `s3(childB)` — grandchildren of the decorated scope — while
  the sibling runs the *identical* mediated loop to 100 advances.
- **The controller stays live because it is owned outside the subtree.** The gate
  is acquired in the session scope, a sibling of the target, so `inspect()`
  answers and `release()` works while the target is held.
- **`pausing` is entered synchronously; `paused` is an acknowledged handshake.**
  A continuation arriving at the boundary registers itself and signals; the
  controller settles only when nothing live is unheld. No `sleep(0)`, no polling,
  no elapsed-time barrier, and no "nothing was printed".
- **Completeness is structural and fails closed.** The live set comes from
  `api.Scope` create/destroy — execution ownership and nothing else — and
  `paused` requires every live descendant scope to be one the gate holds. An
  unheld descendant can never be mistaken for a suspended one.
- **Continue releases the same continuations exactly once.** Each release is
  counted and guarded; numbered steps mean a replayed or respawned continuation
  would leave a duplicate in the history. Neither happens.
- **A held subtree appends no history.** And it cannot: `paused` is unreachable
  while any descendant is between the two checkpoints, so the head is fixed by
  construction rather than by a rule anything has to obey.

### What it does not provide

A descendant advancing in ordinary Effection — `yield* sleep(1)` and a counter,
which is what any component does *between* two journaled steps — never returns to
the boundary. `pausing` then never settles.

Crucially, that child **is** dispatched through the middleware once, when it is
forked. Being mediated at creation is not being pausable. This is the distinction
the Inspector's topology does not settle: the Inspector gates the whole program
body *before it begins*, and a gate installed before a continuation exists says
nothing about stopping one that is already running.

So the honest scope of the mechanism is: **pause lands between mediated steps.**
Whether that covers an XMD execution is an XMD question, not an Effection one. It
holds only if the engine dispatches every advance of every descendant through the
Api. It does not hold for a provider that sleeps, a subprocess stream, or any
component doing ordinary Effection work between steps — and requiring otherwise
is the "every author remembers a checkpoint" condition #841 names as a stop.

### External work

Asked explicitly, and the answer is yes with a cost.

An external operation invoked *through* the Api is wrapped on both sides. While
it is in flight the descendant is live and unheld, so **the pause cannot settle
until it returns** — and when it returns it is held at the exit checkpoint before
its continuation runs. The test drives exactly this: the promise is settled from
outside Effection while the controller is `pausing`, and the continuation past
`external()` has still not run once `paused` is reported.

The external system itself is never frozen. Nothing the gate does reaches it; only
the Effection continuation that would consume its result is held.

The cost is that a long external call delays `paused` for its whole duration. A
revision worth considering: an in-flight *mediated* external call could be counted
as suspended, because its return is guaranteed to hit the exit checkpoint on the
same code path. That would need the pause contract to say so, so it is not built
here.

## The missing runtime seam

`deno task repl:pause:seam` proves what would be required to gate an arbitrary
continuation, and why it is not offered here as a design.

Every continuation in Effection advances through one funnel:
`Coroutine.resume()` calls `reducer.schedule(routine)` on the reducer its scope
resolved **when the coroutine was created**. Substituting that reducer for one
scope therefore holds every descendant created under it, whatever the operation
and whoever wrote it — the seam script freezes three raw `sleep` loops while a
sibling advances 13 times, retaining 3 continuations, and releases them without
replay.

It is not available:

- `effection/experimental` publishes `api.Scope` only. `api.Main`, which the
  Inspector used at `4.1.0-alpha.7`, is **absent** in stable 4.1.0.
- `api.Scope.create` returns a tuple, not an `Operation`, so middleware over it
  cannot suspend. It observes a scope appearing; it cannot withhold a step.
- The package's `exports` map publishes `.` and `./experimental`, so `Reducer`,
  `ReducerContext`, `SettleContext`, `Priority`, `Children`, `callcc` and `trap`
  cannot be imported at all. Both deep-import spellings are refused.
- The one remaining route is to rebuild `@effection/reducer` with
  `createContext()` under Effection's own internal name and write it onto the
  target scope. Contexts resolve by `context.name`, so this works.

That last route **fails open**, which is why it is reported rather than proposed.
Writing a context name the runtime does not read throws nothing and binds
nothing: section 4 of the seam script writes a near-miss name, and the subtree
advances 8 times while the gate believes it holds everything. A pause built this
way would report `paused` for a live subtree the moment the internal name moved.
It can be made to fail closed — a canary task created under a held gate must land
in its queue and take no step — but the binding it would be checking is still
private, undocumented, and no part of Effection's contract.

Stated as a request: **a public, per-scope way to mediate continuation
scheduling** — an `api.Reducer` or `api.Coroutine` that `Scope.around()` can
decorate, or an exported `ReducerContext` — so a gate can be installed by
ownership and *proven* bound.

## Reading the evidence

`scripts/tests/repl-pause-gate.test.ts` holds the six cases. Three deliberate
defects were run against them, because a suite that stays green under a broken
mechanism pins nothing:

| defect | result |
| --- | --- |
| the `Execution` decoration never installed | all 6 fail |
| the completeness check returns "nothing unaccounted" | 5 fail; the one that never pauses passes, correctly |
| every held continuation released twice | only the "exactly once" case fails |

The first run of that first control found a real weakness: the release case
passed vacuously, because releasing nothing exactly zero times satisfied it. It
now asserts that three continuations were actually held first.

## What is deliberately absent

- Uninstalling the decoration. `Scope.around()` has no removal, so the gate is
  installed for the target scope's lifetime.
- Everything #841 puts out of scope: rendering, routing, StarFX, durable
  restart replay.

None of this code is a starting point for production. It is a disposable POC on a
branch that never merges.

---

# Slice 2 — the REPL-owned design over existing surfaces

Slice 1 used an Api invented for the experiment. Slice 2 replaces it with the
surfaces XMD already has, runs a **real** `executeInstalled` document, and adds
no core pause API. `scripts/repl-pause/repl-gate.ts` is the controller,
`xmd-fixture.ts` is the topology and document, and the last seven cases of
`scripts/tests/repl-pause-gate.test.ts` are the evidence.

## Verdict: REVISE

**The existing surfaces are safe but leave named legitimate paths permanently
`pausing`.**

Everything the design promises about *behaviour* holds. Pass-through is exact,
the document really does come to rest at a boundary, its journal really is fixed
for as long as you hold it, and Continue really does release the same
continuation exactly once and reach the expected result. What the REPL cannot do
is **certify** it. A real execution keeps engine-owned scopes alive that never
re-enter any surface a REPL can reach, so the fail-closed controller never
reports `paused`.

It is not `REJECT`: the controller never reports `paused` while work can still
advance, because it never reports `paused` at all. That also means the contract
clause "no continuation advances and no history is appended after `paused`" is
**vacuously satisfied here and is therefore not evidence** — nothing in the tests
asserts it, because an assertion about a state the design never reaches would
prove nothing.

## The coverage inventory

Measured by running the document, not read off the Api declarations
(`deno task repl:pause:xmd`). Every path the contract names, and what sees it:

| execution path | surface that sees it | observed or holdable | owning scope | how the controller knows | can advance after `paused`? |
| --- | --- | --- | --- | --- | --- |
| root document | `Execution.document`, then `Component.importComponent("__root__")` | holdable | the execution's own scope | boundary enter/exit | n/a — `paused` unreachable |
| Markdown component invocation | `Component.importComponent(name)` | holdable | the body-walk scope | enter/exit pair | n/a |
| function-component invocation | `Component.importComponent(name)` | holdable **at the invocation only** | the body-walk scope | enter/exit pair | n/a |
| a function component's **body** | **none** | — | its own invocation scope | only that the scope is live | — |
| a component-retained resource | `Component.retain` at acquisition | holdable at acquisition only | the invocation site's scope | enter/exit pair | — |
| projected content | `Component.content(slot)` | holdable | the invoking component's scope | enter/exit pair | n/a |
| code-block modifier execution | `Component.applyModifiers` + `Component.codeBlock` | holdable | the body-walk scope | enter/exit pair | n/a |
| bound `exec as=` | `Component.applyBoundModifiers` | holdable | the body-walk scope | enter/exit pair | n/a |
| structural expansion from the REPL profile | the REPL's own captured `expand` handler, plus a REPL checkpoint per region chunk | holdable, REPL-owned | the handler's scope | enter/exit and per-chunk | n/a |
| nested and concurrent descendants | **none** | — | spawned scopes of a component body | only `api.Scope` creation/destruction | — |
| an external operation already in flight | **none** | — | the awaiting component's scope | only that the scope is live | — |
| prose, headings, core structural syntax (`<If>`, `<Each>`, `<Let>`) | **none** | — | the body-walk scope | nothing | — |

Nine surfaces are crossed by the representative document —
`applyBoundModifiers`, `applyModifiers`, `codeBlock`, `content`, `document`,
`expand`, `importComponent`, `replCheckpoint`, `retain` — and every one of them
can hold, because each is an operation the REPL wraps.

(Slice 2's own commit reported eight and *2 of 12* live scopes. Slice 3 added
`<Holder>`, which retains a resource through `Component.retain`, because cleanup
on every terminal path has to be watched through a real XMD surface. The
inventory and the scope arithmetic below are the enriched document's, and the
conclusion is unchanged.)

Two facts from that table decide the verdict:

- **Prose, core structural syntax and a component's own body cross nothing.**
  The engine's per-element walk invokes a `Component` operation only where an
  element *is* a component or a code block. A `<Each>` over a thousand items, or a
  provider that sleeps between two journaled steps, reaches no boundary at all.
- **`Execution.document` never exits until the run is over.** It is the right
  anchor for *which* subtree is being paused, and it is useless as a resting
  place: it is permanently in flight, so it can never be held at its exit.

## What the measurement shows

With Pause requested while a component body was running ordinary Effection:

```
live descendant scopes            : 15
held at a controlled boundary     :  1   [s20@enter:importComponent:Fanout]
live and unheld                   : 14
ever crossed a controlled surface :  2   [s6, s20]
```

**Two of fifteen live scopes ever cross a surface the REPL can reach.** The
others are engine-owned — the invocation owner, the durable run, the stream
machinery, region streams — and they are alive for the execution's whole
lifetime. The controller is fail-closed, so it stays in `pausing` and names them.

Nothing here claims those ten are quiescent. Empirically the document stopped:
the journal was **fixed** across thirty of the sibling's own announced advances
and the held continuation did not move. But "it stopped" and "I can prove it
stopped" are different claims, and distinguishing an engine scope that is blocked
on the held walk from one waiting on its own timer would need exactly the seam
this repository does not have. Declaring them safe would be the
"a live parent is declared safe only because a descendant is held" stop
condition, so the controller declines.

Note also what *is* correct about the interval before the report: work already
inside a semantic operation finished (`1 -> 40` steps) and the walk then stopped
at its next existing boundary, which is what the amended contract asks for.
Records written during `pausing` are allowed; the journal moved `4 -> 4` from the
moment of rest onward.

## External work

The external operation is a promise already in flight when the execution starts,
awaited by a component body through `until`.

- **It is never frozen.** Nothing the gate does reaches it.
- **It may finish while `pausing`.** It did.
- **Its Effection continuation is not stopped at the external call site.** There
  is no surface there. The continuation resumes the component body, which returns
  to the body-walk, which is then stopped at *the walk's next* controlled
  boundary — `importComponent`, `applyModifiers` or the REPL's own handler.

So an in-flight external operation is gated one boundary *later* than where it
completed, not where it completed. For a REPL that is acceptable during
`pausing`; it is the reason a component that never reaches another boundary is
one of the permanently-pausing paths named above.

## Surfaces used, and how

- **`Component.around(...)` and `Execution.around(...)`** — real contextual Api
  middleware from `@effectionx/context-api`, installed at the default `max`.
  `min` is the implementation slot the runtime providers occupy; a pause
  installed there would shadow the provider it is trying to observe. Installed in
  the scope that owns the execution **before** the run starts, never when Pause
  is pressed, and inherited through the scope's context prototype chain.
- **The REPL's own `expand` handler** — `ExecutionInstallation.expand` is read
  once and bound at profile capture, so it is a function this REPL holds while
  assembling its own profile. Decorating it is decorating REPL-owned code. It is
  **not** Api middleware and is not described as such anywhere in the evidence.
  The per-region-chunk checkpoint lives in the same REPL-owned loop — it is not a
  checkpoint a component author has to remember, and it is published to nothing.
- **Effection's stable `api.Scope`** — creation and destruction only, for
  accounting. `create` is synchronous middleware returning a tuple, so it could
  not suspend a continuation even if asked; nothing treats it as scheduler
  control.
- **Canonical component identity is untouched.** No imported component definition
  is wrapped or replaced; the middleware observes `importComponent` and delegates.

## Controls

Four deliberate defects, because a suite that stays green under a broken
mechanism pins nothing. Seven slice-2 cases:

| defect | result |
| --- | --- |
| the accounting reports nothing unaccounted (`unaccounted()` returns `[]`) | **5 of 7 fail** — the controller reports `paused` for a live subtree; this is the REJECT-detector |
| `installBoundaries()` installs nothing | **6 of 7 fail** — no surfaces observed, nothing held |
| every held continuation released twice | **only** the exactly-once case fails |
| the `content` middleware stops delegating | pass-through and Continue fail — proving the comparison against the no-middleware control is real |

The two named controls that stay in the suite:

- **the bypassing descendant** — `bypass: true` gives one component body a
  spawned child that advances in ordinary Effection and asks the engine for
  nothing. It keeps advancing while the controller is `pausing`, and the
  controller names an unaccounted branch rather than reporting `paused`.
- **no middleware at all** — `withoutMiddleware: true` leaves ordinary execution
  with no controller, no pause status, no retained gate and no accounting, and
  the same output and journal.

## The missing seam, restated for XMD

Slice 1 named it in Effection's terms. Slice 2 names it in XMD's: a REPL can
mediate every point where a document *re-enters the engine*, and that is not the
same as every point where a document *advances*. Closing the gap needs one of:

- a public per-scope way to mediate continuation scheduling in Effection — the
  `api.Reducer`/`api.Coroutine` ask from slice 1 — which would make every
  descendant holdable regardless of what it invokes; or
- a way to tell, from outside, whether a live scope can still advance, which
  would let a fail-closed controller account for engine-owned scopes instead of
  waiting on them.

Neither is an XMD execution protocol, which is why this slice adds none.

## What the matrix added

Slice 3 runs every row the contract deferred. The rest state for a real execution
is `pausing`, so each row is proven at the rest point the design reaches, and the
two rows that specifically require `paused` are proven on Slice 1's synthetic
gate with the evidence saying so. Details and the terminal-path table are in
[`RESULT.md`](RESULT.md).

The one row that closes the reviewer's named gap: **an external operation
completing while `pausing`, through the real document.** Its continuation runs —
there is no surface at the await — and is stopped one boundary later, with the
next element's body never entered.

## What the experiment deliberately does not do

- No `Execution.advance` and no other public or core XMD pause API.
- No edits to any production package.
- No claim that the controller reaches `paused` for a real execution.
- No narrowing of the target subtree to "scopes the REPL happens to see", which
  would report `paused` by ignoring exactly the branches that matter.
- No classification of the engine-owned scopes. Their count and persistence are
  measured; what each is waiting on is not, because answering that *is* the
  missing seam.

`RESULT.md` records the remaining limits of the evidence, including the eval-block
path, which needs a platform compiler and so does not run under the Node and Bun
suites.
