/**
 * What the screen is made of, as constraints the terminal engine places.
 *
 * Presentation and nothing else. Layout states the product's geometry — which
 * profile a size gets, which regions a profile mounts, how wide a column is,
 * how far in the drawer sits, how many rows the footer keeps — and hands the
 * engine a tree of boxes expressing it. It computes no cell coordinate and no
 * capacity: where a box lands and how many rows a viewport holds are answers
 * the engine gives, which is why the same question cannot be asked twice and
 * answered differently.
 *
 * ## Four profiles, and a refusal
 *
 * `160x36` is wide, `120x30` is medium, `72x20` is narrow, and anything smaller
 * than narrow is a refusal rather than a squeezed layout. The refusal is
 * explicit and recovers on resize: nothing is torn down, and no control it hides
 * can be activated while it is showing.
 *
 * Wide and medium carry the sidebar, the transcript, the bindings/history
 * inspection column, the drawer layer and the fixed full-width footer. Narrow
 * keeps the drawer and the footer and gives the rest of the screen to one routed
 * content surface. The History band is five rows at every size.
 *
 * ## One box tree, two passes
 *
 * A box carries a stable structural id and, where a described node backs it, the
 * description key whose live node the committed frame draws it under. The
 * measurement pass draws the tree under structural ids with every scrolling
 * viewport empty, so it mounts nothing and publishes nothing; the committed pass
 * draws the admitted tree under live node ids. Both come from one builder, so a
 * measured region and the region drawn into it cannot disagree.
 *
 * Geometry is integer. `percent`, `alignX` and `alignY` place at half-cell
 * precision, and a bound naming a row that is not a row is a target a person
 * cannot hit — so every size and inset here is stated as whole cells.
 */

import { close, fixed, fit, grow, open, text } from "@bomb.sh/tty";
import type { Op, OpenElement, SizingAxis } from "@bomb.sh/tty";
import { runText } from "./description.ts";
import type { ReplTokenRun } from "./description.ts";
import {
  REPL_PALETTE,
  runStyleOf,
  surfaceOf,
  terminalColour,
  textStyleOf,
} from "./presentation-style.ts";
import type { ReplRowStyle } from "./presentation-style.ts";
import type { ReplTerminalSize } from "./terminal.ts";

/** Which layout one size gets. */
export type ReplProfile = "wide" | "medium" | "narrow" | "too-small";

/** The named areas a frame can have. */
export type ReplRegion =
  | "sidebar"
  | "transcript"
  | "inspection"
  | "content"
  | "drawer"
  | "footer"
  | "refusal";

/** Integer cell geometry. */
export interface ReplBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The engine props one box is opened with. */
export type ReplBoxProps = Omit<OpenElement, "directive" | "id">;

/**
 * One box of the op tree, paired with whatever description mounts it.
 *
 * `id` is structural and exists before any node does, which is what the
 * measurement pass draws it under. `key` is the description key whose live node
 * the committed pass draws it under; a box with none is a container the engine
 * needs and the tree has never heard of, and it is drawn under its structural id
 * in both passes.
 *
 * `text` is the exact string measurement uses. A control's label is on the box as
 * well as in its description input, because how wide `fit()` makes it has to be
 * answerable before the node that renders it exists.
 */
export interface ReplBox {
  readonly id: string;
  readonly key: string | undefined;
  readonly region: ReplRegion | undefined;
  readonly props: ReplBoxProps;
  readonly text: string | undefined;
  /** Whether activating it means something. Decided by what it is. */
  readonly control: boolean;
  /**
   * What this row means, for the cells it is drawn in, or none for a container.
   *
   * Carried rather than derived: the facts that decide it are the application's
   * and exist before any node does, which is also why the measurement pass can
   * draw the same decoration the committed pass will. A box with none is
   * structure, and structure takes the surface of whatever it is inside.
   */
  readonly style: ReplRowStyle | undefined;
  /**
   * The stretches this row's text is made of, where its characters mean
   * different things, or none where the whole row reads as one thing.
   *
   * They apply only when they spell exactly the text being drawn. A row whose
   * mounted node contributed something else is drawn as one stretch under the
   * row's own role, because runs that said something about other characters
   * would be colouring text they were never built for.
   */
  readonly runs: readonly ReplTokenRun[] | undefined;
  readonly children: readonly ReplBox[];
}

