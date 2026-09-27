/**
 * One clock for the whole screen, and nobody drawing ahead of anybody else.
 *
 * Animation needs a timestamp, and a timestamp that different parts of the
 * screen read at different moments is two animations pretending to be one. So
 * there is exactly one frame stream, the host owns it, and it is
 * **acknowledged**: the next timestamp is not published until every subscriber
 * has applied the current one. Nothing can run a frame ahead, and nothing can
 * fall a frame behind without holding the rest back — which is the visible,
 * debuggable failure rather than a silent drift.
 *
 * ## Subscription is the demand
 *
 * There is no start and no stop. A subscription is a resource, and holding one
 * is what asks for frames; releasing it withdraws the request. When the last
 * one goes, the stream is settled and **no timer is scheduled at all** — an
 * idle REPL costs nothing, which a stream that kept ticking into an empty
 * subscriber set would not.
 *
 * ## Who owns an animation that spans components
 *
 * The nearest common ancestor of everything taking part, and only it. A
 * participant that subscribed for itself would keep its own clock running after
 * a sibling left, and a distant ancestor would hold the timer alive for a
 * subtree that stopped animating. The ancestor in between is the one whose
 * lifetime matches the animation's, so a claim from anywhere else is refused.
 *
 * `delta` is in **seconds**, because that is what the layout engine's
 * transitions take; handing it milliseconds runs every transition 1000x fast.
 */

import { type Api, createApi } from "@effectionx/context-api";
import {
  Err,
  ensure,
  Ok,
  type Operation,
  resource,
  type Result,
  sleep,
  spawn,
  withResolvers,
} from "effection";

/** Sixty frames a second, as seconds. */
export const FRAME_INTERVAL = 1 / 60;

/** The host clock, so a test can hold time still and count what was scheduled. */
export interface ReplClockApi {
  /** Now, in seconds. */
  now(): Operation<number>;
  /** Wait this many seconds. */
  wait(seconds: number): Operation<void>;
}

export const ReplClock: Api<ReplClockApi> = createApi<ReplClockApi>("ReplClock", {
  // deno-lint-ignore require-yield
  *now(): Operation<number> {
    return performance.now() / 1000;
  },
  *wait(seconds: number): Operation<void> {
    yield* sleep(Math.max(0, Math.round(seconds * 1000)));
  },
});

/** One published frame. */
export interface ReplFrameTick {
  /** Monotonic from one, so a subscriber can say which frame it applied. */
  readonly id: number;
  /** The host clock, in seconds. */
  readonly at: number;
  /** Seconds since the previous frame. Zero for the first. */
  readonly delta: number;
}

/**
 * An ancestry as the composition kernel reports one: the node itself first,
 * its root last.
 */
export type ReplAncestry = readonly string[];

/** Who wants frames, and for what. */
export interface ReplFrameRequest {
  /** The node claiming ownership. */
  readonly owner: string;
  /** The ancestry of each participant, one entry per participating node. */
  readonly participants: readonly ReplAncestry[];
}

/** A claim that is not the nearest common ancestor of its participants. */
export class ReplFrameOwnerError extends Error {
  constructor(owner: string, expected: string | undefined) {
    super(
      expected === undefined
        ? `${owner} claimed an animation whose participants share no ancestor, so nothing can own it`
        : `${owner} claimed an animation owned by ${expected}, the nearest common ancestor of its ` +
            `participants`,
    );
    this.name = "ReplFrameOwnerError";
  }
}

/** One subscriber's view of the stream. */
export interface ReplFrameSubscription {
  /**
   * The next frame.
   *
   * Receiving one is not applying it. Applying a timestamp means laying out and
   * rendering with it, and that suspends — so a stream that counted the return
   * of `next()` as the acknowledgement would publish the following frame while
   * this one was still being drawn, which is the drift the acknowledgement
   * exists to prevent.
   */
  next(): Operation<ReplFrameTick>;
  /**
   * Say the received frame has been applied.
   *
   * Until every subscriber says so, the stream publishes nothing further.
   */
  acknowledge(): void;
  /** The last frame this subscriber acknowledged. */
  applied(): number;
  /** The last frame this subscriber received, applied or not. */
  received(): number;
}

/** The one stream. */
export interface ReplFrames {
  /**
   * Ask for frames for as long as the result is held.
   *
   * A refused claim registers no demand at all, so holding an `Err` keeps no
   * timer alive.
   */
  subscribe(request: ReplFrameRequest): Operation<Result<ReplFrameSubscription>>;
  /** Whether anything is currently asking for frames. */
  demanded(): boolean;
  /** How many frames the host has published. */
  published(): number;
  /** Subscribers that have received or owe the current frame but not applied it. */
  outstanding(): number;
}

