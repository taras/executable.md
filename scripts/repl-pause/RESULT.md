# What the expansion-pause experiment found

[#841](https://github.com/taras/executable.md/issues/841), under the REPL quest
[#827](https://github.com/taras/executable.md/issues/827). This is the
conclusion. None of the code under `scripts/repl-pause/` is a starting point —
production begins from current `main`, written afresh.

The question:

> Can the REPL pause and resume XMD expansion using existing XMD surfaces without
> controlling Effection scheduling?

**Yes.**

## Decision: RETAIN

A REPL-installed, pass-through middleware controller pauses and resumes the
expansion of one real XMD execution, over surfaces that already exist, with no
new core XMD API and without touching Effection's scheduler.

| | |
| --- | --- |
| **Retain** | The REPL installs middleware before starting one execution; it is transparent while playing; it holds expansion at existing boundaries; completeness is decided by expansion walks; Continue releases the same continuations exactly once. |
| **Revise** | Nothing structural. Only the vocabulary: the mode is **EXPANSION PAUSED**, never "paused at head", because the durable Journal is free to move while expansion is held. |
| **Reject** | Nothing. |

Effection is the runtime and it keeps running throughout: tasks stay live, timers
fire, external work finishes, and background work records what it produced.
Pausing expansion does not require, and must not wait for, runtime quiescence.

## What an active expansion walk is

XMD expansion is already bracketed. Four existing operations delimit one walk:

| bracket | what it delimits |
| --- | --- |
| `Execution.document` | the root document's expansion |
| `Component.content` | content a component projects |
| `Component.tryContent` | the same, reporting failure instead of replacing |
| the REPL profile's own `expand` handler | structural syntax this REPL declared, and each of its regions |

**A walk is one bracket instance**: it becomes active on entry and settles on
return. Everything else the middleware wraps is a **step gate** *inside* a walk —
a place the walk can be held, not a walk of its own:
`importComponent`, `applyModifiers`, `applyBoundModifiers`, `codeBlock`,
`retain`, `capture`, `raise`, `handleFailure`, `DocumentOutput.output`, and the
REPL's own per-region checkpoint.

A walk publishes its identity on a REPL-owned context for the duration of its
bracket (`Context.with`, so the enclosing identity is restored on the way out).
Every gate crossed underneath attributes to that walk, in whatever coroutine the
engine dispatches from. **That is what stops one walk being counted as several**:
the root document crosses gates in nineteen different coroutines and is one
obligation, not nineteen.

Measured, on the representative document: the nineteen coroutines of the root
walk are **strictly sequential** — each output emission is a fresh short-lived
coroutine, created and finished one at a time. Concurrency inside one walk did
not occur; genuine concurrency appears as *separate* walks, which is what the
region case exercises.

## How `paused` is computed

```
satisfied(walk)  ⟺  (walk holds a continuation  OR  walk has active children)
                    AND every active child walk is satisfied

paused           ⟺  at least one walk is active
                    AND every active walk is satisfied
```

Both halves of `satisfied` are load-bearing, and each was found by a failing case:

- **Without the delegation clause**, a parent suspended inside `next()` while its
  children are held blocks `paused` for ever. That is what two concurrent region
  walks do to `document` and `expand`.
- **Without "and every active child"**, a parent held at its own gate reports
  `paused` while a concurrent child walk is still expanding.

Delegation is recorded, not inferred: a bracket reads the enclosing walk id
*before* publishing its own, so the parent link is a fact the REPL wrote. Both
sides of every such relationship are middleware this REPL owns.

**What is deliberately not an obligation:** ordinary Effection scopes and tasks. A
component body that spawns children, a provider that sleeps, a subprocess being
awaited — none of these expand XMD, so none can prevent `paused`. `api.Scope`
observation is kept as a **diagnostic** that `inspect()` reports and that decides
nothing.

## EXPANSION PAUSED, not paused at head

Two positions must not be conflated, and the mode name carries the distinction:

- **The expansion pause point is fixed.** No further element or output expands.
- **The durable Journal — and therefore the live History head — may advance**,
  because already-running work records its outcomes normally.

The real trace, with Pause requested while a component body was running ordinary
Effection:

```
state the moment Pause is requested : pausing
reached()                           : EXPANSION PAUSED
active walks                        : w1:document(root) held@output:\n\n
live Effection scopes (diagnostic)  : 25

across 30 sibling advances: expansion STOPPED, holds unchanged
ordinary Effection children of a component: 80 -> 140 (still running)

journal records before external work completes : 7
journal records after it recorded              : 8
the appended record                            : yield:background
expansion pause point                          : still fixed
controller state                               : paused

after Continue: completed, released 1, twice 0
the background record appears exactly once     : true
```

Twenty-five live Effection scopes, ordinary component children advancing 80 → 140,
the Journal head moving 7 → 8 — and expansion stopped the whole time, with the
same continuation held in the same place.

A future scrubber can therefore show a **stationary expansion-pause marker while
the live History head advances**. This POC does not implement that UI, and the
distinction is why it must exist.

## External work

- **Never frozen.** Nothing the controller does reaches it.
- **May finish while pausing or paused.** It does.
- **Its durable outcome is appended normally** while expansion is paused.
- **If its continuation then attempts more XMD expansion, it is held** at the next
  controlled expansion boundary, like any other walk.
- **Continue does not replay it.** Counted at append time, so a duplicate landing
  at any moment would be caught. Structurally, Continue cannot replay: it resolves
  a suspended `action()` rather than re-running anything.

## Cancellation and teardown

| terminal path | outcome | held continuations | retained resource |
| --- | --- | --- | --- |
| completion | the document's value | released by Continue | released |
| failure during coordination | raises to the owner on Continue | unwound | released |
| explicit interruption from `paused` | `halted` | **unwound, not released** | released |
| owner shutdown from `paused` | `halted`, never a success | **unwound, not released** | released |

Interruption and shutdown do **not** release holds into ordinary execution: the
gate's release counter stays at **zero** on both paths, because a hold is a
suspended `action()` whose discard runs when the routine unwinds. The element
after the hold never expands and the Journal does not move on the way out.

A failure during coordination is retained like any other expansion work and
reaches the owner when Continue releases it — not swallowed, not deferred.

## What #842 may rely on

- **Expansion can be paused and resumed in memory**, on a real execution, with no
  core XMD pause API.
- **The controller is ephemeral and never journaled.** It is generator state in a
  scope outside the subtree it holds. A UI may report its status; it does not own
  or reconstruct it.
- **A paused interval has a fixed *expansion* position, not a fixed Journal
  head.** Anything reconstructing a view must treat those as two positions.
- **Continue is exactly-once and replay-free.**
- **An installed-but-idle controller changes nothing** — output and journal are
  byte-identical to an unmediated run.
- **Restart is not Continue.** The retained continuations are in memory only;
  after a process restart they are gone and journal replay owns resumption, which
  is #842's subject.
- **Coverage is a standing obligation.** Pause is sound only while every expansion
  path crosses a controlled boundary. A new core operation that becomes a way for
  a document to advance, and that is not one of these surfaces, silently widens
  the gap — which is why the boundary inventory belongs in production as a test.

## Evidence

```bash
deno task test scripts/tests/repl-pause-gate.test.ts   # 16 cases, two suites
deno task repl:pause                                    # the synthetic unit gate
deno task repl:pause:seam                               # Effection's published surface
deno task repl:pause:xmd                                # inventory + expansion-pause trace
```

Green on Deno, Node and Bun. The real-execution suite carries the product claims;
the synthetic gate remains as focused unit evidence and substitutes for nothing.

The boundary inventory, measured by running the document: eleven surfaces crossed,
four of them walk brackets. Prose is covered because `DocumentOutput.output` is
gated — which is what makes "the next element *or output* does not appear until
Continue" a claim about output and not only about elements.

### Break-it controls

| defect | result |
| --- | --- |
| descendant-Effection-scope completeness restored as the decision | **9 of 10 rows fail** — the real execution is stuck in `pausing`, which is exactly the error this correction removed |
| `paused` reported without requiring every walk held or settled | 7 of 10 rows fail |
| durable appends suppressed while paused | the background-recording row fails |
| the same durable outcome recorded twice | the background-recording row fails |
| an expansion path allowed to bypass the gate | the concurrent-walk and exactly-once rows fail |
| holds released into ordinary execution on unwind | exactly the three release/unwind rows fail |

And one **positive** control, required and in the suite permanently: ordinary
Effection children of a component keep running throughout the paused interval and
do **not** fail expansion completeness. A raw task continuing is not a bypass.

### Corrections this slice made to its own earlier evidence

- **An interval that measured nothing.** Earlier slices timed a paused interval by
  consuming N advances from a subscription taken much earlier. The advance signal
  buffers from the moment a subscription is taken, so those reads drained a
  backlog in ~0 ms and the "interval" passed no real time. Every interval now
  starts from a **fresh** subscription. This is what first made ordinary component
  children look as though they had stopped; measured properly they run 80 → 140.
- **A no-replay assertion that sampled once.** Duplicates are now counted at
  append time, so one landing at any moment is caught.
- The conclusions withdrawn from the previous commit — that a real execution
  cannot report `paused`, that production should expose only `playing` and
  `pausing`, that an Effection scheduler or quiescence API is required — were
  artefacts of using Effection-scope quiescence as the completeness rule. They are
  not repeated here.

## Production sequencing

Written afresh from current `main`.

1. **The boundary inventory as a test.** Assert which surfaces a representative
   execution crosses and which of them bracket a walk. This is the standing guard
   on the soundness condition and the most durable artefact here.
2. **The walk registry and the controller.** Walk brackets, step gates,
   context-carried walk identity, the `satisfied` rule with both clauses, and
   `playing` / `pausing` / `paused`.
3. **EXPANSION PAUSED in the interface**, with the expansion pause marker and the
   live History head shown as two positions.
4. **Hand over to #842** for durable resumption after restart.

## Known limits of this evidence

- **One document, one host profile.** No Agent providers, no real subprocess
  beyond the echo stub, no nested `<Execution>`, no plugins.
- **Concurrency inside a single walk was not observed**, so the rule is proven
  against sequential activity within a walk and against concurrency *between*
  walks. A future engine that expands two elements of one walk in parallel would
  need the obligation refined below walk granularity.
- **Eval blocks are not exercised.** They need a platform compiler installed
  through `API.Env.around({ compile })` and are Deno-data-URI shaped, so they do
  not run under the Node and Bun suites. They route through the same
  `applyModifiers` boundary as `exec`, which is exercised.
- **The background recorder is a POC producer on a real channel.** It appends to
  the same durable stream the engine journals through; it is not a core durable
  operation.
- **`Scope.around()` has no removal**, so the controller is installed for the
  target scope's lifetime.
- Nothing in `#841`'s out-of-scope list was touched: no terminal rendering, no
  routing, no StarFX, no durable restart replay, and no public or core XMD pause
  API.