/** One scrolling viewport, and the reading whose offset moves inside it. */
export interface ReplViewportSlot {
  /** The clipped box the engine measures. */
  readonly id: string;
  readonly region: ReplRegion;
  /**
   * Which window moves inside this viewport.
   *
   * Named, so the capacity the engine measured here and the offset the
   * application is holding are joined by something other than the order two
   * lists happen to be in.
   */
  readonly window: string;
}

/** One thing the action row was offered, and whether it can be activated. */
export interface ReplActionCandidate {
  readonly key: string;
  readonly id: string;
  /**
   * Whether this is a control.
   *
   * A control the row cannot hold whole is left out: half a control is
   * something a person can see and cannot reliably hit. An explanatory sentence
   * is not a control, so the row may shorten it instead — losing the end of a
   * reason is better than losing the reason.
   */
  readonly control: boolean;
}

/** The action row, and what was offered to it in priority order. */
export interface ReplActionSlot {
  readonly id: string;
  readonly controls: readonly ReplActionCandidate[];
}

/**
 * What one reading wants on screen, before anything measures it.
 *
 * Inert: identities, row order, control kind and the exact measurement text. No
 * focus store, no mounted node, no authority and no durable record — those
 * belong to the tree this is paired with, and a manifest that carried them would
 * be a second place to ask what is focused.
 */
export interface ReplLayoutManifest {
  readonly profile: ReplProfile;
  readonly size: ReplTerminalSize;
  readonly root: ReplBox;
  readonly viewports: readonly ReplViewportSlot[];
  readonly actions: ReplActionSlot | undefined;
  readonly regions: readonly { readonly region: ReplRegion; readonly id: string }[];
  /**
   * The border-free inside of each bordered pane, for the rows that go in it.
   *
   * A pane's own edges are part of the pane and not part of the room inside it,
   * so a row written to the outer bound would be two columns too wide — and a
   * row too wide for its column widens that column and publishes a hit box
   * reaching into the next one. Separate from `regions`, which keeps answering
   * for the pane itself: where a pane landed and how much room it has inside are
   * two different questions.
   */
  readonly contents: readonly { readonly region: ReplRegion; readonly id: string }[];
  /** The History band, which comes from the model rather than from a node. */
  readonly history: ReplHistoryBand;
}

/** The narrow profile's size, which is also the minimum this REPL draws at. */
export const NARROW: ReplTerminalSize = { columns: 72, rows: 20 };
const MEDIUM: ReplTerminalSize = { columns: 120, rows: 30 };
const WIDE: ReplTerminalSize = { columns: 160, rows: 36 };

/**
 * The footer is one contextual status and action row, five History rows and the
 * draft.
 *
 * Fixed in that order at every size. The draft is last because it is the thing a
 * person is looking at while they type, and the action row is first because what
 * it offers changes while the two rows around it do not.
 */
export const FOOTER_ROWS = 7;
/** The History band's own five rows. */
export const HISTORY_ROWS = 5;

/** How wide a column is at each profile that has one. */
interface ColumnWidths {
  readonly wide: number;
  readonly medium: number;
}

const SIDEBAR: ColumnWidths = { wide: 32, medium: 28 };
const INSPECTION: ColumnWidths = { wide: 36, medium: 28 };

/**
 * How far the drawer sits in from the body it covers, as a share of it.
 *
 * An eighth on each axis, which is what makes the rectangle integer at every
 * supported size: wide `(20,3,120,23)`, medium `(15,2,90,19)` and narrow
 * `(9,1,54,11)`. Stated as one formula rather than three rectangles so a size
 * between them cannot fall through, and read back through `drawerRect()` so
 * nothing recomputes it.
 */
