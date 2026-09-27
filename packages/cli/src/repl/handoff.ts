/**
 * How a description reaches the tree, and how its author learns it arrived.
 *
 * One parent, one handoff. `next()` hands over a complete desired child set and
 * resolves only once reconciliation has committed *that exact* set. Not a tick
 * later, not when a queue accepted it, not when a promise somebody detached
 * settled — after the commit, with that commit's outcome. A parent that
 * described children and then acted as though they were mounted, on the
 * strength of a scheduler turn, is the defect this exists to make impossible.
 *
 * ## The commit belongs to the caller
 *
 * The work runs in the calling operation's own lifetime rather than in a worker
 * this module owns. That is what makes cancellation mean something: an offer
 * still waiting its turn is abandoned by leaving the line, and nothing it
 * described is ever mounted. A worker holding the offer would carry on
 * committing a tree whose author is gone, and flipping a flag before the commit
 * starts does not help once the commit itself has suspended.
 *
 * Offers are serialized by a lock rather than a queue, and the lock is handed
 * directly from one holder to the next, so there is no window in which two
 * commits are halfway through one tree. Releasing is synchronous and happens in
 * a `finally`, so a cancelled holder cannot strand everyone behind it.
 *
 * Tearing the handoff down settles nothing in the future: a `next()` afterwards
 * is refused immediately rather than waiting for a turn that will not come.
 */

import { Err, action, resource } from "effection";
import type { Operation, Result } from "effection";

import type { ReplDescription } from "./description.ts";

/** The handoff is over, and nothing more will be committed through it. */
export class ReplHandoffClosedError extends Error {
  constructor() {
    super("this handoff is closed, so the description it was given was never mounted.");
    this.name = "ReplHandoffClosedError";
  }
}

/** One parent's channel into reconciliation. */
export interface ReplHandoff<Action> {
  /** Offer a complete child set, and learn what committing it did. */
  next(descriptions: readonly ReplDescription<Action>[]): Operation<Result<void>>;
}

/** What a handoff does with an offer once it reaches the front of the line. */
export type ReplCommit<Action> = (
  descriptions: readonly ReplDescription<Action>[],
) => Operation<Result<void>>;

export function useReplHandoff<Action>(commit: ReplCommit<Action>): Operation<ReplHandoff<Action>> {
  return resource(function* (provide) {
    let closed = false;
    let busy = false;
    const waiting: (() => void)[] = [];

    /** Take the lock, waiting for it if somebody else has it. */
    function take(): Operation<void> {
      return action<void>(function (resolve) {
        if (!busy) {
          busy = true;
          resolve();
          return () => {};
        }
        waiting.push(resolve);
        return () => {
          // Cancelled while waiting its turn: leave the line, and the tree
          // never hears about this offer at all.
          const at = waiting.indexOf(resolve);
          if (at !== -1) {
            waiting.splice(at, 1);
          }
        };
      });
    }

    /** Hand the lock straight to whoever is next, or put it down. */
    function release(): void {
      const next = waiting.shift();
      if (next === undefined) {
        busy = false;
        return;
      }
      next();
    }

    try {
      yield* provide({
        *next(descriptions: readonly ReplDescription<Action>[]): Operation<Result<void>> {
          if (closed) {
            return Err(new ReplHandoffClosedError());
          }
          yield* take();
          try {
            if (closed) {
              return Err(new ReplHandoffClosedError());
            }
            return yield* commit(descriptions);
          } finally {
            release();
          }
        },
      });
    } finally {
      closed = true;
      // Everyone still in line learns there is no turn coming rather than
      // waiting for one.
      for (const resume of waiting.splice(0)) {
        resume();
      }
    }
  });
}
