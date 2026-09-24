/**
 * A keystroke goes to the node that has focus, not to the application.
 *
 * The first attempt reduced every key globally: one `reduce()` read the key,
 * looked focus up in a flat list, and decided. Nothing about where the focused
 * control actually *was* could take part in that decision, so a drawer could
 * not intercept a key for its own controls without the global reducer being
 * taught about drawers.
 *
 * Here the key is invoked on the focused node's scope. Effection walks that
 * scope's ancestors, so every branch between the root and the control — the
 * drawer, the panel, the surface — gets its middleware run in order, and any of
 * them can handle the key or pass it on. The path is the tree's, and it is
 * recorded so the evidence can read it rather than infer it.
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
 * Middleware installed on a branch's scope sees every key bound for anything
 * inside it, which is what makes a drawer able to answer for its own controls.
 */
export const KeyboardApi = createApi("xmd:repl:keyboard", {
  keydown(node: Node, key: Key): void {
    // The default: nothing between the root and the node claimed it.
    void node;
    void key;
  },
});

/**
 * Record this branch on the path of every key that passes through it.
 *
 * Installed by `tree.ts` when a branch is mounted, and gone when the branch is
 * removed — which is the whole of why a closed panel cannot receive input.
 */
export function recordPath(node: Node, name: string): void {
  node.scope.around(KeyboardApi, {
    keydown([target, key], next): void {
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
}

/**
 * Send one key to whichever node has focus.
 *
 * The path is collected on the root's scope rather than returned by the
 * middleware, because a middleware that had to return it could not also pass
 * the key on unchanged.
 */
export function sendKey(root: Node, focused: Node, key: Key): Delivery {
  const path: string[] = [];
  root.scope.set(PathContext, path);
  KeyboardApi.invoke(focused.scope, "keydown", [focused, key]);
  // Ancestors run outermost first, so the recorded order is already the path
  // from the root down to the node.
  return { target: focused.name, path };
}