const DRAWER_SHARE = 8;

/**
 * The colour a drawer paints its whole rectangle with.
 *
 * Required for coverage rather than offered as style: a floating element without
 * a background lets what it covers show through from wherever its own text
 * stops, so the blank half of a short modal line would still be the transcript
 * underneath it.
 */
const DRAWER_BACKGROUND = terminalColour(REPL_PALETTE.drawerSurface);

/**
 * How far in from each side of its rectangle a drawer's rows start.
 *
 * One cell. The reference this screen follows separates a drawer's content from
 * its own edge with pixels, and a cell is the terminal's smallest version of
 * that — enough to tell a title from the text it is in front of, and not enough
 * to cost the content a column it needed.
 */
const DRAWER_INSET = 1;

/** Which profile a size gets. */
export function profileFor(size: ReplTerminalSize): ReplProfile {
  if (size.columns < NARROW.columns || size.rows < NARROW.rows) {
    return "too-small";
  }
  if (size.columns >= WIDE.columns && size.rows >= WIDE.rows) {
    return "wide";
  }
  if (size.columns >= MEDIUM.columns && size.rows >= MEDIUM.rows) {
    return "medium";
  }
  return "narrow";
}

/** How many rows the body has: everything above the footer. */
export function bodyRows(size: ReplTerminalSize): number {
  return Math.max(0, size.rows - FOOTER_ROWS);
}

/** How wide the sidebar is, or none at a profile that has no columns. */
export function sidebarWidth(size: ReplTerminalSize): number | undefined {
  const profile = profileFor(size);
  if (profile === "wide") {
    return SIDEBAR.wide;
  }
  return profile === "medium" ? SIDEBAR.medium : undefined;
}

/** How wide the inspection column is, or none at a profile that has none. */
export function inspectionWidth(size: ReplTerminalSize): number | undefined {
  const profile = profileFor(size);
  if (profile === "wide") {
    return INSPECTION.wide;
  }
  return profile === "medium" ? INSPECTION.medium : undefined;
}

/**
 * The drawer's rectangle, in whole cells, or none where there is no frame.
 *
 * Over the body and above the footer rather than across it: a modal that covered
 * the draft would hide the thing the question is about.
 */
export function drawerRect(size: ReplTerminalSize): ReplBounds | undefined {
  if (profileFor(size) === "too-small") {
    return undefined;
  }
  const body = bodyRows(size);
  const x = Math.floor(size.columns / DRAWER_SHARE);
  const y = Math.floor(body / DRAWER_SHARE);
  return Object.freeze({
    x,
    y,
    width: size.columns - 2 * x,
    height: body - 2 * y,
  });
}

/** One selectable history position, as the band would label it. */
export interface ReplSurfaceMarker {
  readonly marker: string;
  readonly label: string;
}

/** One marker as the band shows it, grouped or not. */
export interface ReplPlacedMarker {
  readonly marker: string;
  /** The label shown. Several markers may share one when space is short. */
  readonly label: string;
  /** The other markers sharing that label, this one excluded. */
  readonly grouped: readonly string[];
}

/** The History band: its five rows, and what each marker is labelled. */
export interface ReplHistoryBand {
  /** Exactly five rows, whatever the size. */
  readonly rows: readonly string[];
  readonly markers: readonly ReplPlacedMarker[];
}

/**
 * The History band, labelled and laid into its five rows.
 *
 * The band is the one thing on this screen that is not a mounted row: its labels
 * come from the model rather than from a node, so nothing else can tell the
 * engine what to put there. Grouping is visual — every marker stays under its
 * own name and the ones sharing a label say which others they share it with, so
 * a compact band never costs a reader the ability to select an exact position.
 */
export function historyBand(
  markers: readonly ReplSurfaceMarker[],
  columns: number,
): ReplHistoryBand {
  const placed = groupedMarkers(markers, columns);
  return Object.freeze({ rows: Object.freeze(bandRows(placed, columns)), markers: placed });
}

