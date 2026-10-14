/**
 * Serialize all access to one provider-owned database connection.
 * Transactions suspend, so synchronous SQLite calls alone cannot prevent another
 * operation from joining and committing or rolling back somebody else's work.
 * Handles for one run share this cooperative lock; SQLite coordinates processes.
 *
 * Cancellation removes queued turns before they execute. Synchronous hand-off marks
 * the next turn granted before waking it, so cancellation between grant and resume
 * still releases the lock rather than stranding it.
 */

import { ensure, type Operation, resource, type WithResolvers, withResolvers } from "effection";

/** A turn at one database, held for as long as the acquiring scope lives. */
export interface ConnectionLock {
  hold(): Operation<void>;
}

interface Turn {
  readonly gate: WithResolvers<void>;
  granted: boolean;
}

export function createConnectionLock(): ConnectionLock {
  let held = false;
  const waiting: Turn[] = [];

  function release(): void {
    const next = waiting.shift();
    if (next === undefined) {
      held = false;
      return;
    }
    // Granting synchronously is what closes the window: a scope torn down
    // after this line and before it resumes still sees `granted` and passes
    // the lock on rather than leaving it held by nobody.
    next.granted = true;
    next.gate.resolve();
  }

  return {
    hold: () =>
      resource<void>(function* (provide) {
        const turn: Turn = { gate: withResolvers<void>(), granted: false };

        yield* ensure(() => {
          if (turn.granted) {
            release();
            return;
          }
          const index = waiting.indexOf(turn);
          if (index >= 0) {
            waiting.splice(index, 1);
          }
        });

        if (held) {
          waiting.push(turn);
          yield* turn.gate.operation;
        } else {
          held = true;
          turn.granted = true;
        }

        yield* provide();
      }),
  };
}
