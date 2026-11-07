import { Agent, Component } from "@executablemd/core/api";
import type { AgentPromptEvent } from "@executablemd/core/api";
import type { Operation, Stream } from "effection";
import { configurationOf, describeFailure, isFilesFailure } from "./failure.ts";

export const props = { type: "object", properties: {}, additionalProperties: false };

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
  const reported = terminal !== undefined && terminal.status !== "completed";
  if (isFilesFailure(outcome.failure) || !requested || (providerFailure === undefined && !reported)) {
    throw outcome.failure;
  }
  const cause = providerFailure?.error ?? terminal?.error;
  return {
    state: "failed",
    failure: describeFailure(outcome.failure),
    partial: produced,
    configuration: configurationOf(cause) ?? configurationOf(outcome.failure),
  };
}
