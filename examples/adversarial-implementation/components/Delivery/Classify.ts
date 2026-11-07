import { Agent, Component } from "@executablemd/core/api";
import type { Operation } from "effection";
import { z } from "zod";
import { causedBy, configurationOf, describeFailure, isFilesFailure } from "./failure.ts";
import { outcomeSchema, reviewerSchema, settledSchema } from "./records.ts";

export const props = {
  type: "object",
  properties: { reviewer: { type: "object" } },
  required: ["reviewer"],
  additionalProperties: false,
};

export default function* Classify(value: unknown): Operation<unknown> {
  const { reviewer } = z.strictObject({ reviewer: reviewerSchema }).parse(value);
  const sessionFailures = new Set<unknown>();
  yield* Agent.around({
    *session(args, next) {
      try {
        return yield* next(...args);
      } catch (error) {
        sessionFailures.add(error);
        throw error;
      }
    },
  });
  const outcome = yield* Component.operations.tryContent();
  if (outcome.failure === undefined) {
    const settled = settledSchema.parse(JSON.parse(outcome.text));
    return outcomeSchema.parse({
      schema: "delivery-review-outcome.v1",
      reviewer,
      stage: "settled",
      ...settled,
      failure: null,
      configuration: null,
    });
  }
  if (isFilesFailure(outcome.failure)) {
    throw outcome.failure;
  }
  const session = causedBy(outcome.failure, sessionFailures);
  return outcomeSchema.parse({
    schema: "delivery-review-outcome.v1",
    reviewer,
    stage: session ? "session" : "other",
    catalog: null,
    turn: null,
    failure: describeFailure(outcome.failure),
    configuration: session ? configurationOf(outcome.failure) : null,
  });
}
