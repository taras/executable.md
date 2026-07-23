/**
 * useTesting — scope-local testing composition (specs/testing-spec.md).
 *
 * One `useTesting()` session per execution scope: it installs the testing
 * vocabulary, the collection and completion-policy middleware, and root
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
import { sessionActive, Test, TestFailureError } from "./test-api.ts";
import type { TestResult } from "./test-api.ts";
import { decorateCompletion, installTestingVocabulary } from "./vocabulary.ts";

export interface Testing {
  /** Immutable snapshot of completed tests, in discovery order. */
  readonly results: Operation<readonly TestResult[]>;
}

export function* useTesting(options?: { verbose?: boolean }): Operation<Testing> {
  if (yield* sessionActive) {
    throw new Error(
      "useTesting() is already active in this scope — use one session per execution scope",
    );
  }
  yield* Test.around({ sessionActive: () => true });

  yield* installTestingVocabulary(options);

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

  // Root activation — the same install <Testing> performs for its subtree,
  // applied to the whole execution (`xmd test` ≡ root <Testing>).
  yield* Test.around({ testing: () => true });

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
    *execute([executeOptions], next) {
      if (executed) {
        throw new Error(
          "a useTesting() session supports one execute() call — start a new session for another document",
        );
      }
      executed = true;
      const inner = yield* next(executeOptions);
      return decorateCompletion(inner, () => {
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
    },
  });

  return {
    results: {
      *[Symbol.iterator]() {
        return Object.freeze([...collected]);
      },
    },
  };
}
