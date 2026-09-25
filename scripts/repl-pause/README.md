# Pausing one execution subtree — the middleware seam

[#841](https://github.com/taras/executable.md/issues/841), under the REPL quest
[#827](https://github.com/taras/executable.md/issues/827). This is the first
slice: whether middleware around an XMD-owned execution Api can hold a live
subtree while its owner and siblings stay responsive. The later lifecycle matrix
is deliberately not here, and `RESULT.md` is written after it.

Run the evidence:

```bash
deno task test scripts/tests/repl-pause-gate.test.ts   # the six focused cases
deno task repl:pause                                    # the representative trace
deno task repl:pause:seam                               # what 4.1.0 does not publish
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

- The later lifecycle matrix: concurrent descendants beyond A and B, a child
  settling during coordination, a child starting while pausing, failure during
  coordination, cancellation of the request, interruption while paused, owner
  shutdown while pausing and while paused, and cleanup on every terminal path.
  `release()` already covers abandoning an unsettled request, but that is not
  yet proven.
- Teardown while held. The gate holds continuations in `action()`, whose discard
  runs when a routine unwinds, so ordinary teardown is expected to work — but
  "expected" is not evidence, and it belongs to the matrix.
- Uninstalling the decoration. `Scope.around()` has no removal, so the gate is
  installed for the target scope's lifetime.
- Everything #841 puts out of scope: rendering, routing, StarFX, durable
  restart replay.

None of this code is a starting point for production. It is a disposable POC on a
branch that never merges.
