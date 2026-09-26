# Pausing XMD expansion

[#841](https://github.com/taras/executable.md/issues/841), under the REPL quest
[#827](https://github.com/taras/executable.md/issues/827).

**The conclusion is [`RESULT.md`](RESULT.md): RETAIN.** A REPL-installed
pass-through controller pauses and resumes the expansion of one real XMD
execution, over surfaces that already exist, with no new core XMD API and without
touching Effection's scheduler.

This file is the working record behind it, including what was got wrong on the
way. Run the evidence:

```bash
deno task test scripts/tests/repl-pause-gate.test.ts   # 16 cases, two suites
deno task repl:pause                                    # the synthetic unit gate
deno task repl:pause:seam                               # what Effection publishes
deno task repl:pause:xmd                                # inventory + expansion-pause trace
```

## The correction that mattered

The first attempts used the wrong completeness boundary. They asked whether every
descendant **Effection scope** was suspended, concluded that a real execution could
therefore never report `paused`, and proposed depending on a future Effection
scheduler-decoration or quiescence API.

That was the wrong question. The REPL pauses **XMD expansion**. Effection is the
runtime and keeps running throughout: tasks stay live, timers fire, external work
finishes, and background work records its outcomes. Those conclusions are withdrawn
and are not repeated in `RESULT.md`.

The obligation set is **expansion walks**. `api.Scope` and scope counts remain as
**diagnostics** that `inspect()` reports and that decide nothing.

## EXPANSION PAUSED, not "paused at head"

Two positions, and they must not be conflated:

- **The expansion pause point is fixed** — no further element or output expands.
- **The durable Journal, and so the live History head, may advance**, because
  already-running work records its outcomes normally.

Measured on a real execution: 25 live Effection scopes, ordinary component children
advancing 80 → 140, the Journal head moving 7 → 8 — with expansion stopped
throughout and the same continuation held in the same place.

A future scrubber can show a stationary expansion-pause marker while the live
History head advances. This POC does not implement that UI; the distinction is why
it has to exist.

## What a walk is, and how `paused` is computed

A walk is one **bracket instance**. Four existing operations delimit one:
`Execution.document`, `Component.content`, `Component.tryContent`, and the REPL's
own `expand` handler — including each region it expands. Everything else the
middleware wraps is a **step gate** inside a walk.

```
satisfied(walk)  ⟺  (walk holds a continuation  OR  walk has active children)
                    AND every active child walk is satisfied

paused           ⟺  at least one walk is active
                    AND every active walk is satisfied
```

Both clauses were found by a failing case, and `RESULT.md` records which. Walk
identity travels on a REPL-owned context for the duration of the bracket, so a
walk that crosses gates in nineteen different coroutines is one obligation.

## The boundary inventory

Measured by running the document, not read off the Api declarations — `raise()` in
particular looks ubiquitous in `expand.ts` but fires only on error paths.

| role | surfaces |
| --- | --- |
| **brackets one expansion walk** | `document`, `content`, `expand`, `region` |
| **step gate inside a walk** | `importComponent`, `applyModifiers`, `applyBoundModifiers`, `codeBlock`, `retain`, `output`, `replCheckpoint` |

Gating `DocumentOutput.output` is what covers prose: it makes "the next element *or
output* does not appear until Continue" a claim about output, not only about
elements.

Two measured facts about the shape of expansion:

- **The root walk crosses gates in nineteen coroutines, strictly sequentially.**
  Each output emission is a fresh short-lived coroutine. Concurrency *inside* one
  walk did not occur.
- **Genuine concurrency appears as separate walks.** Two regions expanded in
  parallel are two walks, and both must be held or settled.

## Surfaces used, and how

- **`Component.around(...)`, `Execution.around(...)`, `DocumentOutput.around(...)`**
  — real contextual Api middleware, installed at the default `max` in the scope that
  will own the execution, **before** it starts, never when Pause is pressed. `min`
  is the implementation slot the runtime providers occupy.
- **The REPL's own captured `expand` handler.** `ExecutionInstallation.expand` is
  read once and bound at profile capture, so a host holds its own handler and may
  decorate it while assembling its profile. This is REPL-owned code, **not** Api
  middleware. The per-region bracket and the per-chunk checkpoint live in that same
  REPL-owned loop.
- **Stable `api.Scope`** — creation and destruction, diagnostic only. Its `create`
  returns a tuple rather than an `Operation`, so it could not suspend anything even
  if asked, and nothing treats it as scheduler control.
- **Canonical component identity is untouched.** No imported component definition
  is wrapped or replaced; the middleware observes `importComponent` and delegates.

## What the synthetic gate still contributes

`gate.ts`, `fixture.ts`, `execution.ts`, `journal.ts` and `main.ts` are the first
slice: a gate over an Api invented for the experiment, kept in the suite as focused
unit evidence for the hold-and-release mechanism. It substitutes for nothing — every
product claim is made against the real execution.

Its mechanism findings still stand and are the reason the design works:

- Middleware installed on one scope is inherited by descendants and absent from
  siblings, because that is how Api dispatch resolves a handle.
- A hold is a suspended `action()`, so teardown unwinds *through* it rather than
  releasing it — which is what makes interruption and shutdown safe.
- Continue cannot replay: it resolves a suspended action rather than re-running
  anything.

`missing-seam.ts` (`deno task repl:pause:seam`) records what Effection 4.1.0
publishes and what it does not. **The design does not depend on any of it** — it is
kept only as that record, and as the reason no private reducer, deep import,
scheduler substitution or runtime-name reconstruction appears anywhere here.

## Two measurement errors this work corrected in itself

- **An interval that measured nothing.** Earlier slices timed a paused interval by
  consuming N advances from a subscription taken much earlier. The advance signal
  buffers from the moment a subscription is taken, so those reads drained a backlog
  in ~0 ms and no real time passed. Every interval now starts from a **fresh**
  subscription. This is what first made ordinary component children look as though
  they had stopped; measured properly they run 80 → 140.
- **A no-replay assertion that sampled once.** Duplicate durable outcomes are now
  counted at append time, so one landing at any moment is caught.

## What is deliberately not done

- No `Execution.advance` and no other public or core XMD pause API.
- No edits to any production package.
- No private Effection reducer, deep import, scheduler substitution, or
  runtime-name reconstruction.
- No claim about whole-runtime quiescence, and no inference that a live Effection
  scope means expansion can advance.
- No classification of engine-owned scopes: they are counted as a diagnostic and
  nothing is concluded from them.

`RESULT.md` records the remaining limits of the evidence, including eval blocks,
which need a platform compiler and so do not run under the Node and Bun suites.

None of this code is a starting point for production. It is a disposable POC on a
branch that never merges.
