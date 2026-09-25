# Composing the REPL, take two

A bounded architecture experiment for
[#840](https://github.com/taras/executable.md/issues/840), under the REPL quest
[#827](https://github.com/taras/executable.md/issues/827).

The first #840 experiment is reverted. It established individual behaviours but
no cohesive layering: route resolution, view projection, responsive layout,
manual Freedom mounting and host playback each made overlapping topology
decisions, so a working example depended on keeping several representations in
step. None of its code is here, and none of it will be promoted.

This directory is the replacement, built to one layering:

```text
history fixture → ReplModel → (URL + model) → ResolvedLocation
  → keyed component descriptions → one mounted Freedom tree
  → parent-owned layout → pure render walk → terminal renderer
```

**Journal and history are different things here.** *Journal* stays XMD's
existing durable append-only execution mechanism. This experiment implements no
Journal and fixtures none: production Journal access happens above it and is not
represented. What the REPL consumes is *history* — the immutable ordered
execution records read from a Journal — which projects into `ReplModel`.
*History* is also the name of the UI surface that presents that read model, and
a route can name it (`xmd://repl/e1/history/...`); a surface is not a Journal
either.

It is disposable evidence. `scripts/repl-study/` stays beside it as #838/#839
laboratory apparatus — terminal hosting, fixtures, captures and Freedom focus
evidence — and nothing here reuses its router, components, layout or rendering.

## What is here

| File | What it owns |
| --- | --- |
| `history.ts` | the hand-authored history fixtures, and the projection that ends history-record access |
| `model.ts` | `ReplModel` and the frozen values a checkpoint holds |
| `router.ts` | `decodeRoute`, `encodeRoute`, `resolveRoute`, and nothing else |

Evidence: `scripts/tests/repl-compose-router.test.ts`.

## The representative execution

One entry, a nested scope tree, and two live suspensions:

```text
entry-1  "Add a README to the project"
└── document
    ├── plan     (settled — opened `review`, answered it, exited)
    ├── write    (waiting on `project`)
    └── publish  (waiting on `confirm`)
```

`document` runs `write` and `publish` as concurrent branches. `write` opens a
`project` elicitation and waits; `publish` then opens `confirm` on top of it.
Both are unanswered at the head, so the suspension stack at `cp-10` is ordered
`project, confirm` and the top one is the interactive drawer. That is what makes
the location #840 names resolvable:

```text
xmd://repl/e1/transcript/entry-1/document/+project/+confirm?at=cp-10&inspect
```

and what makes closing `+confirm` expose `+project`, its real parent, rather
than an empty screen.

The `plan` scope exists to be a *settled* nested scope. Leaving a scope closes
it rather than erasing it, so a settled scope stays in the tree and a URL can
still name it — which is how bindings a finished scope published stay reachable.

**Entries in a session are sequential**, so the representative execution has
exactly one and the projection refuses to describe two running at once. A second
entry appears only in `SERIAL_HISTORY`, a separate fixture where `entry-1` opens
a `project` wait in its `document` scope, answers it, leaves the scope and
settles — and only *then* is `entry-2` submitted, opening the same kind at the
same path. An entry cannot settle while it is waiting, and cannot settle while
any scope it opened has not exited, so one moment never holds two live scope
trees. `Scope.settled` records that a scope exited; nothing marks one settled to
let an entry finish.

Every name in that fixture is the same; only the owner differs. That is what
suspension ownership has to be proven against: each `Suspension` names the entry
*and* the scope path that own it, a drawer path under `entry-1` indexes
entry-1's own stack, and an answer consumes a wait only when the entry, the
exact scope path and the kind all match. Without the entry in that comparison, a
stale answer for the finished `entry-1` removed `entry-2`'s live wait and left
the head with an empty stack — a moment that never happened, which routing would
then accept or refuse the wrong drawer against.

## Three decisions this slice makes

**The entry is separate from the scopes it owns.** #839 spelled the entry as the
first scope segment. It is a different kind of thing: an entry is something you
submitted, and a scope is something the execution opened while running it.
Separating them is what lets a refusal say `"plan" is not a scope of entry-1`
rather than reporting a scope miss one level from where it happened.

**One location has one spelling, and the encoder is what gives it.** Decoding
answers the structure a URL names rather than the bytes it was written with, so
`?inspect&at=cp-10`, `%65ntry-1` and `?draft=` are equivalent spellings that
decode to the same `Route`; `encodeRoute()` then supplies the one spelling a
location is stored and generated with. Canonicalizing is
`encodeRoute(decodeRoute(url))`, not a rule that turns an equivalent spelling
away — rejecting equivalent input would be public behaviour #840 never settled,
and it buys nothing the encoder does not already guarantee.

What decoding still refuses is a URL that is malformed, or one that names two
locations at once: an unknown query key, a repeated one, a value on the valueless
`inspect`, an empty `at=`, `inspect` without the marker it reconstructs, an empty
path segment (which is what a trailing slash is), an unnamed drawer (`/+`), a
scope written below a drawer, and a drawer written outside any entry. Accepting a
*spelling* is not accepting a *structure*, and the evidence carries a named
control for exactly that.

A URL is untrusted text, and `decodeURIComponent` throws on a lone `%`. Every
percent-decode in the router therefore goes through one guarded helper that
answers `undefined`, and the refusal names the part the text came from —
`execution`, `entry`, `scope`, `drawer`, `at` or `draft`. `decodeRoute()`
promises `Result<Route>`, and a syntax failure leaving as a thrown `URIError`
would be that promise broken.

**A `Route` cannot hold a structure its encoder would change.** `Route` is a
closed union: a `SurfaceRoute` names a region and has no member a scope path
could occupy, and an `EntryRoute` carries the entry that owns its scopes and
drawers. Both are minted by checked constructors — `surfaceRoute()` and
`entryRoute()` return `Result` and refuse an empty execution, entry, scope,
drawer or marker — and a module-local symbol on the type means a hand-written
look-alike is not a `Route` and never reaches `encodeRoute()`. The defect this
closes: a route carrying `scopes: ["document"]` and no entry used to encode to
`xmd://repl/e1/transcript/document`, which decoded back with `document` as the
*entry*. The round trip now holds for every route that can be built.

## `path-to-regexp` was evaluated and is not adopted

#840 permits it "only as a syntactic recognition primitive", and only if the
comparison shows it materially simplifies strict decoding and canonical encoding
without weakening `Result` failures or semantic resolution. It does not, for
four reasons, and it is not a dependency of this repository today — adding one
is an explicit act that moves `deno.lock`.

**The path has two adjacent unbounded runs, not one.** A location is
`/<execution>/<surface>/<entry>/<scope>*/+<drawer>*`. `path-to-regexp`'s
wildcard captures one run of segments as a flat array, so the most it can match
is `/:execution/:surface{/*rest}` — after which `rest` still has to be split on
the `+` sigil and classified into entry, scopes and drawers by hand. That
classification *is* the work; the primitive would contribute the first two
segments.

**Most of the strictness lives in the query string, which it excludes.** Its own
documentation is explicit: *"`path-to-regexp` is intended for ordered data (e.g.
paths, hosts). It can not handle arbitrarily ordered data (e.g. query strings,
URL fragments, JSON, etc)."* The canonical ordering of `at`, `inspect` and
`draft`, the valueless spelling of `inspect`, the refusal of a repeated key and
of an empty `at=`, and `inspect` without a marker are all outside what it sees —
as is the equivalence that lets those same keys arrive in any order.

**`compile()` cannot produce the canonical encoding.** It encodes each parameter
with `encodeURIComponent`, which turns the `+` that marks a drawer into `%2B`
and destroys the one distinction the path grammar carries. Passing
`encode: false` moves the encoding back here, which is where it already is.

**Its failures are not `Result` failures.** `match()` answers `false`, which
carries no segment and no explanation, and `compile()` throws on a missing
parameter. #840 requires a failure that names the first unresolved segment and
says what exists there, returned through Effection's `Result`. Both would have
to be wrapped, and the wrapper is longer than the matching it replaces.

Revolution's `route()` is still the model for the *control flow* — request in,
result out, no ambient navigation state, rendering kept on the other side of the
boundary. What is not carried over is its choice of matcher, because its paths
are fixed patterns over one kind of segment and a REPL location is not.
