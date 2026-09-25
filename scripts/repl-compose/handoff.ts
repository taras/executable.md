/**
 * Hand a value to every live receiver, and know when they have all taken it.
 *
 * A producer that sends and moves on cannot tell you whether anything acted on
 * what it sent, so a caller that wants to read the result has to guess how long
 * to wait. That guess is what `sleep(0)` was doing here, and a guess is not a
 * barrier: a receiver that needed two turns would be read before it ran.
 *
 * So delivery completes instead. `deliver()` finishes only once every receiver
 * that was live when it started has come back for the next value, which is the
 * moment it has finished applying this one. Asking for the next value is the
 * acknowledgement — there is no separate `ack()` to forget, and a receiver that
 * is slow holds the producer rather than being overtaken.
 *
 * A receiver that goes away does not strand the producer. Its slot is removed
 * and whatever was outstanding on it is released in the same synchronous
 * teardown, so closing a drawer mid-frame leaves the frame's other receivers to
 * finish it and the producer to return.
 */

import { resource, withResolvers } from "effection";
import type { Operation } from "effection";

/** One live receiver's side of a handoff. */
export interface Receiver<T> {
  /**
   * The next value, once there is one.
   *
   * Calling it acknowledges the value returned by the previous call, so a loop
   * that takes a value, applies it and comes back is already reporting.
   */
  next(): Operation<T>;
}

export interface Handoff<T> {
  /** Receive for as long as the acquiring scope lives. */
  receive(): Operation<Receiver<T>>;
  /** Deliver one value, completing when every live receiver has applied it. */
  deliver(value: T): Operation<void>;
  /** How many receivers are live right now. */
  readonly demand: number;
}

interface Slot<T> {
  /** A value delivered before this receiver asked for one. */
  queued: T[];
  /** Resumes a receiver that is waiting for a value. */
  resume?: (value: T) => void;
  /** Releases the producer waiting on this receiver's last value. */
  release?: () => void;
}

export function createHandoff<T>(): Handoff<T> {
  const slots = new Set<Slot<T>>();

  function acknowledge(slot: Slot<T>): void {
    const release = slot.release;
    slot.release = undefined;
    release?.();
  }

  return {
    get demand(): number {
      return slots.size;
    },

    receive(): Operation<Receiver<T>> {
      return resource(function* (provide) {
        const slot: Slot<T> = { queued: [] };
        slots.add(slot);
        try {
          yield* provide({
            *next(): Operation<T> {
              // Coming back for another value is how the last one is reported.
              acknowledge(slot);
              const queued = slot.queued.shift();
              if (queued !== undefined) {
                return queued;
              }
              const waiting = withResolvers<T>();
              slot.resume = waiting.resolve;
              try {
                return yield* waiting.operation;
              } finally {
                slot.resume = undefined;
              }
            },
          });
        } finally {
          // Leaving releases whatever a producer is still waiting on, so a
          // receiver that goes away cannot hold delivery open.
          slots.delete(slot);
          acknowledge(slot);
        }
      });
    },

    *deliver(value: T): Operation<void> {
      // The receivers live at the moment delivery starts. One that subscribes
      // during it joins the next value rather than this one.
      const outstanding: Operation<void>[] = [];
      for (const slot of [...slots]) {
        const applied = withResolvers<void>();
        slot.release = applied.resolve;
        outstanding.push(applied.operation);
        const resume = slot.resume;
        if (resume === undefined) {
          slot.queued.push(value);
        } else {
          slot.resume = undefined;
          resume(value);
        }
      }
      for (const applied of outstanding) {
        yield* applied;
      }
    },
  };
}
