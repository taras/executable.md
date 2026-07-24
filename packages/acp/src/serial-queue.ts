/**
 * Keyed serial queues: each key gets one spawned drain loop that
 * grants slots strictly in arrival order and waits for the holder to
 * finish before granting the next. A slot is a resource — it releases
 * when the acquiring scope exits, on normal, failure, and halt paths
 * alike, including a request halted while it is still queued.
 */

import { createChannel, resource, useScope, withResolvers } from "effection";
import type { Channel, Operation, Scope } from "effection";

interface SlotRequest {
  grant(): void;
  done: Operation<void>;
}

export interface SerialQueues {
  /** Hold this key's slot for the calling scope's lifetime. */
  slot(key: string): Operation<void>;
  /**
   * Hold this key's slot only while `op` runs, in the caller's own
   * scope — for critical sections that must not outlive the operation
   * and must not capture the resources `op` acquires.
   */
  withSlot<T>(key: string, op: () => Operation<T>): Operation<T>;
}

interface Queue {
  channel: Channel<SlotRequest, never>;
  ready: Operation<void>;
}

export function* useSerialQueues(): Operation<SerialQueues> {
  const owner: Scope = yield* useScope();
  const queues = new Map<string, Queue>();

  function* queueFor(key: string): Operation<Queue> {
    const existing = queues.get(key);
    if (existing) {
      return existing;
    }
    const channel = createChannel<SlotRequest, never>();
    // The subscription must belong to the loop task itself — created in
    // a slot holder's scope it would die with that holder. The ready
    // gate keeps sends from racing the subscribe, and the queue is
    // registered before any suspension so concurrent first callers
    // never create duplicate loops.
    const ready = withResolvers<void>();
    const queue: Queue = { channel, ready: ready.operation };
    queues.set(key, queue);
    yield* owner.spawn(function* () {
      const subscription = yield* channel;
      ready.resolve();
      while (true) {
        const next = yield* subscription.next();
        if (next.done) {
          break;
        }
        next.value.grant();
        yield* next.value.done;
      }
    });
    return queue;
  }

  return {
    slot(key) {
      return resource(function* (provide) {
        const queue = yield* queueFor(key);
        yield* queue.ready;
        const granted = withResolvers<void>();
        const done = withResolvers<void>();
        try {
          yield* queue.channel.send({ grant: granted.resolve, done: done.operation });
          yield* granted.operation;
          yield* provide();
        } finally {
          // Covers the queued phase too: a request halted while still
          // waiting resolves done, so the loop advances past it.
          done.resolve();
        }
      });
    },
    *withSlot(key, op) {
      const queue = yield* queueFor(key);
      yield* queue.ready;
      const granted = withResolvers<void>();
      const done = withResolvers<void>();
      try {
        yield* queue.channel.send({ grant: granted.resolve, done: done.operation });
        yield* granted.operation;
        return yield* op();
      } finally {
        done.resolve();
      }
    },
  };
}
