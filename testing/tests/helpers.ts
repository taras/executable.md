/**
 * Document-level test harness: compose the testing vocabulary (or a full
 * useTesting() session) around core execute() inside a bounded scope, and
 * observe chunks, close value, completion Result, and the delegated test
 * results/boundaries.
 */

import { scoped } from "effection";
import type { Operation, Result } from "effection";
import { forEach } from "@effectionx/stream-helpers";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableStream } from "@executablemd/durable-streams";
import { useStubFs } from "@executablemd/runtime/test";
import { execute } from "@executablemd/core";
import { useTesting } from "../src/use-testing.ts";
import { installHandlers, installTestingVocabulary } from "../src/vocabulary.ts";
import type { TestHandlers } from "../src/handlers.ts";
import { Test } from "../src/test-api.ts";
import type { BoundaryOutcome, TestResult } from "../src/test-api.ts";

export interface DocRun {
  /** Chunks received while streaming. */
  chunks: string[];
  /** The output stream's close value. */
  output: string;
  completion: Result<string>;
  /** Results delegated past the session/vocabulary collectors. */
  results: TestResult[];
  boundaries: BoundaryOutcome[];
}

export interface RunDocOptions {
  testing?: boolean;
  verbose?: boolean;
  docPath?: string;
  /** Inject handlers (e.g. a short timeout) instead of the public set. */
  handlers?: TestHandlers;
  /** Supply a journal stream (e.g. for replay scenarios). */
  stream?: DurableStream;
}

export function* runDoc(
  files: Record<string, string>,
  options: RunDocOptions = {},
): Operation<DocRun> {
  return yield* scoped(function* () {
    yield* useStubFs(files);

    const results: TestResult[] = [];
    const boundaries: BoundaryOutcome[] = [];
    yield* Test.around({
      *record([result], next) {
        results.push(result);
        yield* next(result);
      },
      *boundary([outcome], next) {
        boundaries.push(outcome);
        yield* next(outcome);
      },
    });

    if (options.handlers) {
      yield* installHandlers(options.handlers, { verbose: options.verbose });
      if (options.testing) {
        yield* Test.around({ testing: () => true });
      }
    } else if (options.testing) {
      yield* useTesting({ verbose: options.verbose });
    } else {
      yield* installTestingVocabulary({ verbose: options.verbose });
    }

    const execution = yield* execute({
      docPath: options.docPath ?? "README.md",
      stream: options.stream ?? new InMemoryStream(),
    });

    const chunks: string[] = [];
    const output = yield* forEach(function* (chunk: string) {
      chunks.push(chunk);
    }, execution.output);

    const completion = yield* execution;

    return { chunks, output, completion, results, boundaries };
  });
}

export function failureOf(run: DocRun): Error | undefined {
  if (run.completion.ok) {
    return undefined;
  }
  return run.completion.error;
}
