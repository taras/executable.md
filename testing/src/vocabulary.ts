/**
 * Vocabulary registration (specs/testing-spec.md).
 *
 * Teaches the expansion loop the testing words — `<Testing>`, `<Test>`, and
 * the assertion components — via the core `expandInvocation` hook, and
 * decorates the core Execution Api so explicit `<Testing>` boundaries affect
 * the execution outcome even when root testing is inactive.
 *
 * Registration is distinct from activation: installing the vocabulary
 * leaves `testing` false, so `<Test>` skips and assertions stay usable.
 * Root activation is `useTesting()`'s job.
 *
 * Installs are scope-local — call this inside a bounded scope (one CLI
 * command invocation, one `scoped()` block).
 */

import { Err } from "effection";
import type { Operation } from "effection";
import { Component, Execution } from "@executablemd/core";
import type { DocumentExecution } from "@executablemd/core";
import { Test, TestFailureError } from "./test-api.ts";
import type { BoundaryOutcome } from "./test-api.ts";
import { ASSERTIONS } from "./assertions.ts";
import { createTestHandlers } from "./handlers.ts";
import type { TestHandlers } from "./handlers.ts";

const TEST_TIMEOUT_MS = 20_000;

export function* installTestingVocabulary(options?: { verbose?: boolean }): Operation<void> {
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
  yield* Component.around({
    *expandInvocation([invocation, ctx], next) {
      if (invocation.name === "Testing") {
        return { segments: yield* handlers.expandTesting(invocation, ctx) };
      }
      if (invocation.name === "Test") {
        return { segments: yield* handlers.expandTest(invocation, ctx) };
      }
      const assertion = ASSERTIONS.get(invocation.name);
      if (assertion) {
        return { segments: yield* handlers.expandAssertion(assertion, invocation, ctx) };
      }
      return yield* next(invocation, ctx);
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