function groupedMarkers(
  markers: readonly ReplSurfaceMarker[],
  columns: number,
): readonly ReplPlacedMarker[] {
  // Five rows wide as the band is wide. Grouping is about the band's whole
  // budget, not one row's: a label that will not fit row three may fit row four.
  const budget = HISTORY_ROWS * Math.max(1, columns - 2);
  const separate = markers.reduce((width, marker) => width + marker.label.length + 1, 0);
  if (markers.length === 0 || separate <= budget) {
    return Object.freeze(
      markers.map((marker) => Object.freeze({ ...marker, grouped: Object.freeze([]) })),
    );
  }

  // A grouped label is its first member's plus a count, so budget for that.
  const widest = markers.reduce((width, marker) => Math.max(width, marker.label.length), 1) + 4;
  const affordable = Math.max(1, Math.floor(budget / (widest + 1)));
  // At least two: reaching here means one-per-group would group nothing and the
  // band would overflow exactly as before.
  const perGroup = Math.max(2, Math.ceil(markers.length / affordable));
  const placed: ReplPlacedMarker[] = [];
  for (let start = 0; start < markers.length; start += perGroup) {
    const group = markers.slice(start, start + perGroup);
    const label = group.length === 1 ? group[0].label : `${group[0].label} +${group.length - 1}`;
    for (const marker of group) {
      placed.push(
        Object.freeze({
          marker: marker.marker,
          label,
          grouped: Object.freeze(
            group.filter((other) => other !== marker).map((other) => other.marker),
          ),
        }),
      );
    }
  }
  return Object.freeze(placed);
}

/**
 * What the band is called, on the first of its own rows.
 *
 * On the band rather than above it, because the footer is seven rows and all
 * five of these are the band's: a label given a row of its own would be a row
 * taken from the positions it names. It is read, not activated — nothing here
 * becomes a control.
 */
export const HISTORY_LABEL = "History ·";

function bandRows(markers: readonly ReplPlacedMarker[], columns: number): string[] {
  const rows = new Array<string>(HISTORY_ROWS).fill("");
  // The label occupies the first row before any position does, so a position
  // that will not fit beside it moves on like any other.
  rows[0] = HISTORY_LABEL.length <= columns ? HISTORY_LABEL : "";
  const labels: string[] = [];
  for (const marker of markers) {
    if (!labels.includes(marker.label)) {
      labels.push(marker.label);
    }
  }
  labels.forEach((label, index) => {
    const row = index % HISTORY_ROWS;
    const next = rows[row] === "" ? label : `${rows[row]} ${label}`;
    rows[row] = next.length <= columns ? next : rows[row];
  });
  // Padded to the full width, for the same reason the location rows are: a
  // renderer writes what changed, so a band row that got shorter would keep the
  // tail of the position that used to be there.
  return rows.map((row) => (columns < 1 ? row : row.padEnd(columns, " ")));
}

/** The one region a refusal has: the whole terminal, holding one sentence. */
export function refusalProps(): ReplBoxProps {
  return { layout: { width: grow(), height: grow() } };
}

/** The sentence a terminal too small to draw in shows, and nothing else. */
export function refusalText(size: ReplTerminalSize): string {
  return (
    `This REPL needs at least ${NARROW.columns}x${NARROW.rows}; this terminal is ` +
    `${size.columns}x${size.rows}. Make the window larger to carry on, or press ` +
    `Escape to leave the REPL.`
  );
}

/**
 * One row of a stacked region: as wide as the region, exactly one row tall.
 *
 * `width` states that, and stating it is what makes it true. A growing element
 * takes its minimum from its own **content**, so a row holding text longer than
 * its column measures as wide as that text: measured, one unwrapped canonical
 * location made a 92-column transcript report 128 and pushed the inspection
 * column off the frame, and every target inside such a row has a hit box
 * reaching columns it was never drawn in. Clipping the row fixes the width, but
 * makes each row a scroll container, and a screen's worth of them overruns the
 * engine's own array (`INTERNAL_ERROR: Clay attempted to make an out of bounds
 * array access`). Stating the width costs nothing and fixes both.
 *
 * `undefined` leaves it growing, for the one pass that has not measured a width
 * yet — which is also the pass that describes no text long enough to matter.
 */
