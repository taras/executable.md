/**
 * Replay-safe stream — the document output transport (spec §9).
 *
 * An unbuffered channel drops values sent before a consumer subscribes. The
 * replay stream retains its full event history so late subscribers receive
 * every chunk and the close value, and multiple subscribers each get the
 * complete sequence exactly once.
 *
 * Race-free by construction: delivery appends to the history and forwards to
 * every registered subscriber queue in one synchronous step, and a new
 * subscription replays the history into its own queue and registers for live
 * events before yielding — no event can fall between replay and registration.
 */

import { createQueue, ensure } from "effection";
import type { Operation, Queue, Stream } from "effection";

export interface ReplayStream<T, TClose> extends Stream<T, TClose> {
  send(value: T): Operation<void>;
  close(value: TClose): Operation<void>;
}

export function createReplayStream<T, TClose>(): ReplayStream<T, TClose> {
  type Event = IteratorResult<T, TClose>;

  const history: Event[] = [];
  const subscribers = new Set<Queue<T, TClose>>();
  let closed = false;

  function replay(queue: Queue<T, TClose>, event: Event) {
    if (event.done) {
      queue.close(event.value);
    } else {
      queue.add(event.value);
    }
  }

  function deliver(event: Event) {
    if (closed) {
      return;
    }
    closed = event.done === true;
    history.push(event);
    for (const queue of subscribers) {
      replay(queue, event);
    }
  }

  return {
    // deno-lint-ignore require-yield
    *send(value: T) {
      deliver({ done: false, value });
    },
    // deno-lint-ignore require-yield
    *close(value: TClose) {
      deliver({ done: true, value });
    },
    *[Symbol.iterator]() {
      const queue = createQueue<T, TClose>();
      for (const event of history) {
        replay(queue, event);
      }
      subscribers.add(queue);
      yield* ensure(() => {
        subscribers.delete(queue);
      });
      return queue;
    },
  };
}
