# Scroll a mounted reading

Read this when adding wheel input to a CLI reading or changing drawer Content.
This private API applies to REPL presentation in the CLI.

The viewport component lets a reading move beneath the pointer while its
composer or focused control keeps keyboard input. It is optimized for presenting
admitted rows inside an already measured window.

The two production invocations in `application.ts` are:

```ts
const viewport = describeNode<ReplAction>({
  key: "viewport:drawer",
  component: VIEWPORT,
  input: { window: DRAWER_WINDOW },
  children: viewportRows.map((one) => one.description),
});
```

```ts
composed.push(describeNode<ReplAction>({
  key: "viewport:sidekick",
  component: VIEWPORT,
  input: { window: SIDEKICK_WINDOW },
  children: chatRows.map((one) => editorDescription(one.description, context)),
}));
```

Pair that description key with its measured viewport slot:

```ts
viewports.push(Object.freeze({
  id,
  region,
  window: SIDEKICK_WINDOW,
  owner: "viewport:sidekick",
}));
```

The committed pass resolves `owner` through the mounted tree. The renderer copies
its integer bounds into `scrolls` in draw order. `scrollAt()` covers the entire
half-open rectangle, including blank cells; `at()` still names only activation
targets. `resolveWheel()` carries the presented tree revision. The program
checks current terminal dimensions before resolving coordinates, and the tree
rejects stale, removed and modal-covered owners. The owner is nonfocusable and
ends with its branch. Measurement mounts nothing.

`VIEWPORT` emits `viewport-wheel`. The root reads the current focus through its
view and computes the control's fitted extent in admission. A tick requests
three displayed rows, limited by content bounds and that extent. A no-op leaves
following and explicit reveal intact. Drawer Content also receives PageUp and
PageDown left by descendants; those use the existing `reading-key` reduction,
move capacity minus one row and allow Freedom's survivor recovery. Fields keep
arrows and Home/End. Reading anchors keep their own six keys.

A focused reading anchor keeps its keyed description under the viewport when
wheel admission reaches a page containing only controls. With no admitted text
line to carry it, its label is empty and candidate assembly gives it no box.
It reserves no row or activation target and retains no off-screen source row.
When text becomes visible again, the same node carries the first admitted line.
Only the existing focused anchor is retained this way; opening a control-only
form still enters its editable value. Keep this rowless-owner case when changing
`anchored()` or candidate assembly.

This removes window buttons, their activation data, focus placements, guidance
and layout reservations for chat and shared drawers. It adds one component,
one physical input member, one semantic action, an optional focused extent in
admission and a separate copied geometry collection. Consumers do not create
clickable prose, move focus to scroll, decode terminal bytes or keep a second
focus store. The ordered input sequence preserves mixed wheel, key, text and
click delivery; the scanner's key/text and pointer projections remain for
existing decoder consumers.

Retained binding values and recorded schema/answers keep their existing pretty
JSON representation, including escaped newlines inside strings. Preparation
passes `retainedDetailsOf(view)` to the existing `fitPlain` at the measured
drawer width before admission:

```ts
const detailLines = widths.drawer < 1 ? [] : retainedDetailsOf(view);
const details = detailLines.length === 0
  ? Ok(undefined)
  : yield* fitPlain(renderer, view.size, detailLines, widths.drawer);
```

The fitted collection travels as `details` in both `admissionFor` and
`ReplPresentationContext`. The shared `detailRows` builder uses the same pieces
for display, row counts and offset/reveal decisions. Logical JSON lines keep
their token runs across wrapped rows; the schema keeps its subordinate style.
Only the presented retained drawer supplies detail lines, so ordinary composer
typing does not prepare an inactive retained value. This adds one context input
and two private detail helpers beside the pure line selector; no additional
fitter, lifecycle owner, cache service or persistent representation is needed.
When adding retained detail content, include its logical lines in
`retainedDetailsOf` and use the fitted collection in its drawer builder.

Necessary retained work: each reading still owns its offset and semantic
reduction; composition must identify admitted descendants and keep fixed
headings, composers and actions outside. Fitting, modal ownership, explicit turn
reveal and per-chat following remain with their existing owners. Geometry-only
slots may omit `owner`; an active scrolling consumer supplies one.

Maintenance: add a description and slot association together when adding a
reading. Extend its root reduction and focused-candidate lookup together. A
content change belongs in its row builder; a geometry change belongs in its
manifest. Neither requires a decoder or renderer change. No queue owner is
installed by this API.

The behavioral consumers are `repl-wheel-scroll.test.ts`: Sidekick at 160x36
and 120x30, and an entry question at 120x30 and 72x20 whose first editable enum
window contains only controls. They send real terminal sequences through
`ReplPage.wheel(direction, cell)` and read the existing emulator. Input/frame
checks live in `repl-wheel-input.test.ts` and `repl-wheel-frame.test.ts`.
The latter also follows the actual focused drawer anchor node through a long
preview into an all-control enum page using the production pipeline.
`repl-wheel-scroll.test.ts` also retains a real multiline string through Let,
entry selection and Bindings, then reads both ends with wheel/Home/End and
reopens at its held position. The displayed value remains JSON.

Run the foundation evidence with:

```sh
deno task test packages/cli/tests/repl-wheel-input.test.ts packages/cli/tests/repl-wheel-frame.test.ts packages/cli/tests/repl-wheel-scroll.test.ts
```