export function rowProps(width: number | undefined): ReplBoxProps {
  return {
    layout: {
      width: width === undefined || width < 1 ? grow() : fixed(width),
      height: fixed(1),
    },
  };
}

/** One row of a region whose width is not yet known. */
export const ROW_PROPS: ReplBoxProps = Object.freeze({
  layout: Object.freeze({ width: grow(), height: fixed(1) }),
});

/** A control of the action row: as wide as its own label. */
export const CONTROL_PROPS: ReplBoxProps = Object.freeze({
  layout: Object.freeze({ width: fit(), height: fixed(1) }),
});

/**
 * The whole terminal, stacked top to bottom, on the application's own surface.
 *
 * Painted here rather than left to the terminal's default, because the parts of
 * the screen no pane covers — the footer, the band, whatever a profile leaves
 * over — are still this application's. A frame that painted only its panes would
 * read as three lit columns on somebody's wallpaper.
 */
export function rootProps(size: ReplTerminalSize): ReplBoxProps {
  return {
    layout: { width: fixed(size.columns), height: fixed(size.rows), direction: "ttb" },
    bg: terminalColour(REPL_PALETTE.applicationSurface),
  };
}

/**
 * The body: whatever the footer does not take, in one left-to-right flow.
 *
 * `edged` closes the reading along the bottom, which is what separates it from
 * the footer below. The edge is a real row the engine takes out of the body, so
 * what a region has left to hold rows is measured with it rather than guessed
 * around it. A profile with no pane edges takes none here either, so the one
 * screen that gives everything to a single outlet keeps every row it had.
 */
export function bodyProps(edged: boolean): ReplBoxProps {
  const layout = { width: grow(), height: grow(), direction: "ltr" as const };
  if (!edged) {
    return { layout };
  }
  return { layout, border: { color: terminalColour(REPL_PALETTE.edge), bottom: 1 } };
}

/**
 * A pane with its own surface and the edge that starts it.
 *
 * The column keeps the width the product gives it, so the outer constraints are
 * unchanged and the edge comes out of the inside. What is left is the content
 * box below, which is the only honest answer to how wide a row in this pane may
 * be.
 *
 * One edge, on the side the pane begins at, so two panes side by side are parted
 * by a single rule rather than by each one's own: a reader sees where a column
 * starts, and the column beside it does not pay a second cell to say the same
 * thing twice.
 */
export function paneColumnProps(width: number | undefined, surface: number): ReplBoxProps {
  return {
    ...columnProps(width),
    bg: terminalColour(surface),
    border: { color: terminalColour(REPL_PALETTE.edge), left: 1 },
  };
}

/** A pane with a surface and no edge of its own, like the one at the margin. */
export function paneProps(width: number | undefined, surface: number): ReplBoxProps {
  return { ...columnProps(width), bg: terminalColour(surface) };
}

/**
 * The inside of a bordered pane, which is what its rows are measured in.
 *
 * Border-free and stated as a box of its own, because a measured bound is the
 * only thing that can say how much room an edge left — and subtracting a border
 * count in the caller would be a second answer to a question the engine has
 * already answered.
 */
export function paneContentProps(): ReplBoxProps {
  return { layout: { width: grow(), height: grow(), direction: "ttb" } };
}

/**
 * One column of the body, stacked. `undefined` grows into what is left.
 *
 * Not clipped horizontally, and that is load-bearing. The engine resolves a
 * growing child against its **content** rather than its parent as soon as the
 * parent clips on that axis: measured, a row holding 200 columns of text inside
 * a horizontally clipped 92-column column came back 200 wide. Every row clips
 * itself instead, which fixes both halves at once — a row is exactly as wide as
 * its column, and a column takes no minimum from the text inside it.
 */
