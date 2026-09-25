/**
 * A keystroke goes to the node that has focus, and stops where it is consumed.
 *
 * The key is invoked on the focused node's scope, so Effection walks that
 * scope's ancestors and every branch between the root and the control — the
 * drawer, the panel, the surface — runs its middleware in order. Any of them may
 * **consume** the key by not calling `next`, and a consumed key goes no further:
 * no fallback runs it afterwards.
 *
 * That last sentence is the whole point, and an earlier round of this
 * experiment got it wrong. The path was recorded and then the same event was
 * reduced globally regardless, so a branch could intercept a key and watch the
 * global behavior happen anyway — the hierarchy annotated the dispatch instead
 * of governing it.
 *
 * `packages/input/src/lib/input.ts` at the pinned Bombshell commit is the
 * reference this follows.
 */

import { createContext } from "effection";
import { createApi } from "effection/experimental";
import type { Node } from "./vendor/freedom/upstream/index.ts";

import type { Key } from "./store.ts";

/** The branches a dispatch passed through, innermost last. */
const PathContext = createContext<string[]>("xmd:repl:key-path");

/**
 * One keystroke, delivered to a node.
 *
 * The return value is whether the key was **handled**. The default is `false`:
 * nothing between the root and the node claimed it, so the harness's own
 * fallback may run it. Middleware that handles a key returns `true` without
 * calling `next`.
 */
export const KeyboardApi = createApi("xmd:repl:keyboard", {
  keydown(node: Node, key: Key): boolean {
    void node;
    void key;
    return false;
  },
});

/**
 * Record this branch on the path of every key that passes through it.
 *
 * Installed by `tree.ts` when a branch is mounted, and gone when the branch is
 * removed — which is the whole of why a closed panel cannot receive input. It
 * passes every key on: recording is not handling.
 */
export function recordPath(node: Node, name: string): void {
  node.scope.around(KeyboardApi, {
    keydown([target, key], next): boolean {
      node.scope.get(PathContext)?.push(name);
      return next(target, key);
    },
  });
}

export interface Delivery {
  /** The node the key was delivered to. */
  readonly target: string;
  /** The branches it passed through, outermost first. */
  readonly path: readonly string[];
  /** True when something on that path claimed the key. Nothing else may run it. */
  readonly handled: boolean;
}

/**
 * Send one key to whichever node has focus.
 *
 * The path is collected on the root's scope rather than returned by the
 * middleware, because a middleware that had to return it could not also use its
 * return value to say whether it handled the key.
 */
export function sendKey(root: Node, focused: Node, key: Key): Delivery {
  const path: string[] = [];
  root.scope.set(PathContext, path);
  const handled = KeyboardApi.invoke(focused.scope, "keydown", [focused, key]);
  // Ancestors run outermost first, so the recorded order is already the path
  // from the root down to the node.
  return { target: focused.name, path, handled: handled === true };
}
