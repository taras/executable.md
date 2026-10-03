/**
 * Which rows and which controls one measured frame admits.
 *
 * Pure, and holds nothing. Offsets belong to the application, capacities come
 * from what the engine measured, and this decides the one thing that follows
 * from both: exactly which rows a viewport shows and exactly which controls an
 * action row holds whole. Both the reducer that moves a window and the builder
 * that describes its rows read the same answer from here, so what a scroll
 * clamps against cannot disagree with what was drawn.
 *
 * Nothing in this module knows a footer height, a column width, an inset or a
 * row count. A capacity that was computed rather than measured is the defect
 * this replaces: a window sized by subtracting guessed overheads from a region
 * describes rows that land outside the frame, and a row the frame cannot place
 * is a focus stop that draws nothing and a pointer target behind nothing.
 */

import type { ReplActionCandidate, ReplBounds } from "./layout.ts";

/** One window over one ordered reading. */
export interface ReplWindow {
  /** The index in the whole reading that the first shown row came from. */
  readonly from: number;
  /** How many rows are shown, which is never more than the capacity. */
  readonly count: number;
  /** How many rows the engine measured room for. */
  readonly capacity: number;
  /** How many rows the reading holds in total. */
  readonly total: number;
  /** Whether anything is above the window. */
  readonly less: boolean;
  /** Whether anything is below it. */
  readonly more: boolean;
}

/** What one measured frame admitted. */
export interface ReplAdmission {
  /** One window per scrolling reading, by that reading's own identity. */
  readonly windows: ReadonlyMap<string, ReplWindow>;
  /** Everything the action row holds, by description key. */
  readonly actions: ReadonlySet<string>;
  /**
   * The one row's worth of explanatory text the row shortened, if any.
   *
   * A sentence the row cannot hold whole is not dropped like a control; it is
   * cut to what is left, with something saying it was cut. This names it and
   * gives the width it was allowed, so whoever writes that text writes it to
   * exactly the room the measured row had.
   */
  readonly shortened: { readonly key: string; readonly width: number } | undefined;
}

/** An admission that shows nothing: what the measurement pass itself describes. */
export const NOTHING_ADMITTED: ReplAdmission = Object.freeze({
  windows: new Map<string, ReplWindow>(),
  actions: new Set<string>(),
  shortened: undefined,
});

/**
 * How many whole rows one measured region can place.
 *
 * Floored, because half a row is not a row, and bounded at zero because a
 * region the flow gave nothing to holds nothing. A region the engine measured
 * no bounds for holds nothing either — not "everything", which is the fallback
 * that makes a long list describe rows nothing places.
 */
export function capacityOf(bounds: ReplBounds | undefined): number {
  if (bounds === undefined) {
    return 0;
  }
  return Math.max(0, Math.floor(bounds.height));
}

/**
 * The window one reading shows, at one measured capacity.
 *
 * The offset is clamped to the last window the reading actually has, so what is
 * shown is never a position past the end of the list. The clamp is returned
 * rather than written anywhere: this module holds no state, and the application
 * stores the offset it was given back.
 */
export function admitRows(input: {
  readonly offset: number;
  readonly total: number;
  readonly capacity: number;
}): ReplWindow {
  const capacity = Math.max(0, Math.floor(input.capacity));
  const total = Math.max(0, Math.floor(input.total));
  const furthest = Math.max(0, total - capacity);
  const from = Math.min(Math.max(0, Math.floor(input.offset)), furthest);
  const count = Math.min(capacity, Math.max(0, total - from));
  return Object.freeze({
    from,
    count,
    capacity,
    total,
    less: from > 0,
    more: from + count < total,
  });
}

/**
 * Where a scroll of one window lands.
 *
 * From the clamp the frame is **showing**, never from the number that happened
 * to be stored. A resize or a filter changes what a window holds, and the region
 * is already drawing the clamped position — so a delta added to a stale larger
 * offset would spend a press normalizing state nobody can see, and the screen
 * would not move.
 */
export function scrolled(window: ReplWindow, delta: number): number {
  const furthest = Math.max(0, window.total - window.capacity);
  return Math.min(Math.max(0, window.from + Math.trunc(delta)), furthest);
}

/**
 * Which of the offered controls the action row holds whole, in priority order.
 *
 * Order is priority and the prefix is contiguous: the first control the row
 * cannot hold whole ends the row, and a later narrower one is **not** admitted
 * past it. A row that skipped ahead to whatever still fits would reorder what a
 * person reads between two sizes of the same terminal, and the control they were
 * reaching for would move.
 *
 * Whole is measured, not counted. The engine self-sizes each control to its own
 * label and draws an overflowing one half off the row while still reporting its
 * full width, so the test is whether a control's own measured trailing edge
 * crosses the row's.
 */
export function admitActions(input: {
  readonly row: ReplBounds | undefined;
  readonly controls: readonly ReplActionCandidate[];
  readonly boundsOf: (id: string) => ReplBounds | undefined;
}): {
  readonly admitted: ReadonlySet<string>;
  readonly shortened: { readonly key: string; readonly width: number } | undefined;
} {
  const admitted = new Set<string>();
  if (input.row === undefined) {
    return { admitted, shortened: undefined };
  }
  const edge = input.row.x + input.row.width;
  for (const candidate of input.controls) {
    const own = input.boundsOf(candidate.id);
    if (own === undefined) {
      return { admitted, shortened: undefined };
    }
    if (own.x + own.width > edge) {
      if (candidate.control) {
        // Half a control is worse than no control: it is in the target map at a
        // width that disagrees with what is drawn, and a person aiming at the
        // half that is missing reaches whatever is behind it.
        return { admitted, shortened: undefined };
      }
      // A sentence the row may shorten. It still ends the row — what follows it
      // would start past the edge — but it keeps the room it has.
      const room = edge - own.x;
      if (room < 1) {
        return { admitted, shortened: undefined };
      }
      admitted.add(candidate.key);
      return { admitted, shortened: { key: candidate.key, width: room } };
    }
    admitted.add(candidate.key);
  }
  return { admitted, shortened: undefined };
}
