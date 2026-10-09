/**
 * Every position this history retained, and what the execution is doing now.
 *
 * The one thing on this screen that is *not* read at the selected prefix. A
 * reader standing at an earlier position is still owed the whole rail — the
 * positions after theirs are where they can go next, and a rail that stopped
 * at the selection would be a map of the part of the file they had already
 * reached. So navigation is derived from the full validated reading while
 * every other pane is derived from the prefix.
 *
 * ## It carries almost nothing
 *
 * A marker and a kind. No label, no source, no component or binding name, no
 * value, no output, no question, no permission, no Agent detail, no outcome
 * and no observation. That is the whole of the exception: a reader at an
 * earlier position learns *that* there are later positions and what kind they
 * are, and nothing about what they hold. Anything richer would be the future
 * leaking into a reading of the past, which is the thing a frozen position
 * exists to prevent.
 *
 * Selection is not here either. Which position is being read belongs to the
 * route, and copying it into this summary would make two answers to one
 * question.
 *
 * ## One reading, two projections
 *
 * Both halves come from one acknowledged event array: the full file for this
 * summary, the requested prefix for everything else. Two projections of one
 * immutable input cannot disagree about what the file holds, and a navigation
 * built by appending to a selected model would be a rail assembled from a
 * reading that never saw the rest of the file.
 */

import type { ReplCheckpoint } from "./model.ts";

/** One retained position, as the rail needs to know it. */
export type ReplNavigationPoint = Pick<ReplCheckpoint, "marker" | "kind">;

/**
 * What the execution is doing, as the band says it.
 *
 * Seven states and no eighth. Each is a fact about retained records and about
 * work this process actually owns — never about what a body returned, what a
 * root Close recorded, what a badge says or what the selected content shows.
 */
export type ReplHeadState =
  | "empty"
  | "live"
  | "pausing"
  | "paused"
  | "settling"
  | "settled"
  | "unfinished";

/** The whole of what navigation knows. */
export interface ReplHistoryNavigation {
  readonly checkpoints: readonly ReplNavigationPoint[];
  readonly head: ReplHeadState;
}

/** No history and nothing running. What an execution starts as. */
export const NO_NAVIGATION: ReplHistoryNavigation = Object.freeze({
  checkpoints: Object.freeze([]),
  head: "empty",
});

/**
 * The thin summary of one validated full reading.
 *
 * Copied rather than referenced, and frozen item by item: the caller keeps
 * this across frames, and a summary sharing structure with the model it came
 * from is a summary that changes when the model is reprojected.
 */
export function navigationOf(
  checkpoints: readonly ReplCheckpoint[],
  head: ReplHeadState,
): ReplHistoryNavigation {
  return Object.freeze({
    checkpoints: Object.freeze(
      checkpoints.map((one) => Object.freeze({ marker: one.marker, kind: one.kind })),
    ),
    head,
  });
}

/** What the head is doing, by the one precedence the band states. */
export interface ReplHeadFacts {
  /** Whether this prefix retained any entry at all. */
  readonly entries: number;
  /** Whether the latest entry has a retained root outcome. */
  readonly outcome: boolean;
  /**
   * Whether this process still owns the entry's work.
   *
   * True until every resource that entry acquired has been released — its
   * outer Agent attachment and its consumers included. A body that returned
   * and a root Close that was recorded are both earlier than this, which is
   * why neither of them answers it.
   */
  readonly working: boolean;
  /** Whether the controller this process holds is actually paused. */
  readonly paused: boolean;
  /** Whether it is actually pausing. */
  readonly pausing: boolean;
}

/**
 * Which head state those facts are.
 *
 * In precedence order, because more than one can be true at once and the
 * first match is the honest one:
 *
 *  1. an outcome is retained and the work is still coming down — **settling**,
 *     which is the window a reader watching a run end is actually in;
 *  2. no outcome and the controller is paused — **paused**;
 *  3. no outcome and it is pausing — **pausing**, distinct because the holds
 *     have not all been taken yet;
 *  4. work this process owns, and none of the above — **live**;
 *  5. nothing retained and nothing owned — **empty**;
 *  6. no owned work and the latest entry has an outcome — **settled**, and
 *     neutrally: a success, a failure and a cancellation all finished;
 *  7. no owned work and no outcome — **unfinished**. Never an inferred pause:
 *     nothing is holding it, it simply stopped.
 */
export function headOf(facts: ReplHeadFacts): ReplHeadState {
  if (facts.working) {
    if (facts.outcome) {
      return "settling";
    }
    if (facts.paused) {
      return "paused";
    }
    if (facts.pausing) {
      return "pausing";
    }
    return "live";
  }
  if (facts.entries === 0) {
    return "empty";
  }
  return facts.outcome ? "settled" : "unfinished";
}

/** What the band says for each state. */
export const HEAD_LABELS: Readonly<Record<ReplHeadState, string>> = Object.freeze({
  empty: "HEAD · EMPTY",
  live: "HEAD · LIVE",
  pausing: "HEAD · PAUSING EXPANSION",
  paused: "HEAD · EXPANSION PAUSED",
  settling: "HEAD · SETTLING",
  settled: "HEAD · SETTLED",
  unfinished: "HEAD · UNFINISHED",
});

/**
 * What one retained position is, said as a category and nothing more.
 *
 * The drawer's row for a marker. `N` is its one-based ordinal in the full
 * list and `E` is the admitted order of the entry it belongs to — both
 * counted from the thin list itself, so no row needs a payload to describe
 * itself. The wording is the same live and historical: a recorded answer is
 * not somebody waiting, an admission is not an invocation that finished, and
 * an entry outcome is not cleanup that completed.
 */
export function pointLabel(point: ReplNavigationPoint, ordinal: number, entry: number): string {
  switch (point.kind) {
    case "entry":
      return `${ordinal} · Entry ${entry} admitted`;
    case "scope":
      return `${ordinal} · Component admitted`;
    case "binding":
      return `${ordinal} · Bindings recorded`;
    case "generated":
      return `${ordinal} · Generated XMD admitted`;
    case "elicit":
      return `${ordinal} · Answer recorded`;
    case "agent":
      return `${ordinal} · Agent turn recorded`;
    case "terminal":
      return `${ordinal} · Entry outcome recorded`;
  }
}

/**
 * Every retained position with the entry it belongs to.
 *
 * The entry number is the count of `entry` kinds up to and including this
 * point, which is the admitted order — counted from the list rather than
 * looked up, because looking it up would mean reading a payload this summary
 * deliberately does not carry.
 */
export function numbered(navigation: ReplHistoryNavigation): readonly {
  readonly point: ReplNavigationPoint;
  readonly ordinal: number;
  readonly entry: number;
}[] {
  let entry = 0;
  return navigation.checkpoints.map((point, index) => {
    if (point.kind === "entry") {
      entry += 1;
    }
    return Object.freeze({ point, ordinal: index + 1, entry });
  });
}
