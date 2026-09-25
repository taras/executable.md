/**
 * One clock, and the branches that are asking it for frames.
 *
 * The host owns the clock. A branch that animates subscribes to it for exactly
 * as long as that branch is mounted, and the number of live subscriptions *is*
 * the demand — there is nothing else to consult and nothing to keep in step.
 * A closed drawer stops demanding frames because its scope is gone, not because
 * something remembered to say so.
 *
 * Advancing the clock is an operation that completes, not a send that returns
 * at once. When `advance()` returns, every branch that was subscribed has
 * applied that timestamp, so whatever reads the tree next — a render walk, an
 * assertion — sees that frame rather than the one before it. A host that cannot
 * tell when a frame has landed can only guess, and drawing on a guess is how a
 * frame comes out half old.
 */

import type { Operation } from "effection";

import { useHandoff } from "./handoff.ts";
import type { Receiver } from "./handoff.ts";

/** What a mounted branch may do with the clock. */
export interface Frames {
  /**
   * Subscribe for this branch's lifetime.
   *
   * It is a resource, so the subscription and the demand it represents both end
   * when the scope that acquired them does.
   */
  subscribe(): Operation<Receiver<number>>;
  /** How many mounted branches are asking for frames right now. */
  readonly demand: number;
}

/** The host's side: the same clock, plus the ability to advance it. */
export interface FrameClock extends Frames {
  /** Advance to one timestamp, completing once every subscriber has applied it. */
  advance(timestamp: number): Operation<void>;
}

/**
 * One clock, owned by the scope that acquires it.
 *
 * The receivers it is holding are state, so the clock is acquired rather than
 * constructed: when the scope that asked for it ends, so does what it was
 * keeping.
 */
export function* useFrameClock(): Operation<FrameClock> {
  const frames = yield* useHandoff<number>();
  return {
    get demand(): number {
      return frames.demand;
    },
    subscribe: () => frames.receive(),
    advance: (timestamp: number) => frames.deliver(timestamp),
  };
}
