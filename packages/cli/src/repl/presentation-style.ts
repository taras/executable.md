/**
 * What a row means, and what that means for the cells it is drawn in.
 *
 * The application knows what every row *is* while it still has the typed facts
 * that produced it — a recorded output, an event's metadata, an entry that
 * failed, the position a reader has selected. This module is where that meaning
 * becomes colour, weight and a surface, and it is the only place that decides
 * one. Nothing above it names a colour and nothing below it reads a model: the
 * renderer is handed ops, and the ops carry whatever this said.
 *
 * It is pure. There is no operation here, no host Api, no Journal access and no
 * mutable state, so a role is recomputed from the frame's own reading every time
 * and owns nothing that could outlive it. It is private to the REPL; no package
 * exports it and no plugin extends it.
 *
 * ## Three facts, and what each may change
 *
 * A row carries one immutable **role**, and separately whether it is
 * **selected** and whether it is being read as **history**. Those are facts
 * about the reading. Keyboard **focus** is not: it belongs to the mounted tree
 * and is known only after reconciliation, so it arrives at draw time and may
 * change nothing but the foreground and its attributes. That division is what
 * keeps selection visible while focus is somewhere else — the two are drawn by
 * different properties of the same cell, so neither can erase the other.
 *
 * No geometry is decided here. Width, height, padding and borders are the
 * layout's, and a focused row occupies exactly the cells an unfocused one does.
 *
 * ## A colourless reading still works
 *
 * Every state this colours is also said in text: an outcome is spelled `[ok]` or
 * `[err]`, a selected row keeps its `*`, and a focused control keeps its `>`.
 * Colour is emphasis on a reading that is already complete, which is why a
 * terminal that ignores it loses nothing a person needs.
 */

import { rgba } from "@bomb.sh/tty";

/**
 * What one row is, out of the closed set this screen draws.
 *
 * Assigned from the typed reading that produced the row — a transcript record's
 * kind, an entry's terminal status, a form field's part — never from the text
 * that came out or from how the row's key is spelled. Arbitrary document and
 * provider text has no role of its own and reads as `source`, which is what
 * ordinary prose looks like.
 */
export type ReplPresentationRole =
  /** A pane's own name. */
  | "pane-heading"
  /** Document text and ordinary prose, and whatever has no stronger reading. */
  | "source"
  /** What a run produced: the thing a reader came for. */
  | "output"
  /** Facts about an event rather than its result. */
  | "metadata"
  /** What the execution is doing, and what that means for submitting. */
  | "status"
  /** A root that closed `ok`. */
  | "successful-outcome"
  /** A root that closed `err`, and a refusal of something asked for. */
  | "failed-outcome"
  /** Something that has not settled, and the affordance that attends to it. */
  | "waiting"
  /** Something activating does. */
  | "action"
  /** The name of the reading a drawer is showing. */
  | "drawer-title"
  /** What a field is called. */
  | "field-label"
  /** What a field means, or where a record came from. */
  | "field-hint"
  /** A value being edited. */
  | "field-value"
  /** The line the next entry is typed on. */
  | "draft"
  /** A retained position, and the band that holds them. */
  | "history";

/**
 * One row's presentation facts, as the reading settles them.
 *
 * `selected` is what the resolved route is pointing at; `inspected` is whether
 * this reading is a retained position rather than the live head. Both are facts
 * about the model, so both survive focus moving away.
 */
export interface ReplRowStyle {
  readonly role: ReplPresentationRole;
  readonly selected: boolean;
  readonly inspected: boolean;
}

/** Build one row's style. A helper, so no call site assembles the shape. */
export function styleOf(
  role: ReplPresentationRole,
  facts: { readonly selected?: boolean; readonly inspected?: boolean } = {},
): ReplRowStyle {
  return Object.freeze({
    role,
    selected: facts.selected === true,
    inspected: facts.inspected === true,
  });
}

/** Ordinary prose at the live head, which is what unclassified text reads as. */
export const ORDINARY: ReplRowStyle = styleOf("source");

/**
 * The colours this screen is drawn in, as 24-bit values.
 *
 * Stated the way the accepted palette states them and the way a terminal reports
 * them back, so what a test reads out of the cells it inspected is comparable to
 * what was asked for without re-deriving either. `terminalColour` is what turns
 * one into the value the engine takes.
 */
