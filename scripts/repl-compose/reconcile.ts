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
 */

import { sleep, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { createNodeData, focusable } from "../repl-study/vendor/freedom/upstream/index.ts";
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

/** The key one mounted node was described by, when it was described at all. */
export function keyOf(node: Node): string | undefined {
  return node.data.get(KeyOf);
}

/**
 * Reconcile one root's children to `descriptions`.
 *
 * It returns once every branch it mounted has said its local state exists, so
 * what the caller then observes is the whole tree and not a half-built one.
 */
export function* compose(
  root: Node,
  descriptions: readonly Description[],
  frames: Frames,
): Operation<void> {
  const mounted: Operation<void>[] = [];
  yield* reconcile(root, descriptions, frames, mounted);
  for (const ready of mounted) {
    yield* ready;
  }
}

function* reconcile(
  parent: Node,
  descriptions: readonly Description[],
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
  for (const [order, description] of descriptions.entries()) {
    described.add(description.key);
    const found = existing.get(description.key);
    if (found !== undefined && found.data.get(IdentityOf) === description.identity) {
      // The same child. It keeps its node, so it keeps its scope, so it keeps
      // whatever its lifecycle is holding.
      found.data.set(DescriptionOf, description);
      found.set("order", order);
      yield* reconcile(found, description.children(), frames, mounted);
      continue;
    }
    if (found !== undefined) {
      // Same key, different component: a different child, and the old one goes
      // before the new one arrives.
      yield* until(found.remove());
    }
    const child = mount(parent, description, order, frames, mounted);
    yield* reconcile(child, description.children(), frames, mounted);
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
  const body = description.lifecycle(child, frames, function* ready() {
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

/** Let every scope started by the last reconcile settle before observing it. */
export function* settle(): Operation<void> {
  yield* sleep(0);
}
