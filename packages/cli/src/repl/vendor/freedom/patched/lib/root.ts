import { createQueue, createSignal, ensure, until, useScope } from "effection";
import type { Operation, Scope } from "effection";
import type { Root } from "./types.ts";
import { NodeImpl } from "./node.ts";
import { TreeContext, type TreeState } from "./state.ts";
import { DispatchApi } from "./dispatch.ts";

// PATCH executablemd/caller-owned-root: `options.scope`. Without an owner the
// root scope is parented to Effection's `global`.
export function createRoot(options?: { scope?: Scope }): Root {
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

  const node = new NodeImpl(state.nextId(), "", undefined, options?.scope);
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
 * PATCH executablemd/caller-owned-root: the owned surface.
 *
 * The root is a child of the scope that asked for it, so it inherits that
 * scope's contexts, node work that fails raises into an owner that can see it,
 * and the whole tree is destroyed when that owner ends. `createRoot()` remains
 * for an integration with no Effection scope to belong to, and its caller owns
 * calling `destroy()`.
 *
 * Cleanup is registered before the root exists: a halt during registration has
 * nothing to release, while a root created first could be left undestroyed.
 */
export function* useRoot(): Operation<Root> {
  const scope = yield* useScope();
  let root: Root | undefined;
  yield* ensure(function* () {
    if (root !== undefined) {
      yield* until(root.destroy());
    }
  });
  root = createRoot({ scope });
  return root;
}
