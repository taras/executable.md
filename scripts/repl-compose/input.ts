/**
 * A key goes to the node that has focus, and an action comes back up.
 *
 * The key is invoked on the focused node's scope, so Effection walks that
 * scope's ancestors and every branch between the root and the control runs its
 * middleware. Ancestors run outermost first, which is why the recorded path
 * reads from the root down to the target.
 *
 * The *answer* travels the other way. Each branch lets the levels below it
 * answer first and claims the key only if none did, so the innermost component
 * that understands a key decides what it means and an ancestor is a fallback
 * rather than an interceptor. What comes back is a typed semantic action, not
 * the keystroke — which is what lets a pointer and a key produce the same
 * action without the component knowing which arrived.
 *
 * A branch that is not mounted has no scope, so it has no middleware on this
 * path at all. That is the whole of why a closed drawer cannot receive input:
 * not a check, an absence.
 */

import { createContext } from "effection";
import { createApi } from "effection/experimental";
import type { Node } from "../repl-study/vendor/freedom/upstream/index.ts";

/** One key, normalized by the host before it reaches the tree. */
export interface KeyPress {
  readonly key: string;
}

/** What a key meant, said semantically. */
export interface Action {
  readonly kind: string;
  /** The key of the component that claimed it. */
  readonly from: string;
}

/** The branches one delivery passed through, outermost first. */
const PathContext = createContext<string[]>("xmd:repl-compose:key-path");

/**
 * One key, delivered to a node.
 *
 * The default answers nothing: a key no mounted branch claimed produced no
 * action, which is a different outcome from a branch claiming it and deciding
 * it means nothing.
 */
export const KeysApi = createApi("xmd:repl-compose:keys", {
  press(node: Node, key: KeyPress): Action | undefined {
    void node;
    void key;
    return undefined;
  },
});

/**
 * Put one mounted branch on the input path.
 *
 * `claim` is read at delivery rather than captured, so a branch reconciled with
 * new input answers from that input.
 */
export function installBranch(
  node: Node,
  name: string,
  claim: (key: KeyPress) => Action | undefined,
): void {
  node.scope.around(KeysApi, {
    press([target, key], next): Action | undefined {
      node.scope.get(PathContext)?.push(name);
      return next(target, key) ?? claim(key);
    },
  });
}

export interface Delivery {
  /** The node the key was delivered to. */
  readonly target: string;
  /** The branches it passed through, outermost first. */
  readonly path: readonly string[];
  /** What it meant, when a mounted branch claimed it. */
  readonly action: Action | undefined;
}

/** Whether the tree rooted at `root` still holds `target`. */
function attached(root: Node, target: Node): boolean {
  if (root === target) {
    return true;
  }
  for (const child of root.children) {
    if (attached(child, target)) {
      return true;
    }
  }
  return false;
}

/**
 * Send one key to a node of the tree.
 *
 * Delivery addresses a *position in the tree*, never a reference somebody kept.
 * That distinction is load-bearing: removing a node detaches it from its parent
 * but leaves the node object, and a disposed Effection scope still carries the
 * interceptors that were installed on it — so a retained reference to a closed
 * drawer's control would otherwise still run that drawer's middleware and
 * answer with an action. A node the tree no longer holds is not a place input
 * can go, and this says so rather than discovering it later.
 *
 * The path is collected on the root's scope rather than returned by the
 * middleware, because middleware that had to return the path could not also use
 * its return value for the action.
 */
export function press(root: Node, target: Node, key: KeyPress): Delivery {
  if (!attached(root, target)) {
    return { target: target.name, path: [], action: undefined };
  }
  const path: string[] = [];
  root.scope.set(PathContext, path);
  const action = KeysApi.invoke(target.scope, "press", [target, key]);
  return { target: target.name, path, action: action ?? undefined };
}
