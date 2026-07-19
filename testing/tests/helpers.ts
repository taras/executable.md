/**
 * Document-level test harness: run a stub-fs document through
 * executeDocument and observe chunks, close value, completion, and the
 * delegated test results/boundaries.
 */

import type { Operation } from "effection";
import { forEach } from "@effectionx/stream-helpers";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useStubFs } from "@executablemd/runtime/test";
import type { DocumentExecution } from "@executablemd/core";
import { executeDocument } from "../src/execute.ts";
import type { ExecuteDocumentOptions } from "../src/execute.ts";
import { Test } from "../src/test-api.ts";
import type { BoundaryOutcome, TestResult } from "../src/test-api.ts";

export interface DocRun {
  /** Chunks received while streaming. */
  chunks: string[];
  /** The output stream's close value. */
  output: string;
  completion: { ok: true; value: string } | { ok: false; error: Error };
  /** Results delegated past the wrapper's run-level collector. */
  results: TestResult[];
  boundaries: BoundaryOutcome[];
}

export interface RunDocOptions {
  testing?: boolean;
  verbose?: boolean;
  docPath?: string;
  execute?: (options: ExecuteDocumentOptions) => Operation<DocumentExecution>;
}

export function* runDoc(
  files: Record<string, string>,
  options: RunDocOptions = {},
): Operation<DocRun> {
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

  const execute = options.execute ?? executeDocument;
  const execution = yield* execute({
    docPath: options.docPath ?? "README.md",
    stream: new InMemoryStream(),
    testing: options.testing ?? false,
    verbose: options.verbose,
  });

  const chunks: string[] = [];
  const output = yield* forEach(function* (chunk: string) {
    chunks.push(chunk);
  }, execution.output);

  let completion: DocRun["completion"];
  try {
    completion = { ok: true, value: yield* execution };
  } catch (error) {
    completion = {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  return { chunks, output, completion, results, boundaries };
}

export function failureOf(run: DocRun): Error | undefined {
  if (run.completion.ok) {
    return undefined;
  }
  return run.completion.error;
}
