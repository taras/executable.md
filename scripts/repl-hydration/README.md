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

**Slice 2 puts that model in the actual StarFX store** and shows the store adds
nothing to it.

**Slice 3 takes the process away** and asks what is left: a draft that is not a
record, an Agent result without the stream that produced it, a replay that
consumes what is written instead of doing it again, and a secret that has to be
asked for a second time.

```bash
deno task repl:hydration                                    # the observable trace
deno task test scripts/tests/repl-hydration-projection.test.ts   # slice 1
deno task test scripts/tests/repl-hydration-store.test.ts        # slice 2
deno task test scripts/tests/repl-hydration-replay.test.ts       # slice 3
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
| `store.ts` | the actual StarFX store, hydrated from records plus a URL |
| `layout.ts` | presentation, computed outside the store, and the topology that must not move |
| `ephemeral.ts` | partial Agent output and the secret seam — the other half process loss takes |
| `replay.ts` | the deterministic document, and one function that both runs and replays it |

`journal.ts`, `model.ts`, `project.ts` and `purity.ts` import `effection` and
each other. None of them imports `overlay.ts`, and the evidence reads their
imports to say so, and `ephemeral.ts` is held out of the same set. `store.ts` is
the only module that imports `starfx`.

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
| `persisted-snapshots` | a cache that outlived its records, answering a 3-record moment where 22 belong |
| `head-memoized` | a frozen live head still reporting 22 records after the 23rd arrived |
| `layout-in-the-store` | a viewport in the state, making two terminals two executions |
| `overlay-in-the-store` | a pause flag in the state, surviving a restart that cannot know it |
| `replay-reperforms` | a run that ignores the record and does both durable effects again |
| `recoverable-secret` | a secret treated as ordinary: nobody is asked, so the value had to be somewhere |
| `streamed-into-the-record` | a partial chunk under the right request, indistinguishable from the result |
| `draft-as-a-visit` | four navigation entries for one place, burying where the person came from |
| `kind-only-replay` | another document's submission, binding and Agent occurrence, all matching on kind alone |

## The StarFX store

`starfx@0.16.1`, added through the repository's frozen-lock procedure. It
depends on `effection: ^4`, so it sits beside this repository's `effection`
rather than beside a second copy of it, and its root export is React-free. It
runs under Deno, Node and Bun unchanged, and no production package moved.

The store takes the caller's Effection scope through `useScope()`, so its
lifetime is the session's. Its slices are `execution`, `url`, `records`,
`model`, `history`, `location` and `snapshots`, plus the `cache` and `loaders`
slices StarFX's schema requires and this REPL never writes.

Everything in it is derived from the records and the URL, and every transition
re-derives rather than patching — a patch would be a second way to arrive at a
state, and the claim is that there is one.

**Snapshots accelerate and never testify.** `snapshots` memoizes the model of a
*marker* prefix, because a prefix ending at a record can never change. The live
head is never memoized: it is exactly the prefix that grows. A new store starts
with an empty cache and cannot be handed a populated one, so a snapshot cannot
outlive the process that derived it.

## The journey

```
— the journey, accumulated live against a cold rebuild —
  empty                                prefix none  records  0  future markers  0  rebuild identical true
  the first entry                      prefix r-01  records  1  future markers  0  rebuild identical true
  nested scopes                        prefix r-03  records  3  future markers  0  rebuild identical true
  a published binding                  prefix r-07  records  7  future markers  0  rebuild identical true
  the expansion pause marker           prefix r-22  records 22  future markers  0  rebuild identical true
  a background append, expansion held  prefix r-22  records 22  future markers  1  rebuild identical true
  historical inspection                prefix r-03  records  3  future markers 17  rebuild identical true
  the live head                        prefix r-23  records 23  future markers  0  rebuild identical true
  back to the pause marker             prefix r-22  records 22  future markers  1  rebuild identical true

— Continue is the live process's to offer —
  at r-22, holding      : true
  at r-22, released     : false
  at r-22, after restart: false
  the reconstruction is unchanged  : true

— the cache accelerates and decides nothing —
  memoized markers      : r-03 r-22
  after discarding them : true

— one state, two terminals —
  lines at 120 columns : 27
  lines at 28 columns  : 34
  topology identical    : true
  nothing foreign in the store: clean
```

A future marker is listed as navigation context and carries no fact: while
expansion is held at `r-22` and the Journal advances to `r-23`, the selected
model does not move and the string `remote tags fetched` appears in neither
the model nor the History.

## Restart

A live run and a replay are one function. `resume()` walks the document's steps
beside the Journal in append order, and each step either *consumes* the records
it already produced or *performs* itself for the first time. A consumed step
never reaches the performer, which is the whole no-repeat claim. Where it stops
is the **replay frontier**: the first elicitation with no answer recorded.

**A record is consumed only when it is that step's own record.** The kind alone
says far too little — every scope opening is a `scope.opened` — so every
replayable occurrence has an identity: operation, owning entry, owning scope,
and the durable name of the occurrence there. That identity is separate from
the result: replay *matches* the request and *restores* what came back, which
is why `outcome.recorded` carries `request` beside `label`. An outcome
recognized by its own result could only be recognized by a replay that already
knew the answer.

Alignment happens first and completely: the prior Journal is parsed, projected,
and walked against the script before a single effect runs. A divergence
therefore costs nothing — no effect, no appended record, and the Journal handed
in comes back untouched. A retained record still unclaimed when the document
has finished is a divergence too, because it describes work this document does
not do.

```
another document's journal : record 0: expected entry.submitted "entry-1" in entry-1,
                             found entry.submitted "other-entry" in other-entry
another binding, right kind: record 7: expected binding.published "notes" in entry-1,
                             found binding.published "other" in entry-1
```

Two elicitations differ on the way there, and that difference is the secret
rule. An ordinary answer is in the record, so replay recovers it and asks
nobody. A secret answer is not in the record and never was, so replay knows
only that it was asked — and asks again. With nobody to ask, that is a frontier
of its own.

`suspension.opened` carries `secret` and `suspension.answered` carries
`answer`, which is what makes the two cases distinguishable at all. The
projection refuses a `suspension.answered` that carries a value for a wait the
Journal opened as secret, so a leak cannot be written down and then merely left
unread.

```
— a first run, live —
  performed : agent entry-1/document/draft, publish notes
  frontier  : awaiting channel

— the same document after process loss —
  performed again : nothing
  consumed        : agent entry-1/document/draft, publish notes
  recovered       : channel=#releases
  re-prompted for : token
  partial output  : none
  frontier        : complete
  with nobody to ask: unrevealed token

— what the restart shows —
  admitted result : Release notes for 0.14.0
  its scopes      : draft > review
  journal records : 13 (typing appended none)
  navigation stack: 1
  Continue offered: false

— the secret —
  asked for again in : token
  present in journal, store, navigation, audit or run: nowhere
```

## Drafts

Typing moves the URL and nothing else. No record is appended, and the ordinary
navigation history — which is process-local, like the snapshot cache, and so
lives beside the store rather than in it — is replaced in place rather than
grown. Three keystrokes are one place, so Back goes where the person came from
instead of walking backwards through their typing.

## What Slice 3 does not do

No renderer, no terminal, no real XMD execution, no model provider, no forks.
Forks are Slice 4.
