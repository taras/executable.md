/**
 * Component registration (specs/testing-spec.md).
 *
 * `<Testing>`, `<Test>`, the value assertions and `<AssertThrows>` are all
 * registered as ordinary non-reserved defaults, so a repository component of
 * any of those names replaces it. The `Component.expand` install below claims
 * nothing — it is kept until the legacy-removal slice retires the surface.
 *
 * Installing also decorates the core Execution Api so explicit `<Testing>`
 * boundaries affect the execution outcome even when root testing is inactive.
 *
 * Registration is distinct from activation: installing the components
 * leaves `testing` false, so `<Test>` skips and assertions stay usable.
 * Root activation is `useTesting()`'s job.
 *
 * Installs are scope-local — call this inside a bounded scope (one CLI
 * command element, one `scoped()` block).
 */

import { Err } from "effection";
import type { Operation } from "effection";
import { Component, registerComponents, Execution } from "@executablemd/core";
import type {
  ComponentFailure,
  ComponentRegistration,
  DocumentExecution,
} from "@executablemd/core";
import { boundary, record, Test, TestFailureError } from "./test-api.ts";
import type { BoundaryOutcome, TestResult } from "./test-api.ts";
import { readCompletedRun } from "./journal.ts";
import { ASSERTION_PROPS, ASSERTIONS, assertionComponent, capturesFor } from "./assertions.ts";
import { AssertThrows, ASSERT_THROWS_PROPS, createTestHandlers } from "./handlers.ts";
import { Testing, TESTING_PROPS } from "./testing-component.ts";
import {
  absorbTestFailure,
  RaisedSegmentError,
  createTest,
  failureDiagnostic,
  flushStaged,
  formatLocation,
  Staging,
  TEST_PROPS,
} from "./test-component.ts";
import type { TestHandlers } from "./handlers.ts";

const TEST_TIMEOUT_MS = 20_000;

export function* installTestingComponents(options?: { verbose?: boolean }): Operation<void> {
  yield* installHandlers(createTestHandlers({ timeoutMs: TEST_TIMEOUT_MS }), options);
}

/**
 * Install a specific handler set. Internal seam: tests inject handlers built
 * with a short timeout; the public path always uses the fixed 20 seconds.
 */
export function* installHandlers(
  handlers: TestHandlers,
  options?: { verbose?: boolean },
): Operation<void> {
  if (options?.verbose) {
    yield* Test.around({ verbose: () => true });
  }
  // Scope-local, so two sessions never share staged work.
  yield* Staging.set({ staged: [] });
  // A teardown failure arrives after `<Test>` has returned — the invocation
  // boundary is outside the component — so it is folded into that test's staged
  // result here, before the result is journaled.
  yield* Component.around({
    *handleFailure([failure], next) {
      if (failure.name !== "Test") {
        return yield* next(failure);
      }
      // A nested <Test> fails by the ENCLOSING test's interceptor throwing, so
      // its invocation failing is how that test fails — not an outcome of its
      // own. Left to the enclosing test, which is already recording it.
      if (carriesRaisedSegment(failure.error)) {
        return yield* next(failure);
      }
      const location = formatLocation(failure);
      const result = yield* absorbTestFailure(location, failure.error);
      // Returned, not raised. A raise settles under the ambient policy, which
      // would let a documentation policy turn one test's teardown failure into
      // the whole document's — and a test failure fails only that test. The
      // engine puts what this returns straight into the output.
      return {
        type: "error",
        message: failureDiagnostic(result, { detail: true }).trim(),
        source: "Test",
      };
    },
  });
  // Non-reserved defaults: a repository component of either name is chosen
  // ahead of these, as it would be ahead of any other package's.
  const registrations: ComponentRegistration[] = [
    { name: "Testing", origin: "@executablemd/testing", fn: Testing, props: TESTING_PROPS },
    {
      name: "Test",
      origin: "@executablemd/testing",
      fn: createTest(handlers.timeoutMs),
      props: TEST_PROPS,
    },
    // The table stays data: it names the comparison and the props each kind
    // takes, and the registration is built from it rather than beside it.
    {
      name: "AssertThrows",
      origin: "@executablemd/testing",
      fn: AssertThrows,
      props: ASSERT_THROWS_PROPS,
      captures: ["message"],
      liveReturn: true,
    },
    ...[...ASSERTIONS.values()].map((assertion) => ({
      name: assertion.name,
      origin: "@executablemd/testing",
      fn: assertionComponent(assertion),
      props: ASSERTION_PROPS,
      captures: capturesFor(assertion.kind),
    })),
  ];
  yield* registerComponents(registrations);
  // Nothing claims an element here any more. The install is kept rather than
  // deleted: retiring the legacy extension surface is the legacy-removal
  // slice's job, and taking it out here would be cleanup this slice did not
  // budget for.
  yield* Component.around({
    *expand([element], next) {
      return yield* next(element);
    },
  });
  yield* Execution.around({
    *execute([executeOptions], next) {
      // Fresh boundary collection per execution: outcomes reported by
      // explicit <Testing> elements in THIS run decide this run's Result.
      const boundaries: BoundaryOutcome[] = [];
      yield* Test.around({
        *boundary([outcome], nextBoundary) {
          boundaries.push(outcome);
          yield* nextBoundary(outcome);
        },
      });
      // Confirmed full replay: durableRun returns the stored root result
      // without re-expanding, so nothing would re-record. Restore the
      // journaled testing records into the current collectors — through
      // the same record/boundary operations live expansion uses, so every
      // session collector and observer sees them in discovery order. A
      // live or partial journal (no root Close) hydrates nothing;
      // re-expansion records each result exactly once via its durable
      // operation.
      const replayed = yield* readCompletedRun(executeOptions.stream);
      if (replayed) {
        for (const result of replayed.results) {
          yield* record(result);
        }
        for (const outcome of replayed.boundaries) {
          yield* boundary(outcome);
        }
      }
      const inner = yield* next(executeOptions);
      return decorateCompletion(inner, () => {
        const failed = boundaries.filter((b) => b.failed > 0);
        if (failed.length > 0) {
          return new TestFailureError(
            `${failed.reduce((n, b) => n + b.failed, 0)} test(s) failed in <Testing>`,
          );
        }
        if (boundaries.some((b) => b.tests === 0)) {
          return new TestFailureError("a <Testing> boundary discovered no tests");
        }
        return undefined;
      });
    },
  });
}

/**
 * Map an execution's completion: an `Ok` becomes `Err(failure())` when the
 * policy reports one, after the inner completion — and therefore its closed
 * output stream — settles. An existing `Err` passes through unchanged.
 */
export function decorateCompletion(
  inner: DocumentExecution,
  failure: () => Error | undefined,
): DocumentExecution {
  return {
    output: inner.output,
    *[Symbol.iterator]() {
      const result = yield* inner;
      if (!result.ok) {
        return result;
      }
      const error = failure();
      if (error) {
        return Err(error);
      }
      return result;
    },
  };
}

/** Whether a failure is, or wraps, a diagnostic an enclosing test intercepted. */
function carriesRaisedSegment(error: unknown, seen = new Set<unknown>()): boolean {
  if (error instanceof RaisedSegmentError) {
    return true;
  }
  if (typeof error !== "object" || error === null || seen.has(error)) {
    return false;
  }
  seen.add(error);
  if (error instanceof AggregateError && error.errors.some((e) => carriesRaisedSegment(e, seen))) {
    return true;
  }
  return error instanceof Error && error.cause !== undefined
    ? carriesRaisedSegment(error.cause, seen)
    : false;
}
