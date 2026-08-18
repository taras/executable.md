/**
 * Where a coroutine is in its own durable history.
 *
 * A durable operation is identified by what it is and what it is called. Some
 * operations have no name to give: a wait that a document reaches at one point
 * in one procedure is that wait *because of where it is*, not because somebody
 * named it. This is the coordinate such an operation names itself by — the
 * coroutine it runs in, and how many durable yields that coroutine has already
 * settled.
 *
 * ## Why it is not the replay cursor
 *
 * Replay already keeps a cursor per coroutine, and it looks like the same
 * number. It is not. The cursor advances only while entries are being consumed
 * from retained history; once a coroutine runs past the end of what was
 * retained, the cursor stops while the coroutine keeps performing durable work.
 * A position taken from it would be stable across replays of the retained
 * prefix and would collide for every operation in the live suffix.
 *
 * So the position advances on both — a replayed yield and a committed live one
 * — which is what makes the index a coroutine reaches at one point in its
 * procedure the same index it reaches there next time.
 *
 * ## Observation, never authority
 *
 * A position describes where execution is. It authorizes nothing, proves
 * nothing about who is executing, and is not durable state: it is derived by
 * counting what the journal already holds. Anything that must be trusted is
 * checked by whoever owns the authority to check it.
 */

import { type Operation } from "effection";
import { DurableContext } from "./context.ts";
import type { CoroutineId } from "./types.ts";

/**
 * One coroutine's coordinate: which coroutine, and how far along it is.
 *
 * The pair rather than the index alone, because two coroutines each reach index
 * 0, and the two are different places. A child's coordinate is its own — a
 * child coroutine counts its own yields from zero — and the coroutine id is
 * what keeps that from colliding with its parent's.
 */
export interface DurablePosition {
  readonly coroutineId: CoroutineId;
  readonly index: number;
}

/**
 * The position this coroutine has reached.
 *
 * Read before performing a durable operation, it is that operation's
 * coordinate. Read after, it is the next one's.
 */
export function* durablePosition(): Operation<DurablePosition> {
  const context = yield* DurableContext.expect();
  return Object.freeze({
    coroutineId: context.coroutineId,
    index: context.position ?? 0,
  });
}

/**
 * Record that this coroutine settled one durable yield.
 *
 * Called from both settlement paths, which is the whole point of the field. A
 * caller outside this package never advances a position: it is a count of what
 * happened, and only the code that made it happen may say so.
 */
export function advanceDurablePosition(context: { position?: number }): void {
  context.position = (context.position ?? 0) + 1;
}
