/**
 * Descriptions in, one mounted Freedom tree out.
 *
 * Reconciliation is the only thing that mounts anything, and Freedom is the
 * only thing it mounts into. There is no second tree, no ownership map and no
 * collection of live components: what exists is exactly the nodes reconciliation
 * created and has not removed, and every question about the interface — what is
 * drawn, what can be focused, where a key goes, who is asking for frames — is
 * answered by walking those nodes.
 *
 * Matching is by key, the way Crank matches keyed children. A description whose
 * key and component both match the node already there keeps that node, and with
 * it the node's Effection scope and everything the branch's lifecycle is holding
 * inside it. A description that names a different component at the same key is a
 * different child, so the old one is unmounted first. A key that stops being
 * described is removed with its whole subtree, and removal is awaited rather
 * than started, because a branch that is merely on its way out is still there.
 *
 * A retained branch is *told* what changed rather than rebuilt. Its new input
 * goes down the same parent-child boundary the first one did, and the delivery
 * completes only once the branch has taken it — so when a reconcile returns,
 * every branch it kept is acting on the input it was just given, not the one
 * before.
 *
 * Nothing is mutated until the whole description tree has been checked. A key
 * has to be unique among one parent's direct children, because two branches
 * answering to one key is a tree that cannot be addressed: the second shadows
 * the first, and the first is then unreachable by the only name anything has
 * for it — never matched again, never removed, mounted for as long as its
 * parent lives.
 */

