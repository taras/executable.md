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

import { createContext, type Operation } from "effection";
import type { DurableStream } from "./stream.ts";
import type { DurableEvent } from "./types.ts";

const inheritProvenance = Symbol.for("executablemd.durable-stream.inherit-provenance");

interface ProvenancedDurableStream extends DurableStream {
  [inheritProvenance]?: (target: DurableStream) => void;
}

/** Opaque proof that a stream is one specific backend or a guarded view of it. */
export interface DurableStreamProvenance {
  matches(stream: DurableStream): boolean;
}

/** Claim a stream identity without exposing the identity itself. */
export function claimDurableStreamProvenance(stream: DurableStream): DurableStreamProvenance {
  const source: ProvenancedDurableStream = stream;
  if (source[inheritProvenance] !== undefined) {
    throw new Error("this durable stream already has a provenance owner");
  }
  const members = new WeakSet<DurableStream>([stream]);
  const inherit = (target: DurableStream): void => {
    members.add(target);
    Object.defineProperty(target, inheritProvenance, {
      configurable: false,
      enumerable: false,
      value: inherit,
      writable: false,
    });
  };
  inherit(stream);
  return Object.freeze({
    matches(candidate: DurableStream): boolean {
      return members.has(candidate);
    },
  });
}

function inheritDurableStreamProvenance(source: DurableStream, target: DurableStream): void {
  const inherit = Reflect.get(source, inheritProvenance);
  if (typeof inherit === "function") {
    Reflect.apply(inherit, undefined, [target]);
  }
}

export interface DurableEventRejectionOccurrence {
  rejected: boolean;
  error?: unknown;
}

const EventRejectionOccurrence = createContext<DurableEventRejectionOccurrence | undefined>(
  "effectionx.durable-streams.event-rejection-occurrence",
  undefined,
);

export function withDurableEventRejectionOccurrence(
  occurrence: DurableEventRejectionOccurrence,
  operation: () => Operation<void>,
): Operation<void> {
  return EventRejectionOccurrence.with(occurrence, operation);
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
  const guarded: DurableStream = {
    readAll: () => stream.readAll(),

    *append(event: DurableEvent): Operation<void> {
      // The gate sees a copy so "inspect or reject" is enforced rather than
      // merely documented: the backend always receives the event the effect
      // produced, whatever the gate did to the one it was handed.
      try {
        yield* gate(structuredClone(event));
      } catch (error) {
        const occurrence = yield* EventRejectionOccurrence.get();
        if (occurrence !== undefined) {
          occurrence.rejected = true;
          occurrence.error = error;
        }
        throw error;
      }
      yield* stream.append(event);
    },
  };
  inheritDurableStreamProvenance(stream, guarded);
  return guarded;
}
