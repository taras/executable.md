/**
 * Reading one entry's output, bounded, and saying exactly what was read.
 *
 * A reply that submits an entry has to be able to look at what the entry
 * printed, and an entry can print more than any turn should carry. So the read
 * is bounded — a window, and a truthful statement of where that window sat in
 * what was observed. The whole of this module is resolving a request into that
 * window and the instructions for the ones either side of it. It performs
 * nothing: there is no filesystem here, no provider, no entry task, and no way
 * for a read to start, resume or wait for work.
 *
 * ## Code points, because the window is for a person's text
 *
 * Offsets and limits count Unicode code points rather than UTF-16 units. An
 * emoji is one position, not two, so a window never ends halfway through a
 * character and two adjacent reads never disagree about where one stopped and
 * the next began. That costs an array per read, which is the right trade for
 * output measured in thousands of characters.
 *
 * ## Resolved once, then stated absolutely
 *
 * `entry` may be relative (`-1` is the latest, `-2` the one before) and
 * `offset` may be negative (counted back from the end of what was observed).
 * Both are resolved *once*, against this moment's snapshot, and what comes back
 * names the exact entry id and absolute offsets — including in the adjacent
 * read instructions. That is what keeps a follow-up read pointing at the same
 * entry after a newer one has been admitted: an instruction that still said
 * "latest" would quietly move.
 *
 * ## Truthful rather than helpful
 *
 * An empty range, a window past the end of what was observed, and an entry that
 * printed nothing are all answered as what they are. A range before the start
 * clamps to the beginning, because asking for the last 4096 code points of a
 * shorter output means its whole output. An entry nobody can name is refused
 * rather than substituted with a neighbour, and nothing adds a summary: the
 * reply reads output, and output is what it gets.
 */

import { Err, Ok } from "effection";
import type { Result } from "effection";

/** Why one output read could not be resolved. */
export class OutputReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutputReadError";
  }
}

/** The default window, when a request states no limit. */
export const DEFAULT_LIMIT = 4096;

/** What one entry has printed so far, as the host observed it. */
export interface ObservedEntry {
  /** Its exact id, which is what a read names and what an answer pins to. */
  readonly id: string;
  /** Everything this entry has printed so far, buffering respected. */
  readonly output: string;
  /** Whether this entry has settled, and how. */
  readonly status: "running" | "completed" | "failed" | "cancelled";
}

/** What a reply asked to read. */
export interface OutputReadRequest {
  /**
   * Which entry: an exact id, or a negative index back from the latest.
   *
   * Zero and positive numbers are unavailable rather than clamped. There is no
   * sensible reading of "entry 0", and a positive index would be an
   * admission-order position that looks stable and is not — a reply holding one
   * across a new admission would read a different entry than it meant.
   */
  readonly entry?: string | number;
  /**
   * Where the window starts, in code points.
   *
   * Negative counts back from the end of what was observed. Omitted means
   * `-limit`: the tail, which is what a reply wants almost every time.
   * Explicitly zero reads from the beginning, which omitted cannot express.
   */
  readonly offset?: number;
  /** How many code points, at most. A positive integer; 4096 by default. */
  readonly limit?: number;
}

/** One resolved read instruction, for the window beside this one. */
export interface AdjacentRead {
  /** The exact entry, never a relative index. */
  readonly entry: string;
  /** An absolute offset, so this instruction cannot drift. */
  readonly offset: number;
  readonly limit: number;
}

/** One window of one entry's output, and where it sat. */
export interface OutputRead {
  /** The exact entry this read resolved to. */
  readonly entry: string;
  readonly status: ObservedEntry["status"];
  /** How many code points had been observed when this read resolved. */
  readonly length: number;
  /** Where the window started, absolutely. */
  readonly offset: number;
  /** The limit this read used. */
  readonly limit: number;
  /** Exactly the code points in the window, and nothing added. */
  readonly text: string;
  /** The window before this one, when there is one. */
  readonly previous: AdjacentRead | undefined;
  /**
   * The window after this one, when the observed output already has more.
   *
   * Absent when this window reached the end of what was observed — which for a
   * running entry means the end *so far*, so a reply that wants to see more
   * reads again rather than being promised something that does not exist yet.
   */
  readonly next: AdjacentRead | undefined;
}

/**
 * Resolve one read against this moment's entries.
 *
 * `entries` is in admission order, latest last — the order the projection
 * already keeps. Nothing here mutates it, and nothing here looks at anything
 * else.
 */
