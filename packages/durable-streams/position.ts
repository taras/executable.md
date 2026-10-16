/**
 * A coroutine's durable coordinate: its identity and number of settled yields.
 * Operations without an authored name can use this to identify their position.
 *
 * The count advances on replayed yields and committed live yields. The replay
 * cursor alone stops at the saved prefix and would collide for every
 * operation in a live suffix.
 *
 * This is derived observation, not durable state or permission. Decisions that
 * require trusted identity are checked by their owner.
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
