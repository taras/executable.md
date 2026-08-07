/**
 * One connection, one operation at a time.
 *
 * SQLite is reached synchronously, but the operations built on it are not: a
 * transaction holds the connection across every `yield*` its body performs. A
 * second operation arriving in that window would run its statements inside
 * somebody else's transaction and commit or roll back with it, so the adapter
 * serializes everything that touches one connection rather than relying on
 * callers to take turns.
 *
 * Waiting is cancellable and hand-off is synchronous. A caller torn down while
 * queued leaves the queue without ever running its statements, and a caller
 * torn down in the instant between being handed the lock and resuming still
 * passes it on — the two states that would otherwise strand it.
 */

import { ensure, type Operation, resource, withResolvers, type WithResolvers } from "effection";

/** A turn at the connection, held for as long as the acquiring scope lives. */
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
