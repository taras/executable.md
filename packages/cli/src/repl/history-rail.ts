/**
 * The History band: every retained position, on five rows of measured rail.
 *
 * A map of the whole recorded order, not of the part a reader has reached.
 * The selection sits on it in amber; the head sits below its end. Content
 * stays at the selected prefix — this is the one reading taken at the whole
 * file, and it carries a marker and a kind and nothing else.
 *
 * ## Why it is measured rather than counted
 *
 * Where a mark goes is a proportion of the rail's *columns*, and a column is
 * not a character: the title, the head labels and the entry captions are
 * engine answers, and the rail is whatever they leave. A band laid out by
 * `String.length` would put its last mark off the end of a pane the moment a
 * caption held a character wider than one cell.
 *
 * ## What each row is
 *
 *   1. the band's own name, and the head label against the right
 *   2. entry captions, and the selection caption against the right
 *   3. the tall uprisers of entry marks, and the selection's diamond
 *   4. the rule itself, with a junction under every mark
 *   5. the short stems of minor marks, and the head's own marker
 *
 * The right-hand captions share one reserved width across every head state,
 * so a head changing from LIVE to SETTLING moves no mark and re-cuts no
 * caption. Only the count, the selection or the size can do that.
 *
 * ## Grouping keeps every position selectable
 *
 * Two positions that land on one column are one *visual* group and stay two
 * positions: the group remembers both, and the drawer offers each its own
 * row. A rail that merged them would be a rail that cost a reader the ability
 * to reach one of them, which is the whole point of retaining it.
 */

import { close, fit, open, text } from "@bomb.sh/tty";
import type { Op } from "@bomb.sh/tty";
import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";
import { tokenRuns } from "./description.ts";
import type { ReplTokenRun } from "./description.ts";
import { HEAD_LABELS, numbered } from "./navigation.ts";
import type { ReplHeadState, ReplHistoryNavigation, ReplNavigationPoint } from "./navigation.ts";
import type { ReplPresentationRole } from "./presentation-style.ts";
import type { ReplRenderer } from "./renderer.ts";
import type { ReplTerminalSize } from "./terminal.ts";

/** What the band calls itself, on the first of its own rows. */
export const HISTORY_TITLE = "History · recorded order";

/** What it says where a history holds nothing. */
export const HISTORY_EMPTY = "No recorded checkpoints";

/** The caption for a live reading, which is not standing at a position. */
export const SELECTED_HEAD = "SELECTED · HEAD";

/** Exactly five, at every size. */
export const HISTORY_ROWS = 5;

/**
 * A band with nothing on it.
 *
 * What a frame carries before it has measured one, and what a refusal
 * carries: there is no validated reading to draw a rail from, and a stale one
 * beside a refusal would be the worst of both.
 */
export const EMPTY_BAND: ReplPreparedRail = Object.freeze({
  reservation: Object.freeze({ right: 0, separator: 0, rail: 0 }),
  rows: Object.freeze(Array.from({ length: HISTORY_ROWS }, () => Object.freeze([]))),
  groups: Object.freeze([]),
});

/**
 * Five rows of the band's own surface, at a width.
 *
 * What a frame draws where it has not prepared a rail. Full width rather than
 * empty, for the reason every other row of this screen is: the renderer
 * writes what changed, so a band row that got shorter would keep the tail of
 * whatever used to be there.
 */
export function blankBand(columns: number): readonly (readonly ReplTokenRun[])[] {
  const blank = tokenRuns([{ text: " ".repeat(Math.max(0, columns)), token: "history" }]);
  return Object.freeze(Array.from({ length: HISTORY_ROWS }, () => blank));
}

