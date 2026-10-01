/**
 * Where one entry's history stops and the next one begins.
 *
 * One REPL execution keeps one physical append-only stream, and a person may
 * submit into it more than once. Nothing in the file says which entry a record
 * belongs to, and nothing needs to: the protocol already writes the boundary.
 * The root document is imported under one durable name on one coroutine, and
 * that coroutine closes once — so an entry is exactly the range from a root
 * `import_component("__root__")` yield on `root` to that range's `close:root`.
 * Reading the boundary out of the records already there is what keeps a second
 * entry from needing a second storage, a record family, a manifest or an index.
 *
 * This module owns that grammar and nothing else. It says which ranges a file
 * holds and refuses a file whose ranges are not ranges; what a range *means* —
 * scopes, bindings, transcripts, outcomes — belongs to the projector, which
 * reads each range exactly as it has always read a one-entry history. Keeping
 * the two apart is what lets the whole file be validated before any part of it
 * is projected, so a reader is never shown a catalog assembled from the half of
 * a history that happened to parse.
 *
 * ## Why an execution is handed a view and not the file
 *
 * Replay correlates a record by coroutine id and durable name, and both restart
 * for every entry: two entries both import `__root__` on `root`, and their
 * nested work carries the same coroutine ids. An execution given the whole file
 * would replay somebody else's entry as its own. So each execution is handed
 * `EntrySegmentStream`, which reads exactly its own range and appends to the one
 * physical stream behind it. There is one writer and one copy of the truth; what
 * differs is how much of it an execution is allowed to see.
 */

import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";
import type { DurableEvent, DurableStream, Yield } from "@executablemd/durable-streams";

/** The durable name of the root document import, on the root coroutine. */
export const ROOT_IMPORT = "__root__";

/** The coroutine an entry's root document runs on. */
const ROOT_COROUTINE = "root";

/** What the REPL could not read or write about an entry boundary. */
export class ReplSegmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplSegmentError";
  }
}

/**
 * The stable key of the entry admitted in this position.
 *
 * Derived from admission order and from nothing else. It is not a Journal
 * marker, not a completion rank and not a name anybody typed, so an entry that
 * fails, is cancelled or runs for an hour keeps the key it was admitted under.
 */
export function entryKey(order: number): string {
  return `entry-${order}`;
}

/**
 * One segment-local marker, spelled the way the whole history spells it.
 *
 * The first entry keeps every marker exactly as a one-entry history wrote it,
 * because those spellings are already in people's locations and there is no
 * reading of `yield:root:0` that could mean anything else there. Every later
 * entry namespaces its own, so a second `close:root` names the second entry's
 * close instead of resolving to the first one's — which is what a repeated
 * coroutine name would otherwise do to a selection.
 */
export function entryMarker(order: number, local: string): string {
  return order === 1 ? local : `${entryKey(order)}:${local}`;
}

/** One entry's range of the physical stream. */
export interface EntrySegment {
  /** The admission-order key of the entry this range belongs to. */
  readonly key: string;
  /** Its admission order, counting from one. */
  readonly order: number;
  /** Where the range starts in the physical stream, inclusive. */
  readonly start: number;
  /** Where it ends, exclusive. */
  readonly end: number;
  /** Whether the range holds this entry's terminal `close:root`. */
  readonly settled: boolean;
  /** The events in the range, in append order. */
  readonly events: readonly DurableEvent[];
  /**
   * The root admission the range begins with, which is also `events[0]`.
   *
   * Carried as the yield it is, because the partition is what established that
   * it is one: a reader that took `events[0]` and asserted its type would be
   * restating the grammar instead of being handed its result.
   */
  readonly admission: Yield;
}

/** This event as a root admission, or none because it is not one. */
function rootAdmission(event: DurableEvent): Yield | undefined {
  if (
    event.type === "yield" &&
    event.description.type === "import_component" &&
    event.description.name === ROOT_IMPORT
  ) {
    return event;
  }
  return undefined;
}

/** Whether this event settles a root coroutine. */
function settlesRoot(event: DurableEvent): boolean {
  return event.type === "close" && event.coroutineId === ROOT_COROUTINE;
}

/**
 * Partition one complete physical prefix into the entries it holds.
 *
 * The whole prefix, atomically: a file whose boundaries are not boundaries
 * comes back as `Err` with no segments at all, because a partial partition is a
 * catalog that omits whichever entry stopped parsing, and a reader cannot tell
 * that from a history that never held it.
 *
 * Every refusal names what the records say rather than quoting them. A history
 * holds whatever a person's own documents held.
 */
