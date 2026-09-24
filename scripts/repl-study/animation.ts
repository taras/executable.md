/**
 * One clock, and the components that animate against it.
 *
 * The host owns *when* a frame happens: it is the only thing that knows whether
 * anything is still moving, how long the next wait should be, and when the
 * terminal has been given back. Everything else asks this service for frames
 * and is told; nothing else schedules one.
 *
 * What a component does with a frame is its own. The progress of an arriving
 * transcript, the position of a travelling playhead — those live in the
 * component's lifecycle, in its own variables, and its render body reads the
 * resulting snapshot and nothing else. An earlier round computed every one of
 * them centrally and threaded the answer down through the presentation, which
 * is the same second structure the focus rework removed: a number worked out
 * somewhere else, free to disagree with the thing it described.
 *
 * Delivery is **synchronous**. A frame is a moment in time, and the component
 * has to have moved before the picture of that moment is drawn — a subscription
 * that woke a turn later would render the frame before last, and a capture
 * would record a screen no viewer ever saw.
 */

import { createContext, ensure, suspend } from "effection";
import type { Operation } from "effection";
import type { Node } from "./vendor/freedom/upstream/index.ts";

/** One frame's worth of time, in the unit the renderer measures transitions in. */
export interface Frame {
  readonly deltaSeconds: number;
}

export type Listener = (frame: Frame) => void;

export interface FrameService {
  /** Subscribe until the release is called. */
  listen(listener: Listener): () => void;
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
  /** Deliver one frame. The host calls this; nothing else does. */
  advance(deltaSeconds: number): void;
}

export function createFrameService(): FrameService {
  const listeners = new Set<Listener>();
  let wants = 0;
  return {
    listen(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
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
    advance(deltaSeconds) {
      for (const listener of [...listeners]) {
        listener({ deltaSeconds });
      }
    },
  };
}

const FrameContext = createContext<FrameService>("xmd:repl:frames");

/**
 * The one frame service this run animates against.
 *
 * The host installs it before anything is mounted, so the tree and the loop
 * that drives it are looking at the same clock. A caller that mounts a tree
 * without one gets a service of its own — which is what a capture wants: time
 * supplied rather than measured, and nothing shared with any other run.
 */
export function useFrames(): Operation<FrameService> {
  return {
    *[Symbol.iterator]() {
      const existing = yield* FrameContext.get();
      if (existing !== undefined) {
        return existing;
      }
      return yield* FrameContext.set(createFrameService());
    },
  };
}

/**
 * Subscribe one node's own scope to the clock.
 *
 * The subscription belongs to the node: it is created in the node's scope and
 * released when that scope ends, so removing a branch takes its animation with
 * it. Nothing has to remember to unsubscribe, because there is nowhere for the
 * registration to outlive the thing it was for.
 */
export function animates(node: Node, service: FrameService, listener: Listener): void {
  // Subscribed **now**, not on the next turn. A task spawned into a scope does
  // not begin until the scheduler gets one, and a frame loop that renders
  // without yielding never gives it one — the whole journey ran with nothing
  // subscribed and nothing moved.
  //
  // The node's scope owns the registration and releases it when the branch
  // goes. It cannot be the *only* thing that does, for the same reason: a
  // branch removed before that task ever started would be halted with nothing
  // registered to release. So the clock also asks the tree, which is the
  // authority on what exists, and a node that is no longer in it is not woken
  // again.
  let release = (): void => {};
  release = service.listen((frame) => {
    if (!attached(node)) {
      release();
      return;
    }
    listener(frame);
  });
  const owned = release;
  node.scope.run(function* () {
    yield* ensure(owned);
    yield* suspend();
  });
}

/** True while this node is still reachable from the tree it was mounted in. */
function attached(node: Node): boolean {
  for (let at: Node = node; at.parent !== undefined; at = at.parent) {
    let found = false;
    for (const child of at.parent.children) {
      if (child === at) {
        found = true;
        break;
      }
    }
    if (!found) {
      return false;
    }
  }
  return true;
}

/** How long one transition takes, in the seconds the renderer measures in. */
export const TRANSITION_SECONDS = 0.64;

/**
 * How close to the end counts as the end.
 *
 * Elapsed time is accumulated a frame at a time, so forty sixteen-millisecond
 * steps land a few parts in 10^16 short of the 640 they add up to. A transition
 * that close to its duration has ended: there is no frame left to draw the
 * difference in, and waiting for exact equality would leave one running for
 * ever.
 */
export const SETTLED_SECONDS = 1e-9;

export function easeInOutCubic(fraction: number): number {
  return fraction < 0.5
    ? 4 * fraction * fraction * fraction
    : 1 - Math.pow(-2 * fraction + 2, 3) / 2;
}
