/**
 * Test Api — contextual operations for testing mode (specs/testing-spec.md).
 *
 * `testing` is the public mode switch: false by default, true beneath
 * `<Testing>` and beneath a `useTesting()` session, which is what makes
 * `xmd test` equivalent to wrapping the entrypoint in `<Testing>`.
 *
 * It is policy, not authority. Middleware may narrow it to false, observe it,
 * refuse, and compose recording behavior around `record`; what an answer of
 * `true` cannot say is that a collector, a final flush and a completion policy
 * exist. That is complete activation, it is package-private, and a `<Test>`
 * proves it separately before it expands anything (`activation.ts`).
 *
 * `record` delegates outward through nested collectors, so every enclosing
 * `<Testing>` boundary and the run-level collector observe each completed
 * test. `boundary` reports each `<Testing>` element's aggregate outcome.
 */

import { type Api, createApi, type Operations } from "@effectionx/context-api";
import type { Operation } from "effection";
import type { EvalScope } from "@effectionx/scope-eval";

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
  /** Whether testing mode is active in the current scope. Replaceable policy. */
  testing: boolean;
  /** Whether expansion is currently inside a `<Test>` body. */
  inTest: boolean;
  /**
   * The eval scope of the `<Test>` being expanded, or undefined outside one.
   *
   * `evalScope` answers with the *nearest* one, and a component invocation
   * installs its own — so something running inside a component in a test reads
   * the invocation's, not the test's. This answers the same from anywhere in
   * the test however deeply nested, which is what lets per-test state be found
   * rather than re-created, and gives that state the test's lifetime.
   */
  testScope: EvalScope | undefined;
  /** Whether assertion reports render during regular execution. */
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

export const Test: Api<TestApi> = createApi<TestApi>("Test", {
  testing: false,
  inTest: false,
  testScope: undefined,
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

export const testing: Operations<TestApi>["testing"] = Test.operations.testing;
export const inTest: Operations<TestApi>["inTest"] = Test.operations.inTest;
export const testScope: Operations<TestApi>["testScope"] = Test.operations.testScope;
export const verbose: Operations<TestApi>["verbose"] = Test.operations.verbose;
export const sessionActive: Operations<TestApi>["sessionActive"] = Test.operations.sessionActive;
export const record: Operations<TestApi>["record"] = Test.operations.record;
export const results: Operations<TestApi>["results"] = Test.operations.results;
export const boundary: Operations<TestApi>["boundary"] = Test.operations.boundary;

/** A document execution failed its testing outcome (test failures or zero tests). */
export class TestFailureError extends Error {
  override name = "TestFailureError";
}
