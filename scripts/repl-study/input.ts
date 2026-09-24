/**
 * One thing a person did, delivered to the node it is aimed at.
 *
 * The terminal is read in one place and normalized once. What travels from
 * there is a `ReplInput` — a key, or a pointer landing on a cell — and nothing
 * below this boundary parses an escape sequence or reads a decoder's shape
 * again.
 *
 * The input is invoked on the target node's scope, so Effection walks that
 * scope's ancestors and every branch between the root and the target — the
 * drawer, the panel, the region — runs its middleware in order. Any of them may
 * **handle** it by returning `true` without calling `next`, and a handled input
 * goes no further: no root fallback runs an input the hierarchy already
 * answered.
 *
 * That last sentence is the whole point, and an earlier round of this
 * experiment got it wrong. The path was recorded and then the same event was
 * reduced globally regardless, so a branch could intercept a key and watch the
 * global behavior happen anyway — the hierarchy annotated the dispatch instead
 * of governing it.
 *
 * Middleware receives no node. The lifecycle that installed it already holds
 * the node it is for, and a handler that was handed one could act on a part of
 * the tree it has no business in.
 *
 * `packages/input/src/lib/input.ts` at the pinned Bombshell commit is the
 * reference this follows.
 */

import { createContext } from "effection";
import { createApi } from "effection/experimental";
import type { Node } from "./vendor/freedom/upstream/index.ts";

import { asKey } from "./store.ts";
import type { HarnessEvent, Key, Pointer } from "./store.ts";

/** The branches a dispatch passed through, innermost last. */
const PathContext = createContext<string[]>("xmd:repl:input-path");

/** The node this input was aimed at, for the branches it passes on the way. */
const TargetContext = createContext<Node>("xmd:repl:input-target");

/**
 * True where the input travelling through was aimed at this node itself.
 *
 * Middleware runs outermost first, so a region sees an activation meant for a
 * control inside it before the control does. Without this a band would answer
 * its own children's buttons. The node comes from the lifecycle that installed
 * the middleware, never from the input.
 */
export function aimedAt(node: Node): boolean {
  return node.scope.get(TargetContext) === node;
}

export type ReplInput =
  | { readonly kind: "key"; readonly key: Key }
  /**
   * A pointer that no terminal sent.
   *
   * Mouse reporting is never enabled — #838 decided that, and a terminal left
   * reporting movement is the loudest way this experiment could damage the
   * thing it is borrowing. A pointer here is synthetic: it exists to prove that
   * activating a control with it and activating it with the keyboard are the
   * same act by the time either reaches an action.
   */
  | { readonly kind: "pointer"; readonly pointer: Pointer };

/**
 * One input, delivered to a node.
 *
 * The return value is whether it was **handled**. The default is `false`:
 * nothing between the root and the node claimed it, so the root's own fallback
 * may read it. Middleware that handles an input returns `true` without calling
 * `next`.
 */
export const ReplInputApi = createApi("xmd:repl:input", {
  handle(input: ReplInput): boolean {
    void input;
    return false;
  },
});

/**
 * The terminal's event, read once.
 *
 * Only a keystroke and a synthetic pointer are input. A resize, a frame passing
 * and a record arriving from a running execution are things that happened *to*
 * the interface, not things a person did to it, so they never become input and
 * never reach a node.
 */
export function normalize(event: HarnessEvent): ReplInput | undefined {
  if (event.kind === "key") {
    const key = asKey(event.event);
    return key.type === "keydown" ? { kind: "key", key } : undefined;
  }
  if (event.kind === "pointer") {
    return { kind: "pointer", pointer: event.pointer };
  }
  return undefined;
}

/**
 * True where this input is an activation of whatever it reached.
 *
 * Enter, Space and a primary pointer are one gesture with three spellings. A
 * control tests this and nothing else, which is why its keyboard and its
 * pointer behavior cannot drift apart: there is one branch, not two.
 */
export function activation(input: ReplInput): boolean {
  if (input.kind === "pointer") {
    return input.pointer.button === "primary";
  }
  return input.key.code === "Enter" || input.key.code === "Space" || input.key.text === " ";
}

/**
 * Record this branch on the path of every input that passes through it.
 *
 * Installed by `tree.ts` when a branch is mounted, and gone when the branch is
 * removed — which is the whole of why a closed panel cannot receive input. It
 * passes everything on: recording is not handling.
 */
export function recordPath(node: Node, name: string): void {
  node.scope.around(ReplInputApi, {
    handle([input], next): boolean {
      node.scope.get(PathContext)?.push(name);
      return next(input);
    },
  });
}

export interface Delivery {
  /** The node the input was delivered to. */
  readonly target: string;
  /** The branches it passed through, outermost first. */
  readonly path: readonly string[];
  /** True when something on that path claimed it. Nothing else may run it. */
  readonly handled: boolean;
}

/**
 * Send one input to one node.
 *
 * The path is collected on the root's scope rather than returned by the
 * middleware, because a middleware that had to return it could not also use its
 * return value to say whether it handled the input.
 */
export function sendInput(root: Node, target: Node, input: ReplInput): Delivery {
  const path: string[] = [];
  root.scope.set(PathContext, path);
  root.scope.set(TargetContext, target);
  const handled = ReplInputApi.invoke(target.scope, "handle", [input]);
  // Ancestors run outermost first, so the recorded order is already the path
  // from the root down to the node.
  return { target: target.name, path, handled: handled === true };
}
