import { Agent, Component } from "@executablemd/core/api";
import type { AgentPromptEvent } from "@executablemd/core/api";
import type { Stream } from "effection";
import { z } from "zod";

export const props = {
  type: "object",
  properties: {
    session: { type: "object" },
    startedIdentity: { type: "object" },
    laterIdentity: { type: "object" },
    failBeforeStarted: { type: "boolean", default: false },
    fail: { type: "boolean", default: false },
  },
  additionalProperties: false,
};
const identitySchema = z.strictObject({ kind: z.string().min(1), value: z.string().min(1) });
const schema = z.strictObject({
  session: z
    .strictObject({
      sessionKey: z.string(),
      cwd: z.string(),
      identity: identitySchema.optional(),
    })
    .optional(),
  startedIdentity: identitySchema.optional(),
  laterIdentity: identitySchema.optional(),
  failBeforeStarted: z.boolean(),
  fail: z.boolean(),
});

export default function* Session(input: Record<string, unknown>) {
  const selected = schema.parse(input);
  const session = selected.session;
  if (session === undefined) {
    throw new Error("Provide the fixture session.");
  }
  yield* Agent.around({
    *agent() {
      return "fixture";
    },
    *session() {
      return session;
    },
  });
  if (selected.startedIdentity !== undefined || selected.failBeforeStarted) {
    Object.freeze(session);
    let subscriptions = 0;
    yield* Agent.around(
      {
        *prompt() {
          const stream: Stream<AgentPromptEvent, string> = {
            *[Symbol.iterator]() {
              const identity =
                subscriptions++ === 0
                  ? selected.startedIdentity
                  : (selected.laterIdentity ?? selected.startedIdentity);
              let started = false;
              let terminal = false;
              return {
                *next() {
                  if (selected.failBeforeStarted) {
                    throw new Error(
                      "The original fixture turn failed without an identity assertion.",
                    );
                  }
                  if (!started) {
                    started = true;
                    return {
                      done: false,
                      value: {
                        type: "started",
                        agent: "fixture",
                        session: { ...session, identity },
                      },
                    };
                  }
                  if (selected.fail) {
                    throw new Error("The fixture turn failed after starting.");
                  }
                  if (!terminal) {
                    terminal = true;
                    return { done: false, value: { type: "terminal", status: "completed" } };
                  }
                  return { done: true, value: "fixture reply" };
                },
              };
            },
          };
          return stream;
        },
      },
      { at: "min" },
    );
  }
  return yield* Component.operations.content();
}
