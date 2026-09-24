/**
 * One clock, as a stream, and the components that animate against it.
 *
 * The host owns the producer: it is the only thing that knows whether anything
 * is still moving, how long the next wait should be, and when the terminal has
 * been given back. What it hands the interface is a `Stream<Frame, never>` —
 * not a callback to register against — so a component consumes time the same
 * way it consumes anything else in this system, with an Effection operation, in
 * a scope that owns it.
 *
 * That is the whole of the lifetime story. A subscription is taken inside a
 * task attached to a Freedom node's scope, so removing the branch closes it.
 * There is no registry to keep in step, nothing asking the tree whether a node
 * still exists, and nothing deferred to a later frame. An earlier round had all
 * three, and each of them was a second structure that could disagree with the
 * tree.
 *
 * What a component does with a frame is its own. The progress of an arriving
 * transcript, the position of a travelling playhead — those live in the
 * component's lifecycle, in its own variables, and its render body reads the
 * resulting snapshot and nothing else.
 *
 * This follows `@effection-contrib/raf`, which is the same shape: one producer
 * of timestamps, consumed as a stream. The clock here is the host's rather than
 * the browser's, because a terminal has no animation frame and the study has to
 * supply time as well as measure it.
 */

import { createContext, createSignal, sleep } from "effection";
import type { Operation, Stream } from "effection";
import type { Node } from "./vendor/freedom/upstream/index.ts";

/** One frame: when it happened, on the one clock the host runs. */
export interface Frame {
  /**
   * Seconds since the producer started.
   *
   * A timestamp rather than a delta, so a component works out its own elapsed
   * time by subtraction and never accumulates one — forty additions of sixteen
   * milliseconds do not land on 640, and a transition that never quite reaches
   * its duration never quite ends.
   */
  readonly at: number;
}

export interface Frames {
  /** The one stream every component animates against. */
  readonly stream: Stream<Frame, never>;
  /**
   * Deliver one frame, and return once every subscriber has taken it.
   *
   * Nothing is drawn from a frame half the interface has not reached yet, so
   * this is an operation: the producer hands the moment over and waits for the
   * consumers before the caller goes on to render it.
   */
  advance(at: number): Operation<void>;
  /**
   * Ask for the clock to keep running.
   *
   * A component that is animating says so and releases when it settles. The
   * host runs the clock while anything still wants it, so an interface with
   * nothing moving schedules nothing at all.
   */
  want(): () => void;
  /** True while at least one component is still animating. */
  wanted(): boolean;
}

export function createFrames(): Frames {
  const signal = createSignal<Frame, never>();
  let wants = 0;
  return {
    stream: signal,
    *advance(at: number) {
      signal.send({ at });
      // Every subscriber takes the frame before anything is drawn from it.
      yield* sleep(0);
    },
    want() {
      wants += 1;
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        wants -= 1;
      };
    },
    wanted: () => wants > 0,
  };
}

const FrameContext = createContext<Frames>("xmd:repl:frames");

/**
 * The one frame service this run animates against.
 *
 * The host installs it before anything is mounted, so the tree's components and
 * the loop that drives them are looking at the same clock. A caller that mounts
 * a tree without one gets a producer of its own — which is what a capture
 * wants: time supplied rather than measured, and nothing shared with any other
 * run.
 */
export function useFrames(): Operation<Frames> {
  return {
    *[Symbol.iterator]() {
      const existing = yield* FrameContext.get();
      if (existing !== undefined) {
        return existing;
      }
      return yield* FrameContext.set(createFrames());
    },
  };
}

/**
 * Consume frames for as long as this branch exists.
 *
 * The consumer is a task in the node's own scope, and the subscription is taken
 * inside it — so the scope that ends when the branch is removed is the scope
 * that closes the subscription. Nothing else has to know it was ever there.
 *
 * A task attaches a turn before it runs, so a caller mounts every consumer it
 * means to have and then lets the scheduler reach them before the first frame.
 * `useReplTree` does exactly that, which is why nothing here has to guess
 * whether it was subscribed in time.
 */
export function animates(
  node: Node,
  frames: Frames,
  apply: (frame: Frame) => void,
): Operation<void> {
  return {
    *[Symbol.iterator]() {
      // A task attaches a turn before it runs, so this does not return until
      // the consumer has actually subscribed. Without that, a caller that
      // mounted a component and advanced the clock in the same turn would send
      // the first frame to nobody — which is the whole of what
      // subscribe-before-spawn is about, arranged so that the subscription
      // still belongs to the branch rather than to whoever mounted it.
      const subscribed = createSignal<void, void>();
      const ready = yield* subscribed;
      yield* node.scope.spawn(function* () {
        const subscription = yield* frames.stream;
        subscribed.send();
        for (;;) {
          const next = yield* subscription.next();
          if (next.done) {
            return;
          }
          apply(next.value);
        }
      });
      yield* ready.next();
    },
  };
}

/** How long one transition takes, in the seconds the renderer measures in. */
export const TRANSITION_SECONDS = 0.64;

export function easeInOutCubic(fraction: number): number {
  return fraction < 0.5
    ? 4 * fraction * fraction * fraction
    : 1 - Math.pow(-2 * fraction + 2, 3) / 2;
}
