import type { Scope, Stream } from "effection";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface NodeDataKey<T> {
  readonly symbol: symbol;
  readonly defaultValue?: T;
}

export function createNodeData<T>(
  name: string,
  defaultValue?: T,
): NodeDataKey<T> {
  return { symbol: Symbol(name), defaultValue };
}

export interface NodeData {
  get<T>(key: NodeDataKey<T>): T | undefined;
  set<T>(key: NodeDataKey<T>, value: T): void;
  expect<T>(key: NodeDataKey<T>): T;
}

export interface CreateChildOptions {
  before?: Node;
}

export interface Node {
  readonly id: string;
  readonly name: string;
  readonly props: Record<string, JsonValue>;
  readonly children: Iterable<Node>;
  readonly parent: Node | undefined;
  readonly data: NodeData;
  readonly scope: Scope;
  get(key: string): JsonValue | undefined;
  set(key: string, value: JsonValue): void;
  update(key: string, fn: (prev: JsonValue | undefined) => JsonValue): void;
  unset(key: string): void;
  createChild(name?: string, options?: CreateChildOptions): Node;
  sort(fn?: (a: Node, b: Node) => number): void;
  remove(): Promise<void>;
}

export interface Root extends Stream<void, never> {
  node: Node;
  dispatch(event: unknown): void;
  destroy(): Promise<void>;
}
