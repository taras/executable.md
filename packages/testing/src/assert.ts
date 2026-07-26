/**
 * Assertion primitives for the testing vocabulary (specs/testing-spec.md
 * §Assertions).
 *
 * These came from `@std/assert`, which npm serves as `@jsr/std__assert` from
 * npm.jsr.io. That was the only JSR-sourced runtime dependency in the whole
 * published graph, and it made `npm install @executablemd/cli` fail against the
 * default registry — a package cannot fix that for its users, because npm reads
 * `@jsr:registry` from the consumer's own configuration and strips `.npmrc`
 * from published tarballs. `node:assert/strict` is a builtin under Node, Deno
 * and Bun, so the dependency simply disappears.
 *
 * Every export keeps the call shape the vocabulary already used — operands
 * first, optional `msg` last — so the ASSERTIONS table is unchanged. Failure
 * message text is Node's and is not kept byte-compatible with @std; the
 * rendered diagnostic (see `buildDiagnostic`) is what this package promises,
 * and it prints the operands itself.
 *
 * INVARIANT, pinned by the hostile-value tests in tests/assertions.test.ts:
 * an assertion must never format its operands before its outcome is decided.
 * Operands are arbitrary user values whose getters, `toJSON`, `toString` or
 * custom-inspect hooks may throw. Every helper below decides first and returns
 * early on success; none of them formats an operand at all — the diagnostic
 * layer already renders `actual` and `expected` through its own guarded
 * formatter.
 *
 * Named imports are deliberate: `@types/node` declares these with `asserts`
 * signatures, which trip TS2775 when called through a namespace object.
 */

import {
  AssertionError,
  deepStrictEqual,
  doesNotMatch,
  match,
  notDeepStrictEqual,
  notStrictEqual,
  ok,
  strictEqual,
} from "node:assert/strict";

export { AssertionError };

/**
 * Build an assertion failure. Node's `AssertionError` takes an options bag
 * rather than a string, and this is the only place that knows it.
 */
export function assertionError(message: string): AssertionError {
  return new AssertionError({ message, operator: "fail", stackStartFn: assertionError });
}

/** Throw an assertion failure. */
export function fail(message: string): never {
  throw assertionError(message);
}

export function assert(expr: unknown, msg?: string): void {
  ok(expr, msg);
}

export function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  deepStrictEqual(actual, expected, msg);
}

export function assertNotEquals(actual: unknown, expected: unknown, msg?: string): void {
  notDeepStrictEqual(actual, expected, msg);
}

export function assertStrictEquals(actual: unknown, expected: unknown, msg?: string): void {
  strictEqual(actual, expected, msg);
}

export function assertNotStrictEquals(actual: unknown, expected: unknown, msg?: string): void {
  notStrictEqual(actual, expected, msg);
}

export function assertMatch(actual: string, expected: RegExp, msg?: string): void {
  match(actual, expected, msg);
}

export function assertNotMatch(actual: string, expected: RegExp, msg?: string): void {
  doesNotMatch(actual, expected, msg);
}

/**
 * The helpers below have no `node:assert` equivalent. Each states the operator
 * and defers the operand values to the diagnostic, which renders them under a
 * guarded formatter.
 */

export function assertFalse(expr: unknown, msg?: string): void {
  if (expr) {
    fail(msg ?? "Expected actual to be falsy");
  }
}

export function assertExists(actual: unknown, msg?: string): void {
  if (actual === undefined || actual === null) {
    fail(msg ?? "Expected actual to not be null or undefined");
  }
}

export function assertStringIncludes(actual: string, expected: string, msg?: string): void {
  if (!actual.includes(expected)) {
    fail(msg ?? "Expected actual to contain expected");
  }
}

/**
 * Ordering comparisons are generic rather than `unknown` so the relational
 * operators type-check on opaque operands, matching the signature the
 * vocabulary was written against.
 */

export function assertGreater<T>(actual: T, expected: T, msg?: string): void {
  if (!(actual > expected)) {
    fail(msg ?? "Expected actual to be greater than expected");
  }
}

export function assertGreaterOrEqual<T>(actual: T, expected: T, msg?: string): void {
  if (!(actual >= expected)) {
    fail(msg ?? "Expected actual to be greater than or equal to expected");
  }
}

export function assertLess<T>(actual: T, expected: T, msg?: string): void {
  if (!(actual < expected)) {
    fail(msg ?? "Expected actual to be less than expected");
  }
}

export function assertLessOrEqual<T>(actual: T, expected: T, msg?: string): void {
  if (!(actual <= expected)) {
    fail(msg ?? "Expected actual to be less than or equal to expected");
  }
}
