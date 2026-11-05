/**
 * Page one selected value by the standard selected-value units.
 *
 * A reader evaluates ordinary yq over the complete value it was asked about,
 * and the selection is what gets paged: a string by 4096 code points and an
 * array by 20 items. Any other selection — an object, a number, a boolean or
 * `null` — is one value and answers whole. A page is exactly
 * `{value, next, prev, last}`, where each navigation member is the yq string
 * that reads that neighbouring page, or `null`.
 *
 * What a navigation string looks like, which value it is bound to and how a
 * page is measured belong to the reader: Journal binds a window to one entry
 * and fits it inside its own protocol frame, and Git binds a window to one
 * commit and has no frame to fit. They meet here only in the arithmetic of
 * cutting a selection into pages and settling whose navigation fits.
 */

import { Err, Ok } from "effection";
import type { Result } from "effection";
import type { Json } from "../types.ts";

/** One page of a selected value. */
export interface SelectedValuePage {
  readonly value: Json;
  readonly next: string | null;
  readonly prev: string | null;
  readonly last: string | null;
}

/** The half-open unit range one page covers. */
export interface SelectedValueRange {
  readonly start: number;
  readonly end: number;
}

/** A navigation string the reader recognized as one of its own. */
export interface SelectedValueWindow {
  /** The complete selection the window was cut from, evaluated again now. */
  readonly value: string | Json[];
  /** The query that selection came from. */
  readonly query: string;
  readonly range: SelectedValueRange;
  /** Whether the window's end is kept as a page boundary under a byte budget. */
  readonly preserveWindow: boolean;
}

/** What one reader decides about its own pages. */
export interface SelectedValuePageAdapter {
  /** The navigation string that reads this range of this query. */
  format(query: string, range: SelectedValueRange, maxBytes?: number): string;
  /** Whether this page fits, under an explicit budget or the reader's own default. */
  fits(page: SelectedValuePage, maxBytes?: number): boolean;
  /** The refusal for a single value or item that cannot fit. */
  tooLarge(): Error;
}

const TEXT_UNITS = 4096;
const ITEM_UNITS = 20;

/**
 * The page this selection answers with.
 *
 * `selected` is what the expression evaluated to. When the expression is a
 * navigation string the reader recognized, `window` carries the complete
 * selection it was cut from, so its neighbours can be computed.
 */
export function pageSelectedValue(
  selected: Json,
  query: string,
  window: SelectedValueWindow | undefined,
  maxBytes: number | undefined,
  adapter: SelectedValuePageAdapter,
): Result<SelectedValuePage> {
  const value = window === undefined ? selected : window.value;
  const base = window === undefined ? query : window.query;
  const range = window?.range;
  const empty = { value, next: null, prev: null, last: null };
  if (typeof value !== "string" && !Array.isArray(value)) {
    return adapter.fits(empty, maxBytes) ? Ok(empty) : Err(adapter.tooLarge());
  }
  const length = typeof value === "string" ? [...value].length : value.length;
  if (
    range === undefined &&
    length <= (typeof value === "string" ? TEXT_UNITS : ITEM_UNITS) &&
    adapter.fits(empty, maxBytes)
  ) {
    return Ok(empty);
  }
  if (maxBytes !== undefined) {
    return budgetedPage(value, base, maxBytes, adapter, range, window?.preserveWindow === true);
  }
  const cuts = rangesOf(value, base, adapter);
  if (!cuts.ok) {
    return cuts;
  }
  const current = range ?? cuts.value[0] ?? { start: 0, end: 0 };
  const previous = cuts.value.findLast((one) => one.start < current.start);
  const next = current.end < length ? cuts.value.find((one) => one.end > current.end) : undefined;
  const last = current.end < length ? cuts.value.at(-1) : undefined;
  const navigation = (one: SelectedValueRange | undefined): string | null =>
    one === undefined ? null : adapter.format(base, one);
  const page: SelectedValuePage = {
    value:
      range === undefined
        ? typeof value === "string"
          ? [...value].slice(current.start, current.end).join("")
          : value.slice(current.start, current.end)
        : selected,
    next: navigation(next === undefined ? undefined : { start: current.end, end: next.end }),
    prev: navigation(
      previous === undefined ? undefined : { start: previous.start, end: current.start },
    ),
    last: navigation(last),
  };
  return adapter.fits(page) ? Ok(page) : Err(adapter.tooLarge());
}

