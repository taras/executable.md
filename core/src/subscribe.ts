/**
 * Deterministic stream subscription helper (spec §9.6).
 *
 * Solves the channel subscribe-before-close race: spawns a consumer
 * that manually subscribes to a stream, then signals readiness via
 * withResolvers so the caller can yield* ready before sending
 * messages or closing the channel.
 *
 * Without this, a synchronously completing workflow could close the channel
 * before the consumer subscribes, hanging forever.
 */

import type { Operation, Stream, Task } from "effection";
import { spawn, withResolvers } from "effection";

export interface Subscriber<T> {
  /** Resolves when the subscription is established. */
  ready: Operation<void>;
  /** The spawned consumer task. yield* to get collected chunks. */
  task: Task<T[]>;
}

/**
 * Subscribe to a stream and collect all values, signaling when
 * subscription is established.
 *
 * @param stream - any Effection Stream (Channel, Signal, etc.)
 * @param onValue - optional synchronous callback for each value
 * @returns Subscriber with ready operation and consumer task
 */
export function* subscribe<T>(
  stream: Stream<T, unknown>,
  onValue?: (value: T) => void,
): Operation<Subscriber<T>> {
  const { operation: ready, resolve } = withResolvers<void>();

  const task = yield* spawn(function* () {
    const subscription = yield* stream;
    resolve();

    const chunks: T[] = [];
    let next = yield* subscription.next();
    while (!next.done) {
      if (onValue) {
        onValue(next.value);
      }
      chunks.push(next.value);
      next = yield* subscription.next();
    }
    return chunks;
  });

  return { ready, task };
}
