/**
 * What admits a provisional session: work that went beyond the retained prefix.
 *
 * A session reconstructing from history is provisional until something proves
 * the run reached new work — a queued Agent turn, a question, a fresh record.
 * The announcement that proves it is sent on a `Signal`, and a Signal delivers
 * only to subscriptions that are already active: whatever it sends before one
 * exists is dropped, not buffered.
 *
 * `spawn()` returns before its child body has run, so a consumer that
 * subscribes as its first act subscribes a turn too late. The subscription
 * therefore belongs to the caller, which creates it before starting the work
 * that can announce; this consumer only iterates what it was handed. Values
 * sent after `yield* stream` returns are queued for that active subscription
 * even while the consumer has not begun reading, which is exactly the window
 * this closes.
 */

import type { Operation, Subscription } from "effection";

/**
 * Iterate an already-active subscription, admitting on every value that counts.
 *
 * Takes the subscription rather than the stream, so there is no way to write
 * the consumer that creates its own: the race this exists to prevent cannot be
 * reintroduced without changing the signature.
 */
export function consumeAdmissions<T>(
  subscription: Subscription<T, never>,
  admits: (value: T) => boolean,
  admit: () => void,
): () => Operation<void> {
  return function* (): Operation<void> {
    let next = yield* subscription.next();
    while (!next.done) {
      if (admits(next.value)) {
        admit();
      }
      next = yield* subscription.next();
    }
  };
}
