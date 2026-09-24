/**
 * One clock, as a stream, and the branches that consume it.
 *
 * The host owns the producer: it is the only thing that knows whether anything
 * is still moving, how long the next wait should be, and when the terminal has
 * been given back. What it hands the interface is a `Stream<Frame, never>` —
 * not a callback to register against — so a component consumes time the way it
 * consumes anything else here, with an Effection operation, in a scope that
 * owns it.
 *
 * Everything a branch takes from the clock belongs to the branch: its
 * subscription, and its demand for more frames. Both are released by the scope
 * that ends when the node is removed. There is no registry to keep in step,
 * nothing asking the tree whether a node still exists, and nothing deferred to
 * a later frame. An earlier round had all three, and each of them was a second
 * structure that could disagree with the tree.
 *
 * The producer is a `Channel`, because it sends from inside an operation.
 * `Signal` is for the other direction — a callback arriving from outside
 * Effection — and nothing here is that.
 *
 * Delivery is acknowledged, not timed. `advance` waits for every consumer to
 * say it has applied the frame, so nothing is ever drawn from a moment half the
 * interface has not reached. Waiting a scheduler turn instead would be a guess
 * that happened to be right.
 *
 * This follows `@effection-contrib/raf`: one producer of timestamps, consumed
 * as a stream. The clock is the host's rather than the browser's, because a
 * terminal has no animation frame and the study has to supply time as well as
 * measure it.
 */

import { createChannel, createContext, ensure } from "effection";
import type { Channel, Operation, Stream } from "effection";
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
   * Deliver one frame, and return once every consumer has applied it.
   *
   * Nothing is drawn from a frame half the interface has not reached yet, so
   * this is an operation: the producer hands the moment over and waits to be
   * told it has landed.
   */
  advance(at: number): Operation<void>;
  /** True while at least one branch is still asking to be woken. */
  wanted(): boolean;
  /**
   * Consume frames for as long as this branch exists.
   *
   * The consumer is a task in the node's own scope and the subscription is
   * taken inside it, so the scope that ends when the branch is removed is the
   * scope that closes it. The same scope releases every demand the branch still
   * holds and acknowledges a frame it was halted in the middle of, so a
   * teardown can neither leave the clock running nor leave the producer
   * waiting.
   *
   * This does not return until that task has actually subscribed. A task
   * attaches a turn before it runs, and a caller that mounted a component and
   * advanced the clock in the same turn would otherwise send the first frame to
   * nobody. That is subscribe-before-spawn, arranged so the subscription still
   * belongs to the branch rather than to whoever mounted it.
   */
  animate(node: Node, apply: (frame: Frame) => void): Operation<Animation>;
}

/** What a branch gets for animating: its own demand on the clock. */
export interface Animation {
  /**
   * Ask for the clock while a transition runs.
   *
   * Released when the transition settles, or by the branch's own teardown if it
   * is removed before then. A demand cannot outlive what asked for it.
   */
  want(): () => void;
}

export function createFrames(): Frames {
  const frames = createChannel<Frame, never>();
  const acks = createChannel<void, never>();
  let consumers = 0;
  let demands = 0;
  return {
    stream: frames,
    *advance(at: number) {
      const expected = consumers;
      if (expected === 0) {
        yield* frames.send({ at });
        return;
      }
      // Subscribed to the acknowledgements before the frame goes out, so none
      // of them can be missed between sending and waiting for them.
      const acked = yield* acks;
      yield* frames.send({ at });
      for (let taken = 0; taken < expected; taken += 1) {
        yield* acked.next();
      }
    },
    wanted: () => demands > 0,
    animate(node: Node, apply: (frame: Frame) => void): Operation<Animation> {
      return {
        *[Symbol.iterator]() {
          const held = new Set<() => void>();
          let owing = false;
          const started = createChannel<void, never>();
          const ready = yield* started;
          yield* node.scope.spawn(function* () {
            const subscription = yield* frames;
            yield* ensure(function* () {
              for (const release of [...held]) {
                release();
              }
              consumers -= 1;
              if (owing) {
                // Halted holding a frame. The producer is still counting this
                // one, and an acknowledgement it never gets is a loop that
                // never ends.
                owing = false;
                yield* acks.send();
              }
            });
            consumers += 1;
            yield* started.send();
            for (;;) {
              const next = yield* subscription.next();
              if (next.done) {
                return;
              }
              owing = true;
              apply(next.value);
              yield* acks.send();
              owing = false;
            }
          });
          yield* ready.next();
          return {
            want() {
              demands += 1;
              let released = false;
              const release = (): void => {
                if (released) {
                  return;
                }
                released = true;
                demands -= 1;
                held.delete(release);
              };
              held.add(release);
              return release;
            },
          };
        },
      };
    },
  };
}

/**
 * Where the one service lives for a run.
 *
 * Exported so a caller can install a producer it retains — which is how the
 * evidence keeps hold of the clock while the thing that was animating against
 * it is torn down.
 */
export const FrameContext = createContext<Frames>("xmd:repl:frames");

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

/** How long one transition takes, in the seconds the renderer measures in. */
export const TRANSITION_SECONDS = 0.64;

export function easeInOutCubic(fraction: number): number {
  return fraction < 0.5
    ? 4 * fraction * fraction * fraction
    : 1 - Math.pow(-2 * fraction + 2, 3) / 2;
}
