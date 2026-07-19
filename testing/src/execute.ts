/**
 * executeDocument — the single scoped wrapper both CLI paths use
 * (specs/testing-spec.md §Testing Mode).
 *
 * Testing middleware lives and dies with the execution it serves: a bounded
 * child task installs the vocabulary, the run-level collectors, and (in
 * testing mode) root activation, runs the document inside that scope, and
 * evaluates the aggregate outcome only after the inner execution — and
 * therefore its closed output stream — completes. When the execution
 * finishes, the scope exits and every install is gone.
 *
 * `output` is a lazy stream delegating to the inner execution's replay-safe
 * output — no second channel, nothing dropped for late subscribers.
 */

import { spawn, withResolvers } from "effection";
import type { Operation } from "effection";
import { runDocument } from "@executablemd/core";
import type { DocumentExecution, RunDocumentOptions } from "@executablemd/core";
import { Test, TestFailureError } from "./test-api.ts";
import type { BoundaryOutcome, TestResult } from "./test-api.ts";
import { installHandlers, installTestingVocabulary } from "./vocabulary.ts";
import type { TestHandlers } from "./handlers.ts";

export interface ExecuteDocumentOptions extends RunDocumentOptions {
  /** Activate testing mode at the root (`xmd test` ≡ root `<Testing>`). */
  testing: boolean;
  /** Render assertion diagnostics during regular execution. */
  verbose?: boolean;
}

interface ExecuteDependencies {
  runDocument(options: RunDocumentOptions): Operation<DocumentExecution>;
  handlers?: TestHandlers;
}

/**
 * Internal dependency-injection seam: tests inject a throwing `runDocument`
 * (pre-publication setup failure) or short-timeout handlers.
 */
export function createExecuteDocument(deps: ExecuteDependencies) {
  return function* executeDocument(options: ExecuteDocumentOptions): Operation<DocumentExecution> {
    const innerExecution = withResolvers<DocumentExecution>();
    const completion = withResolvers<string>();

    yield* spawn(function* () {
      // One error boundary around setup, runDocument, and completion: any
      // failure rejects BOTH resolvers so neither output consumption nor
      // `yield* execution` can hang.
      try {
        if (deps.handlers) {
          yield* installHandlers(deps.handlers, { verbose: options.verbose });
        } else {
          yield* installTestingVocabulary({ verbose: options.verbose });
        }

        const runResults: TestResult[] = [];
        const boundaries: BoundaryOutcome[] = [];
        // Run-level collector — ALWAYS installed, so explicit <Testing>
        // boundaries are observable during ordinary runs too.
        yield* Test.around({
          // deno-lint-ignore require-yield
          *results() {
            return runResults;
          },
          *record([result], next) {
            runResults.push(result);
            yield* next(result);
          },
          *boundary([outcome], next) {
            boundaries.push(outcome);
            yield* next(outcome);
          },
        });
        if (options.testing) {
          yield* Test.around({ testing: () => true });
        }

        const inner = yield* deps.runDocument(options);
        innerExecution.resolve(inner);

        // Observing the inner execution keeps this child (and its installs)
        // alive; core closes inner.output before the execution settles, so
        // the report is fully delivered before any rejection below.
        let out: string;
        try {
          out = yield* inner;
        } catch (error) {
          completion.reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }

        const failed =
          boundaries.some((b) => b.failed > 0 || b.tests === 0) ||
          (options.testing &&
            (runResults.some((r) => r.status === "fail") || runResults.length === 0));
        if (failed) {
          completion.reject(new TestFailureError(summarize(runResults, boundaries)));
        } else {
          completion.resolve(out);
        }
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        innerExecution.reject(failure);
        completion.reject(failure);
      }
    });

    return {
      // A Stream IS an Operation<Subscription>: await the published inner
      // execution, then delegate to its replay-safe output.
      output: {
        *[Symbol.iterator]() {
          const inner = yield* innerExecution.operation;
          return yield* inner.output;
        },
      },
      *[Symbol.iterator]() {
        return yield* completion.operation;
      },
    };
  };
}

export const executeDocument = createExecuteDocument({ runDocument });

function summarize(results: TestResult[], boundaries: BoundaryOutcome[]): string {
  const failed = results.filter((result) => result.status === "fail");
  if (results.length === 0 && boundaries.every((b) => b.tests === 0)) {
    return "no tests were discovered";
  }
  if (failed.length === 0 && boundaries.some((b) => b.tests === 0)) {
    return "a <Testing> boundary discovered no tests";
  }
  const details = failed
    .map((result) => `  ${result.name ?? result.location}: ${result.error?.message ?? "failed"}`)
    .join("\n");
  return `${failed.length} of ${results.length} tests failed\n${details}`;
}
