/**
 * Component registration (specs/testing-spec.md).
 *
 * `<Testing>`, `<Test>`, the value assertions and `<AssertThrows>` are all
 * registered as ordinary non-reserved defaults, so a repository component of
 * any of those names replaces it.
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
  failureReport,
  flushStaged,
  formatLocation,
  Staging,
  TEST_PROPS,
} from "./test-component.ts";
import type { TestHandlers } from "./handlers.ts";
import type { FunctionComponent } from "@executablemd/core";

const TEST_TIMEOUT_MS = 20_000;

/**
 * Install the testing components, and report the `<Test>` this session built.
 *
 * The identity is returned rather than published: a host that starts an
 * execution passes it back through its own options so a checked command failure
 * inside a test is that test's outcome. A caller that ignores it gets the
 * previous behaviour, and nothing a document reaches is offered the identity or
 * a way to nominate another (#441).
 */
export function* installTestingComponents(options?: {
  verbose?: boolean;
}): Operation<FunctionComponent> {
  return yield* installHandlers(createTestHandlers({ timeoutMs: TEST_TIMEOUT_MS }), options);
}

/**
 * Install a specific handler set. Internal seam: tests inject handlers built
 * with a short timeout; the public path always uses the fixed 20 seconds.
 */
export function* installHandlers(
  handlers: TestHandlers,
  options?: { verbose?: boolean },
): Operation<FunctionComponent> {
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
      // Returned, not raised. A raise settles under the ambient error mode, which
      // would let a documentation error mode turn one test's teardown failure into
      // the whole document's — and a test failure fails only that test. The
      // engine puts what this returns straight into the output.
      return {
        type: "error",
        message: failureReport(result, { detail: true }).trim(),
        source: "Test",
      };
    },
  });
  // Built once, so the identity registered below and the identity enrolled for
  // containment are the same object. A repository `Test` is chosen ahead of
  // this one and is a different function, which is exactly why containment is
  // asked for by identity rather than by name.
  const test = createTest(handlers.timeoutMs);

  // Non-reserved defaults: a repository component of either name is chosen
  // ahead of these, as it would be ahead of any other package's.
  const registrations: ComponentRegistration[] = [
    { name: "Testing", origin: "@executablemd/testing", fn: Testing, props: TESTING_PROPS },
    {
      name: "Test",
      origin: "@executablemd/testing",
      fn: test,
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
  yield* Execution.around({
    *execute([request], next) {
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
      const replayed = yield* readCompletedRun(request.options.stream);
      if (replayed) {
        for (const result of replayed.results) {
          yield* record(result);
        }
        for (const outcome of replayed.boundaries) {
          yield* boundary(outcome);
        }
      }
      request.addCompletionFailure(() => {
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
      yield* next(request);
    },
  });

  return test;
}

/** Whether a failure is, or wraps, a printed error an enclosing test intercepted. */
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
