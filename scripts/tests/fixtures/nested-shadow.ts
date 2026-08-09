/**
 * Fixture for `local/prefer-effection-operation` — shadowing is lexical.
 *
 * A type parameter and a nested declaration each cover their own scope and
 * nothing beyond it, so the contracts declared after them still name the
 * built-in and are still reported.
 */

export function identity<Generator>(value: Generator): Generator {
  return value;
}

export type EvalBlock = (env: Record<string, unknown>) => Generator<unknown, unknown, unknown>;

export function pull(): string {
  interface AsyncGenerator {
    chunk(): string;
  }

  const source: AsyncGenerator = { chunk: () => "chunk" };

  return source.chunk();
}

export type ReadBlock = (path: string) => AsyncGenerator<unknown, void, unknown>;

export type Wrap<AsyncGenerator> = (value: AsyncGenerator) => AsyncGenerator;