export function columnProps(width: number | undefined): ReplBoxProps {
  const axis: SizingAxis = width === undefined ? grow() : fixed(width);
  return { layout: { width: axis, height: grow(), direction: "ttb" } };
}

/**
 * One group of rows inside a column: a heading, its controls and its viewport.
 *
 * Grouped so that each shared column has **one** growing child. Two growing
 * siblings split what is left between them in the engine's own arithmetic, and
 * that arithmetic is not whole: measured, two `grow()` viewports in a 29-row
 * sidebar came back `11.994140625` and `12`, which puts every row inside the
 * first one at a fractional position. A target there names a row that is not a
 * row, so placement states the size and lets one child grow into the remainder.
 *
 * `"grow"` takes whatever the column has left, `"fit"` takes exactly what its
 * own rows need, and a number states a share.
 */
export function stackProps(height: "grow" | "fit" | number): ReplBoxProps {
  const axis: SizingAxis =
    height === "grow" ? grow() : height === "fit" ? fit() : fixed(Math.max(0, height));
  return { layout: { width: grow(), height: axis, direction: "ttb" } };
}

/**
 * A scrolling viewport: it grows into what its region has left, and clips.
 *
 * Clipped because the engine draws an overflowing child half off its parent
 * rather than dropping it, and reports its whole bounds either way. Clipping
 * keeps a row admission left out from painting over the region below; admission
 * is what keeps it from being mounted at all.
 *
 * Growing, it is the one growing child of its group, so what it is given is the
 * whole integer remainder of that group rather than a share split with a
 * sibling. `rows` states the height instead, for a reading short enough to show
 * whole: a measured viewport has to answer the same way whether or not the pass
 * asking put any rows in it, so a natural footprint is stated rather than fitted.
 */
export function viewportProps(rows?: number): ReplBoxProps {
  const height: SizingAxis = rows === undefined ? grow() : fixed(Math.max(0, rows));
  return {
    layout: { width: grow(), height, direction: "ttb" },
    clip: { vertical: true },
  };
}

/**
 * The most of a shared column one of its two readings may take.
 *
 * A share rather than whatever a list happens to need: both readings are in one
 * column, and a catalog that sized itself by its own length would push the
 * Sessions reading — and then its own heading — off the bottom as entries
 * accumulated. Halving it is what makes the two independent.
 */
export function sharedColumnRows(size: ReplTerminalSize): number {
  return Math.floor(bodyRows(size) / 2);
}

/** The footer: seven rows, stacked, at the bottom of every frame that has one. */
export function footerProps(): ReplBoxProps {
  return { layout: { width: grow(), height: fixed(FOOTER_ROWS), direction: "ttb" } };
}

/**
 * The action row: one row, controls side by side with a space between them.
 *
 * Clipped horizontally so a control admission left out cannot paint past the
 * row's edge. Which controls the row holds whole is measured rather than
 * counted — the engine self-sizes each to its own label, and the first one that
 * crosses the trailing edge ends the row.
 */
export function actionRowProps(): ReplBoxProps {
  return {
    layout: { width: grow(), height: fixed(1), direction: "ltr", gap: 1 },
    clip: { horizontal: true },
  };
}

/** The History band: its own five rows, stacked. */
export function bandProps(): ReplBoxProps {
  return { layout: { width: grow(), height: fixed(HISTORY_ROWS), direction: "ttb" } };
}

/**
 * The drawer layer: one floating, opaque, clipped rectangle over the body.
 *
 * Floated as a layer rather than per cell, at the integer rectangle
 * `drawerRect()` states, and painted with its own background so the blank
 * interior of a short modal line obscures the text beneath it.
 *
 * It is bounded by a rule along its top and inset one cell on each side. Both
 * are part of the rectangle rather than additions to it, and both are measured:
 * the rule is a row the engine takes out of the layer and the inset is two
 * columns, so the content window below is measured at what is left and admits
 * only what fits there. A drawer in front of a reading has to say where the
 * reading stops, and a title flush against the text it covers reads as one more
 * line of that text.
 *
 * The vertical rows beyond the rule are the drawer's to use. There is no second
 * margin: the rectangle is already inset from the body, and another one inside
 * it would cost the content more of the rows the product gives it.
 *
 * `capture` narrows the engine's own hit test over the rectangle, blank cells
 * included. It is not modal containment and nothing here treats it as such: a
 * pointer is resolved against this frame's own detached bounds, and whether a
 * dispatch reaches a node behind the modal is the reconciler's to refuse.
 */