/** A tall mark: an entry, which is what a reader navigates by. */
const ENTRY_UPRISER = "┃";
/** Its junction on the rule, and the heavier one a crowded group takes. */
const ENTRY_JUNCTION = "━";
const ENTRY_CROWDED = "┳";
/** A minor position: its junction on the rule, and its stem below. */
const MINOR_JUNCTION = "┬";
const MINOR_STEM = "│";
/** The rule itself. */
const RULE = "─";
/** The selection, above the rule; the head, below its end. */
const SELECTED_DIAMOND = "◆";
const HEAD_MARKER = "▼";

/** One visual column, and every position that landed on it. */
export interface ReplRailGroup {
  readonly column: number;
  /** Every member, in recorded order. Never merged away. */
  readonly members: readonly ReplNavigationPoint[];
  /** Their one-based ordinals in the full list. */
  readonly ordinals: readonly number[];
  /** Whether any member is an entry, and whether any is at or before the selection. */
  readonly entry: boolean;
  readonly minor: boolean;
  readonly entryEarlier: boolean;
  readonly minorEarlier: boolean;
  /** Whether the selected position is one of these. */
  readonly selected: boolean;
}

/** What the band reserved before it placed anything. */
export interface ReplRailReservation {
  /** The right-hand caption column, shared by every head state. */
  readonly right: number;
  /** The measured space parting it from the rail. */
  readonly separator: number;
  /** What is left, which is the rail. */
  readonly rail: number;
}

/** The band, prepared. Inert: text and roles, no capability and no target. */
export interface ReplPreparedRail {
  readonly reservation: ReplRailReservation;
  /** Exactly `HISTORY_ROWS` rows of runs, each already the band's full width. */
  readonly rows: readonly (readonly ReplTokenRun[])[];
  readonly groups: readonly ReplRailGroup[];
}

/** Ask the engine how wide each of these texts is, in one render. */
function* widths(
  renderer: ReplRenderer,
  size: ReplTerminalSize,
  texts: readonly string[],
): Operation<Result<readonly number[]>> {
  if (texts.length === 0) {
    return Ok([]);
  }
  const ops: Op[] = [
    open("band:root", { layout: { width: fit(), height: fit(), direction: "ttb" } }),
  ];
  for (const [index, one] of texts.entries()) {
    ops.push(open(`band:${index}`, { layout: { width: fit(), height: fit() } }));
    if (one.length > 0) {
      ops.push(text(one));
    }
    ops.push(close());
  }
  ops.push(close());
  const measured = yield* renderer.measure(ops, size);
  if (!measured.ok) {
    return measured;
  }
  const answers: number[] = [];
  for (const [index, one] of texts.entries()) {
    if (one.length === 0) {
      answers.push(0);
      continue;
    }
    const bounds = measured.value.boundsOf(`band:${index}`);
    if (bounds === undefined) {
      return Err(new Error(`the engine measured no width for ${JSON.stringify(one)}`));
    }
    answers.push(Math.ceil(bounds.width));
  }
  return Ok(answers);
}

/**
 * Where each position lands, as a proportion of the rail's measured columns.
 *
 * Deterministic and frozen: the first is at 0, the last at W−1, and the rest
 * spread evenly between them. A single position goes at the end, where the
 * head is — one recorded thing and the present are the same place. This is
 * proportional spacing inside measured bounds and says nothing about when
 * anything happened.
 */
function columnOf(index: number, count: number, room: number): number {
  if (count <= 1) {
    return Math.max(0, room - 1);
  }
  return Math.round((index * (room - 1)) / (count - 1));
}

/**
 * The positions, gathered into the columns they landed on.
 *
 * Consecutive ordinals sharing a column are one group. Every member stays in
 * it: the group is how the band *draws* them, never how it counts them.
 */
