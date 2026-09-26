# What the pause experiment found

[#841](https://github.com/taras/executable.md/issues/841), under the REPL quest
[#827](https://github.com/taras/executable.md/issues/827). This is the
conclusion. None of the code under `scripts/repl-pause/` is a starting point —
production begins from current `main`, written afresh.

The question was whether one visible XMD execution subtree can be paused and
continued without cancelling it, using surfaces that already exist.

**It can be paused. It cannot be certified paused.** That difference is the whole
result, and it is not a detail of this implementation — it is a property of what
Effection publishes.

## Decision: REVISE

Retain the design. Change what the design is allowed to *claim*.

| | |
| --- | --- |
| **Retain** | A REPL-owned controller, installed before one execution starts, holding continuations at XMD's existing boundaries, with fail-closed accounting from scope ownership. |
| **Revise** | `paused` cannot be a reported state for a real execution. The reachable rest state is `pausing`. Any UI, contract or story that promises `paused` is promising something the runtime cannot support today. |
| **Reject** | Nothing. No approach was tried and abandoned; the limit is in the runtime, not in the shape of the controller. |

## The seam used, and the seam missing

**Used.** Three kinds of surface, which are not interchangeable:

- **`Component.around(...)` and `Execution.around(...)`** — real contextual Api
  middleware (`@effectionx/context-api`), installed at the default `max` in the
  scope that will own the execution, *before* it starts. `min` is the
  implementation slot the runtime providers occupy. These can hold a
  continuation, because middleware is an operation.
- **The REPL's own captured `expand` handler.** `ExecutionInstallation.expand` is
  read once and bound at profile capture, so a host holds its own handler and may
  decorate it while assembling its profile. This is REPL-owned code, **not** Api
  middleware.
- **Stable `api.Scope`** — creation and destruction, for accounting only. Its
  `create` returns a tuple rather than an `Operation`, so it could not suspend a
  continuation even if asked.

**Missing.** A REPL can mediate every point where a document *re-enters the
engine*. That is not the same as every point where a document *advances*. Closing
the gap needs one of two things from Effection, neither of which is an XMD
protocol:

1. **A public per-scope way to mediate continuation scheduling** — an
   `api.Reducer` or `api.Coroutine` that `Scope.around()` can decorate, or an
   exported `ReducerContext`. Every continuation already funnels through
   `Coroutine.resume() → reducer.schedule(routine)` on the reducer its scope
   resolved *at creation*, so substituting that for one scope holds every
   descendant regardless of what it invokes. `deno task repl:pause:seam` freezes
   three raw `sleep` loops that way while a sibling advances. It is unreachable:
   `api.Main` is gone in stable 4.1.0, the package `exports` map hides the
   reducer, and the one remaining route — rebuilding `@effection/reducer` by name
   — **fails open**, reporting `paused` for a live subtree the moment the internal
   name moves.
2. **A way to ask, from outside, whether a live scope can still advance.** That
   would let a fail-closed controller account for engine-owned scopes instead of
   waiting on them forever.

Either one turns this REVISE into a RETAIN. Neither can be substituted by
anything XMD adds to itself, which is why this experiment adds nothing.

## Why the mechanism covers what it covers

Coverage is **measured**, by running a representative document with observers on
every surface — not read off the Api declarations, where `raise()` in particular
looks ubiquitous but fires only on error paths.

Nine surfaces are crossed, and every one can hold:

`importComponent` · `applyModifiers` · `applyBoundModifiers` · `codeBlock` ·
`content` · `retain` · `document` · the REPL's `expand` handler · a REPL
checkpoint per region chunk

Three paths cross **nothing**:

- **Prose, headings and core structural syntax** (`<If>`, `<Each>`, `<Let>`). The
  per-element walk invokes a `Component` operation only where an element *is* a
  component or a code block. An `<Each>` over a thousand items reaches no
  boundary.
- **A function component's own body**, and every scope it spawns.
- **An external operation a component body awaits.**

And `Execution.document` never exits until the run is over: it is the right
anchor for *which* subtree is being paused and can never be a resting place.

Two consequences follow, and they point in opposite directions.

**The favourable one: history fixity is reachable.** Every durable journal append
in the representative document lands *exactly* on a crossed boundary — 5
`import_component`, 2 `exec`, `close`, and nothing else. Prose and regions
journal nothing. So holding at those boundaries fixes the journal head even
though the walk is not fully gated. Measured: the journal did not move across
thirty of an unrelated sibling's own announced advances, and the held
continuation did not move either.

**The limiting one: the subtree cannot be accounted for.** A real execution keeps
**15 live descendant scopes, of which 2 ever cross a REPL-reachable surface.**
The rest are engine-owned — the invocation owner, the durable run, the stream
machinery, region streams, a retained resource — and they live for the whole run.
The controller is fail-closed, so it stays in `pausing` and names them.

Nothing here claims those scopes are quiescent. Empirically the document stopped;
but "it stopped" and "I can prove it stopped" are different claims, and
distinguishing an engine scope blocked on the held walk from one waiting on its
own timer needs seam (2) above. Declaring them safe would be inferring that a
live parent is quiescent because a descendant is held, which is precisely the
error this controller is built to refuse.

## What external work does

The external operation is a promise already in flight, awaited by a component
body through `until`.

- **It is never frozen.** Nothing the controller does reaches it.
- **It may finish while `pausing`.** It does, and the test drives exactly that.
- **Its continuation is *not* stopped where it completed.** There is no surface
  at the await. The continuation resumes the component body, which returns to the
  walk, which is then stopped at *the walk's next* controlled boundary.

So an in-flight external operation is gated one boundary **later** than where it
completed. For a REPL that is acceptable while `pausing`. It is also the reason a
component that never reaches another boundary is one of the permanently-pausing
paths.

## Cancellation and teardown

Every terminal path was taken with a continuation actually held, and every one
released what the document owned — watched through `Component.retain`, XMD's own
way for a component to own something that outlives its body.

| terminal path | outcome | held continuation | resource |
| --- | --- | --- | --- |
| completion | the document's value | released by Continue | released |
| cancelled pause request | indistinguishable from an unpaused run | never held | released |
| failure during coordination | raises to the owner on Continue | unwound | released |
| explicit interruption | `halted` | **unwound, not released** | released |
| owner shutdown | `halted`, never a success | **unwound, not released** | released |

Two details matter more than the table.

**Interruption and shutdown do not briefly resume ordinary work.** The gate's
release counter stays at **zero** on both paths: a held continuation is suspended
inside `action()`, whose discard runs when the routine unwinds, so teardown
unwinds *through* the hold rather than releasing it and letting it run. The
element after the hold never executes and the journal does not move.

**Owner shutdown does not convert resumability into success.** It settles as
`halted`.

**A failure during coordination is retained like anything else** — it travels the
same surfaces ordinary work does — and reaches the owner when Continue releases
it. It is not swallowed by the pause machinery, and it is not deferred past
Continue: it tears the execution scope down immediately.

**Interruption and shutdown *from `paused`*** are the two rows a real execution
cannot reach, because `paused` is unreachable. They are proven on Slice 1's
synthetic gate, which does reach `paused`: both unwind with zero releases, a
fixed history head, and an empty live set. The evidence says which fixture proved
which row rather than relabelling `pausing` as `paused`.

## What #842 may rely on

- **The controller is ephemeral and never journaled.** It is generator state in
  the scope that acquired it, outside the subtree it holds. A UI may report its
  status; it does not own or reconstruct it. So #842 inherits no durable pause
  record and no obligation to write one.
- **The journal is a faithful boundary log.** Appends coincide with the
  boundaries a pause holds, so a paused interval has a stable head and journal
  order is unaffected by pausing.
- **Restart is not Continue.** The retained continuations are in memory only.
  After a process restart they are gone, and journal replay owns resumption —
  which is #842's subject, not this one's.
- **Continue is exactly-once and replay-free.** Proven by counting releases and
  by numbering every step so a repeat would appear as a duplicate record. Neither
  a second release nor a duplicate ever occurred.
- **Pass-through is exact.** With the controller installed and never paused, the
  document produces byte-identical output and an identical journal to a run with
  no middleware at all. #842 can assume an installed-but-idle controller changes
  nothing.
- **What #842 must *not* assume:** that a subtree can be certified suspended.
  Until one of the two Effection seams exists, a REPL can stop a document and
  cannot prove it stopped.

## Evidence

```bash
deno task test scripts/tests/repl-pause-gate.test.ts   # 23 cases, three suites
deno task repl:pause                                    # slice 1, synthetic gate
deno task repl:pause:seam                               # the missing Effection seam
deno task repl:pause:xmd                                # coverage inventory + lifecycle trace
```

Green on Deno, Node and Bun.

Eleven deliberate defects were run against the suites, because a suite that stays
green under a broken mechanism pins nothing.

| defect | result |
| --- | --- |
| slice 1: decoration never installed | all 6 fail |
| slice 1: completeness check vacuous | 5 fail; the non-pausing case correctly survives |
| slice 1: every hold released twice | only the exactly-once case fails |
| slice 2: `Execution`/`Component` boundaries not installed | 6 of 7 fail |
| slice 2: accounting reports nothing unaccounted | 5 of 7 fail — the REJECT detector |
| slice 2: `content` middleware stops delegating | pass-through and Continue fail |
| slice 2: holds released twice | only the exactly-once case fails |
| matrix: holds never hold | 5 of 10 fail; the rows that survive are not hold-claims |
| matrix: retained resource never released | all 5 cleanup rows fail |
| matrix: a release counted on unwind | exactly the three "released zero / once" rows fail |

Two controls caught real weaknesses rather than merely passing:

- The first run of slice 1's removal control found the release case passing
  **vacuously** — releasing nothing exactly zero times satisfied it. It now
  asserts that three continuations were held first.
- Adding the retained resource to the fixture broke slice 1's live-scope count,
  because a `resource()` body is its own task. Rather than edit slice 1's
  assertions to fit, the instrumentation was moved so slice 1's numbers stayed
  true — and the enrichment is recorded: slice 2's measurement is now **2 of 15**
  crossing scopes rather than the 2 of 12 its own commit reported, with the same
  conclusion.

Two named controls stay in the suite permanently: a legitimate descendant that
bypasses every surface, and no middleware at all.

## Production sequencing, if this is built

Written afresh from current `main`. Steps 1–2 are useful whatever Effection does;
step 3 is blocked on it.

1. **The boundary inventory as a test.** Assert which surfaces a representative
   execution crosses, so a new core operation that becomes a document's way of
   advancing cannot silently escape a future pause. This is the single most
   durable artefact here.
2. **A REPL-owned controller with `playing` / `pausing` only, and honest UI.**
   Install before the execution, hold at existing boundaries, keep the fail-closed
   accounting, and let the interface say *pausing* and name what it is waiting
   for. That is shippable today and is not a lie.
3. **`paused` as a reported state** — only after Effection publishes per-scope
   scheduling control or a quiescence query. Until then it must not be promised.

## Known limits of this evidence

- **`paused` is never reached for a real execution**, so the contract clause
  "nothing advances and no history is appended after `paused`" is **vacuously
  satisfied** here. Nothing asserts it, because an assertion about a state the
  design never reaches proves nothing.
- **Eval blocks are not exercised.** They need a platform compiler installed
  through `API.Env.around({ compile })` and are Deno-data-URI shaped, so they do
  not run under the Node and Bun suites. They route through the same
  `applyModifiers` boundary as `exec`, which *is* exercised.
- **One document, one host profile.** No Agent providers, no real subprocess
  beyond the echo stub, no nested `<Execution>`, no plugins.
- **`Scope.around()` has no removal**, so the controller is installed for the
  target scope's lifetime. Uninstalling mid-run was never attempted.
- **The engine-owned scopes were never classified.** Their count and persistence
  are measured; what each one is waiting on is not, deliberately — that is the
  question seam (2) exists to answer.
- Nothing in `#841`'s out-of-scope list was touched: no terminal rendering, no
  routing, no StarFX, no durable restart replay, and no public or core XMD pause
  API.
