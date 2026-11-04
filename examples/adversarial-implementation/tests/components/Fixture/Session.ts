import { Agent, Component, sessionOf } from "@executablemd/core/api";
import type { AgentPromptEvent } from "@executablemd/core/api";
import type { Stream } from "effection";
import { z } from "zod";

export const props = {
  type: "object",
  properties: {
    session: { type: "object" },
    nativeId: { type: "string" },
    startedNativeId: { type: "string" },
    failBeforeStarted: { type: "boolean", default: false },
    fail: { type: "boolean", default: false },
  },
  additionalProperties: false,
};
const schema = z.strictObject({
  session: z
    .strictObject({
      sessionKey: z.string(),
      cwd: z.string(),
      agentSessionId: z.string().optional(),
    })
    .optional(),
  nativeId: z.string().optional(),
  startedNativeId: z.string().optional(),
  failBeforeStarted: z.boolean(),
  fail: z.boolean(),
});

export default function* Session(input: Record<string, unknown>) {
  const selected = schema.parse(input);
  if (selected.nativeId !== undefined) {
    const session = sessionOf(yield* Agent.operations.session());
    if (session === undefined) {
      throw new Error("The fixture needs its enclosing session.");
    }
    session.agentSessionId = selected.nativeId;
    return "";
  }
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
  if (selected.startedNativeId !== undefined || selected.failBeforeStarted) {
    Object.freeze(session);
    yield* Agent.around(
      {
        *prompt() {
          const stream: Stream<AgentPromptEvent, string> = {
            *[Symbol.iterator]() {
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
                        session: { ...session, agentSessionId: selected.startedNativeId },
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