export function groupsOf(
  navigation: ReplHistoryNavigation,
  selected: string | undefined,
  room: number,
): readonly ReplRailGroup[] {
  const points = numbered(navigation);
  if (points.length === 0 || room < 1) {
    return Object.freeze([]);
  }
  const at =
    selected === undefined ? undefined : points.findIndex((one) => one.point.marker === selected);
  const selectedOrdinal = at === undefined || at < 0 ? undefined : at + 1;
  const byColumn = new Map<number, typeof points>();
  for (const [index, one] of points.entries()) {
    const column = columnOf(index, points.length, room);
    byColumn.set(column, [...(byColumn.get(column) ?? []), one]);
  }
  return Object.freeze(
    [...byColumn.entries()]
      .sort(([a], [b]) => a - b)
      .map(([column, members]) => {
        // Each category decides its own colour independently: a group holding
        // an entry a reader has passed and a minor position they have not is
        // both, and saying so with one colour would lose half of it.
        const entries = members.filter((one) => one.point.kind === "entry");
        const minors = members.filter((one) => one.point.kind !== "entry");
        const earlier = (of: typeof members) =>
          selectedOrdinal === undefined || of.some((one) => one.ordinal <= selectedOrdinal);
        return Object.freeze({
          column,
          members: Object.freeze(members.map((one) => one.point)),
          ordinals: Object.freeze(members.map((one) => one.ordinal)),
          entry: entries.length > 0,
          minor: minors.length > 0,
          entryEarlier: entries.length > 0 && earlier(entries),
          minorEarlier: minors.length > 0 && earlier(minors),
          selected:
            selectedOrdinal !== undefined && members.some((one) => one.ordinal === selectedOrdinal),
        });
      }),
  );
}

/** One row under construction: a fixed-width line of cells with roles. */
class Row {
  readonly #cells: { text: string; role: ReplPresentationRole }[];

  constructor(width: number, role: ReplPresentationRole) {
    this.#cells = Array.from({ length: Math.max(0, width) }, () => ({ text: " ", role }));
  }

  /** Put one character at a column, if the column is on this row. */
  put(column: number, glyph: string, role: ReplPresentationRole): void {
    const cell = this.#cells[column];
    if (cell !== undefined) {
      cell.text = glyph;
      cell.role = role;
    }
  }

  /** Put a string starting at a column, clamped to what the row has. */
  write(column: number, value: string, role: ReplPresentationRole): void {
    for (const [offset, glyph] of [...value].entries()) {
      this.put(column + offset, glyph, role);
    }
  }

