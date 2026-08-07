/**
 * One database, one operation at a time.
 *
 * SQLite is reached synchronously, but the operations built on it are not: a
 * transaction holds the database across every `yield*` its body performs. A
 * second operation arriving in that window would run its statements inside
 * somebody else's transaction and commit or roll back with it, so the adapter
 * serializes everything that touches one database rather than relying on
 * callers to take turns.
 *
 * Turns are taken per database file, not per connection. Two handles opened for
 * the same run have two connections, and the second one entering SQLite while
 * the first holds a write lock does not wait politely: `node:sqlite` is
 * synchronous, so it stops the host's event loop for the whole busy timeout —
 * during which the first transaction cannot resume to commit, and the second
 * ends up reporting the database busy. Waiting here instead leaves the host
 * running and lets the first transaction finish. SQLite's own locking remains
 * responsible for contention between processes.
 *
 * Waiting is cancellable and hand-off is synchronous. A caller torn down while
 * queued leaves the queue without ever running its statements, and a caller
 * torn down in the instant between being handed the lock and resuming still
 * passes it on — the two states that would otherwise strand it.
 */

import { ensure, type Operation, resource, withResolvers, type WithResolvers } from "effection";

/** A turn at one database, held for as long as the acquiring scope lives. */
export interface ConnectionLock {
  hold(): Operation<void>;
}

/**
 * The turns for every database one provider has opened.
 *
 * Owned by the provider installation rather than the module, so the
 * coordination lasts exactly as long as the scope that installed the provider
 * and nothing accumulates across runs.
 */
export interface ConnectionLocks {
  at(path: string): ConnectionLock;
}

export function createConnectionLocks(): ConnectionLocks {
  const locks = new Map<string, ConnectionLock>();

  return {
    at(path: string): ConnectionLock {
      const existing = locks.get(path);
      if (existing !== undefined) {
        return existing;
      }
      const created = createConnectionLock();
      locks.set(path, created);
      return created;
    },
  };
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
