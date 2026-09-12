/**
 * How a structural handler reads one child region's output (spec §6.1).
 *
 * The transport is a rendezvous rather than a buffer. A producer that ran ahead
 * of its consumer would turn a pane's output into an accumulating queue, and a
 * handler that stopped reading would leave that work running behind it. Here
 * the producer delivers one chunk and stays suspended until the consumer
 * advances past it, so what has been produced is exactly what has been taken.
 *
 * Nothing here reaches `DocumentOutput`. A region's chunks travel to whoever
 * asked for them and nowhere else, and no default writer copies an unconsumed
 * region into the root.
 */

import { resource, spawn, withResolvers } from "effection";
import type { Operation, Stream, Subscription } from "effection";

import type { ExpansionChunk } from "./expansion-request.ts";

/** What the producer published, and the acknowledgement that releases it. */
interface Offer {
  readonly result: IteratorResult<ExpansionChunk, void>;
  /** Resolved by the consumer's *next* advance, not by taking this result. */
  readonly release?: () => void;
  readonly failure?: Error;
}

/**
 * One chunk in flight between a producer and a consumer.
 *
 * The producer's `deliver` completes only once the consumer has asked for
 * something after the delivered chunk, which is what makes the delivery a
 * rendezvous instead of a hand-off into a queue.
 */
class RegionRendezvous {
  /** Published before the consumer asked. At most one: the producer suspends. */
  #queued: Offer | undefined;
  #waiting: ReturnType<typeof withResolvers<Offer>> | undefined;
  /** The delivery the consumer is currently holding, released on its next ask. */
  #holding: (() => void) | undefined;

  #publish(offer: Offer): void {
    const waiting = this.#waiting;
    if (waiting !== undefined) {
      this.#waiting = undefined;
      waiting.resolve(offer);
      return;
    }
    this.#queued = offer;
  }

  *deliver(chunk: ExpansionChunk): Operation<void> {
    const acknowledged = withResolvers<void>();
    this.#publish({
      result: { value: chunk, done: false },
      release: () => acknowledged.resolve(),
    });
    yield* acknowledged.operation;
  }

  finish(): void {
    this.#publish({ result: { value: undefined, done: true } });
  }

  fail(failure: Error): void {
    this.#publish({ result: { value: undefined, done: true }, failure });
  }

  subscribe(): Subscription<ExpansionChunk, void> {
    return {
      next: () => this.#next(),
    };
  }

  *#next(): Operation<IteratorResult<ExpansionChunk, void>> {
    // Releasing here rather than where the chunk was taken is the whole
    // contract: the producer stays suspended across the consumer's use of the
    // chunk it delivered, and resumes only when the consumer asks for another.
    const holding = this.#holding;
    this.#holding = undefined;
    if (holding !== undefined) {
      holding();
    }

    const offer = yield* this.#take();
    if (offer.failure !== undefined) {
      throw offer.failure;
    }
    if (offer.release !== undefined) {
      this.#holding = offer.release;
    }
    return offer.result;
  }

  *#take(): Operation<Offer> {
    const queued = this.#queued;
    if (queued !== undefined) {
      this.#queued = undefined;
      return queued;
    }
    const waiting = withResolvers<Offer>();
    this.#waiting = waiting;
    return yield* waiting.operation;
  }
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/** What one region's content produces, chunk by chunk. */
export type RegionProducer = (
  deliver: (chunk: ExpansionChunk) => Operation<void>,
) => Operation<void>;

/**
 * Establish one region's producer in the calling handler's scope.
 *
 * The producer is spawned with the resource, so leaving the handler's scope,
 * cancelling it, or failing inside it halts and joins the producer and
 * everything it started. Production itself waits for the first subscription, so
 * a handler that asks for a region's stream and never reads it starts no work.
 *
 * A failure the producer raised is delivered to the consumer after every chunk
 * the consumer already acknowledged, rather than replacing them.
 */
export function regionStream(produce: RegionProducer): Operation<Stream<ExpansionChunk, void>> {
  return resource(function* (provide) {
    const rendezvous = new RegionRendezvous();
    const started = withResolvers<void>();
    let subscribed = false;

    yield* spawn(function* () {
      yield* started.operation;
      try {
        yield* produce((chunk) => rendezvous.deliver(chunk));
      } catch (error) {
        rendezvous.fail(asError(error));
        return;
      }
      rendezvous.finish();
    });

    const stream: Stream<ExpansionChunk, void> = {
      // deno-lint-ignore require-yield
      *[Symbol.iterator]() {
        if (!subscribed) {
          subscribed = true;
          started.resolve();
        }
        return rendezvous.subscribe();
      },
    };

    yield* provide(stream);
  });
}
