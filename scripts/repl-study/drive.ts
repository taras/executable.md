/**
 * One event, carried through the tree and the store.
 *
 * The harness and the evidence both go through here, so a case cannot prove a
 * path the interactive run does not take. The order is the whole of the
 * architecture, in five lines:
 *
 * 1. the key is delivered to the focused node, so every branch between the root
 *    and it runs its middleware;
 * 2. the store decides what the event means, told where focus is rather than
 *    keeping its own answer;
 * 3. the tree carries out whatever the store decided about focus;
 * 4. the tree is brought into line with the new state, mounting and removing
 *    branches;
 * 5. the route follows focus, because the surface segment is what says which
 *    region owns it.
 */

import type { Operation } from "effection";

import { asKey, followFocus, reduce } from "./store.ts";
import type { HarnessEvent, ReduceContext, ReplState } from "./store.ts";
import type { FocusIntent } from "./store.ts";
import { focus as focusNode } from "./tree.ts";
import type { ReplTree } from "./tree.ts";
import { sendKey } from "./keys.ts";
import type { Delivery } from "./keys.ts";
import type { Mutation } from "./mutations.ts";

/** Carry out what the store decided about focus. The tree performs it. */
export function applyFocus(tree: ReplTree, intent: FocusIntent | undefined): void {
  if (intent === undefined) {
    return;
  }
  if (intent.kind === "advance") {
    tree.advance();
    return;
  }
  if (intent.kind === "retreat") {
    tree.retreat();
    return;
  }
  const wanted = intent.kind === "to" ? intent.identity : undefined;
  const target = tree.chain().find((node) => node.name === wanted);
  if (target) {
    focusNode(target);
  }
}

export interface Driven {
  readonly state: ReplState;
  /** Where the key went, and through what. Absent for a non-key event. */
  readonly delivery?: Delivery;
}

export function drive(
  tree: ReplTree,
  state: ReplState,
  event: HarnessEvent,
  context: Omit<ReduceContext, "focused">,
): Operation<Driven> {
  return {
    *[Symbol.iterator]() {
      const delivery =
        event.kind === "key"
          ? sendKey(tree.root.node, tree.focused(), asKey(event.event))
          : undefined;
      const reduced = reduce(state, event, { ...context, focused: tree.focused().name });
      applyFocus(tree, reduced.focus);
      yield* tree.sync(reduced.state, context.mutation);
      const followed = followFocus(reduced.state, tree.focused().name, "focus", context.mutation);
      yield* tree.sync(followed, context.mutation);
      return { state: followed, delivery };
    },
  };
}

export type { Mutation };
