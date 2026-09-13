/**
 * The transport one structural region's output crosses (spec §5.3).
 *
 * A handler asks a region to expand and reads what it produced. Between the two
 * sits this: a stream whose producer does authored work only while somebody is
 * waiting for a chunk, and whose lifetime belongs to the scope that subscribed.
 *
 * ## Demand is the only clock
 *
 * Nothing here buffers output. A producer's `emit` suspends until a consumer's
 * `next()` is waiting, and resolving that one read with that one chunk is the
 * only way a chunk is ever delivered. So a handler that never reads runs no
 * authored body at all, a handler that reads once runs as far as the first
 * chunk, and a body that would print forever cannot outrun the reader.
 *
 * That is why this is not a channel or an output queue. Both accept a send and
 * return: the producer would keep going, and the authored work behind it would
 * happen whether or not anyone wanted the result. A queue of *consumer demand*
 * is a different thing and is what the FIFO below holds — it buffers requests,
 * not products, so concurrent reads are ordered rather than raced.
 *
 * ## The producer belongs to the subscription
 *
 * Each subscription acquires its own resource with its own producer, so two
 * reads of one region are two expansions rather than two views of one. Leaving
 * the scope — a handler returning, failing, or being cancelled — halts that
 * producer and waits for it, which is what stops authored work from outliving
 * the invocation that asked for it.
 *
 * Cancellation stays cancellation: a halted producer never becomes an ordinary
 * failure, and a read halted while waiting takes its demand with it rather than
 * leaving one behind to swallow a later chunk.
 */

import { ensure, Err, Ok, resource, spawn, withResolvers } from "effection";
import type { Operation, Result, Stream, Subscription } from "effection";

import type { ExpansionChunk } from "./execution-declarations.ts";

/**
 * What a region's authored body does with the chunks it renders.
 *
 * `emit` is the whole capability: there is no completion call, no failure call
 * and no handle to the stream. Returning closes the region and throwing fails
 * it, which is what makes a producer an ordinary operation rather than
 * something that has to remember to settle a transport.
 */
export type RegionProducer = (emit: (chunk: ExpansionChunk) => Operation<void>) => Operation<void>;

/** One read waiting for a chunk. */
interface Demand {
  settle(result: IteratorResult<ExpansionChunk, void>): void;
  fail(error: Error): void;
}

/**
 * One region's output, as a stream a handler subscribes to.
 *
 * The stream is re-subscribable by construction: every subscription runs this
 * resource again, so it acquires a fresh producer and shares no history,
 * position or consumed flag with any other. Nothing is refused here — a second
 * subscription is a second expansion, which is the honest answer to asking for
 * one twice.
 */
export function regionStream(produce: RegionProducer): Stream<ExpansionChunk, void> {
  return resource(function* (provide) {
    const demands: Demand[] = [];
    let closed: Result<void> | undefined;
    // The producer waits here when it has a chunk and nobody wants it yet.
    let wanted = withResolvers<void>("region demand");

    function* emit(chunk: ExpansionChunk): Operation<void> {
      while (demands.length === 0) {
        yield* wanted.operation;
      }
      demands.shift()?.settle({ done: false, value: chunk });
    }

    /** Tell a waiting producer that a read is now outstanding. */
    function offer(): void {
      const arrived = wanted;
      wanted = withResolvers<void>("region demand");
      arrived.resolve();
    }

    function settleAll(outcome: Result<void>): void {
      closed = outcome;
      // Copied first: settling a demand can let its reader run and enqueue
      // another, and this list is finished with.
      const waiting = demands.splice(0, demands.length);
      for (const demand of waiting) {
        if (outcome.ok) {
          demand.settle({ done: true, value: undefined });
        } else {
          demand.fail(outcome.error);
        }
      }
    }

    // The producer is this subscription's own, and the `ensure` below is
    // registered after it so teardown halts and joins it before the resource
    // returns — a producer blocked on demand cannot survive the handler that
    // asked for it.
    const producer = yield* spawn(function* () {
      // Authored work starts when the first read does, not when the stream is
      // subscribed: a handler that holds a region and never reads it runs none
      // of its body.
      while (demands.length === 0) {
        yield* wanted.operation;
      }
      try {
        yield* produce(emit);
      } catch (error) {
        // Converted once, here: every later read raises this same object, so a
        // consumer comparing identity across two reads compares one thing. An
        // `Error` thrown by a body passes through `Err` untouched.
        settleAll(Err(error));
        return;
      }
      settleAll(Ok());
    });

    const subscription: Subscription<ExpansionChunk, void> = {
      *next() {
        if (closed !== undefined) {
          if (closed.ok) {
            return { done: true, value: undefined };
          }
          throw closed.error;
        }
        const read = withResolvers<IteratorResult<ExpansionChunk, void>>("region chunk");
        const demand: Demand = { settle: read.resolve, fail: read.reject };
        demands.push(demand);
        offer();
        try {
          return yield* read.operation;
        } finally {
          // Synchronous, and the reason a halted read is not a hole: a demand
          // left behind would be handed the next chunk with nobody to receive
          // it. Removal is idempotent — a settled demand is already gone.
          const index = demands.indexOf(demand);
          if (index >= 0) {
            demands.splice(index, 1);
          }
        }
      },
    };

    yield* ensure(function* () {
      yield* producer.halt();
    });

    yield* provide(subscription);
  });
}
