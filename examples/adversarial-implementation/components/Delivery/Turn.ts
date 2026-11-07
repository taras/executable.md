import { Agent, Component } from "@executablemd/core/api";
import type { AgentPromptEvent } from "@executablemd/core/api";
import type { Operation, Stream } from "effection";
import { z } from "zod";
import { configurationOf, configurationSchema, describeFailure, isFilesFailure } from "./failure.ts";
import { retained } from "./observation.ts";

export const props = { type: "object", properties: {}, additionalProperties: false };

const observationSchema = z.discriminatedUnion("provider", [
  z.strictObject({ provider: z.literal(false) }),
  z.strictObject({
    provider: z.literal(true),
    failure: z.string(),
    partial: z.string(),
    configuration: configurationSchema,
  }),
]);

export default function* Turn(): Operation<unknown> {
  let requested = false;
  let providerFailure: { error: unknown } | undefined;
  let terminal: { status: string; error: Error | undefined } | undefined;
  let produced = "";
  yield* Agent.around({
    *prompt(args, next) {
      requested = true;
      let stream: Stream<AgentPromptEvent, string>;
      try {
        stream = yield* next(...args);
      } catch (error) {
        providerFailure = { error };
        throw error;
      }
      const observed: Stream<AgentPromptEvent, string> = {
        *[Symbol.iterator]() {
          try {
            const subscription = yield* stream;
            return {
              *next() {
                try {
                  const event = yield* subscription.next();
                  if (event.done) {
                    produced ||= event.value;
                  } else if (event.value.type === "text_delta") {
                    produced += event.value.text;
                  } else if (event.value.type === "terminal") {
                    terminal = { status: event.value.status, error: event.value.error };
                  }
                  return event;
                } catch (error) {
                  providerFailure = { error };
                  throw error;
                }
              },
            };
          } catch (error) {
            providerFailure ??= { error };
            throw error;
          }
        },
      };
      return observed;
    },
  });
  const outcome = yield* Component.operations.tryContent();
  if (outcome.failure === undefined) {
    return { state: "reply", reply: outcome.text };
  }
  const failure = outcome.failure;
  if (isFilesFailure(failure)) {
    throw failure;
  }
  const observed = yield* retained("delivery-review-turn", observationSchema, function* () {
    const reported = terminal !== undefined && terminal.status !== "completed";
    if (!requested || (providerFailure === undefined && !reported)) {
      return { provider: false };
    }
    const cause = providerFailure?.error ?? terminal?.error;
    return {
      provider: true,
      failure: describeFailure(failure),
      partial: produced,
      configuration: configurationOf(cause) ?? configurationOf(failure),
    };
  });
  if (!observed.provider) {
    throw failure;
  }
  return {
    state: "failed",
    failure: observed.failure,
    partial: observed.partial,
    configuration: observed.configuration,
  };
}