  /** The row as runs, adjacent cells of one role joined. */
  runs(): readonly ReplTokenRun[] {
    return tokenRuns(this.#cells.map((cell) => ({ text: cell.text, token: cell.role })));
  }
}

/** One entry caption, before and after merging. */
interface Caption {
  /** The first and last entry numbers it covers. */
  readonly from: number;
  readonly to: number;
  /** The rail columns of those entries. */
  readonly first: number;
  readonly last: number;
  readonly text: string;
  readonly earlier: boolean;
  width: number;
  column: number;
}

function captionText(from: number, to: number): string {
  return from === to ? `Entry ${from}` : `Entry ${from}–${to}`;
}

/**
 * The band, measured and laid out.
 *
 * Every width here is an engine answer. The right-hand column is reserved
 * first and identically for every head state, so a head change moves nothing;
 * the rail is what remains, and the captions are fitted into it by merging
 * overlapping runs of entries until they fit.
 */
export function* prepareRail(
  renderer: ReplRenderer,
  size: ReplTerminalSize,
  navigation: ReplHistoryNavigation,
  selected: string | undefined,
  width: number,
): Operation<Result<ReplPreparedRail>> {
  const points = numbered(navigation);
  const at = selected === undefined ? -1 : points.findIndex((one) => one.point.marker === selected);
  const selectedOrdinal = at < 0 ? undefined : at + 1;
  const selectionCaption =
    selectedOrdinal === undefined
      ? SELECTED_HEAD
      : `${SELECTED_DIAMOND} SELECTED · ${selectedOrdinal}`;

  // Every head label, so the reserved column is the same whichever one is
  // showing: a reservation that tracked the current state would re-cut the
  // rail each time the head moved.
  const heads = Object.values(HEAD_LABELS);
  const measured = yield* widths(renderer, size, [
    " ",
    HISTORY_TITLE,
    HISTORY_EMPTY,
    SELECTED_HEAD,
    selectionCaption,
    ...heads,
  ]);
  if (!measured.ok) {
    return measured;
  }
  const [separator, titleWidth, emptyWidth, headCaption, selectionWidth, ...headWidths] =
    measured.value;
  const right = Math.max(headCaption, selectionWidth, ...headWidths);
  const rail = width - right - separator;
  if (rail < 1 || titleWidth > rail) {
    return Err(
      new Error(
        `the History band needs ${right + separator + Math.max(titleWidth, 1)} columns and ` +
          `has ${width}`,
      ),
    );
  }

  const groups = groupsOf(navigation, selected, rail);
  const rows = Array.from({ length: HISTORY_ROWS }, () => new Row(width, "history-rail"));

  // Row 1: what this is, and what the execution is doing.
  rows[0].write(0, HISTORY_TITLE, "history-title");
  const headLabel = HEAD_LABELS[navigation.head];
  const headWidth = headWidths[heads.indexOf(headLabel)] ?? headLabel.length;
  rows[0].write(
    width - headWidth,
    headLabel,
    navigation.head === "live" ? "history-head-live" : "history-head",
  );

  // Row 2: the entry captions, and which position is being read.
  rows[1].write(
    width - (selectedOrdinal === undefined ? headCaption : selectionWidth),
    selectionCaption,
    selectedOrdinal === undefined ? "history-head" : "history-selected",
  );
  if (points.length === 0) {
    rows[1].write(
      0,
      HISTORY_EMPTY.slice(0, Math.max(0, Math.min(emptyWidth, rail))),
      "history-head",
    );
    return Ok(
      Object.freeze({
        reservation: Object.freeze({ right, separator, rail }),
        rows: Object.freeze(rows.map((row) => row.runs())),
        groups,
      }),
    );
  }

  const captions = yield* fitCaptions(renderer, size, groups, rail, selectedOrdinal, points);
  if (!captions.ok) {
    return captions;
  }
  for (const caption of captions.value) {
    rows[1].write(
      caption.column,
      caption.text,
      caption.earlier ? "history-entry-earlier" : "history-entry-later",
    );
  }

  // Rows 3–5: the marks themselves, on and around the rule.
  for (let column = 0; column < rail; column += 1) {
    rows[3].put(column, RULE, "history-rail");
  }
  for (const group of groups) {
    const crowded = group.members.length > 1;
    if (group.entry) {
      const role: ReplPresentationRole = group.entryEarlier
        ? "history-tick-earlier"
        : "history-entry-later";
      rows[2].put(group.column, ENTRY_UPRISER, role);
      rows[3].put(group.column, crowded ? ENTRY_CROWDED : ENTRY_JUNCTION, role);
    }
    if (group.minor) {
      const role: ReplPresentationRole = group.minorEarlier
        ? "history-minor-earlier"
        : "history-minor-later";
      // A group holding both keeps the entry's tall boundary above and its
      // heavier junction on the rule; the minor position keeps its own stem
      // below, so neither category is dropped for the other.
      if (!group.entry) {
        rows[3].put(group.column, crowded ? ENTRY_CROWDED : MINOR_JUNCTION, role);
      }
      rows[4].put(group.column, MINOR_STEM, role);
    }
    if (group.selected) {
      // The selection wins its cells above and on the rule. What the group
      // also holds stays readable in its junction, its caption and its own
      // drawer rows.
      rows[2].put(group.column, SELECTED_DIAMOND, "history-selected");
      rows[3].put(group.column, crowded ? ENTRY_CROWDED : ENTRY_JUNCTION, "history-selected");
    }
  }
  // The head is below the rail's end, in its own colour — so a selection on
  // that same column keeps its diamond above and the head keeps its marker
  // below, and neither has to borrow the other's cell.
  rows[4].put(
    Math.max(0, rail - 1),
    HEAD_MARKER,
    navigation.head === "live" ? "history-head-live" : "history-head",
  );

  return Ok(
    Object.freeze({
      reservation: Object.freeze({ right, separator, rail }),
      rows: Object.freeze(rows.map((row) => row.runs())),
      groups,
    }),
  );
}

/**
 * The entry captions, merged left to right until they fit.
 *
 * One `Entry E` per entry, centred on its mark. Where two overlap, the
 * leftmost pair becomes the span they actually cover — `Entry A–B`, never a
 * number that is not there — recentred between its own first and last marks,
 * remeasured, and the pass repeats. A caption is never clipped and never
 * reaches into the reserved right column: a band that cannot fit its captions
 * is a frame refusal, which already recovers on resize.
 */
function* fitCaptions(
  renderer: ReplRenderer,
  size: ReplTerminalSize,
  groups: readonly ReplRailGroup[],
  rail: number,
  selectedOrdinal: number | undefined,
  points: ReturnType<typeof numbered>,
): Operation<Result<readonly Caption[]>> {
  // Where each entry's mark is, by its admitted number.
  const marks = new Map<number, number>();
  for (const group of groups) {
    for (const [index, member] of group.members.entries()) {
      if (member.kind === "entry") {
        const ordinal = group.ordinals[index];
        const found = points.find((one) => one.ordinal === ordinal);
        if (found !== undefined) {
          marks.set(found.entry, group.column);
        }
      }
    }
  }
  if (marks.size === 0) {
    return Ok([]);
  }
  const earliest = (from: number, to: number): boolean => {
    if (selectedOrdinal === undefined) {
      return true;
    }
    // A merged caption spanning the selection reads as the earlier one: part
    // of what it covers is behind the reader.
    return points.some(
      (one) =>
        one.point.kind === "entry" &&
        one.entry >= from &&
        one.entry <= to &&
        one.ordinal <= selectedOrdinal,
    );
  };

  let captions: Caption[] = [...marks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([entry, column]) => ({
      from: entry,
      to: entry,
      first: column,
      last: column,
      text: captionText(entry, entry),
      earlier: earliest(entry, entry),
      width: 0,
      column: 0,
    }));

  // One pass per possible merge, counted from the captions there were — the
  // list shrinks as they merge, so a bound read from it each time would stop
  // the pass before the last pair had been joined.
  const passes = captions.length;
  for (let pass = 0; pass <= passes; pass += 1) {
    const sized = yield* widths(
      renderer,
      size,
      captions.map((one) => one.text),
    );
    if (!sized.ok) {
      return sized;
    }
    for (const [index, caption] of captions.entries()) {
      caption.width = sized.value[index];
      const centre = Math.round((caption.first + caption.last) / 2);
      caption.column = Math.max(
        0,
        Math.min(centre - Math.floor(caption.width / 2), rail - caption.width),
      );
    }
    // The first pair that touches, left to right. One separating cell is
    // required, so "touching" is an end that reaches the next one's start.
    const collision = captions.findIndex(
      (one, index) =>
        index + 1 < captions.length && one.column + one.width >= captions[index + 1].column,
    );
    if (collision < 0) {
      return Ok(Object.freeze(captions.map((one) => Object.freeze({ ...one }))));
    }
    const left = captions[collision];
    const right = captions[collision + 1];
    captions = [
      ...captions.slice(0, collision),
      {
        from: left.from,
        to: right.to,
        first: left.first,
        last: right.last,
        text: captionText(left.from, right.to),
        earlier: earliest(left.from, right.to),
        width: 0,
        column: 0,
      },
      ...captions.slice(collision + 2),
    ];
  }
  return Err(new Error("the History band could not fit its entry captions"));
}
