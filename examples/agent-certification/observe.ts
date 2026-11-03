import { Agent, Component, configurationOf, sessionOf } from "@executablemd/core";
import type { AgentPromptEvent } from "@executablemd/core";
import { scoped, Err, Ok, useScope, spawn, sleep } from "effection";
import type { Result, Operation, Stream, Task } from "effection";
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

function hasInvocationTeardownFailure(error: unknown, seen = new Set<unknown>()): boolean {
  if (typeof error !== "object" || error === null || seen.has(error)) {
    return false;
  }
  seen.add(error);
  if (Reflect.get(error, "name") === "InvocationTeardownError") {
    return true;
  }
  const cause = Reflect.get(error, "cause");
  const members = Reflect.get(error, "errors");
  return (
    hasInvocationTeardownFailure(cause, seen) ||
    (Array.isArray(members) && members.some((member) => hasInvocationTeardownFailure(member, seen)))
  );
}

export function* observeTeardown(
  report: Report,
  expired: () => void,
): Operation<() => Operation<void>> {
  const owner = yield* useScope();
  const observations: Task<void>[] = [];
  yield* Component.around({
    *expand([request], next) {
      observations.push(
        yield* owner.spawn(function* () {
          const subscription = yield* request.phases;
          let phase = yield* subscription.next();
          while (!phase.done) {
            if (phase.value.phase === "exit") {
              yield* spawn(function* () {
                yield* sleep(30_000);
                expired();
              });
            } else if (phase.value.phase === "complete") {
              if (
                !phase.value.result.ok &&
                hasInvocationTeardownFailure(phase.value.result.error)
              ) {
                recordCleanup(report, false, false, true);
              }
              return;
            } else if (phase.value.phase === "cancelled") {
              return;
            }
            phase = yield* subscription.next();
          }
        }),
      );
      return yield* next(request);
    },
  });
  return function* () {
    for (const observation of observations) {
      yield* observation;
    }
  };
}

export function* joinQualification<T>(report: Report, work: () => Operation<T>): Operation<T> {
  let result: Result<T> | undefined;
  try {
    yield* scoped(function* () {
      try {
        result = Ok(yield* work());
      } catch (error) {
        if (hasInvocationTeardownFailure(error)) {
          recordCleanup(report, false, false, true);
        }
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
