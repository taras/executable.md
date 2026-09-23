# What the routing and focus experiment found

Issue [#839](https://github.com/taras/executable.md/issues/839) asked whether a
REPL can have one coherent location that survives resizing, drawer nesting,
historical inspection and the loss of its in-memory store — and whether focus
can be derived rather than remembered, so that background work never moves
somebody somewhere else.

**Decision: retain the model, and adopt three things it settled.** One URL
carries location. One registry, rebuilt every frame, carries focus. Between them
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

Focus is never a coordinate and never an index. It is a semantic identity —
`region:transcript`, `control:transport.pause`, `field:drawer.project.name` — and
every frame a registry is derived from the route, the journal and the layout.
Asking where focus is means resolving one identity against the registry that
exists *now*.

That single mechanism answers two of the issue's criteria at once. A background
update cannot steal focus, because nothing writes focus when one arrives — the
suite asserts **reference** equality of the route, the focus, the selection and
the anchor across a background event, since a reducer that rebuilt an equal
route would pass a deep comparison having already lost the property. And a route
transition restores a stable identity or the nearest surviving owner, because a
vanished identity is resolved by walking its owner chain rather than by anybody
remembering to move anything.

Four things the fourteen frames settled:

- **Two lists, not one.** The **registry** is visible ∧ enabled and is what Tab
  walks. The **map** is visible whether enabled or not and is what the overlay
  numbers. Frame 12 numbers a dimmed `Continue` as target 6 and says Tab skips
  it, so a disabled control is in one list and never in the other. Conflating
  them is the trap, and `focus-hidden-target` is the control that does.
- **Traversal order is not numbering order.** The ring is the five regions with
  each region's own controls inlined immediately after it; numbering assigns 1–5
  to the regions and 6 upward to the controls. Frames 05, 11 and 14 only agree
  with each other under that reading — frame 14 numbers `Run` as 6 and traverses
  it *before* region 5, because `Run` belongs to the input.
- **Ownership is read from the identity.** Resolution has to answer "who owns
  this?" for a target that is already gone, so it cannot be a lookup in the
  registry that no longer contains it. The naming scheme is the ownership.
- **A transport control declares a counterpart.** Frame 13 requires that leaving
  history with `Continue` focused lands on `Pause`, so a declared counterpart is
  preferred over the owner walk. Nothing else needed one.

**The drawer's trap is the drawer's controls and the Execution History region,
and nothing else.** The footer is inside the trap deliberately — the study calls
it "the one way out" — which is how #827's "keeps the fixed history footer
reachable" survives a suspension. Opening a drawer records the identity that
invoked it; closing it restores that identity through the same resolution walk,
so a drawer whose invoking scope no longer exists falls back rather than
dangling.

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

Twenty-three controls, thirteen of them new, each breaking exactly one claim and
each rejected by name by the same oracle that admits the honest run. The two
that matter most are the two that reproduce the decoder defects, because they
are the only reason to believe the byte-driven cases would notice if the repair
were undone.

**Transitions are driven through the reducer**, forward and in reverse, from
each of the fourteen frames. An earlier round proved them only by constructing
each destination from its own URL, which is a check a reducer that moved focus
and left the route behind passes without trouble — and did.