export function readEntryOutput(
  request: OutputReadRequest,
  entries: readonly ObservedEntry[],
): Result<OutputRead> {
  const limit = resolveLimit(request.limit);
  if (!limit.ok) {
    return limit;
  }
  const target = resolveEntry(request.entry, entries);
  if (!target.ok) {
    return target;
  }
  const entry = target.value;
  // Once, here: every position below is in code points, and splitting twice
  // would let two halves of one read disagree about how long the output is.
  const points = [...entry.output];
  const offset = resolveOffset(request.offset, limit.value, points.length);
  const end = offset + limit.value;

  return Ok(
    Object.freeze({
      entry: entry.id,
      status: entry.status,
      length: points.length,
      offset,
      limit: limit.value,
      text: points.slice(offset, end).join(""),
      previous:
        offset > 0
          ? Object.freeze({
              entry: entry.id,
              offset: Math.max(0, offset - limit.value),
              limit: limit.value,
            })
          : undefined,
      next:
        end < points.length
          ? Object.freeze({ entry: entry.id, offset: end, limit: limit.value })
          : undefined,
    }),
  );
}

function resolveLimit(stated: number | undefined): Result<number> {
  if (stated === undefined) {
    return Ok(DEFAULT_LIMIT);
  }
  if (!Number.isInteger(stated) || stated <= 0) {
    // Nonpositive and fractional limits are refused rather than rounded: a
    // read that silently became a different read is worse than one that said
    // it could not be performed.
    return Err(
      new OutputReadError(
        "a limit is a positive whole number of code points, so this read cannot be performed.",
      ),
    );
  }
  return Ok(stated);
}

function resolveEntry(
  stated: string | number | undefined,
  entries: readonly ObservedEntry[],
): Result<ObservedEntry> {
  const latest = entries[entries.length - 1];
  if (stated === undefined) {
    if (latest === undefined) {
      return Err(new OutputReadError("this session has no entries to read."));
    }
    return Ok(latest);
  }
  if (typeof stated === "number") {
    if (!Number.isInteger(stated) || stated >= 0) {
      return Err(
        new OutputReadError(
          "an entry is named by its exact id or by a negative position back from the latest " +
            "(-1 is the latest, -2 the one before), so this read cannot be performed.",
        ),
      );
    }
    const found = entries[entries.length + stated];
    if (found === undefined) {
      // Out of range refuses rather than clamping to the oldest: a reply that
      // asked for the entry before last and got the only entry would be told
      // about a different run than it asked about.
      return Err(
        new OutputReadError(
          `this session has no entry at position ${stated}, so there is nothing to read there.`,
        ),
      );
    }
    return Ok(found);
  }
  const found = entries.find((held) => held.id === stated);
  if (found === undefined) {
    return Err(
      new OutputReadError(`this session has no entry "${stated}", so there is nothing to read.`),
    );
  }
  return Ok(found);
}

/**
 * Where the window starts, absolutely.
 *
 * Omitted means the tail. A negative offset counts back from the end of what
 * was observed and clamps at the beginning, so asking for the last 4096 code
 * points of a shorter output is that output rather than a refusal. A positive
 * offset past the end is left where it is: the window is then empty, which is
 * the truth about that range.
 */
function resolveOffset(stated: number | undefined, limit: number, length: number): number {
  if (stated === undefined) {
    return Math.max(0, length - limit);
  }
  if (!Number.isInteger(stated)) {
    // Fractions cannot name a code point. Truncating toward the start keeps the
    // window inside what was asked for rather than past it.
    return Math.max(0, Math.trunc(stated) < 0 ? length + Math.trunc(stated) : Math.trunc(stated));
  }
  return stated < 0 ? Math.max(0, length + stated) : stated;
}

/**
 * The read instruction a submitted entry is handed back.
 *
 * Submit answers with a status, the exact entry and a read that is ready to
 * use — no body, no preview, no summary. The entry is pinned and the offset is
 * left out, which is the request's own spelling for the tail: an entry that has
 * just been submitted has nothing worth reading from the front.
 *
 * Deliberately not an `AdjacentRead`. Those carry absolute offsets because they
 * describe a window somebody has already seen the edges of; this describes one
 * nobody has read yet.
 */
export function initialRead(entry: string): OutputReadRequest {
  return Object.freeze({ entry, limit: DEFAULT_LIMIT });
}