export function drawerLayerProps(
  rect: ReplBounds,
  capture: "capture" | "passthrough" = "capture",
): ReplBoxProps {
  return {
    layout: {
      width: fixed(rect.width),
      height: fixed(rect.height),
      direction: "ttb",
      padding: { left: DRAWER_INSET, right: DRAWER_INSET },
    },
    bg: DRAWER_BACKGROUND,
    border: { color: terminalColour(REPL_PALETTE.waiting), top: 1 },
    // Vertically only: every row inside clips itself to the layer's width, so
    // nothing paints past the rectangle. Clipping horizontally here would make
    // each of those rows resolve its width against its own text instead.
    clip: { vertical: true },
    floating: {
      x: rect.x,
      y: rect.y,
      attachTo: "root",
      zIndex: 10,
      pointerCaptureMode: capture,
    },
  };
}

/**
 * The ops for the measurement pass, under structural ids and nothing else.
 *
 * Decorated by the same builder as the committed frame. Nothing holds focus
 * here — there is no mounted node to hold it — and that costs the measurement
 * nothing, because focus changes a foreground and never a width.
 */
export function skeletonOps(root: ReplBox): Op[] {
  return opsOf(
    [root],
    (box) => box.id,
    () => undefined,
    undefined,
  );
}

/**
 * The committed frame's ops, drawn under live node ids wherever a node backs a
 * box.
 *
 * What an element says is the cell its own mounted node contributed, so a box
 * whose node drew nothing is drawn empty rather than drawn with the text a
 * description guessed. A box whose key names no mounted node is not drawn at
 * all — which is how an admitted row that failed to mount contributes no cell
 * and no target — while a structural container the tree has never heard of keeps
 * its own id.
 */
export function committedOps(
  root: ReplBox,
  nodeByKey: ReadonlyMap<string, string>,
  mounted: ReadonlySet<string>,
  cells: ReadonlyMap<string, string>,
  /**
   * The mounted node holding focus after this frame reconciled, for this frame
   * alone.
   *
   * Passed in rather than looked up, and not kept: focus belongs to the tree, and
   * a manifest or a box that remembered it would be a second place to ask where
   * it is. It is matched by exact mounted identity, so a box whose node is not
   * the focused one is drawn unfocused however its key is spelled, and it is
   * discarded with the ops it decorated.
   */
  focused: string | undefined,
): Op[] {
  return opsOf(
    [root],
    (box) => {
      if (box.key === undefined) {
        return box.id;
      }
      const node = nodeByKey.get(box.key);
      return node !== undefined && mounted.has(node) ? node : undefined;
    },
    (id) => cells.get(id),
    focused,
  );
}

function opsOf(
  boxes: readonly ReplBox[],
  idOf: (box: ReplBox) => string | undefined,
  textOf: (id: string) => string | undefined,
  focused: string | undefined,
): Op[] {
  const ops: Op[] = [];
  for (const box of boxes) {
    const id = idOf(box);
    if (id === undefined) {
      continue;
    }
    ops.push(open(id, decorated(box)));
    const content = textOf(id) ?? box.text;
    if (content !== undefined && content !== "") {
      ops.push(...written(content, box, id === focused));
    }
    ops.push(...opsOf(box.children, idOf, textOf, focused));
    ops.push(close());
  }
  return ops;
}

/**
 * One box's props with its surface on them.
 *
 * On the element rather than on the text, because a surface is the row's whole
 * measured width: the engine paints an element's background across every cell it
 * was given, and text only covers the cells it filled — so a selected row whose
 * label got shorter would otherwise be half selected.
 */
