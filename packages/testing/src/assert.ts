/**
 * Assertion primitives for the testing components (specs/testing-spec.md
 * §Assertions). Every export keeps the operands-first, `msg`-last call shape
 * the ASSERTIONS table is written against.
 *
 * Import these by name rather than through a namespace object: `@types/node`
 * declares them with `asserts` signatures, which trip TS2775 at the call site.
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
 * Node's `AssertionError` takes an options bag rather than a message string —
 * passing a string is a `TypeError`. This is the only place that knows that.
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
  if (msg === undefined) {
    deepStrictEqual(actual, expected);
  } else {
    deepStrictEqual(actual, expected, msg);
  }
}

export function assertNotEquals(actual: unknown, expected: unknown, msg?: string): void {
  if (msg === undefined) {
    notDeepStrictEqual(actual, expected);
  } else {
    notDeepStrictEqual(actual, expected, msg);
  }
}

export function assertStrictEquals(actual: unknown, expected: unknown, msg?: string): void {
  if (msg === undefined) {
    strictEqual(actual, expected);
  } else {
    strictEqual(actual, expected, msg);
  }
}

export function assertNotStrictEquals(actual: unknown, expected: unknown, msg?: string): void {
  if (msg === undefined) {
    notStrictEqual(actual, expected);
  } else {
    notStrictEqual(actual, expected, msg);
  }
}

export function assertMatch(actual: string, expected: RegExp, msg?: string): void {
  if (msg === undefined) {
    match(actual, expected);
  } else {
    match(actual, expected, msg);
  }
}

export function assertNotMatch(actual: string, expected: RegExp, msg?: string): void {
  if (msg === undefined) {
    doesNotMatch(actual, expected);
  } else {
    doesNotMatch(actual, expected, msg);
  }
}

/**
 * The rest have no `node:assert` equivalent. They name the operator and leave
 * the operands to the report, which renders them under its own guarded
 * formatter — formatting here could run a hostile `toString` on a value whose
 * assertion has already passed.
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

/** Generic rather than `unknown` so the relational operators type-check. */

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
