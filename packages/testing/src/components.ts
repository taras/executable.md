/**
 * Component registration (specs/testing-spec.md).
 *
 * `<Testing>` is registered as an ordinary non-reserved default, so a
 * repository component of that name replaces it. `<Test>`, `<AssertThrows>`
 * and the assertion components are claimed through the core `Component.expand`
 * hook by the expansion middleware installed here.
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
import { Component, Execution, registerComponents } from "@executablemd/core";
import type { DocumentExecution } from "@executablemd/core";
import { boundary, record, Test, TestFailureError } from "./test-api.ts";
import type { BoundaryOutcome } from "./test-api.ts";
import { readCompletedRun } from "./journal.ts";
import { ASSERTIONS } from "./assertions.ts";
import { createTestHandlers } from "./handlers.ts";
import { Testing, TESTING_PROPS } from "./testing-component.ts";
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
  // A non-reserved default: a repository component named `Testing` is chosen
  // ahead of this one, as it would be ahead of any other package's.
  yield* registerComponents([
    { name: "Testing", origin: "@executablemd/testing", fn: Testing, props: TESTING_PROPS },
  ]);
  yield* Component.around({
    *expand([element], next) {
      if (element.name === "Test") {
        return { segments: yield* handlers.expandTest(element) };
      }
      if (element.name === "AssertThrows") {
        return { segments: yield* handlers.expandAssertThrows(element) };
      }
      const assertion = ASSERTIONS.get(element.name);
      if (assertion) {
        return { segments: yield* handlers.expandAssertion(assertion, element) };
      }
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
