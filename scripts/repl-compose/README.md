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
| `component.ts` | what a parent says its children are: keyed descriptions over immutable input |
| `reconcile.ts` | descriptions in, one mounted Freedom tree out — and the walks that read it |
| `handoff.ts` | deliver a value to every live receiver, and know when they have applied it |
| `frames.ts` | the host's clock, and the demand the mounted branches place on it |
| `input.ts` | a key down the live ancestry, a typed action back up |
| `shell.ts` | the small set of components the reconciliation evidence drives |
| `screen.ts` | a resolved location, described as an interface — and the refusal when it is not one |
| `render.ts` | cells, and nothing else: two renderers, so the seam is a seam |
| `host.ts` | the terminal, the viewport, the frames, the raw input — and none of their names |
| `trace.ts` | one location followed through every layer |
| `main.ts` | the documented command |

Evidence: `scripts/tests/repl-compose-router.test.ts`,
`scripts/tests/repl-compose-reconcile.test.ts`,
`scripts/tests/repl-compose-screen.test.ts` and
`scripts/tests/repl-compose-command.test.ts`.

Conclusions — what to retain, revise and discard, and the production
sequencing — are in [`RESULT.md`](RESULT.md).

## Run it

```bash
deno task repl:compose --journey          # the representative journey, unattended
deno task repl:compose --journey --narrow # the same tree, laid out for less width
deno task repl:compose --trace '<url>'    # one location, through every layer
```

The journey opens a drawer, stacks another on it, closes the top one, and then
asks for a location the execution never went to. Nothing needs pressing, and no
terminal is attached: the host measures its viewport from a flag rather than a
device, which is the whole point of it being the host.

`--trace` prints the seven things #840 asks for — the decoded route, the model
identities it resolved to, the keyed description, the mounted tree and its focus
chain, where an activation went and what it meant, what a closing branch took
with it, and the output drawn from that same tree. Every line is read from the
one place that answers it, so a wrong line means a wrong thing rather than a
stale report.

## One mounted tree, and nothing beside it

A parent declares its direct children as keyed descriptions over immutable
input. It does not reach into a registry, ask what is mounted, or hand a child a
way to register itself — so the tree is decided before anything exists.
Reconciliation is then the only thing that mounts anything, and Freedom is the
only thing it mounts into.

Matching is by key, the way Crank matches keyed children. A description whose
key *and component* both match the node already there keeps that node, and with
it the node's Effection scope and everything the branch's lifecycle holds inside
it. A key that stops being described is removed with its whole subtree, and the
removal is awaited rather than started.

That is what makes teardown structural rather than remembered. A drawer stack is
described as a branch — the second drawer is a child of the first — so closing
the top one removes exactly one subtree. What goes with it goes because its
scope is gone: its frame subscription, its input middleware, its focus target
and its presentation. Nothing is notified, and there is nothing to keep in step.

Every question about the interface is answered by walking those same nodes:
`paint` for what is drawn, `focusTargets` for what can be focused, `press` for
where a key goes, and the clock's own `demand` for who is asking for frames.

**A key names one child.** Uniqueness among a parent's direct children is
checked over the whole description tree before a single node is created,
removed or updated, so a refusal leaves the mounted tree exactly as it was. Two
branches under one key is a tree that cannot be addressed: the reconciler finds
children by key, so the second shadows the first, and the first is then never
matched for an update and never counted as undescribed for removal — mounted for
as long as its parent lives.

**A retained branch is told what changed rather than rebuilt.** Its new input
travels the same direct parent-child boundary the first one did — nothing
ambient, nothing looked up, nothing polled — and the delivery completes only
once the branch has taken it. So when a reconcile returns, every branch it kept
is acting on the input it was just given. Presentation, children and `onPress`
read that same current input.

**One description carries one input.** A description does not hold its input
where anything can reach it: everything the input decides is a closure over one
captured value, made in one call, and a description is a class with a private
field, so nothing assembled from its parts is one. An earlier version exposed
`input: unknown` beside those closures and delivered through a sink whose
parameter was `unknown`. A spread could then replace the payload while the
closures kept the original — `{ ...describe(Probe, "probe", 2), input: 3 }`
type-checked and mounted a component whose lifecycle acted on 3 while it drew 2.
Matching the component identity did not catch it, because identity only says who
made the *original* description.

The typed channel that replaces it needs no cast, no bivariance and no table: a
component carries its own `NodeDataKey<Handoff<Input>>`, minted when the
component is built with `component()`, and a branch keeps its update channel on
its own node under that key. Reading it back is
`node.data.get(component.updates)`, which the compiler already knows is a
`Handoff<Input>`. The reconciler holds no input of its own and could not
substitute one.

**Delivery completes; it does not merely send.** One primitive in `handoff.ts`
carries both frames and input: `deliver()` finishes once every receiver that was
live when it started has come back for the next value, which is the moment it
has finished applying this one. Asking for the next value *is* the
acknowledgement, so there is no `ack()` to forget and a slow receiver holds the
producer rather than being overtaken. When `advance(timestamp)` returns, a
render walk sees that frame. Nothing sleeps to find out.

A receiver that goes away mid-delivery does not strand the producer: its slot is
removed and whatever was outstanding on it released in the same synchronous
teardown, so closing a drawer while a frame is in flight leaves the other
receivers to finish it and the clock to return.

**A value with state is acquired, not constructed.** A handoff holds the set of
live receivers and what each of them still owes, and a clock holds a handoff, so
both are resources: `useHandoff()` and `useFrameClock()`, owned by the scope that
asked for them and ended by it. A branch's update channel is acquired inside the
branch's own lifecycle, so it belongs to that branch's scope and goes when the
branch does. A factory would have made that state belong to whoever happened to
hold the reference — which is how a set of receivers outlives the thing they were
receiving from and goes on being counted.

The exception is a component's `NodeDataKey`. It is immutable metadata an author
declares at module evaluation about a value they own, which is what
`component()` mints and carries — not state, and nothing to tear down.

**The URL reconstructs focus.** Every surface a route can name is a
focus-owning branch, and a description says whether its input makes it the
branch the location is asking for. The innermost claim wins, which is how an
opening drawer takes focus from the surface underneath it and closing it gives
focus back — without the host, the renderer or the reconciler knowing what a
drawer or a surface is. Focus moves only when nothing holds it or when whatever
held it is no longer inside the branch being asked for, so an ordinary reconcile
does not take focus away from whoever was using it.

**A pointer names what it was on.** The target survives normalization as an
opaque node identity, and the host resolves it against the live tree: a
focusable target takes focus and is then dispatched to exactly as a keypress
there would have been, and a removed, container, never-focusable or absent one
takes no focus and receives no input. Only the top drawer is interactive, so the
controls beneath it are a different component that was never made focusable —
which is what makes "disabled" an absence rather than a flag.

**Delivery addresses a position in the tree, never a retained reference.**
Removing a node detaches it from its parent but leaves the node object, and a
disposed Effection scope still carries the interceptors installed on it — so a
kept reference to a closed drawer's control would otherwise still run that
drawer's middleware and answer with an action.

**A component declares every member except `onPress`.** A member is optional
when its absence is the neutral element of a composition and required when its
absence would substitute a claim. Absent `onPress` means the component says
nothing about a key, so it carries on to the branch that does understand it —
which is what would have happened anyway. Absent `children` would instead be the
reconciler deciding the component has no subtree, and a `children` misspelled or
lost in a merge would mount a tree missing a branch with nothing to report.
`lifecycle` is written `null` rather than left out, because whether a branch
holds anything disposable decides whether a task is started for it at all.

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
