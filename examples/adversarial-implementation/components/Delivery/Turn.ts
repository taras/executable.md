import { Agent, Component } from "@executablemd/core/api";
import type { AgentPromptEvent } from "@executablemd/core/api";
import type { Operation, Stream } from "effection";
import { z } from "zod";
import {
  causedBy,
  configurationOf,
  configurationSchema,
  describeFailure,
  isFilesFailure,
} from "./failure.ts";
import { retained } from "./observation.ts";

export const props = { type: "object", properties: {}, additionalProperties: false };

const observationSchema = z.discriminatedUnion("provider", [
  z.strictObject({ provider: z.literal(false) }),
  z.strictObject({
    provider: z.literal(true),
    stage: z.enum(["session", "turn"]),
    failure: z.string(),
    partial: z.string(),
    configuration: configurationSchema,
  }),
]);

/**
 * A failure is the provider's only when its own session or turn produced it:
 * a refusal thrown by the session operation, or a turn the provider stream
 * failed or reported failed. Everything else, including a workflow guard in
 * this content, is rethrown.
 */
export default function* Turn(): Operation<unknown> {
  const sessionFailures = new Set<unknown>();
  let requested = false;
  let streamFailure: { error: unknown } | undefined;
  let terminal: { status: string; error: Error | undefined } | undefined;
  let produced = "";
  yield* Agent.around({
    *session(args, next) {
      try {
        return yield* next(...args);
      } catch (error) {
        sessionFailures.add(error);
        throw error;
      }
    },
    *prompt(args, next) {
      requested = true;
      let stream: Stream<AgentPromptEvent, string>;
      try {
        stream = yield* next(...args);
      } catch (error) {
        streamFailure = { error };
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
                  streamFailure = { error };
                  throw error;
                }
              },
            };
          } catch (error) {
            streamFailure ??= { error };
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
    if (causedBy(failure, sessionFailures)) {
      return {
        provider: true,
        stage: "session",
        failure: describeFailure(failure),
        partial: "",
        configuration: configurationOf(failure),
      };
    }
    const raw = streamFailure?.error;
    const reported = terminal !== undefined && terminal.status !== "completed";
    if (!requested || (raw === undefined && !reported) || isFilesFailure(raw)) {
      return { provider: false };
    }
    return {
      provider: true,
      stage: "turn",
      failure: describeFailure(failure),
      partial: produced,
      configuration: configurationOf(raw ?? terminal?.error) ?? configurationOf(failure),
    };
  });
  if (!observed.provider) {
    throw failure;
  }
  const { provider: _provider, ...turn } = observed;
  return { state: "failed", ...turn };
}
