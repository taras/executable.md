# What the replacement experiment found

[#840](https://github.com/taras/executable.md/issues/840), under the REPL quest
[#827](https://github.com/taras/executable.md/issues/827). This is the
conclusion: what to keep, what to change, what to drop, and in what order to
build it. None of the code under `scripts/repl-compose/` is a starting point —
production begins from current `main`, written afresh.

The question was whether one small routing and component model can carry the
REPL. It can. The layering held from a URL to bytes without anything needing to
be kept in step with anything else, and every defect the reviews found was a
*boundary* defect — a value reachable where it should not have been — rather
than a layering one.

## Retain

**The URL is the location, and the router is three pure functions.**
`decodeRoute`, `encodeRoute` and `resolveRoute` own no current route, no
history, no subscription and no callback. Asking where you are means handing the
router a URL again. That is what made the same question answerable of two
different models without either input moving, and it is why a refusal could be
rendered as a whole screen rather than a banner: there was no retained "current
route" to be half-updated.

**History-record access ends at `ReplModel`.** Routing, composition, layout and
rendering never saw a record. The projection is the only module that reads one,
and the evidence holds the router to importing `effection` and the model's types
and nothing else.

**A resolved location holds the model's own values.** Not a copy, not a second
projection — the identity checks (`toBe`, not `toEqual`) are what stopped a
display-shaped duplicate growing between the model and the screen, which is the
failure the first experiment had.

**Keyed descriptions reconciled into Freedom, with Freedom the only mounted
tree.** A parent declares its direct children and their immutable inputs;
reconciliation mounts them and nothing else. Every question — what is drawn,
what can be focused, where a key goes, who wants frames — is a walk of those
same nodes. The three negative controls (positional matching, a hidden-but-live
drawer, a parallel registry) each *pass* the check the real design fails them
on, which is what makes the checks checks.

**Structural teardown.** A drawer stack is a branch, so closing the top removes
one subtree and closing the bottom removes both — and what goes with it goes
because its Effection scope is gone, not because anything was notified. This is
the single strongest result of the experiment: the properties #840 asks for
("no focus target, input path, frame demand or presentation") are not
maintained, they are unavailable.

**Acknowledged delivery.** `advance(timestamp)` completes once every subscriber
has applied that frame, and a retained branch's new input completes once the
branch has taken it. Asking for the next value *is* the acknowledgement, so
there is no `ack()` to forget. This replaced a `sleep(0)` barrier that was a
guess at how long a receiver needed.

**Layout as presentation only.** The viewport reaches components through their
input and decides how a parent arranges what its children drew. The same
location describes the same tree at every width — proven by composing once at
each viewport and comparing topology and focus order.

**Normalizing input at the host.** A keypress and a pointer become one value
before anything is dispatched, so a control cannot tell them apart and
"equivalent activations emit the same action" is not a property anything has to
maintain.

## Revise

**`Description` had to become opaque.** It first carried `input: unknown`
beside closures over the input it was made with, so a spread could replace the
payload and leave one mounted component acting on two inputs. The fix — capture
the input in closures, make the description a class with a private field, and
give each component its own `NodeDataKey<Handoff<Input>>` — is what production
should start from. Do not ship a description with a reachable input.

**Key uniqueness needs a preflight, not a check while mounting.** Two siblings
under one key produce a tree that cannot be addressed: the reconciler finds
children by key, so the second shadows the first, and the first is never matched
again and never removed. The whole description tree is checked before anything
is created, so a refusal changes nothing.

**Entries and scopes are different kinds of thing.** #839 spelled the entry as
the first scope segment. Separating them is what lets a refusal say `"plan" is
not a scope of entry-1` rather than reporting a miss one level from where it
happened.

**Decoding should accept equivalent spellings.** Refusing a reordered query or
an over-encoded segment was public behaviour #840 never settled, and it bought
nothing: `encodeRoute()` already gives every persisted and generated location
one spelling. Canonicalizing is `encodeRoute(decodeRoute(url))`.

**Values with state are resources.** A handoff and a clock hold live receivers,
so they are acquired, not constructed, and the scope that asked for them ends
them. A factory made that state belong to whoever held the reference.

**A serial-entry invariant belongs in the projection.** Entries in a session are
sequential, and an entry cannot settle while it waits or while a scope it opened
has not exited. Enforcing it where history becomes the model is what stops a
fixture — or a real journal read — describing two live scope trees at one
moment.

## Discard

**`InputSink.accept(input: unknown)` and the bivariant-method bridge.** It
type-checked and it was wrong. Nothing should cross the typed boundary by
variance.

**`settle()` / `sleep(0)` as a barrier.** A guess, not a barrier.

**A slot-level acknowledgement.** The release has to travel with the value, or a
queued value is acknowledged when it is fetched rather than when it is applied.

**`path-to-regexp`.** Evaluated against #840's own condition and not adopted:
the path has two adjacent unbounded runs rather than one, its documentation
excludes query strings where this grammar's query rules live, `compile()`
percent-encodes the `+` that marks a drawer, and `match()` answers `false`
rather than a `Result` naming a segment. The README records the comparison.

**Crank and Revolution as dependencies.** Both were the right *models* — Crank
for keyed reconciliation and generator-local lifetimes, Revolution for
request-in/result-out matching with no ambient navigation state. Neither is
needed as code, and a Crank runtime would have put a second mounted
component-context tree beside Freedom, which is the duplication this experiment
existed to remove.

## Known limits of this evidence

- **Pointer input is proven at the dispatch boundary, not at a terminal.** Mouse
  reporting is deliberately never enabled, following #838's decision. The claim
  proven is that a pointer and a key produce the same action through the same
  live ancestry; hit-testing a click to a node is not proven and is real work.
- **Presentation is lines of text.** Cells, widths, wrapping and the responsive
  long tail are out of scope here; `render.ts` exists to show the seam is real,
  not to draw well.
- **The session snapshot is a shape, not a store.** StarFX was not added. What
  is proven is that per-surface state kept outside the tree survives a branch
  being unmounted — not any particular store's semantics.
- **No real journal, no XMD execution, no Agent providers, no subtree pause.**

## Production sequencing

Written afresh from current `main`, in dependency order. Each step is
independently reviewable and each one has evidence before the next begins.

1. **`ReplModel` and the history projection.** The immutable model, the
   serial-entry and scope-exit invariants, and the checkpoint snapshot. No
   routing. Evidence: projection refusals and per-checkpoint isolation.
2. **The router.** `decodeRoute`, `encodeRoute`, `resolveRoute` over that model,
   returning `Result`. Evidence: canonical encoding, equivalent-spelling
   decoding, and refusal at the first unresolved segment. This is the step that
   most benefits from being alone — it is pure, and its evidence is cheap.
3. **The handoff primitive.** Acknowledged delivery with per-value release and
   scope-owned state, on its own, before anything depends on it.
4. **The component boundary and reconciler.** Opaque keyed descriptions,
   component-owned typed update channels, duplicate-key preflight, and
   reconciliation into Freedom. Evidence: retention, teardown, and the three
   negative controls.
5. **The frame clock and input normalization**, on the primitive from step 3.
6. **The screen.** `describeScreen` over a resolved location, with the refusal
   as a whole screen and layout as presentation only.
7. **The host and a renderer.** Viewport, frames, raw input, renderer
   replacement — and a source-level control that the host names nothing it
   shows.
8. **The component catalog and the responsive long tail**, which is where the
   #838 study's content belongs, and which this experiment deliberately did not
   rebuild.

Steps 1–4 are the contract. Steps 5–8 are work that gets easier because of them,
and none of them can put a second representation back without deleting a
control that is already written.
