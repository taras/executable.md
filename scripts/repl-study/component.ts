/**
 * The smallest component interface this experiment could find.
 *
 * A component is a **render body attached to a Freedom node**. Mounting one
 * creates a node beneath its rendered parent; the node's scope owns its
 * focusability, its input middleware and its disposable local state, and its
 * `data` carries the body. Rendering walks that same tree: each parent wraps
 * its already-rendered children in terminal operations.
 *
 * That is the whole of it, and the shape is the pinned Bombshell example's. It
 * matters because it leaves nothing for a second structure to be: there is no
 * focus-target list to return, no ownership map to keep in step and no
 * interaction registry to consult. Removing the node removes the rendering, the
 * focusables, the middleware and the local state together, because they were
 * never anywhere else.
 *
 * A component is handed its own immutable view subtree and nothing else — no
 * journal, no store, no node, no geometry beyond the box its parent gives it,
 * and no callback. What it wants to happen it says as an action.
 */

import { createNodeData } from "./vendor/freedom/upstream/index.ts";
import type { Node } from "./vendor/freedom/upstream/index.ts";
import type { Op } from "@bomb.sh/tty";

import type { Rect } from "./layout.ts";

/**
 * What a parent tells a child about where it may draw.
 *
 * Parents own the visibility, order and placement of their direct children, so
 * a child receives its box rather than measuring the screen. It is the only
 * geometry that crosses the boundary, and it arrives from the parent rather
 * than from a layout a child looked up for itself.
 */
export interface Placement {
  readonly rect: Rect;
  /** True where the pane is at its floor and secondary detail is dropped. */
  readonly dense: boolean;
}

export interface BodyContext<Data> {
  readonly node: Node;
  /** This component's own immutable view subtree. */
  readonly data: Data;
  readonly placement: Placement;
  /** The children's operations, already rendered. */
  readonly children: readonly Op[];
}

export type Body<Data> = (context: BodyContext<Data>) => Op[];

interface Attached {
  readonly render: (node: Node, children: readonly Op[]) => Op[];
}

const bodyKey = createNodeData<Attached>("xmd:repl:body");

/** Hand a mounted component new data, without replacing the node. */
export type Update<Data> = (data: Data, placement: Placement) => void;

/**
 * Attach a body to a node, closing over the data and placement it was given.
 *
 * The updater comes back typed rather than living on the node behind an
 * `unknown`: whoever mounted the component knows its data's shape, and nothing
 * else needs to. Handing new data through it keeps the node — and with it the
 * node's identity, its focus, its middleware and its generator-local state —
 * which is what preserving unchanged nodes across an immutable update means in
 * practice.
 */
export function attach<Data>(
  node: Node,
  body: Body<Data>,
  data: Data,
  placement: Placement,
): Update<Data> {
  let current = data;
  let where = placement;
  node.data.set(bodyKey, {
    render: (self, children) => body({ node: self, data: current, placement: where, children }),
  });
  return (next, to) => {
    current = next;
    where = to;
  };
}

export function hasBody(node: Node): boolean {
  return node.data.get(bodyKey) !== undefined;
}

/**
 * Render the tree, depth first, each parent wrapping its rendered children.
 *
 * A node without a body contributes its children's operations unchanged, which
 * is what lets a purely structural node — a routing outlet, a focus root — exist
 * without drawing anything.
 */
export function walk(node: Node): Op[] {
  const children: Op[] = [];
  for (const child of node.children) {
    children.push(...walk(child));
  }
  const attached = node.data.get(bodyKey);
  return attached ? attached.render(node, children) : children;
}