function decorated(box: ReplBox): ReplBoxProps {
  if (box.style === undefined) {
    return box.props;
  }
  const surface = surfaceOf(box.style);
  if (surface === undefined) {
    return box.props;
  }
  return { ...box.props, bg: terminalColour(surface) };
}

/**
 * One row's text, as the operations that draw it.
 *
 * Several operations inside the one element the row was measured as, never one
 * element per stretch: the engine lays adjacent text out along the element's own
 * flow, so what a reader sees is still one row of exactly the measured width —
 * while a child per token would be a box, a bound and a pointer target for every
 * delimiter on the screen.
 *
 * Bounded to the room the element has, because the engine wraps each operation
 * it is given **on its own** and a row is one cell tall: several operations
 * totalling more than the element each show their own first line and leave the
 * cells their remainder went to blank — measured, a 400-column generated tag in
 * a 118-column drawer came out with its quoted values missing. Cutting the
 * stretches at the room keeps every character the row can show, in order, in
 * the role it has; what is past the edge was never on the screen either way.
 */
function written(content: string, box: ReplBox, focused: boolean): Op[] {
  const style = box.style;
  if (style === undefined) {
    return [text(content)];
  }
  const { runs } = box;
  const room = roomOf(box.props);
  if (runs === undefined || runs.length === 0 || runText(runs) !== content || room === "unknown") {
    const { colour, attrs } = textStyleOf(style, focused);
    return [drawn(content, colour, attrs)];
  }
  return bounded(runs, room).map((run) => {
    const { colour, attrs } = runStyleOf(run.token, style, focused);
    return drawn(run.text, colour, attrs);
  });
}

/**
 * How many columns this element gives its text.
 *
 * Read off the constraint the element was opened with rather than worked out
 * again: a box stated at a measured width says how much room its text has, and
 * a box that sizes itself to its own content never has too little. A box that
 * grows takes its width from the flow around it, which is not an answer this
 * builder has — and only the pass that is *asking* what the widths are draws
 * one, so that row is drawn the way it always was and the measurement it
 * contributes is unchanged.
 */
function roomOf(props: ReplBoxProps): number | "whole" | "unknown" {
  const width = props.layout?.width;
  if (width === undefined) {
    return "unknown";
  }
  if (width.type === "fit") {
    return "whole";
  }
  return width.type === "fixed" ? width.value : "unknown";
}

/** The stretches of a row that fall inside the room it has, in order. */
function bounded(runs: readonly ReplTokenRun[], room: number | "whole"): readonly ReplTokenRun[] {
  if (room === "whole" || runText(runs).length <= room) {
    return runs;
  }
  const kept: ReplTokenRun[] = [];
  let used = 0;
  for (const run of runs) {
    if (used >= room) {
      break;
    }
    const take = Math.min(run.text.length, room - used);
    kept.push(Object.freeze({ text: run.text.slice(0, take), token: run.token }));
    used += take;
  }
  return kept;
}

function drawn(content: string, colour: number, attrs: number): Op {
  return text(content, { color: terminalColour(colour), ...(attrs === 0 ? {} : { attrs }) });
}

/** Every box of one tree, outermost first, for a caller that wants the list. */
export function flatten(root: ReplBox): readonly ReplBox[] {
  return [root, ...root.children.flatMap((child) => flatten(child))];
}

/** Build one box. A helper, so no call site assembles the shape by hand. */
export function box(input: {
  readonly id: string;
  readonly key?: string;
  readonly region?: ReplRegion;
  readonly props: ReplBoxProps;
  readonly text?: string;
  readonly control?: boolean;
  readonly style?: ReplRowStyle;
  readonly runs?: readonly ReplTokenRun[];
  readonly children?: readonly ReplBox[];
}): ReplBox {
  return Object.freeze({
    id: input.id,
    key: input.key,
    region: input.region,
    props: input.props,
    text: input.text,
    control: input.control === true,
    style: input.style,
    runs: input.runs,
    children: Object.freeze(input.children === undefined ? [] : [...input.children]),
  });
}
