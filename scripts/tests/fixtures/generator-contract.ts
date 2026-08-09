/**
 * Fixture for `local/prefer-effection-operation` — the shapes it reports.
 *
 * Every declaration here stands in for Effection work: it yields nothing a
 * consumer could use, or it yields effects. They appear directly, nested inside
 * a callable an operation hands back, as the annotation on an implementation,
 * and through `globalThis`. The effects are Effection's own `Effect` — under
 * its own name, renamed at the import, and restated as a contract the way
 * `DurableEffect` restates it.
 */
import type { Effect, Effect as Performed, Operation } from "effection";

/** The contract restated, the way `packages/durable-streams` restates it. */
interface DurableEffect<T> {
  description: string;
  effectDescription: { type: string; name: string };
  enter(
    resolve: (result: T) => void,
    routine: { scope: unknown },
  ): (resolve: (result: void) => void) => void;
}

interface Retried<T> extends Effect<T> {
  attempts: number;
}

export type EvalBlock = (env: Record<string, unknown>) => Generator<unknown, unknown, unknown>;

export type CompileBlock = (
  source: string,
) => Operation<(env: Record<string, unknown>) => Generator<unknown, unknown, unknown>>;

export function* evaluate(): Generator<unknown, string, unknown> {
  yield undefined;
  return "evaluated";
}

export type Untyped = (env: Record<string, unknown>) => Generator;

export type Loose = (env: Record<string, unknown>) => Generator<any, unknown, unknown>;

export type ReadBlock = (path: string) => AsyncGenerator<unknown, void, unknown>;

export type OpenBlock = (
  path: string,
) => Operation<(chunk: string) => AsyncGenerator<unknown, void, unknown>>;

export async function* read(): AsyncGenerator<unknown, void, unknown> {
  yield undefined;
}

export type Effects<T> = Generator<Effect<unknown>, T, unknown>;

export type Renamed<T> = Generator<Performed<unknown>, T, unknown>;

export type Inherited<T> = Generator<Retried<unknown>, T, unknown>;

export type Mixed<T> = Generator<Effect<unknown> | string, T, unknown>;

export type Workflow<T> = Generator<DurableEffect<unknown>, T, unknown>;

export type Qualified = () => globalThis.Generator<unknown, void, unknown>;

export type QualifiedAsync = () => globalThis.AsyncGenerator<unknown, void, unknown>;