import { Err, Ok, until, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import { current, focus, focusable } from "../repl-study/vendor/freedom/upstream/index.ts";
import { createNodeData } from "../repl-study/vendor/freedom/upstream/index.ts";
import type { Node } from "../repl-study/vendor/freedom/upstream/index.ts";

import type { ComponentIdentity, Description } from "./component.ts";
import type { Frames } from "./frames.ts";
import { installBranch } from "./input.ts";

/** The key its parent described this node by. */
const KeyOf = createNodeData<string>("xmd:repl-compose:key");

/** The component this node is mounted for, compared by reference. */
const IdentityOf = createNodeData<ComponentIdentity>("xmd:repl-compose:identity");

/** The description this node is currently reconciled to. */
const DescriptionOf = createNodeData<Description>("xmd:repl-compose:description");

/** Two of one parent's direct children answering to one key. */
export class DuplicateKey extends Error {
  readonly key: string;
  /** The component whose children collided, by name. */
  readonly parent: string;

  constructor(parent: string, key: string) {
    super(`${parent} describes two children keyed ${JSON.stringify(key)}; a key names one child`);
    this.name = "DuplicateKey";
    this.key = key;
    this.parent = parent;
  }
}

/**
 * Two branches in unrelated subtrees both asking to hold focus.
 *
 * A location names one place. Claims that lie on one ancestry describe the same
 * place at different depths, which is a drawer inside the surface it opened
 * over; claims that do not describe two, and there is no answer to give.
 */
export class AmbiguousFocus extends Error {
  /** The two claims that are not in each other's ancestry. */
  readonly claims: readonly [string, string];

  constructor(first: string, second: string) {
    super(
      `${JSON.stringify(first)} and ${JSON.stringify(second)} both ask to hold focus, and neither contains the other`,
    );
    this.name = "AmbiguousFocus";
    this.claims = [first, second];
  }
}

/** The key one mounted node was described by, when it was described at all. */
export function keyOf(node: Node): string | undefined {
  return node.data.get(KeyOf);
}

/** One checked description, with its children already checked too. */
interface Planned {
  readonly description: Description;
  readonly children: readonly Planned[];
}

function plan(parent: string, descriptions: readonly Description[]): Result<readonly Planned[]> {
  const seen = new Set<string>();
  const planned: Planned[] = [];
  for (const description of descriptions) {
    if (seen.has(description.key)) {
      return Err(new DuplicateKey(parent, description.key));
    }
    seen.add(description.key);
    const children = plan(description.key, description.children());
    if (!children.ok) {
      return children;
    }
    planned.push({ description, children: children.value });
  }
  return Ok(planned);
}

/**
 * Reconcile one root's children to `descriptions`.
 *
 * The whole description tree is checked before a single node is created,
 * removed or handed new input, so a refusal leaves the mounted tree exactly as
 * it was. It returns once every branch it mounted has said its local state
 * exists and every branch it kept has taken its new input, so what the caller
 * then observes is the whole tree and not a half-built one.
 */
export function* compose(
  root: Node,
  descriptions: readonly Description[],
  frames: Frames,
): Operation<Result<void>> {
  const planned = plan(root.name === "" ? "the root" : root.name, descriptions);
  if (!planned.ok) {
    return planned;
  }
  const focus = claimedBy(planned.value);
  if (!focus.ok) {
    return focus;
  }
  const mounted: Operation<void>[] = [];
  yield* reconcile(root, planned.value, frames, mounted);
  for (const ready of mounted) {
    yield* ready;
  }
  establishFocus(root);
  return Ok();
}

/**
 * Put focus inside the one branch the location is asking for.
 *
 * A description may say that its branch is the one the location wants. Those
 * claims have to describe *one* place, so they are required to lie on a single
 * ancestry: a branch may claim inside a branch that also claims, and the
 * deepest one wins, but two claims in unrelated subtrees name two places at
 * once and are refused before a single node is touched.
 *
 * That is the difference between structure and rendering order. An earlier
 * version flattened every claimant in tree order and took the last, so moving
 * an unrelated sibling moved focus. Here the active branch is found by
 * descending — at each level at most one subtree can hold a claim, which is
 * what the preflight guarantees — so no sibling's position is part of the
 * answer.
 *
 * The active branch is also the *only* place focus can be. Everything outside
 * it stops being a focus target for as long as it is covered: a drawer under
 * another drawer, and the surfaces behind them, remain mounted and keep
 * drawing and keep their lifecycles, and none of them can be reached by Tab or
 * by a pointer. Input still travels their scopes, so a key the top drawer does
 * not claim still bubbles out through them.
 */
function establishFocus(root: Node): void {
  const active = activeBranch(root);
  const branch = active ?? root;
  // A drawer says focus belongs to it *alone*, so nothing outside it can be
  // reached. A surface says only where focus starts and leaves the rest of the
  // interface reachable — trapping traversal inside one region would be a
  // different product, and moving focus across a region boundary is what moves
  // the URL in the first place.
  const alone = active !== undefined && active.data.get(DescriptionOf)?.claimsFocus() === "alone";
  reachable(root, branch, !alone || root === branch);

  const within = focusTargets(branch);
  const anywhere = focusTargets(root);
  const settled = current(root);

  if (within.length === 0) {
    if (anywhere.length > 0 && !anywhere.includes(settled)) {
      focus(anywhere[0]);
    }
    return;
  }

  // Focus moves when it is not already inside the branch being asked for: on a
  // cold mount, when the location names somewhere else, and when the branch
  // that held it was removed. Focus that is already there stays where the
  // person put it.
  if (!within.includes(settled)) {
    focus(within[0]);
  }
}

/**
 * The deepest branch asking for focus, found by descending rather than sorting.
 *
 * At most one child subtree can hold a claim, so which child is visited first
 * cannot change the answer.
 */
function activeBranch(node: Node): Node | undefined {
  let deeper: Node | undefined;
  for (const child of node.children) {
    deeper = activeBranch(child) ?? deeper;
  }
  if (deeper !== undefined) {
    return deeper;
  }
  return node.data.get(DescriptionOf)?.claimsFocus() === "none" ? undefined : node;
}

/** Make exactly the focusable nodes inside the active branch reachable. */
function reachable(node: Node, active: Node, inside: boolean): void {
  const within = inside || node === active;
  const description = node.data.get(DescriptionOf);
  if (description?.focusable === true) {
    if (within) {
      focusable(node);
    } else if ("focused" in node.props) {
      node.unset("focused");
    }
  }
  for (const child of node.children) {
    reachable(child, active, within);
  }
}

/**
 * The deepest claim in a described forest, or the reason there is no one claim.
 *
 * Checked over the whole description tree before anything is created, removed
 * or updated, so a location that names two places at once changes nothing at
 * all rather than mounting half of itself and then discovering the problem.
 */
function claimedBy(planned: readonly Planned[]): Result<Description | undefined> {
  let found: Description | undefined;
  for (const { description, children } of planned) {
    const deeper = claimedBy(children);
    if (!deeper.ok) {
      return deeper;
    }
    // A claim inside a claiming branch is the same place, deeper. A claim
    // beside one is a different place.
    const here = deeper.value ?? (description.claimsFocus() === "none" ? undefined : description);
    if (here !== undefined) {
      if (found !== undefined) {
        return Err(new AmbiguousFocus(found.key, here.key));
      }
      found = here;
    }
  }
  return Ok(found);
}

function* reconcile(
  parent: Node,
  planned: readonly Planned[],
  frames: Frames,
  mounted: Operation<void>[],
): Operation<void> {
  const existing = new Map<string, Node>();
  for (const child of parent.children) {
    const key = child.data.get(KeyOf);
    if (key !== undefined) {
      existing.set(key, child);
    }
  }

  const described = new Set<string>();
  for (const [order, { description, children }] of planned.entries()) {
    described.add(description.key);
    const found = existing.get(description.key);
    if (found !== undefined && found.data.get(IdentityOf) === description.identity) {
      // The same child. It keeps its node, so it keeps its scope, so it keeps
      // whatever its lifecycle is holding — and is told what changed.
      found.data.set(DescriptionOf, description);
      found.set("order", order);
      // The identity above matched, so this description was made by the very
      // component whose branch is mounted here — and `update` reaches that
      // component's own typed channel on this node. The reconciler carries no
      // input of its own and could not substitute one. A branch that never
      // subscribed for updates has no receiver, and this returns at once.
      yield* description.update(found);
      yield* reconcile(found, children, frames, mounted);
      continue;
    }
    if (found !== undefined) {
      // Same key, different component: a different child, and the old one goes
      // before the new one arrives.
      yield* until(found.remove());
    }
    const child = mount(parent, description, order, frames, mounted);
    yield* reconcile(child, children, frames, mounted);
  }

  for (const [key, child] of existing) {
    if (!described.has(key)) {
      yield* until(child.remove());
    }
  }

  parent.sort(byOrder);
}

function mount(
  parent: Node,
  description: Description,
  order: number,
  frames: Frames,
  mounted: Operation<void>[],
): Node {
  const child = parent.createChild(description.name);
  child.data.set(KeyOf, description.key);
  child.data.set(IdentityOf, description.identity);
  child.data.set(DescriptionOf, description);
  child.set("key", description.key);
  child.set("order", order);

  if (description.focusable) {
    focusable(child);
  }

  // Read the description from the node rather than closing over this one, so a
  // branch reconciled to new input answers keys from that input.
  installBranch(child, description.key, (key) => child.data.get(DescriptionOf)?.onPress(key));

  const gate = withResolvers<void>();
  const body = description.start(child, frames, function* ready() {
    gate.resolve();
  });
  if (body === undefined) {
    gate.resolve();
  } else {
    child.scope.run(function* () {
      try {
        yield* body;
      } finally {
        // A lifecycle that returned or was halted without readying releases the
        // gate here, so a forgotten `ready()` is a branch nothing waited for
        // rather than a mount that never finishes.
        gate.resolve();
      }
    });
  }
  mounted.push(gate.operation);
  return child;
}

function byOrder(left: Node, right: Node): number {
  return Number(left.props.order ?? 0) - Number(right.props.order ?? 0);
}

/**
 * What the interface draws, walked out of the same tree that owns it.
 *
 * A parent wraps what its children drew, so presentation is a parent-to-child
 * decision over the mounted tree and a node that is not there contributes
 * nothing — not an empty string, nothing.
 */
export function paint(node: Node): readonly string[] {
  const children: string[] = [];
  for (const child of node.children) {
    children.push(...paint(child));
  }
  return node.data.get(DescriptionOf)?.present(children) ?? children;
}

/** Every focus target in the tree, in tree order, derived rather than remembered. */
export function focusTargets(node: Node): readonly Node[] {
  const found: Node[] = [];
  if ("focused" in node.props) {
    found.push(node);
  }
  for (const child of node.children) {
    found.push(...focusTargets(child));
  }
  return found;
}

/** Every mounted branch's key, in tree order. */
export function topology(node: Node): readonly string[] {
  const found: string[] = [];
  const key = node.data.get(KeyOf);
  if (key !== undefined) {
    found.push(key);
  }
  for (const child of node.children) {
    found.push(...topology(child));
  }
  return found;
}
