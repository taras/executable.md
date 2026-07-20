/**
 * Test Api — contextual operations for testing mode (specs/testing-spec.md).
 *
 * `testing` is the activation switch: false by default, true beneath
 * `<Testing>` (or root activation via `executeDocument({ testing: true })`).
 * Both perform the identical `Test.around({ testing: () => true })` install,
 * which is what makes `xmd test` equivalent to wrapping the entrypoint in
 * `<Testing>`.
 *
 * `record` delegates outward through nested collectors, so every enclosing
 * `<Testing>` boundary and the run-level collector observe each completed
 * test. `boundary` reports each `<Testing>` element's aggregate outcome.
 */

import { createApi } from "@effectionx/context-api";
import type { Operation } from "effection";

/** A completed test, in discovery order. Never holds rendered markdown. */
export interface TestResult {
  status: "pass" | "fail";
  name?: string;
  /** "path:line:column" ("line:column" for dynamically scanned sources). */
  location: string;
  error?: {
    kind: "assertion" | "timeout" | "teardown" | "error";
    message: string;
    actual?: string;
    expected?: string;
  };
}

/** Aggregate outcome of one `<Testing>` boundary. */
export interface BoundaryOutcome {
  tests: number;
  failed: number;
}

export interface TestApi {
  /** Whether testing mode is active in the current scope. */
  testing: boolean;
  /** Whether expansion is currently inside a `<Test>` body. */
  inTest: boolean;
  /** Whether assertion diagnostics render during regular execution. */
  verbose: boolean;
  /** Whether a useTesting() session is already active in this scope. */
  sessionActive: boolean;
  /** Record a completed test. Collectors delegate outward via `next`. */
  record(result: TestResult): Operation<void>;
  /** Completed tests recorded by the nearest collector, discovery order. */
  results(): Operation<TestResult[]>;
  /** Report a `<Testing>` boundary's aggregate outcome. */
  boundary(outcome: BoundaryOutcome): Operation<void>;
}

export const Test = createApi<TestApi>("Test", {
  testing: false,
  inTest: false,
  verbose: false,
  sessionActive: false,
  // deno-lint-ignore require-yield
  *record(_result: TestResult): Operation<void> {},
  // deno-lint-ignore require-yield
  *results(): Operation<TestResult[]> {
    return [];
  },
  // deno-lint-ignore require-yield
  *boundary(_outcome: BoundaryOutcome): Operation<void> {},
});

export const { testing, inTest, verbose, sessionActive, record, results, boundary } =
  Test.operations;

/** A document execution failed its testing outcome (test failures or zero tests). */
export class TestFailureError extends Error {
  override name = "TestFailureError";
}