/**
 * The nearest common ancestor of some participants, or none.
 *
 * Ancestries arrive node-first, so the shared *suffix* is the shared ancestry;
 * reversing makes it a prefix, and the last element of the common prefix is the
 * nearest one.
 */
export function nearestCommonAncestor(participants: readonly ReplAncestry[]): string | undefined {
  if (participants.length === 0) {
    return undefined;
  }
  const paths = participants.map((ancestry) => [...ancestry].reverse());
  const [first, ...rest] = paths;
  let shared = 0;
  while (shared < first.length && rest.every((path) => path[shared] === first[shared])) {
    shared += 1;
  }
  return shared === 0 ? undefined : first[shared - 1];
}

interface Subscriber {
  /** The last frame acknowledged. */
  applied: number;
  /** The last frame handed over, which may still be being drawn. */
  received: number;
  waiting: { resolve(tick: ReplFrameTick): void } | undefined;
}

/** Open the frame stream for the calling scope. */
export function useReplFrames(interval: number = FRAME_INTERVAL): Operation<ReplFrames> {
  return resource<ReplFrames>(function* (provide) {
    let ticks = 0;
    let current: ReplFrameTick | undefined;
    let previous: number | undefined;
    const live = new Set<Subscriber>();
    let outstanding = new Set<Subscriber>();
    let gate = withResolvers<void>();

    /** Let the driver reconsider: demand or acknowledgement changed. */
    function nudge(): void {
      gate.resolve();
    }

    yield* spawn(function* driver(): Operation<void> {
      while (true) {
        if (live.size === 0 || outstanding.size > 0) {
          // Settled, or still waiting on somebody. Either way there is nothing
          // to schedule, so this suspends on the gate rather than on a timer.
          yield* gate.operation;
          gate = withResolvers<void>();
          continue;
        }
        yield* ReplClock.operations.wait(interval);
        if (live.size === 0) {
          continue;
        }
        const at = yield* ReplClock.operations.now();
        ticks += 1;
        const tick: ReplFrameTick = Object.freeze({
          id: ticks,
          at,
          delta: previous === undefined ? 0 : at - previous,
        });
        previous = at;
        current = tick;
        outstanding = new Set(live);
        for (const subscriber of live) {
          const waiter = subscriber.waiting;
          subscriber.waiting = undefined;
          waiter?.resolve(tick);
        }
      }
    });

    yield* provide({
      subscribe(request) {
        return resource<Result<ReplFrameSubscription>>(function* (give) {
          const expected = nearestCommonAncestor(request.participants);
          if (expected !== request.owner) {
            // Nothing registered, so an unheld claim cannot keep the stream
            // awake while its holder waits for a frame that will never come.
            yield* give(Err(new ReplFrameOwnerError(request.owner, expected)));
            return;
          }

          const subscriber: Subscriber = { applied: 0, received: 0, waiting: undefined };
          // Registered before the subscriber is anywhere the driver can see it.
          // Adding first would put a subscriber in the demand set with no way to
          // take it back out, and a cancellation there leaves the stream awake
          // for something that has already gone.
          yield* ensure(function* () {
            live.delete(subscriber);
            // Its demand goes; its acknowledgement does not arrive. A cancelled
            // subscriber did not apply the frame it was holding, and saying it
            // did would be the stream lying about what is on screen.
            outstanding.delete(subscriber);
            // Leaving can be what finally completes a frame, and it is always
            // what settles the stream.
            nudge();
          });

          live.add(subscriber);
          if (current !== undefined) {
            // Joining mid-flight owes the current frame like everyone else.
            outstanding.add(subscriber);
          }
          nudge();

          yield* give(
            Ok({
              *next(): Operation<ReplFrameTick> {
                if (current !== undefined && subscriber.received !== current.id) {
                  const tick = current;
                  subscriber.received = tick.id;
                  return tick;
                }
                const waiter = withResolvers<ReplFrameTick>();
                subscriber.waiting = waiter;
                const tick = yield* waiter.operation;
                subscriber.received = tick.id;
                return tick;
              },
              acknowledge(): void {
                if (subscriber.received === subscriber.applied) {
                  return;
                }
                subscriber.applied = subscriber.received;
                outstanding.delete(subscriber);
                nudge();
              },
              applied(): number {
                return subscriber.applied;
              },
              received(): number {
                return subscriber.received;
              },
            }),
          );
        });
      },
      demanded(): boolean {
        return live.size > 0;
      },
      published(): number {
        return ticks;
      },
      outstanding(): number {
        return outstanding.size;
      },
    });
  });
}
