/**
 * guardDurableStream — a host-side pre-persistence boundary.
 *
 * A gate runs once per live append, before the event reaches the backend.
 * It receives a copy and returns nothing, so it can inspect or reject but
 * never rewrite. When the gate completes, the original event is handed to
 * the underlying stream exactly once. When the gate fails or is cancelled,
 * the backend is never invoked and the failure propagates to the durable
 * effect that produced the event.
 *
 * The backend append is a statement after the gate rather than a
 * continuation passed to it. A gate therefore has nothing it can invoke
 * twice, which preserves the protocol invariant that one durable yield
 * produces at most one journal event.
 */

import type { Operation } from "effection";
import type { DurableStream } from "./stream.ts";
import type { DurableEvent } from "./types.ts";

const EVENT_REJECTION = Symbol.for("@effectionx/durable-streams/event-rejection");

class WrappedDurableEventRejection extends Error {
  constructor(readonly rejection: unknown) {
    super(rejection instanceof Error ? rejection.message : String(rejection), {
      cause: rejection,
    });
  }
}

function markEventRejection(error: unknown): Error {
  const rejection = error instanceof Error ? error : new Error(String(error));
  if (
    Reflect.defineProperty(rejection, EVENT_REJECTION, {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false,
    })
  ) {
    return rejection;
  }
  return new WrappedDurableEventRejection(error);
}

export function isDurableEventRejection(error: unknown): boolean {
  if (error instanceof WrappedDurableEventRejection) {
    return true;
  }
  if ((typeof error !== "object" || error === null) && typeof error !== "function") {
    return false;
  }
  return Reflect.get(error, EVENT_REJECTION) === true;
}

export function unwrapDurableEventRejection(error: unknown): unknown {
  return error instanceof WrappedDurableEventRejection ? error.rejection : error;
}

/**
 * A check that runs before a durable event is persisted.
 *
 * Completing successfully admits the event. Failing or being cancelled
 * rejects it. A gate inspects or rejects, and nothing else: it returns no
 * value, and the event it receives is a copy, so writing to that copy
 * changes nothing about what gets journaled.
 */
export type DurableEventGate = (event: DurableEvent) => Operation<void>;

/**
 * Wrap a durable stream so every live append passes through `gate` first.
 *
 * `readAll()` delegates straight to the underlying stream, so replaying a
 * journal restores existing entries without gating them.
 *
 * Wrap the stream before execution begins to cover the complete live
 * journal — root component imports, yields, child closes, and the root
 * close.
 *
 * Rejection is per event. The rejected event never reaches the backend, but
 * the resulting failure may lead the workflow to append a later `Close`
 * event with an `err` result, and that close crosses the gate on its own.
 */
export function guardDurableStream(stream: DurableStream, gate: DurableEventGate): DurableStream {
  return {
    readAll: () => stream.readAll(),

    *append(event: DurableEvent): Operation<void> {
      // The gate sees a copy so "inspect or reject" is enforced rather than
      // merely documented: the backend always receives the event the effect
      // produced, whatever the gate did to the one it was handed.
      try {
        yield* gate(structuredClone(event));
      } catch (error) {
        throw markEventRejection(error);
      }
      yield* stream.append(event);
    },
  };
}
