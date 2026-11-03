import { Agent, configurationOf, sessionOf } from "@executablemd/core";
import type { AgentPromptEvent } from "@executablemd/core";
import { scoped, Err, Ok } from "effection";
import type { Result, Operation, Stream } from "effection";
import {
  recordCleanup,
  recordConfigurationFailure,
  recordConfigurationSuccess,
  recordTurn,
} from "./report.ts";
import type { Report } from "./report.ts";

export function* observeQualification(
  report: Report,
  observe?: (event: AgentPromptEvent) => void,
): Operation<void> {
  yield* Agent.around({
    *session(args, next) {
      try {
        return yield* next(...args);
      } catch (error) {
        recordConfigurationFailure(report, error);
        throw error;
      }
    },
    *prompt(args, next) {
      const source = yield* next(...args);
      const observed: Stream<AgentPromptEvent, string> = {
        *[Symbol.iterator]() {
          try {
            const subscription = yield* source;
            let accepted = false;
            let completed = false;
            let deltas = 0;
            return {
              *next() {
                const event = yield* subscription.next();
                if (event.done) {
                  recordTurn(report, { accepted, completed, deltas }, !accepted);
                } else if (event.value.type === "started") {
                  accepted = true;
                  report.counts.prompts++;
                  recordConfigurationSuccess(report, configurationOf(event.value.session));
                } else if (event.value.type === "text_delta") {
                  deltas++;
                } else if (event.value.type === "terminal") {
                  completed = event.value.status === "completed";
                }
                if (!event.done) {
                  observe?.(
                    event.value.type === "started"
                      ? {
                          ...event.value,
                          session: sessionOf(event.value.session) ?? event.value.session,
                        }
                      : event.value,
                  );
                }
                return event;
              },
            };
          } catch (error) {
            recordConfigurationFailure(report, error);
            throw error;
          }
        },
      };
      return observed;
    },
  });
}

export function* joinQualification<T>(report: Report, work: () => Operation<T>): Operation<T> {
  let result: Result<T> | undefined;
  try {
    yield* scoped(function* () {
      try {
        result = Ok(yield* work());
      } catch (error) {
        result = Err(error instanceof Error ? error : new Error(String(error)));
      }
    });
  } catch (error) {
    report.exitState = "failed";
    recordCleanup(report, true, false, true);
    throw error;
  }
  recordCleanup(report, true, false);
  if (result === undefined) {
    throw new Error("Qualification did not settle");
  }
  if (!result.ok) {
    report.exitState = "failed";
    throw result.error;
  }
  return result.value;
}
