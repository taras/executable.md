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

class JournalProvenance {
  #opaque = undefined;
}

/**
 * A non-operational, equality-only witness that a stream descends from the
 * exact journal backend a provider selected.
 *
 * It grants no append, read, execution, publication or reconciliation
 * capability. It is meaningful only because the provider retains the witness
 * it established and later requires exact equality.
 */
export type { JournalProvenance };

const journalProvenances = (() => {
  // This security witness is deliberately canonical-module-local. A loaded
  // copy cannot read this copy's association or enroll a stream into it.
  const provenances = new WeakMap<DurableStream, JournalProvenance>();

  return {
    establish(stream: DurableStream): JournalProvenance {
      if (provenances.has(stream)) {
        throw new Error("this durable stream already has journal provenance");
      }
      const provenance = new JournalProvenance();
      provenances.set(stream, provenance);
      return provenance;
    },

    preserve(source: DurableStream, target: DurableStream): void {
      const provenance = provenances.get(source);
      if (provenance !== undefined) {
        provenances.set(target, provenance);
      }
    },

    get(stream: DurableStream): JournalProvenance | undefined {
      return provenances.get(stream);
    },
  };
})();

/** Establish the provenance a provider retains for one exact journal backend. */
export function establishJournalProvenance(stream: DurableStream): JournalProvenance {
  return journalProvenances.establish(stream);
}

/**
 * Carry an exact source stream's provenance onto a trusted wrapper of it.
 *
 * Preservation is visible composition rather than new authority: it transfers
 * only the witness already associated with that exact source, so an unproven
 * source leaves the target unproven. The target is returned so the wrapping
 * site reads as one expression.
 */
export function preserveJournalProvenance(
  source: DurableStream,
  target: DurableStream,
): DurableStream {
  journalProvenances.preserve(source, target);
  return target;
}

/** @internal The live durable path reads provenance without receiving stream authority. */
export function getJournalProvenance(stream: DurableStream): JournalProvenance | undefined {
  return journalProvenances.get(stream);
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
 *
 * The guard is policy-neutral, so the wrapper it returns is unproven. An
 * authorized wrapping site preserves journal provenance explicitly through
 * {@link preserveJournalProvenance}.
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
}
