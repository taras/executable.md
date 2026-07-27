/**
 * The route slot (specs/test-agent-spec.md §Scenario instances). Scenario
 * routes reach the ACPX registry through one mutable field, so the provider's
 * registry-dependent work has to hold this slot while its own route is pinned.
 *
 * One spawned drain loop grants the slot in arrival order and waits for the
 * holder to finish before granting the next. The holder's operation runs in
 * the caller's own scope, so resources it acquires — a turn, a worker — belong
 * to the caller and outlive the critical section.
 */

import { createChannel, useScope, withResolvers } from "effection";
import type { Operation, Scope } from "effection";

interface SlotRequest {
  grant(): void;
  done: Operation<void>;
}

export interface RouteSlot {
  /** Hold the slot only while `op` runs. */
  withSlot<T>(op: () => Operation<T>): Operation<T>;
}

export function* useRouteSlot(): Operation<RouteSlot> {
  const owner: Scope = yield* useScope();
  const requests = createChannel<SlotRequest, never>();
  // The subscription must belong to the loop task itself — created in a
  // holder's scope it would die with that holder. The ready gate keeps sends
  // from racing the subscribe.
  const ready = withResolvers<void>();
  yield* owner.spawn(function* () {
    const subscription = yield* requests;
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

  return {
    *withSlot(op) {
      yield* ready.operation;
      const granted = withResolvers<void>();
      const done = withResolvers<void>();
      try {
        yield* requests.send({ grant: granted.resolve, done: done.operation });
        yield* granted.operation;
        return yield* op();
      } finally {
        // Reached on the normal, failure, and halt paths alike, so a holder
        // that never completes still advances the queue.
        done.resolve();
      }
    },
  };
}
