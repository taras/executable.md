# What the hydration experiment found

[#842](https://github.com/taras/executable.md/issues/842), under the REPL quest
[#827](https://github.com/taras/executable.md/issues/827). This is the
conclusion. None of the code under `scripts/repl-hydration/` is a starting
point — production begins from current `main`, written afresh.

The question:

> Can one durable XMD Journal plus one canonical URL reconstruct every durable
> semantic REPL view, while StarFX remains a discardable cache and
> process-local continuations remain honestly unreconstructable?

**Yes.**

## Decision: RETAIN

| | |
| --- | --- |
| **Retain** | Records and a URL determine the view. The projector takes records and a marker and has no parameter a snapshot could go in. StarFX holds only what those two produce. The pause controller, partial Agent output and the navigation stack live where process loss takes them. A fork publishes its inheritance into its own Journal and points at its parent by name. |
| **Revise** | Two vocabulary facts the experiment had to settle and one it had to repair: which records mint markers, that an unfinished scope is `interrupted` rather than a fifth status, and that replay must match a record's *identity* and restore its *result*. All three are below. |
| **Reject** | Nothing. |

## The event vocabulary

Eleven kinds. A record naming anything else is refused, and so is a record
carrying a field its kind does not declare — which is what stops a
continuation, a callback, a renderer handle or a terminal cell being written
into the durable stream and read back as an execution fact.

| kind | fields beyond the envelope | marker |
| --- | --- | --- |
| `entry.submitted` | `entry`, `title` | boundary |
| `entry.inherited` | `entry`, `title`, `parent`, `source` | boundary |
| `entry.settled` | `entry` | terminal |
| `entry.failed` | `entry`, `reason` | terminal |
| `entry.interrupted` | `entry`, `reason` | terminal |
| `scope.opened` | `entry`, `scope`, `name`, `source` | opening |
| `scope.completed` | `entry`, `scope`, `name` | none |
| `suspension.opened` | `entry`, `scope`, `wait`, `prompt`, `secret` | opening |
| `suspension.answered` | `entry`, `scope`, `wait`, `answer` | none |
| `binding.published` | `entry`, `name`, `value` | checkpoint |
| `outcome.recorded` | `entry`, `scope`, `request`, `label` | checkpoint |

The envelope is `id`, `seq`, `at`, `kind`. **A record's marker is its own
opaque `id`; `seq` is append position, which orders replay, names nothing, and
whose gap is how a short stream is recognized.**

Three fields exist because something would otherwise be unprovable:

- **`secret` and `answer`.** Without them a recoverable answer and a redacted
  one are the same record, and "replay re-prompts for a secret" is vacuous.
  The projection refuses a `suspension.answered` carrying a value for a wait
  the Journal opened as secret, so a leak cannot be written and then merely
  left unread.
- **`request` on `outcome.recorded`.** Identity and result must be separate:
  an outcome recognized by its own result could only be recognized by a replay
  that already knew the answer.
- **`source` on `scope.opened`.** Concurrent siblings open in dispatch order
  and the transcript is a reading of the document, so the position has to be
  recorded rather than inferred.

### Marker policy

Every record mints a semantic History marker except the two *closing* kinds.
An entry's end is a place to stand, not a property of the marker before it, so
settlement, failure and interruption are each directly navigable. A scope
completion and a suspension answer update the state the opening already
minted. Weight — boundary, terminal, opening, checkpoint — is a value on the
marker, not a convention.

### Lifecycle

Four statuses: `running`, `settled`, `failed`, `interrupted`. One terminal
record ends an entry and interrupts whatever it still had open; each
still-running descendant scope carries the entry's reason, because the Journal
recorded one ending and not one per scope. A scope that completed earlier
stays completed. There is no `abandoned`.

## The URL schema

There is one REPL URL grammar and this experiment did not write a second one.
`decodeRoute()` and `encodeRoute()` come from #840's router unchanged.

```
xmd://repl/<execution>/<surface>[/<entry>[/<scope>…][/+<drawer>…]][?at=&inspect&draft=]
```

Surfaces are `sessions`, `transcript`, `bindings`, `input`, `history`.
Decoding is structural and encoding is canonical: equivalent spellings decode
to one route, and one route has one spelling. What is refused is a URL that is
malformed or names two locations at once.

**Only resolution was adapted, and adapted in a module of its own.** #840
resolves against a model holding every checkpoint of the execution; that table
is exactly the accelerator #842 must not depend on, so resolution here projects
the prefix the URL named and answers against that one model. `repl-compose` is
untouched and its four suites are green.

The grammar named every state the experiment needed. No product decision about
the URL was required.

## The hydration boundary

```
records ──parse──▶ events ──project(prefix)──▶ model ──resolveIn(route)──▶ location
   │                                             │
   └──────────────── URL ────────────────────────┘                    ▼
                                                              StarFX store
```

The StarFX store — `starfx@0.16.1`, real, running unchanged on Deno, Node and
Bun — holds `execution`, `url`, `records`, `model`, `history`, `location` and
`snapshots`, plus the `cache` and `loaders` slices its schema requires and
this REPL never writes. It takes the caller's Effection scope through
`useScope()`, so its lifetime is the session's. Every transition re-derives
from the records and the URL rather than patching: a patch would be a second
way to arrive at a state, and the claim is that there is one.

**Outside the store, and unreconstructable:**

| state | where it lives |
| --- | --- |
| the pause controller, and whether Continue is offered | `overlay.ts` |
| partial Agent output, and the secret seam | `ephemeral.ts` |
| the ordinary navigation history | a private field on the session |
| marker snapshots | the store, but see below |
| the viewport, and everything drawn | `layout.ts`, computed from a model |

None of `journal.ts`, `model.ts`, `project.ts`, `purity.ts`, `location.ts` or
`store.ts` imports `overlay.ts` or `ephemeral.ts`, and the evidence reads their
imports to say so.

## The snapshot policy

**Snapshots accelerate and never testify.** Only a *marker* prefix is
memoized, because a prefix that ends at a record can never change. The live
head is never memoized: it is exactly the prefix that grows. A new store
starts with an empty cache and cannot be handed a populated one, so a snapshot
cannot outlive the process that derived it — which is the only reason reading
one is safe at all.

Discarding every memoized marker and navigating the same tour again produces
deeply equal semantic state at every step.

## The replay frontier

A live run and a replay are one function. `resume()` walks the document's steps
beside the Journal in append order and each step either *consumes* the records
it already produced or *performs* itself for the first time. Where it stops is
the frontier: the first elicitation with no answer recorded.

Three rules make that sound, and each was found by a defect:

1. **Alignment happens first and completely.** The prior Journal is parsed,
   projected and walked against the whole script before a single effect runs,
   so a divergence performs nothing, appends nothing and leaves the supplied
   Journal untouched. A retained record left unclaimed once the document has
   finished is a divergence too.
2. **A record is consumed only when it is that step's own.** Every replayable
   occurrence has an identity — operation, owning entry, owning scope, durable
   occurrence name. Matching on the record kind alone let one document's
   records stand in for another's.
3. **A matched operation returns its recorded result.** Producing steps name
   what they put into execution state; consuming steps derive from it; the
   live performer's value and the matched record's are written to the same
   place. An entry in `consumed` or `recovered` is an audit line, not a
   restoration — and a script that keeps its own copy of a result it did not
   compute hides the difference.

Restart is not Continue. Continue resolves a suspended routine in a process
that still exists (#841); replay rebuilds a position from what was written
down. Cold hydration offers a frontier, never Continue, and never claims
EXPANSION PAUSED.

**Secrets.** An ordinary answer is in the record, so replay recovers it and
asks nobody. A secret answer is not in the record and never was, so replay
knows only that it was asked — and asks again. With nobody to ask, that is a
frontier of its own.

## Forks

A fork owns a new Journal whose first record is `entry.inherited`: it submits
an entry, publishes the environment the parent had at the source marker into
*this* Journal, and names the parent and that marker. Nothing points outward
for a value.

```
with the parent    : resolvable xmd://repl/e1/transcript?at=r-07
without the parent : unavailable (e1@r-07)
hydrates unaided   : e1-fork
```

Removing the parent costs the link and nothing else. The fork still
reconstructs, still says where it came from, and merely has nowhere to send
someone who follows it. Resolving provenance is a separate function over
whatever journals the process can reach, never part of hydration — a hydration
that insisted on a resolvable link would have made the parent a dependency.

## Refusals

Every layer that reads untrusted input refuses rather than answering
partially: the record parser (malformed, truncated, repeated identity, foreign
field, unknown kind), the projection (overlapping entries, impossible scope
closure, malformed ownership, two siblings at one source, a recorded secret),
the URL codec (thirteen malformed spellings), the resolver (execution, marker,
entry, scope, drawer) and hydration itself, which builds no half-session and
leaves a live session's state intact when a move is refused.

## Named negative controls

Twenty-seven, each a weaker implementation written in the evidence that accepts
what the real boundary refuses.

`open-vocabulary` · `skip-malformed` · `leaky-prefix` · `pause-truncates-head`
· `append-order-siblings` · `decorated-model` · `snapshot-dependent` ·
`permissive-ownership` · `permissive-closure` · `restore-abandoned` ·
`omit-terminal-kinds` · `closing-marker` · `interrupt-completed-scope` ·
`persisted-snapshots` · `head-memoized` · `layout-in-the-store` ·
`overlay-in-the-store` · `replay-reperforms` · `recoverable-secret` ·
`streamed-into-the-record` · `draft-as-a-visit` · `kind-only-replay` ·
`discarded-result` · `parent-backed-fork` · `provenance-at-hydration` ·
`plausible-partial` · `marker-without-a-record`

## Evidence

```bash
deno task repl:hydration                                        # the observable trace
deno task test scripts/tests/repl-hydration-projection.test.ts  # vocabulary, projection, location
deno task test scripts/tests/repl-hydration-store.test.ts       # the StarFX store
deno task test scripts/tests/repl-hydration-replay.test.ts      # restart, drafts, Agent, secrets
deno task test scripts/tests/repl-hydration-fork.test.ts        # forks and the refusal matrix
```

Green on Deno, Node and Bun.

## What this evidence does not cover

- **No real XMD execution.** Slice 1's Journal is a hand-authored fixture and
  the replay document is a script of steps. #841 proved pause against a real
  execution; this proved reconstruction against records, and the two have not
  been run together.
- **No model provider**, by #842's own instruction. The Agent is a deterministic
  fixture that streams three chunks and admits one result.
- **Admission is producer-owned and unprovable from a record.** A partial chunk
  written as an `outcome.recorded` under the right request is indistinguishable
  from an admitted result, because both are text under one durable name. The
  guarantee is that `admit()` discards the buffer, not that a reader could
  catch a producer that did not.
- **Presentation is lines of text.** `layout.ts` exists to show the seam is
  real, not to draw well; cells, widths and wrapping are #838's subject.
- **One fork, one parent.** Fork chains, and what a provenance link means two
  generations back, were not exercised.
- **Nothing was measured.** No snapshot was shown to make navigation faster,
  only to be unnecessary.

## Production sequencing

Written afresh from current `main`, in dependency order.

1. **The durable vocabulary and the projector.** The eleven kinds as parsed
   records, the marker policy, the lifecycle, prefix projection, and the
   refusals. Pure, and the cheapest step to get right alone.
2. **Resolution against a prefix.** #840's codec with the adaptation this
   experiment isolated.
3. **The StarFX store**, hydrated from the two, with the snapshot rule as a
   test rather than a comment.
4. **The process-local boundary.** The pause overlay, the Agent stream and the
   navigation stack, each with the import guard that keeps it out of the
   durable path.
5. **Restart replay.** Alignment before execution, identity matching, result
   restoration, and the frontier — in that order, because each of the three
   was a defect found after the one before it looked finished.
6. **Forks**, which need nothing above them but the vocabulary.

Steps 1–3 are the contract. Step 5 is the one that repaid adversarial review
three times, and its evidence must include a downstream data dependency: a
replay whose restored values nothing consumes looks correct however wrong it
is.
