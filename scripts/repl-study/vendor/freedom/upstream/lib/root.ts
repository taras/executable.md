import { createQueue, createSignal, ensure, resource, until, useScope } from "effection";
import type { Operation, Scope } from "effection";
import type { Root } from "./types.ts";
import { NodeImpl } from "./node.ts";
import { TreeContext, type TreeState } from "./state.ts";
import { DispatchApi } from "./dispatch.ts";

export function createRoot(owner?: Scope): Root {
  const output = createSignal<void, never>();
  // Internal, always-drained buffer: createRoot is synchronous, so the drain
  // loop subscribes asynchronously — a Queue keeps events dispatched before the
  // loop runs from being lost (bounded, since the loop drains immediately).
  const events = createQueue<unknown, void>();

  let counter = 0;
  const state: TreeState = {
    dirty: false,
    output,
    nodes: new Map(),
    nextId() {
      return `node-${++counter}`;
    },
    markDirty() {
      state.dirty = true;
    },
  };

  const node = new NodeImpl(state.nextId(), "", undefined, owner);
  node.scope.set(TreeContext, state);
  state.nodes.set(node.id, node);

  // Dispatch loop: drain events through the demux middleware chain.
  node.scope.run(function* () {
    while (true) {
      const next = yield* events.next();
      if (next.done) {
        break;
      }
      state.dirty = false;
      yield* DispatchApi.operations.dispatch(next.value);
      if (state.dirty) {
        output.send();
      }
    }
  });

  return {
    node,
    dispatch(event) {
      events.add(event);
    },
    [Symbol.iterator]: output[Symbol.iterator],
    destroy() {
      return node.destroy();
    },
  };
}

/**
 * A tree owned by the scope that acquires it.
 *
 * XMD patch. `createRoot()` alone parents the root scope to Effection `global`,
 * so host context does not reach the tree, a failure in node work raises into a
 * boundary nobody observes, and the caller owns the tree only by remembering to
 * destroy it. Acquiring the root as a resource makes all three structural: the
 * root scope is a child of the calling scope, it inherits that scope's
 * contexts, and teardown joins it.
 *
 * The cleanup is registered before the root exists, because a run halted while
 * acquiring has nothing registered to unwind.
 */
export function useRoot(): Operation<Root> {
  return resource(function* (provide) {
    const owner = yield* useScope();
    let root: Root | undefined;
    yield* ensure(function* () {
      if (root) {
        yield* until(root.destroy());
      }
    });
    root = createRoot(owner);
    yield* provide(root);
  });
}