export const REPL_PALETTE = Object.freeze({
  /** Document text and ordinary prose. */
  source: 0xc8d2d9,
  /** A result, which outranks the metadata around it. */
  output: 0xe6ecf1,
  /** A heading, a field's name, a drawer's title. */
  heading: 0xcfe0ea,
  /** Subordinate facts: metadata, a hint, where a record came from. */
  muted: 0x7b858d,
  success: 0x5aa87c,
  failure: 0xc2766e,
  waiting: 0xc99a3f,
  /** Where the next keystroke lands. */
  focus: 0x7fd3e8,
  /** Behind a selected row, for the whole width the frame measured it at. */
  selectedSurface: 0x122026,
  /** A retained reading, and the band that holds the positions. */
  historical: 0xc9a86a,
  historySurface: 0x08090b,
  draftSurface: 0x0a0d0f,
  fieldSurface: 0x090c0e,
  /** The rectangle a drawer covers the body with. */
  drawerSurface: 0x0e1316,
  /** The transcript's own surface. */
  centreSurface: 0x0c0e11,
  /** The sidebar's. */
  sideSurface: 0x090b0c,
  /** The bindings and recorded-answer column's. */
  bindingsSurface: 0x0a0c0e,
  /** A pane's edge. */
  edge: 0x161c21,
});

/**
 * Bold, as the installed engine spells a text attribute.
 *
 * The engine takes one byte of flags and emits the matching SGR, so weight is
 * stated as that flag rather than as an escape this product writes itself.
 */
export const BOLD = 1;

/** What one row's text is drawn with. */
export interface ReplTextStyle {
  /** 24-bit, as the palette states it. */
  readonly colour: number;
  readonly attrs: number;
}

/**
 * The foreground one row's text takes, focus included.
 *
 * Focus wins the foreground and adds weight, because the row a keystroke reaches
 * is the one fact a reader needs before any other. It leaves the surface alone,
 * so a selected row that loses focus is still visibly the selected row.
 */
export function textStyleOf(style: ReplRowStyle, focused: boolean): ReplTextStyle {
  if (focused) {
    return Object.freeze({ colour: REPL_PALETTE.focus, attrs: BOLD });
  }
  return Object.freeze({ colour: colourOf(style), attrs: attrsOf(style.role) });
}

/**
 * What one row's whole measured width is painted with, or none where the pane it
 * sits in supplies it.
 *
 * Selection is a surface rather than a foreground so that it survives focus: the
 * row a reader chose and the row their next keystroke reaches are two different
 * facts, and a screen that drew them with one property could only ever show one
 * of them.
 */
export function surfaceOf(style: ReplRowStyle): number | undefined {
  if (style.selected) {
    return REPL_PALETTE.selectedSurface;
  }
  if (style.role === "draft") {
    return REPL_PALETTE.draftSurface;
  }
  if (style.role === "field-value") {
    return REPL_PALETTE.fieldSurface;
  }
  // Something you activate, wherever it is. A drawer's choices sit among the
  // lines explaining what they decide, and a reader has to be able to tell the
  // two apart before reading either — so a control carries the same surface the
  // draft does, which is this screen's other place a keystroke does something.
  if (style.role === "action") {
    return REPL_PALETTE.draftSurface;
  }
  if (style.role === "history") {
    return REPL_PALETTE.historySurface;
  }
  return undefined;
}

/** One palette colour, as the value the installed engine takes. */
export function terminalColour(colour: number): number {
  return rgba((colour >> 16) & 0xff, (colour >> 8) & 0xff, colour & 0xff);
}

function colourOf(style: ReplRowStyle): number {
  // A retained reading is marked on the two rows that say which reading it is,
  // and nowhere else: accenting every source line of a historical prefix would
  // say the document had changed rather than that the position had.
  if (style.inspected && (style.role === "status" || style.role === "history")) {
    return REPL_PALETTE.historical;
  }
  switch (style.role) {
    case "output":
    case "field-value":
      return REPL_PALETTE.output;
    case "pane-heading":
    case "drawer-title":
    case "field-label":
    case "action":
      return REPL_PALETTE.heading;
    case "metadata":
    case "field-hint":
      return REPL_PALETTE.muted;
    case "successful-outcome":
      return REPL_PALETTE.success;
    case "failed-outcome":
      return REPL_PALETTE.failure;
    case "waiting":
      return REPL_PALETTE.waiting;
    case "history":
      return REPL_PALETTE.historical;
    case "source":
    case "status":
    case "draft":
      return REPL_PALETTE.source;
  }
}

function attrsOf(role: ReplPresentationRole): number {
  if (role === "pane-heading" || role === "drawer-title" || role === "field-label") {
    return BOLD;
  }
  return 0;
}
