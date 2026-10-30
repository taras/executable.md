import type { ReplCaretKey } from "./components/actions.ts";

export interface ReplCaret {
  readonly value: string;
  readonly offset: number;
  readonly column?: number;
  readonly backward?: true;
}

export interface ReplCaretRow {
  readonly stops: readonly { readonly offset: number; readonly column: number }[];
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function boundaries(value: string): readonly number[] {
  return [...GRAPHEMES.segment(value)].map((one) => one.index).concat(value.length);
}

export function caretFor(value: string, held: ReplCaret | undefined): ReplCaret {
  if (held === undefined || held.value !== value) {
    return { value, offset: value.length };
  }
  const offset =
    boundaries(value)
      .filter((at) => at <= held.offset)
      .at(-1) ?? 0;
  return { ...held, offset };
}

export function insertAt(caret: ReplCaret, text: string): ReplCaret {
  const value = caret.value.slice(0, caret.offset) + text + caret.value.slice(caret.offset);
  const after = caret.offset + text.length;
  const offset = boundaries(value).find((at) => at >= after) ?? value.length;
  return { value, offset };
}

export function eraseAt(caret: ReplCaret): ReplCaret {
  const before =
    boundaries(caret.value)
      .filter((at) => at < caret.offset)
      .at(-1) ?? 0;
  return { value: caret.value.slice(0, before) + caret.value.slice(caret.offset), offset: before };
}

export function caretRow(rows: readonly ReplCaretRow[], offset: number, backward = false): number {
  const at = Math.max(
    0,
    rows.findLastIndex((row) => (row.stops[0]?.offset ?? 0) <= offset),
  );
  // End retains the preceding row at a shared soft-wrap boundary.
  return backward && rows[at - 1]?.stops.at(-1)?.offset === offset ? at - 1 : at;
}

export function moveCaret(
  caret: ReplCaret,
  key: ReplCaretKey,
  rows: readonly ReplCaretRow[],
): ReplCaret {
  const stops = boundaries(caret.value);
  const at = stops.indexOf(caret.offset);
  if (key === "ArrowLeft" || key === "ArrowRight") {
    return {
      value: caret.value,
      offset: stops[at + (key === "ArrowLeft" ? -1 : 1)] ?? caret.offset,
    };
  }
  const rowIndex = caretRow(rows, caret.offset, caret.backward);
  const row = rows[rowIndex];
  if (row === undefined) {
    return caret;
  }
  if (key === "Home" || key === "End") {
    return {
      value: caret.value,
      offset: (key === "Home" ? row.stops[0] : row.stops.at(-1))?.offset ?? caret.offset,
      ...(key === "End" ? { backward: true } : {}),
    };
  }
  const column = caret.column ?? row.stops.find((one) => one.offset === caret.offset)?.column ?? 0;
  const destination = rows[rowIndex + (key === "ArrowUp" ? -1 : 1)];
  if (destination === undefined) {
    return { ...caret, column };
  }
  const closest = destination.stops.reduce((best, one) =>
    Math.abs(one.column - column) < Math.abs(best.column - column) ? one : best,
  );
  return { value: caret.value, offset: closest.offset, column };
}
