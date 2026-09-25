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
 *
 * The handoff itself is scope-owned for the same reason. It is a value with
 * state — the set of live receivers and what each of them still owes — so it is
 * acquired rather than constructed, and the scope that acquired it is what ends
 * it. A factory would have made that state belong to whoever happened to hold
 * the reference, which is how a set of receivers outlives the thing they were
 * receiving from and goes on being counted.
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

/**
 * One value on its way to one receiver, and the producer it will release.
 *
 * The release travels *with* the value rather than living on the slot, because
 * a value that waited in the queue must be acknowledged when it is applied and
 * not when it is handed over. Keeping one release per slot acknowledged a
 * queued value on the call that fetched it — before the receiver had done
 * anything with it — which is a producer told "applied" about work that had not
 * started.
 */
interface Parcel<T> {
  readonly value: T;
  readonly release: () => void;
}

interface Slot<T> {
  /** Values delivered before this receiver asked for one, oldest first. */
  queued: Parcel<T>[];
  /** Resumes a receiver that is waiting for a value. */
  resume?: (parcel: Parcel<T>) => void;
  /** The release owed for the value this receiver is applying right now. */
  applying?: () => void;
}

/** Release the producer of the value this receiver has now finished applying. */
function acknowledge<T>(slot: Slot<T>): void {
  const applying = slot.applying;
  slot.applying = undefined;
  applying?.();
}

/** Release everything this slot still owes, because it can owe nothing now. */
function abandon<T>(slot: Slot<T>): void {
  acknowledge(slot);
  for (const parcel of slot.queued) {
    parcel.release();
  }
  slot.queued = [];
}

export function useHandoff<T>(): Operation<Handoff<T>> {
  return resource(function* (provide) {
    const slots = new Set<Slot<T>>();
    try {
      yield* provide(handoffOver(slots));
    } finally {
      // Nothing waiting on a receiver here can still be answered, and no
      // receiver still counts, so the state ends with the scope that owns it.
      for (const slot of slots) {
        abandon(slot);
      }
      slots.clear();
    }
  });
}

function handoffOver<T>(slots: Set<Slot<T>>): Handoff<T> {
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
                slot.applying = queued.release;
                return queued.value;
              }
              const waiting = withResolvers<Parcel<T>>();
              slot.resume = waiting.resolve;
              let parcel: Parcel<T>;
              try {
                parcel = yield* waiting.operation;
              } finally {
                slot.resume = undefined;
              }
              slot.applying = parcel.release;
              return parcel.value;
            },
          });
        } finally {
          // Leaving releases everything this receiver still owes, so one that
          // goes away cannot hold delivery open.
          slots.delete(slot);
          abandon(slot);
        }
      });
    },

    *deliver(value: T): Operation<void> {
      // The receivers live at the moment delivery starts. One that subscribes
      // during it joins the next value rather than this one.
      const outstanding: Operation<void>[] = [];
      for (const slot of [...slots]) {
        const applied = withResolvers<void>();
        const parcel: Parcel<T> = { value, release: applied.resolve };
        outstanding.push(applied.operation);
        const resume = slot.resume;
        if (resume === undefined) {
          slot.queued.push(parcel);
        } else {
          slot.resume = undefined;
          resume(parcel);
        }
      }
      for (const applied of outstanding) {
        yield* applied;
      }
    },
  };
}
