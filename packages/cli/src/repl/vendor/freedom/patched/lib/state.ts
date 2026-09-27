import { createContext, type Signal } from "effection";
import type { NodeImpl } from "./node.ts";

export interface TreeState {
  dirty: boolean;
  output: Signal<void, never>;
  nodes: Map<string, NodeImpl>;
  nextId(): string;
  markDirty(): void;
}

export const TreeContext = createContext<TreeState>("freedom:tree");
