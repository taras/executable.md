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
| `fixture.ts` | two truthful append-only journals, and the one-thing-wrong variants of the first |
| `model.ts` | the semantic model's types: frozen plain data, no optional member |
| `project.ts` | the fold — one prefix in, one model out — and the inconsistency refusals |
| `location.ts` | #840's URL grammar, resolved against a selected prefix |
| `purity.ts` | the walk that names anything in a model that is not frozen plain data |
| `overlay.ts` | the live process's pause state, where nothing durable can reach it |

`journal.ts`, `model.ts`, `project.ts` and `purity.ts` import `effection` and
each other. None of them imports `overlay.ts`, and the evidence reads their
imports to say so.

## The event vocabulary

Ten kinds, and a record naming anything else is refused rather than carried:

```
entry.submitted   entry.settled  entry.failed  entry.interrupted
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

## The marker policy

Every record mints a marker except the two *closing* kinds. Weight is how
prominent the position is, and it is a value on the marker rather than a
convention:

| kind | marker |
| --- | --- |
| `entry.submitted` | major entry boundary |
| `entry.settled` | terminal |
| `entry.failed` | terminal |
| `entry.interrupted` | terminal |
| `scope.opened` | opening |
| `suspension.opened` | opening |
| `binding.published` | small semantic checkpoint |
| `outcome.recorded` | small semantic checkpoint |
| `scope.completed` | none — updates the scope the opening minted |
| `suspension.answered` | none — updates the suspension the opening minted |

An entry's end is a place to stand, not a property of the marker before it, so
settlement, failure and interruption are each directly navigable. The
representative journal is 23 records and 20 markers; the terminal journal is
18 records and 15.

## How an entry ends

There are four lifecycle statuses and no fifth: `running`, `settled`, `failed`
and `interrupted`.

One terminal record ends an entry and interrupts whatever it still had open.
The entry carries what the record said; each still-running descendant scope
becomes `interrupted` and carries the same reason, because the Journal
recorded one ending and not one per scope. A scope that completed earlier
stays completed, open waits close, and published bindings are untouched.

```
t-13 failed       weight=terminal
  entry-2 failed (the registry rejected the tarball)
    document: interrupted (the registry rejected the tarball)
      verify: settled
      upload: interrupted (the registry rejected the tarball)

t-18 interrupted  weight=terminal
  entry-3 interrupted (the operator stopped the run)
    document: interrupted (the operator stopped the run)
      watch: interrupted (the operator stopped the run)

before the failure (t-12): 0 ended entries
release survives the failure: release=0.14.0
```

`fixture.ts` holds two journals. The representative one is the pause/head
subject and keeps that shape; the terminal one is three entries and nothing
else, one for each way an entry can end.

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
| `restore-abandoned` | a fifth lifecycle status renaming an interruption |
| `omit-terminal-kinds` | a policy whose nearest position to a failure is `t-12`, where the entry is still running |
| `closing-marker` | `t-04`, a second position for a scope that has one |
| `interrupt-completed-scope` | `verify:interrupted`, rewriting a scope that finished |

## What Slice 1 does not do

No StarFX, no store, no hydration of one, no renderer, no terminal, no real XMD
execution, no Agent, no secrets, no restart replay, no forks. Those are slices
2 through 4.
