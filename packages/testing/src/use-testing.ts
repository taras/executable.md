/**
 * useTesting — scope-local testing composition (specs/testing-spec.md).
 *
 * One `useTesting()` session per execution scope: it installs the testing
 * components, the collection and completion-policy middleware, and root
 * activation, then returns a session handle whose `results` operation
 * snapshots completed tests in discovery order. Every install is removed
 * with the session's Effection scope.
 *
 * ```ts
 * const tests = yield* useTesting();
 * const execution = yield* execute(options);
 * const outcome = yield* execution;          // Result<string>
 * const results = yield* tests.results;
 * ```
 */

import type { Operation } from "effection";
import { Execution } from "@executablemd/core";
import type { FunctionComponent } from "@executablemd/core";
import { sessionActive, Test, TestFailureError } from "./test-api.ts";
import type { TestResult } from "./test-api.ts";
import { installTestingComponents } from "./components.ts";
import { flushStaged } from "./test-component.ts";

export interface Testing {
  /** Immutable snapshot of completed tests, in discovery order. */
  readonly results: Operation<readonly TestResult[]>;
  /**
   * The `<Test>` this session built, for the host to hand back on its own
   * options so a checked command failure is contained in the test that ran it.
   */
  readonly test: FunctionComponent;
}

export function* useTesting(options?: { verbose?: boolean }): Operation<Testing> {
  if (yield* sessionActive) {
    throw new Error(
      "useTesting() is already active in this scope — use one session per execution scope",
    );
  }
  yield* Test.around({ sessionActive: () => true });

  const test = yield* installTestingComponents(options);

  const collected: TestResult[] = [];
  yield* Test.around({
    // deno-lint-ignore require-yield
    *results() {
      return [...collected];
    },
    *record([result], next) {
      collected.push(result);
      yield* next(result);
    },
  });

  // Root activation — the activation half of what <Testing> performs for its
  // subtree, applied to the whole execution. `xmd test` ≡ root <Testing>) for
  // activation and for flushing staged results; a root run reports no boundary
  // outcome of its own, which an explicit <Testing> does.
  yield* Test.around({ testing: () => true });

  // The flushing half. A root run has no <Testing> element to flush the last
  // test's staged result, so the region that settles after the document has
  // expanded does it — inside durableRun, where the stream is still live, and
  // before the root Close. Flush-only: no boundary outcome, no journal entry of
  // its own.
  yield* Execution.around({
    *document([request], next) {
      yield* next(request);
      yield* flushStaged();
    },
  });

  // Completion policy: an otherwise successful execution becomes
  // Err(TestFailureError) after its output closes when tests failed or none
  // were discovered. A core Err passes through unchanged, and `results`
  // stays available either way.
  //
  // One execute() per session: results are cumulative across the session,
  // so a second document would inherit the first document's outcomes (a
  // zero-test document after a passing one would succeed). Fail clearly
  // BEFORE a handle exists — the pre-handle throw path.
  let executed = false;
  yield* Execution.around({
    *execute([request], next) {
      // Refused before delegating: no execution is issued, which is what makes
      // the second call fail rather than produce a document whose outcomes are
      // the first call's.
      if (executed) {
        throw new Error(
          "a useTesting() session supports one execute() call — start a new session for another document",
        );
      }
      executed = true;
      request.addCompletionFailure(() => {
        if (collected.length === 0) {
          return new TestFailureError("no tests were discovered");
        }
        const failed = collected.filter((result) => result.status === "fail");
        if (failed.length > 0) {
          const details = failed
            .map(
              (result) =>
                `  ${result.name ?? result.location}: ${result.error?.message ?? "failed"}`,
            )
            .join("\n");
          return new TestFailureError(
            `${failed.length} of ${collected.length} tests failed\n${details}`,
          );
        }
        return undefined;
      });
      yield* next(request);
    },
  });

  return {
    results: {
      *[Symbol.iterator]() {
        return Object.freeze([...collected]);
      },
    },
    test,
  };
}