export function partitionEntrySegments(
  events: readonly DurableEvent[],
): Result<readonly EntrySegment[]> {
  const segments: EntrySegment[] = [];
  let open: { readonly start: number; readonly admission: Yield } | undefined;

  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    const admission = rootAdmission(event);

    if (admission !== undefined) {
      if (admission.coroutineId !== ROOT_COROUTINE) {
        // An entry's root document runs on the root coroutine. A root admitted
        // from inside somebody's work is an entry nested in an entry, which is
        // not a boundary this history could have been written with.
        return Err(
          new ReplSegmentError(
            "this journal admits an entry from inside work another entry had already started. " +
              "An entry's source is the first thing its own history decides.",
          ),
        );
      }
      if (open !== undefined) {
        return Err(
          new ReplSegmentError(
            "this journal admits a second entry before the first one settled. One entry runs at " +
              "a time, and the entry before it ends with its own outcome.",
          ),
        );
      }
      open = { start: index, admission };
      continue;
    }

    if (settlesRoot(event)) {
      if (open === undefined) {
        return Err(
          new ReplSegmentError(
            "this journal records an entry settling that it never admitted. An entry's source is " +
              "admitted before anything it does.",
          ),
        );
      }
      segments.push(segment(events, segments.length + 1, open, index + 1, true));
      open = undefined;
      continue;
    }

    if (open === undefined) {
      // Two different damaged histories, and a reader repairing one needs to
      // know which they have: nothing has ever been admitted here, or something
      // was and the record landed past its outcome.
      return Err(
        new ReplSegmentError(
          segments.length === 0
            ? "this journal records work before it admitted its entry. The entry's source is the " +
                "first thing an execution decides."
            : "this journal records work after the entry settled and before another was " +
                "admitted. A settled entry is the end of its own history.",
        ),
      );
    }
  }

  if (open !== undefined) {
    segments.push(segment(events, segments.length + 1, open, events.length, false));
  }
  return Ok(Object.freeze(segments));
}

function segment(
  events: readonly DurableEvent[],
  order: number,
  open: { readonly start: number; readonly admission: Yield },
  end: number,
  settled: boolean,
): EntrySegment {
  return Object.freeze({
    key: entryKey(order),
    order,
    start: open.start,
    end,
    settled,
    events: Object.freeze(events.slice(open.start, end)),
    admission: open.admission,
  });
}

/** What range of the physical stream one execution may read and write. */
export interface EntrySegmentView {
  /** The events this entry's range already holds, in append order. */
  readonly retained?: readonly DurableEvent[];
  /** Whether nothing follows this range in the physical stream. */
  readonly final?: boolean;
}

/**
 * The one entry segment an execution is given, over the one physical stream.
 *
 * `readAll()` answers with this range and never with the file, so replay
 * correlates this entry's records against this entry's work and cannot reach a
 * repeated coroutine id from somebody else's. `append()` goes to the physical
 * stream first and is remembered only once that stream has acknowledged it —
 * the same order the physical stream itself keeps, and for the same reason: a
 * local record of a write that was never retained is a view describing a history
 * the file does not hold. After a failed append there is nothing to roll back,
 * because nothing moved.
 *
 * No physical position crosses this boundary. The execution learns how much of
 * its own range it has, which is all replay needs; where that range sits in the
 * file is the command's business, and its observer already knows the whole
 * acknowledged prefix.
 *
 * Writing is refused rather than ordered. A settled range is over — its entry
 * produced an outcome — and a range something already follows is not where the
 * next record goes. Either append would interleave two entries in one file, so
 * neither is answered with a position.
 */
export class EntrySegmentStream implements DurableStream {
  private readonly physical: DurableStream;
  private readonly snapshot: DurableEvent[];
  private readonly last: boolean;
  private closed: boolean;

  constructor(physical: DurableStream, view: EntrySegmentView = {}) {
    this.physical = physical;
    this.snapshot = (view.retained ?? []).map(clone);
    this.last = view.final ?? true;
    // Read off the range rather than taken as a claim: what settles an entry is
    // its own terminal close, and the records say whether it holds one.
    const end = this.snapshot[this.snapshot.length - 1];
    this.closed = end !== undefined && settlesRoot(end);
  }

  /** Whether this range holds its entry's terminal close. */
  get settled(): boolean {
    return this.closed;
  }

  // deno-lint-ignore require-yield
  *readAll(): Operation<DurableEvent[]> {
    return this.snapshot.map(clone);
  }

  *append(event: DurableEvent): Operation<void> {
    if (!this.last) {
      throw new ReplSegmentError(
        "this entry is not the last one in its history, so nothing can be added to it. A later " +
          "entry already follows it.",
      );
    }
    if (this.closed) {
      throw new ReplSegmentError(
        "this entry has already settled, so nothing can be added to it. A settled entry is the " +
          "end of its own history.",
      );
    }
    const recorded = clone(event);

    yield* this.physical.append(recorded);

    // A copy of its own, because the physical stream may retain the object it
    // was handed: two records of one event that share a graph are one record
    // either side could edit.
    this.snapshot.push(clone(recorded));
    if (settlesRoot(recorded)) {
      this.closed = true;
    }
  }
}

function clone(event: DurableEvent): DurableEvent {
  return structuredClone(event);
}
