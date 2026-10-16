/**
 * One capability, acquired at most once, owned by the scope that installed it.
 *
 * Shared by the two native providers that hold environment-dependent state for
 * longer than the element that first needed it: the ordinary run's repository
 * provider and a REPL entry's. Installing either must reach nothing — no
 * directory, no lease, no `git`, no identity read — so what each capability
 * costs is paid by the first operation that actually needs it, and by nothing
 * else.
 *
 * Four properties, and each one is why this is not a plain memoized function:
 *
 * - **Single-flight.** The first ask starts the acquisition; an ask that
 *   arrives while it is still running awaits the same task rather than starting
 *   a second. Two concurrent elements share one answer.
 * - **Owned by the installation scope.** The work runs in `owner`, not in
 *   whichever element happened to ask first, and then *suspends* — because a
 *   task that returns releases what it acquired. A temporary directory, a
 *   session and a lease therefore last as long as the owner does, rather than
 *   as long as the element that first needed them.
 * - **Settled answers are answers.** An absent ambient repository and a host
 *   that cannot state a commit identity are values, not failures, and are
 *   remembered as such: the second ask does not rediscover them.
 * - **Nothing half-made is observable.** A caller cancelled while waiting
 *   abandons its own wait and not the acquisition; a failed acquisition is
 *   remembered as failed, and every later ask is told the same thing rather
 *   than retrying into partially made state.
 */

import { race, suspend, withResolvers } from "effection";
import type { Operation, Scope, WithResolvers } from "effection";

export function lazily<T>(owner: Scope, acquire: () => Operation<T>): () => Operation<T> {
  let settled:
    | { readonly ready: WithResolvers<T>; readonly failed: WithResolvers<never> }
    | undefined;
  return function* (): Operation<T> {
    if (settled === undefined) {
      const ready = withResolvers<T>();
      const failed = withResolvers<never>();
      settled = { ready, failed };
      owner.run(function* () {
        let value: T;
        try {
          value = yield* acquire();
        } catch (error) {
          failed.reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        ready.resolve(value);
        // Held for the scope's life. Returning here would end the task, and
        // ending a task releases everything it acquired.
        yield* suspend();
      });
    }
    return yield* race([settled.ready.operation, settled.failed.operation]);
  };
}
