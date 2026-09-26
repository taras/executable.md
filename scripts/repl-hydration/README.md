# Rebuilding a REPL view from its Journal and URL

[#842](https://github.com/taras/executable.md/issues/842), under the REPL quest
[#827](https://github.com/taras/executable.md/issues/827). An experiment. None
of this merges, and none of it is a starting point for production.

The question is whether one durable XMD Journal plus one canonical URL can
reconstruct every durable semantic REPL view, while StarFX stays a discardable
cache and process-local continuations stay honestly unreconstructable.

**Slice 1 establishes the pure boundary, before StarFX exists.** Records in, one
immutable semantic model out, one URL resolved against it, and a refusal for
everything else.

```bash
deno task repl:hydration                                    # the observable trace
deno task test scripts/tests/repl-hydration-projection.test.ts
```

## The layers

| module | what it owns |
| --- | --- |
| `journal.ts` | the closed semantic vocabulary, parsed out of untrusted durable records |
| `fixture.ts` | one truthful append-only journal, and the one-thing-wrong variants of it |
| `model.ts` | the semantic model's types: frozen plain data, no optional member |
| `project.ts` | the fold — one prefix in, one model out — and the inconsistency refusals |
| `location.ts` | #840's URL grammar, resolved against a selected prefix |
| `purity.ts` | the walk that names anything in a model that is not frozen plain data |
| `overlay.ts` | the live process's pause state, where nothing durable can reach it |

`journal.ts`, `model.ts`, `project.ts` and `purity.ts` import `effection` and
each other. None of them imports `overlay.ts`, and the evidence reads their
imports to say so.

## The event vocabulary

Nine kinds, and a record naming anything else is refused rather than carried:

```
entry.submitted   entry.settled      entry.failed
scope.opened      scope.completed
binding.published
suspension.opened suspension.answered
outcome.recorded
```

Each kind declares its fields, and a record carrying a field its kind does not
declare is refused too. That is what stops a continuation, a callback, a
renderer handle or a terminal cell being written into the durable stream and
read back as an execution fact — not a rule about what to look for, but a
vocabulary with nowhere to put one.

A record's marker is its own opaque `id`. Its `seq` is append position: it
orders replay, names nothing, and a gap in it is how a short stream is
recognized.

**Openings mint a marker; completions update what the opening minted.** #842's
contract states this for scopes — "a user-visible scope opening creates one
semantic History marker; scope completion updates its outcome without creating
a closing marker" — and this POC extends the same rule to the rest of the
vocabulary: `entry.submitted`, `scope.opened`, `suspension.opened`,
`binding.published` and `outcome.recorded` mint; `entry.settled`,
`entry.failed`, `scope.completed` and `suspension.answered` update. The
representative journal is 23 records and 18 markers. Whether a point fact
should mint a navigable marker is a product decision the contract does not
settle; this is the reading Slice 1 proceeds under.

## The URL

There is one REPL URL grammar and this is not a second one. `decodeRoute()` and
`encodeRoute()` are imported unchanged from #840's `../repl-compose/router.ts`:
the same five surfaces, the same `+drawer` segments, the same
`at` / `inspect` / `draft` query, the same canonical spelling, the same
equivalent-spelling decoding, the same `RouteRefusal` shape.

```
xmd://repl/e1/transcript/entry-3/document/publish/+source/+confirm?at=r-22&inspect
```

What is adapted, and adapted here rather than there, is **resolution**. #840
resolves against a model holding a snapshot of every checkpoint; that table is
exactly the accelerator #842 must not depend on. So resolution here projects
the prefix the URL named and answers against that single model. Nothing in
`repl-compose` changed, and its evidence is green.

## The two positions

The expansion pause point and the live History head are independent, which #841
measured on a real execution. In the fixture `r-22` is the marker expansion is
held at and `r-23` is a durable outcome background work appended afterwards:

```
expansion pause point (live overlay): r-22
live History head (durable)         : r-23

  at r-22 : 22 records, outcomes none
  at r-23 : 23 records, outcomes "remote tags fetched"
```

Which marker expansion is held at is not written down in the Journal, because
the Journal has no field for it. `overlay.ts` is the only place it exists, and
a reconstruction from records and a URL gets `cold()` — not an overlay
reporting "not paused", which would still be a claim about a pause.

## Named negative controls

Each structural claim carries one, written in the test as the weaker
implementation it rules out.

| control | what it accepts that the real boundary refuses |
| --- | --- |
| `open-vocabulary` | a record whose kind is `pause.held` |
| `skip-malformed` | a 22-record journal in which `project` was silently never published |
| `leaky-prefix` | a "historical" view built by filtering the head, carrying every later binding, drawer and outcome |
| `pause-truncates-head` | a head that stops at the expansion pause point and loses the background outcome |
| `append-order-siblings` | `publish, write` — the order the coroutines opened in, not the document's |
| `decorated-model` | a renderer handle, a `Uint8Array` of cells, or an unfrozen scroll offset on the model |
| `snapshot-dependent` | a projector that answers from a cache and answers nothing without one |
| `permissive-ownership` | two top-level entries running at once |
| `permissive-closure` | an entry settling over a scope that never completed |

## What Slice 1 does not do

No StarFX, no store, no hydration of one, no renderer, no terminal, no real XMD
execution, no Agent, no secrets, no restart replay, no forks. Those are slices
2 through 4.
