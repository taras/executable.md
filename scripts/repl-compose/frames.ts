/**
 * One clock, and the branches that are asking it for frames.
 *
 * The host owns the clock. A branch that animates subscribes to it for exactly
 * as long as that branch is mounted, and the number of live subscriptions *is*
 * the demand — there is nothing else to consult and nothing to keep in step.
 * A closed drawer stops demanding frames because its scope is gone, not because
 * something remembered to say so.
 */

import { createSignal, resource } from "effection";
import type { Operation, Subscription } from "effection";

/** What a mounted branch may do with the clock. */
export interface Frames {
  /**
   * Subscribe for this branch's lifetime.
   *
   * It is a resource, so the subscription and the demand it represents both end
   * when the scope that acquired them does.
   */
  subscribe(): Operation<Subscription<number, never>>;
  /** How many mounted branches are asking for frames right now. */
  readonly demand: number;
}

/** The host's side: the same clock, plus the ability to advance it. */
export interface FrameClock extends Frames {
  /** Advance every subscriber by one frame. */
  tick(elapsed: number): void;
}

export function createFrameClock(): FrameClock {
  // A Signal, because the host advances the clock from a timer callback rather
  // than from inside an operation.
  const frames = createSignal<number, never>();
  let demand = 0;

  return {
    get demand(): number {
      return demand;
    },

    tick(elapsed: number): void {
      frames.send(elapsed);
    },

    subscribe(): Operation<Subscription<number, never>> {
      return resource(function* (provide) {
        const subscription = yield* frames;
        demand += 1;
        try {
          yield* provide(subscription);
        } finally {
          demand -= 1;
        }
      });
    },
  };
}
