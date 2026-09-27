/**
 * The reference entry, executed for real.
 *
 * Every REPL test that needs a Journal gets one from here rather than from a
 * recorded file, because the projector's whole claim is that it reads what the
 * *current* runtime writes. A frozen event array would keep passing on the day
 * core changed a record's shape, which is the day the claim stopped being true.
 *
 * The entry is one document deliberately holding one of each thing this slice
 * projects: a durable evaluation that publishes JSON, one nested component
 * occurrence whose source the run retains, one generated fragment admitted from
 * a value that evaluation published, and one validated question whose answer
 * changes what the document renders after it.
 */

import { readTextFile } from "@effectionx/fs";
import { fileURLToPath } from "node:url";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { collect, Elicitation } from "@executablemd/core";
import type { ElicitationRequest } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { inlineSource } from "@executablemd/core";
import type { Operation } from "effection";
import { scoped } from "effection";

import { ordinaryEvaluationProfile } from "../../../src/evaluation-profile.ts";

/** Where the entry and its nested component live. */
export const REFERENCE_DIRECTORY = fileURLToPath(new URL("./", import.meta.url));

/** The exact entry text this slice's evidence submits. */
export function referenceSource(): Operation<string> {
  return readTextFile(fileURLToPath(new URL("./entry.md", import.meta.url)));
}

/** What one reference execution produced. */
export interface ReferenceRun {
  readonly output: string;
  readonly events: DurableEvent[];
  readonly asked: ElicitationRequest[];
  readonly failure: Error | undefined;
}

/**
 * Run the reference entry once, over `stream`.
 *
 * `answer` decides what the installed provider hands back, so a test can answer,
 * refuse, or count. Failures are captured rather than raised: how far a run got
 * is most of what the negative controls are about.
 */
export function runReference(
  answer: (request: ElicitationRequest) => Operation<unknown>,
  stream: InMemoryStream = new InMemoryStream(),
): Operation<ReferenceRun> {
  return scoped(function* () {
    const asked: ElicitationRequest[] = [];
    yield* Elicitation.around(
      {
        *elicit([request]) {
          asked.push(request);
          return yield* answer(request);
        },
      },
      { at: "min" },
    );
    const source = yield* referenceSource();
    try {
      const execution = yield* executeInstalled(
        { ...inlineSource(source), stream, includes: [REFERENCE_DIRECTORY] },
        [{ evaluation: ordinaryEvaluationProfile() }],
      );
      const output = yield* collect(execution);
      return { output: String(output), events: yield* stream.readAll(), asked, failure: undefined };
    } catch (error) {
      return {
        output: "",
        events: yield* stream.readAll(),
        asked,
        failure: error instanceof Error ? error : new Error(String(error)),
      };
    }
  });
}

/** The answer the reference journey submits. */
export const REFERENCE_ANSWER: Json = { decision: "approve" };

/** A provider that always answers the same way. */
export function answering(value: Json): (request: ElicitationRequest) => Operation<unknown> {
  // deno-lint-ignore require-yield
  return function* () {
    return value;
  };
}

/** The complete reference Journal of one settled run. */
export function* referenceEvents(): Operation<DurableEvent[]> {
  const run = yield* runReference(answering(REFERENCE_ANSWER));
  if (run.failure !== undefined) {
    throw run.failure;
  }
  return run.events;
}
