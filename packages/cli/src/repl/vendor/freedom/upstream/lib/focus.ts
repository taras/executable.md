// oxlint-disable bombshell-dev/no-generic-error

//TODO: export as freedom/focus
import { createContext } from "effection";
import type { Node } from "./types.ts";
import { NodeApi } from "./node.ts";

// A pushed focus root: the boundary cycling is trapped within, the focus to
// restore, and the callback to notify when it is popped (§12).
interface FocusEntry {
  node: Node;
  restore: Node | undefined;
  callback?: (value: unknown) => void;
}

export type PopFocus = (value?: unknown) => void;

// The focus stack lives on the tree root's scope, not module state (§12, FS2).
const FocusStackContext = createContext<FocusEntry[]>("freedom:focus-stack");

function findRoot(node: Node): Node {
  let n = node;
  while (n.parent) {
    n = n.parent;
  }
  return n;
}

// The tree's focus stack, lazily created on the root scope on first use.
function focusStack(node: Node): FocusEntry[] {
  const root = findRoot(node);
  let stack = root.scope.get(FocusStackContext);
  if (!stack) {
    stack = [];
    root.scope.set(FocusStackContext, stack);
  }
  return stack;
}

// The active focus root: the top of the stack, or the tree root (§12.3).
function focusRoot(node: Node): Node {
  const stack = focusStack(node);
  return stack.length > 0 ? stack[stack.length - 1].node : findRoot(node);
}

function focusChain(node: Node): Node[] {
  const result: Node[] = [];
  if ("focused" in node.props) {
    result.push(node);
  }
  for (const child of node.children) {
    result.push(...focusChain(child));
  }
  return result;
}

function successorOf(node: Node): Node | undefined {
  const nodes = focusChain(focusRoot(node));
  if (nodes.length <= 1) {
    return undefined;
  }
  const idx = nodes.indexOf(node);
  if (idx === -1) {
    return undefined;
  }
  return nodes[(idx + 1) % nodes.length];
}

// TODO nename -> setFocusable
export function focusable(node: Node): void {
  if (!("focused" in node.props)) {
    node.set("focused", false);
  }
}

// TODO: rename -> getCurrentFocus()
export function current(node: Node): Node {
  const root = focusRoot(node);
  return focusChain(root).find((n) => n.props.focused === true) ?? root;
}

export function advance(node: Node): void {
  const nodes = focusChain(focusRoot(node));
  if (nodes.length <= 1) {
    return;
  }
  const idx = nodes.findIndex((n) => n.props.focused === true);
  if (idx === -1) {
    return;
  }
  nodes[idx].set("focused", false);
  nodes[(idx + 1) % nodes.length].set("focused", true);
}

export function retreat(node: Node): void {
  const nodes = focusChain(focusRoot(node));
  if (nodes.length <= 1) {
    return;
  }
  const idx = nodes.findIndex((n) => n.props.focused === true);
  if (idx === -1) {
    return;
  }
  nodes[idx].set("focused", false);
  nodes[(idx - 1 + nodes.length) % nodes.length].set("focused", true);
}

export function focus(target: Node): void {
  if (!("focused" in target.props)) {
    throw new Error("Cannot focus a non-focusable node");
  }
  if (!focusChain(focusRoot(target)).includes(target)) {
    throw new Error("Cannot focus a node outside the active focus root");
  }
  if (target.props.focused === true) {
    return;
  }
  const old = focusChain(findRoot(target)).find((n) => n.props.focused === true);
  if (old) {
    old.set("focused", false);
  }
  target.set("focused", true);
}

export function useFocus(node: Node): void {
  const first = focusChain(node).find((n) => n !== node);
  if (first) {
    focus(first);
  }
  node.scope.around(NodeApi, {
    remove([target], next) {
      if (target.props.focused === true) {
        const successor = successorOf(target);
        if (successor && successor !== target) {
          focus(successor);
        }
      }
      return next(target);
    },
  });
}

// Push `node` as the active focus root: cycling is trapped within its focusable
// descendants (§12.4). Returns the bound pop (§12.5).
export function focusPush(
  node: Node,
  callback?: (value: unknown) => void,
): PopFocus {
  const stack = focusStack(node);
  const restore = focusChain(focusRoot(node)).find(
    (n) => n.props.focused === true,
  );
  const entry: FocusEntry = { node, restore, callback };
  stack.push(entry);

  const first = focusChain(node).find((n) => n !== node);
  if (first) {
    focus(first); // seed inside; clears the pre-push focus (FS6)
  } else if (restore) {
    restore.set("focused", false); // empty container: nothing focused (FS6)
  }

  return (value?: unknown) => {
    if (stack[stack.length - 1] !== entry) {
      throw new Error("focus pop out of order (unbalanced push/pop)");
    }
    stack.pop();
    restoreFocus(node, restore);
    if (callback) {
      callback(value);
    }
  };
}

// Restore focus after a pop: the remembered node if still valid, else the first
// focusable descendant of the now-active root, else clear any residual focus.
function restoreFocus(node: Node, restore: Node | undefined): void {
  const root = focusRoot(node);
  const chain = focusChain(root);
  if (restore && chain.includes(restore)) {
    focus(restore);
  } else {
    const first = chain.find((n) => n !== root);
    if (first) {
      focus(first);
    } else {
      const residual = focusChain(findRoot(node)).find(
        (n) => n.props.focused === true,
      );
      if (residual) {
        residual.set("focused", false);
      }
    }
  }
}
