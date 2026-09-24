/**
 * One event, carried through the tree and the store.
 *
 * The harness and the evidence both go through here, so a case cannot prove a
 * path the interactive run does not take. The order is the whole of the
 * architecture, in five lines:
 *
 * 1. the key is delivered to the focused node, so every branch between the root
 *    and it runs its middleware — and if one of them **consumes** it, that is
 *    the end: no fallback runs a key the hierarchy already answered;
 * 2. otherwise the store decides what the event means, told where focus is
 *    rather than keeping its own answer;
 * 3. the tree carries out whatever the store decided about focus;
 * 4. the tree is brought into line with the new state, mounting and removing
 *    branches;
 * 5. the route follows focus, because the surface segment is what says which
 *    region owns it.
 */

import type { Operation } from "effection";

import { followFocus, reduce } from "./store.ts";
import type { HarnessEvent, ReduceContext, ReplState } from "./store.ts";
import type { FocusIntent } from "./store.ts";
import { focus as focusNode, surfaceOwning } from "./tree.ts";
import type { ReplTree } from "./tree.ts";
import type { Node } from "./vendor/freedom/upstream/index.ts";
import { normalize } from "./input.ts";
import type { Delivery } from "./input.ts";
import type { Mutation } from "./mutations.ts";

/**
 * The nearest focusable ancestor of a node, read off the live tree.
 *
 * Ownership is a question about where a node *is*, so it is asked of the tree.
 * Reconstructing it by parsing the identity string would be a second answer,
 * and a second answer is what this architecture exists to remove.
 */
function ownerOf(tree: ReplTree, node: Node): Node | undefined {
  const reachable = tree.chain();
  for (let at = node.parent; at; at = at.parent) {
    const found = reachable.find((candidate) => candidate === at);
    if (found) {
      return found;
    }
  }
  return undefined;
}

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
  if (intent.kind === "owner") {
    const owner = ownerOf(tree, tree.focused());
    if (owner) {
      focusNode(owner);
    }
    return;
  }
  const target = tree.chain().find((node) => node.name === intent.identity);
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
      // The terminal's event is read once, here, and what travels on is a
      // normalized input. A resize, a frame passing and a record arriving are
      // not things a person did, so they never become one.
      const input = normalize(event);
      const delivered = input === undefined ? undefined : tree.deliver({ state, input, context });
      // A branch on the live ancestor path claimed it. Running the fallback
      // anyway is exactly the defect this ordering exists to prevent: the
      // hierarchy would be annotating the dispatch instead of governing it.
      const reduced =
        delivered?.reduction ??
        (delivered?.delivery.handled === true
          ? { state }
          : reduce(state, event, { ...context, focused: tree.focused().name }));
      const delivery = delivered?.delivery;
      // Topology first, then focus. A narrow composition mounts the surface it
      // routes to, so the node focus is being sent to may not exist until this
      // sync has run — and the one it is leaving may not survive it.
      yield* tree.sync(reduced.state, { mutation: context.mutation, size: context.size });
      applyFocus(tree, reduced.focus);
      // Which surface owns focus is read off the tree, not parsed out of the
      // focused node's name.
      const followed = followFocus(
        reduced.state,
        surfaceOwning(tree.focused()),
        "focus",
        context.mutation,
      );
      yield* tree.sync(followed, { mutation: context.mutation, size: context.size });
      return { state: followed, delivery };
    },
  };
}

export type { Mutation };

/**
 * Put focus where a run is opening.
 *
 * The route's surface says which region owns focus, and a named study frame
 * additionally says which node inside it. Both are addresses; the tree decides
 * whether they are there.
 *
 * The interactive harness and the evidence both enter through here. When they
 * did not, `--frame 12` opened at the frame's location but not its focus, so
 * the footer — an explicit region, whose controls exist only once focus is
 * inside it — drew none of the transport controls that frame is about, and
 * nothing noticed because the evidence entered a different way.
 */
export function enterRoute(tree: ReplTree, state: ReplState, wanted?: string): Operation<void> {
  return {
    *[Symbol.iterator]() {
      const region = tree.chain().find((node) => node.name === `region:${state.route.surface}`);
      if (region) {
        focusNode(region);
      }
      yield* tree.sync(state);
      const target =
        wanted === undefined ? undefined : tree.chain().find((node) => node.name === wanted);
      if (target) {
        focusNode(target);
      }
    },
  };
}
