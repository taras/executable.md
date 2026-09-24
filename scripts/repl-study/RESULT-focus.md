# What the routing and focus experiment found

Issue [#839](https://github.com/taras/executable.md/issues/839) asked whether a
REPL can have one coherent location that survives resizing, drawer nesting,
historical inspection and the loss of its in-memory store — and whether focus
can be derived rather than remembered, so that background work never moves
somebody somewhere else.

**Decision: retain the model.** One URL carries location. Freedom's node tree
carries focus, traversal, input targeting and branch lifetime. Between them
they answer all fourteen frames of the Product Owner's approved focus study,
forward and in reverse, at the wide and the narrow profile, and a state built by
a long interaction rebuilds from its URL and a journal alone. Two defects were
found on the way, and both were only findable by driving bytes.

## The two defects, and why the suite could not see them

**A lone Escape never arrived.** `@bomb.sh/tty` buffers a solitary `ESC` — it
cannot yet know whether an escape sequence is following — and returns
`pending: { delay: 25 }` with an empty event list, asking the caller to re-scan
after that delay. #838's reader took `scanned.events` and dropped
`scanned.pending`, so Escape was swallowed until some other key was pressed
behind it. The key was documented in the README, handled in the reducer, and
covered by a test that handed the reducer a synthetic `{ code: "Escape" }` no
terminal had produced.

**A real Shift+Tab never arrived either.** It is `ESC [ Z`, which the decoder
reports as key code `Backtab` with **no** shift flag. The reducer tested
`code === "Tab" && shift`, which is an event only a test had ever constructed.

Both are the same mistake: a keyboard claim checked against invented events.
Everything this slice asserts about Escape and about reverse traversal is
therefore driven as bytes through `input.scan()`, pending flush included, and
two controls — `swallow-pending-escape` and `ignore-backtab` — reproduce the
pre-repair behaviour exactly so the repair cannot regress into a synthetic test
again.

The general lesson is narrow and worth keeping: **a decoder's contract includes
what it does not hand you yet.** A harness that reads only the events out of a
scan has not finished reading the scan.

## What location turned out to be

```text
xmd://repl/<execution>/<surface>[/<scope>]*[/+<drawer>]*[?at=<marker>][&inspect][&draft=<text>]
```

The REPL has exactly three kinds of state, and telling them apart is what made
every acceptance criterion reachable:

1. **Execution truth** belongs to the journal. Which scope is open, what has been
   published, what is waiting for an answer, whether the run is live or paused —
   none of that is location, and none of it is in the URL. This experiment folds
   a hand-authored journal fixture; #842 owns the real one.
2. **Location** is the URL, and nothing else is location.
3. **Everything else is disposable** — the scroll anchor, whether the overlay is
   drawn, which target is focused within a region.

The scrubber's selected marker is **not** in that third group, and putting it
there was this experiment's first real mistake. A selection that lived only in
memory rendered a state its own URL could not reopen: the band showed a marker,
and a cold start came back with none. It is location, so it is in the URL.

Four decisions inside the schema earned their keep:

- **A drawer segment wears `+`.** Drawers are nested routes, and a path is how
  nesting is said; the prefix is what stops `.../project/+project` being
  ambiguous. The suite checks exactly that URL.
- **Pause is not in the URL.** Whether the runtime is live or paused is
  execution truth. A URL that could describe "paused" independently of the
  execution it names would be able to describe pausing a finished run.
- **`at` absent is the live head.** There is no `at=head` sentinel, so two URLs
  cannot render the same screen and hydrate into different states.
- **Selecting a marker and reconstructing it are two parts, not one.** `at` is
  the marker the scrubber has selected; `inspect` says the reconstruction at it
  is open. They are genuinely different states — study frame 11 has a marker
  selected with the run merely paused, and frame 12 has the reconstruction open
  at another — and one field could not tell them apart. `inspect` is valueless
  and refused without `at`, so each state has exactly one spelling.

**Scrubbing replaces and entering inspection pushes**, and that has a visible
consequence the study does not state: Back from an inspected marker returns to
the head, not back through every marker the scrubber passed. Draft editing
replaces for the same reason — both are continuous adjustments rather than
places somebody went. Closing a reconstruction is not the same act as
deselecting a marker, so returning to the head leaves `at` where it was.

**Moving focus across a region boundary is moving the route.** The surface
segment says which region owns focus, so the two cannot be updated in different
transitions — a reducer that changed only focus left the URL describing the
region somebody had already tabbed away from, and at narrow widths would have
gone on rendering one surface full-screen while focus named another. A control
belongs to the surface of the region that owns it, which is why focusing `Pause`
reads as `history` and focusing `Run` reads as `input`.

## What focus turned out to be

**Freedom's node tree owns it.** The tree replaces the DOM in the terminal: a
surface is a node, a scope panel mounted inside it is a branch, a drawer is a
branch pushed as the active focus root, and a control is a leaf. Traversal order
is tree order, computed on demand from the active subtree. There is no registry,
no ordered list, no owner strings and no identifier parsing.

This experiment's first attempt did keep such a registry — a flat
`FocusTarget[]` with hand-written traversal order, a hand-written owner chain
and hand-written restoration. It passed every case written against it, because a
list compared with itself always agrees. What it could not do was answer a
question about where a control actually *is*, and three of this slice's cases
are exactly those questions.

**Input goes to the focused node, and stops where it is consumed.** A key is
invoked on `current(root).scope`, so Effection walks that scope's ancestors and
every branch between the root and the control runs its middleware in order. The
evidence reads the path rather than inferring it:

```text
target  field:drawer.project.name
path    drawer:project → panel:project.body
```

A flat registry has no way to produce that: the path is the tree's.

**A branch that consumes a key ends the dispatch.** `keydown` returns whether it
was handled; middleware that handles one returns `true` without calling `next`,
and the harness's own fallback does not run. An earlier round recorded the path
and then reduced the same event globally regardless — so a drawer could
intercept Escape and watch the drawer close anyway. That is the difference
between a hierarchy that *annotates* a dispatch and one that *governs* it, and
only the second is worth having.

## What identities may and may not be used for

Nodes carry semantic names — `region:transcript`, `control:transport.pause`,
`field:drawer.project.name` — and the line between a legitimate use and a
forbidden one is worth stating exactly, because this experiment crossed it twice
before getting it right.

**Permitted: annotating routing.** The route's surface segment is one of five
names, and a digit key naming the region to jump to, or a frame table declaring
which node it focuses, are addresses. They say *what to look for*; the tree is
what says whether it is there and where.

**Forbidden: deriving ancestry or input targeting.** Which region owns a
control, which branch a key passes through, and what focus falls back to when a
node disappears are all questions about where a node *is*. They are answered by
walking the live tree — `surfaceOwning()` climbs parents, the dispatch path is
Effection's own scope chain — never by parsing a prefix out of a name. An
identity string cannot be wrong about its own spelling but can easily be wrong
about the tree, and a second answer is precisely what this architecture removes.

The earlier `ownerOf()` and `ownerRegion()` helpers, which read ownership out of
the identity, are gone.

**Closing a branch destroys it.** A drawer closes by removing its node; its
controls, its body panel and their middleware go with it through structured
teardown. Afterwards nothing in the tree can be focused, and no dispatch reaches
what used to be there. There is no second list to update, because there is no
second list.

**A drawer is a pushed focus root.** `focusPush()` traps cycling inside the
branch and remembers what to restore; nested drawers nest, and popping restores
first to the outer drawer and finally to the invoking control. The footer is
mounted *inside* the pushed branch deliberately — the study calls it "the one
way out" — which is how #827's "keeps the fixed history footer reachable"
survives a suspension.

**A disabled control is a node that was never made focusable.** It is mounted,
the renderer draws it and the `F1` map numbers it; it simply carries no
`focused` prop, so it cannot enter the chain. That is Freedom's own distinction
rather than one this harness invents, and it is what study frame 12 means by
numbering a dimmed `Continue` and saying Tab skips it.

**The overlay is the tree, walked.** Numbering is assigned as the study assigns
it — regions first, then controls — but the list it numbers is the live tree,
which is why the overlay follows focus into a drawer instead of going on
numbering the panes behind it.

**Focus is not in the application model at all.** `ReplState` has no focus
field. The store decides what an event *means* and names what should happen to
focus; the tree carries it out, because the tree is the thing that knows what
exists. That is the strongest form the "background updates never steal focus"
claim can take: the honest path does not write focus, and the control that
breaks it has to reach past the store into the tree.

The URL still records the **surface**, because the surface segment is what says
which region owns focus — so a focus move that crosses a region boundary is a
move the route makes in the same transition. What the URL never records is the
focus identity.

## Two gaps found in Freedom, and what was done about them

`@bomb.sh/freedom` is private and unpublished, so its source is vendored here
from the public playground repository, pinned and manifested. Two patches are
recorded against it; `vendor/freedom/PROVENANCE.md` has the detail.

1. **A root was parented to Effection `global`.** `createRoot()` alone means
   host context does not reach the tree and a failure in node work raises into
   a boundary nobody observes. `useRoot()` acquires the tree as a resource owned
   by the acquiring scope.
2. **Removal asked about identity, not containment.** `useFocus()`'s middleware
   moved focus to a successor when the *removed node* was the focused one — but
   a drawer or panel is closed by removing the branch *above* the focused
   control, so the common case left focus on a node that had just been
   destroyed while a perfectly good sibling survived.

Two more are this harness's own, and both are the same mistake in miniature —
letting the order things happened to happen in stand in for the order that was
meant.

**A reconciler must add before it removes.** Removing the focused control
before its replacement exists leaves the region with nothing to move focus to,
and focus lands outside it — which is how a resumed run first lost its transport
slot.

**And it must then restore the canonical order.** A replacement is appended
wherever there is room, so a control that changed from enabled to disabled ended
up last. The tree a live interaction arrived at and the tree a cold start
rebuilt from the same URL and journal then disagreed — `Return → Fork →
Continue` against `Continue → Return → Fork` — which breaks the reconstruction
boundary even though every node was present in both. Sorting the region's
children by their canonical index after reconciling settles it, and the evidence
drives frame 11 into inspection, throws the store and the tree away, and rebuilds
to compare the ordered topology.

## Divergences from the study, named rather than hidden

1. **Escape closes the top drawer without answering it.** Study frame 09 gives
   the confirmation drawer `esc declines` — Escape as an *answer*. This
   experiment owns navigation and answers no `Elicit` request; answering is
   #840's and #842's. Escape here is Back, and Back is non-destructive: the
   suspension is still waiting afterwards, which the suite asserts.
2. **"Entered" is being focused within.** The study says `history` exposes its
   controls once the region is entered with Enter. The rule this harness
   implements is that the controls are in the sequence while focus is within the
   region *and an execution has been recorded*. All fourteen frames agree with
   it: frame 03 focuses region 5 and lists no controls because the REPL is
   empty, not because it was not entered. A state with a recorded execution,
   focus in the footer and no controls exposed does not appear in the study, so
   nothing here distinguishes the two readings and the simpler one was taken.
3. **The overlay is a legend, not floating callouts.** The study numbers its
   targets on top of the interface, which a browser can do because it measured
   them. In cells the honest equivalent is a right-anchored legend carrying the
   same numbers in the same order, dimming a target that is visible but
   disabled.
4. **Focus is a glyph, not a colour.** The focused region wears `▌` at its
   top-left and a focused control wears `▸` beside its label — including inside
   the footer's `[▸Continue ]`, where the marker replaces the space inside the
   bracket rather than widening it, because the track's room is computed from
   that string and a focused control that shortened the track would make focus a
   layout decision. The study's own "glyph + word, never colour alone" rule
   applies here too, and a committed `.txt` capture records glyphs.
5. **The harness's own moment keys changed.** #838 used `1`–`6` to switch
   fixture. The moment is now a function of the route and the journal, so the
   digits do what study frame 02 says they do — jump straight to a region — and
   `--frame` and `--route` are how a particular moment is opened.

## What `SURFACES` is, and what it is not

#838 has **four** routing surfaces and the study has **five** focus regions.
These are different things and `layout.ts` was not changed. Narrow routing
promotes one region to a whole screen; the REPL input is never one of those,
because `layout.ts` already renders it inside the transcript. It is still
somewhere focus can be, so it is a route surface and not a layout surface, and
the one line of reconciliation lives in `store.ts`. No #838 golden moved.

## Structural navigation, and where the sibling list comes from

`Ctrl+↑` moves the locus out to the parent scope, `Ctrl+↓` in to the first
child, and `Ctrl+←`/`Ctrl+→` along the siblings, wrapping at both ends. All four
push, because each is a place somebody went, and all four act only outside an
editable target so a modified arrow is never stolen out of a draft.

**The sibling list is derived from the journal, never declared.** Siblings are a
fact about what the execution actually opened, which is why a scope that has not
been entered yet is not one. The fixture journal opens `plan`, `preview` and
`write` inside `document`, in that source order, so the arrows have something
real to walk.

## Ctrl+C, and what counts as active

An entry that is paused, or that is being read through a reconstruction, is
still running. Ctrl+C interrupts it and the REPL stays open; only an idle REPL
clears its draft or leaves. Treating a live transport as the test for "active"
exited from a paused entry instead of interrupting it, which hands that entry's
lifecycle to whoever closed the terminal.

## Scoped limits

- **Three regions expose no controls.** `sessions`, `transcript` and `bindings`
  are declared explicit and none of the fourteen frames gives any of them a
  control, so nothing here says what their controls would be.
- **The journal is a fixture.** Pausing and resuming extend it to the record the
  story already contains rather than recording anything, and no state is durable
  past the process. #842 owns a real journal, journal storage and replay.
- **The six #838 fixtures are the available content.** The route and the journal
  choose which one a moment shows and override its transport, its badge and its
  open drawer, so `--route` and `--frame` genuinely drive the picture. They do
  not synthesise content the fixture set does not have: there is no "paused at
  the live head" transcript distinct from the reconstruction's, and a frame that
  wants three sessions borrows the fixture that has three.
- **The journey is a projector.** While `--play` runs it supplies the moment on
  screen; the store still reduces every keystroke, and the two meet again the
  moment the journey ends.
- **Nothing here answers an `Elicit`, executes XMD or opens an Agent session.**
  Every claim is about navigation.

## What the evidence rests on

Twenty-six controls, each breaking exactly one claim and each rejected by name
by the same oracle that admits the honest run. Four of them exist only because
the tree does: `rebuild-tree-each-sync` destroys focus by rebuilding rather than
reconciling, `keep-closed-branch` closes a drawer without removing it,
`flat-overlay` numbers a list kept beside the interface instead of the tree, and
`focus-hidden-target` makes a disabled control focusable. The two
that matter most are the two that reproduce the decoder defects, because they
are the only reason to believe the byte-driven cases would notice if the repair
were undone.

**Transitions are driven through the real path**, forward and in reverse, from
each of the fourteen frames — the same `drive()` the interactive harness uses,
so a case cannot prove a path the running harness does not take. An earlier
round proved them by constructing each destination from its own URL, which is a
check a reducer that moved focus and left the route behind passes without
trouble — and did.
