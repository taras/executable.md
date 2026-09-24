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
 *
 * "No node" is literal. A body receives a read-only `Surface` carrying the one
 * identity its operations are addressed by, never the Freedom node itself: a
 * body holding the node could create children, remove itself, set props or
 * reach its scope, and the tree's authority over topology would be advisory.
 */

import { createNodeData } from "./vendor/freedom/upstream/index.ts";
import type { Node } from "./vendor/freedom/upstream/index.ts";
import type { Op } from "@bomb.sh/tty";

import type { Layout, Profile, Rect } from "./layout.ts";

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
  /** Which composition this is, which changes what a component may spend room on. */
  readonly profile: Profile;
}

/** The presentation constraints one region of a composed layout is given. */
export function placementOf(layout: Layout, rect: Rect | undefined): Placement {
  return {
    rect: rect ?? { x: 0, y: 0, width: 0, height: 0 },
    dense: layout.dense,
    profile: layout.profile,
  };
}

/**
 * The minimum a body needs to know about itself.
 *
 * One identity, read-only. Not the node — a body cannot reach topology, focus,
 * scope or props through this, which is what keeps the tree authoritative
 * rather than merely conventional.
 */
export interface Surface {
  /**
   * The unique id this component's operations are addressed by.
   *
   * The node's own id, not its name: two nodes may legitimately share a
   * semantic name — the Execution History region is both a pane and the way
   * out of a drawer's trap — and the renderer requires each addressed element
   * to be declared once.
   */
  readonly id: string;
  /** The semantic name, for a body that renders itself differently by role. */
  readonly name: string;
}

/**
 * Where focus is, relative to this node and nothing else.
 *
 * `self` is the focused node. `within` is an ancestor of it. `outside` is
 * everything else. A body is told no more than this: which *descendant* holds
 * focus is not a question a component may ask, because answering it would let a
 * parent draw a child's state and the child would stop owning its own
 * presentation.
 */
export type FocusRelation = "self" | "within" | "outside";

export interface BodyContext<Data> {
  readonly self: Surface;
  /** Where focus is relative to this node, derived while walking the tree. */
  readonly focus: FocusRelation;
  /** This component's own immutable view subtree. */
  readonly data: Data;
  readonly placement: Placement;
  /** The children's operations, already rendered. */
  readonly children: readonly Op[];
}

export type Body<Data> = (context: BodyContext<Data>) => Op[];

interface Attached {
  readonly render: (node: Node, children: readonly Op[], focus: FocusRelation) => Op[];
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
  const self: Surface = { id: node.id, name: node.name === "" ? "root" : node.name };
  node.data.set(bodyKey, {
    render: (_node, children, focus) =>
      body({ self, data: current, placement: where, children, focus }),
  });
  return (next, to) => {
    current = next;
    where = to;
  };
}

/**
 * How a parent presents its own children.
 *
 * Installed by the lifecycle that created the node, which is the one thing
 * holding it. A render body may not receive a Freedom node; a lifecycle may,
 * and presenting children is a lifecycle's work — it is where a parent decides
 * which of its children exist on screen, what each of them is given and where
 * each of them may draw.
 *
 * Nothing walks the tree to do this. Each parent is asked, and asks its own
 * children in turn, so no presentation reaches past a direct child.
 */
export type Presentation<Data> = (data: Data, placement: Placement) => void;

const presenterKey = createNodeData<Presentation<never>>("xmd:repl:presents");

export function presents<Data>(node: Node, presentation: Presentation<Data>): void {
  node.data.set(presenterKey, presentation as Presentation<never>);
}

/**
 * Ask one node to present its own children.
 *
 * A node with no children to place has nothing installed, and this does
 * nothing — a leaf is not a special case.
 */
export function presentOwn<Data>(node: Node, data: Data, placement: Placement): void {
  const presentation = node.data.get(presenterKey);
  presentation?.(data as never, placement);
}

/**
 * One child's box, inside its parent's.
 *
 * The density and the profile are the parent's, because they are facts about
 * the composition a child was placed into. Only the rectangle is the parent's
 * decision, and a child given none has nowhere to draw.
 */
export function within(parent: Placement, rect: Rect | undefined): Placement {
  return {
    rect: rect ?? { x: 0, y: 0, width: 0, height: 0 },
    dense: parent.dense,
    profile: parent.profile,
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
export function walk(node: Node, focused?: Node): Op[] {
  const children: Op[] = [];
  let holds = false;
  for (const child of node.children) {
    children.push(...walk(child, focused));
    if (focused !== undefined && contains(child, focused)) {
      holds = true;
    }
  }
  const relation: FocusRelation =
    focused === undefined ? "outside" : node === focused ? "self" : holds ? "within" : "outside";
  const attached = node.data.get(bodyKey);
  return attached ? attached.render(node, children, relation) : children;
}

/** True where `node` is `target` or one of its ancestors. */
function contains(node: Node, target: Node): boolean {
  for (let at: Node | undefined = target; at; at = at.parent) {
    if (at === node) {
      return true;
    }
  }
  return false;
}
