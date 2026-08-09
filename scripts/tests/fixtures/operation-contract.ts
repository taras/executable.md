/**
 * Fixture for `local/prefer-effection-operation` — the shapes it accepts.
 *
 * Effection work is declared as `Operation<T>` however it is implemented. A
 * generator that really does serve a consumer names what it yields, and saying
 * so is enough — whether it is spelled as a concrete generator or as one of the
 * iterator interfaces.
 */
import type { Operation } from "effection";

export type EvalBlock = (env: Record<string, unknown>) => Operation<unknown>;

export type CompileBlock = (
  source: string,
) => Operation<(env: Record<string, unknown>) => Operation<unknown>>;

export function* inferred() {
  yield undefined;
  return "evaluated";
}

export function* annotated(): Operation<string> {
  yield undefined;
  return "evaluated";
}

export function* numbers(): Generator<number, void, unknown> {
  yield 1;
}

export type NumberSource = () => Generator<number, void, unknown>;

export type ChunkSource = (path: string) => AsyncGenerator<string, void, unknown>;

export type Walk = (root: string) => IterableIterator<string>;

export type Step = (root: string) => Iterator<string, void, unknown>;

export type Stream = (root: string) => AsyncIterableIterator<string>;

export type Pull = (root: string) => AsyncIterator<string, void, unknown>;