function rangesOf(
  value: string | Json[],
  query: string,
  adapter: SelectedValuePageAdapter,
): Result<SelectedValueRange[]> {
  const ranges: SelectedValueRange[] = [];
  if (typeof value === "string") {
    const length = [...value].length;
    for (let start = 0; start < length; start += TEXT_UNITS) {
      ranges.push({ start, end: Math.min(start + TEXT_UNITS, length) });
    }
    return Ok(ranges);
  }
  const navigation = adapter.format(query, {
    start: Number.MAX_SAFE_INTEGER - 1,
    end: Number.MAX_SAFE_INTEGER,
  });
  for (let start = 0; start < value.length; ) {
    let end = start;
    while (
      end < value.length &&
      end - start < ITEM_UNITS &&
      adapter.fits({
        value: value.slice(start, end + 1),
        next: navigation,
        prev: navigation,
        last: navigation,
      })
    ) {
      end += 1;
    }
    if (end === start) {
      return Err(adapter.tooLarge());
    }
    ranges.push({ start, end });
    start = end;
  }
  return Ok(ranges);
}

function budgetedPage(
  value: string | Json[],
  query: string,
  maxBytes: number,
  adapter: SelectedValuePageAdapter,
  requested?: SelectedValueRange,
  preserveWindow = false,
): Result<SelectedValuePage> {
  const items = typeof value === "string" ? [...value] : value;
  const limit = typeof value === "string" ? TEXT_UNITS : ITEM_UNITS;
  const cuts: SelectedValueRange[] = [];
  for (let start = 0; start < items.length; ) {
    let end = Math.min(start + limit, items.length);
    if (requested !== undefined) {
      for (const boundary of [requested.start, ...(preserveWindow ? [requested.end] : [])]) {
        if (boundary > start && boundary < end) {
          end = boundary;
        }
      }
    }
    cuts.push({ start, end });
    start = end;
  }
  const navigation = (one: SelectedValueRange | undefined): string | null =>
    one === undefined ? null : adapter.format(query, one, maxBytes);
  const pageAt = (index: number): SelectedValuePage => {
    const current = cuts[index];
    const part = current === undefined ? [] : items.slice(current.start, current.end);
    return {
      value: typeof value === "string" ? part.join("") : part,
      next: navigation(cuts[index + 1]),
      prev: navigation(cuts[index - 1]),
      last: navigation(index < cuts.length - 1 ? cuts.at(-1) : undefined),
    };
  };
  // Splitting changes neighbouring navigation too; settle the actual complete pages together.
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < cuts.length; index += 1) {
      if (adapter.fits(pageAt(index), maxBytes)) {
        continue;
      }
      const current = cuts[index];
      if (current.end - current.start <= 1) {
        return Err(adapter.tooLarge());
      }
      const middle = current.start + Math.floor((current.end - current.start) / 2);
      cuts.splice(
        index,
        1,
        { start: current.start, end: middle },
        { start: middle, end: current.end },
      );
      changed = true;
    }
  }
  const index =
    requested === undefined ? 0 : cuts.findIndex((one) => one.start === requested.start);
  const page =
    index < 0
      ? {
          value: typeof value === "string" ? "" : [],
          next: null,
          prev: navigation(cuts.at(-1)),
          last: null,
        }
      : pageAt(index);
  return adapter.fits(page, maxBytes) ? Ok(page) : Err(adapter.tooLarge());
}
