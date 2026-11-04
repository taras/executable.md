import { Agent, Component, sessionOf } from "@executablemd/core/api";
import type { AgentPromptEvent } from "@executablemd/core/api";
import { API, cwd, parseFilesFailure } from "@executablemd/runtime";
import { ensure, type Stream } from "effection";
import { z } from "zod";

export const props = {
  type: "object",
  properties: {
    directory: { type: "string", pattern: "^/" },
    name: { type: "string", minLength: 1 },
    requireExisting: { type: "boolean", default: false },
  },
  required: ["directory", "name"],
  additionalProperties: false,
};

const inputSchema = z.strictObject({
  directory: z.string().startsWith("/"),
  name: z.string().min(1),
  requireExisting: z.boolean(),
});
const identitySchema = z.strictObject({
  agent: z.string().min(1),
  name: z.string().min(1),
  sessionKey: z.string().min(1),
  cwd: z.string().min(1),
  nativeId: z.string().min(1).nullable(),
  attempted: z.boolean(),
  started: z
    .strictObject({
      sessionKey: z.string().min(1),
      cwd: z.string().min(1),
      nativeId: z.string().min(1).nullable(),
    })
    .nullable(),
});

export default function* Session(input: Record<string, unknown>) {
  const selected = inputSchema.parse(input);
  const agent = yield* Agent.operations.agent();
  const session = sessionOf(yield* Agent.operations.session());
  if (session === undefined) {
    throw new Error("The workflow needs its enclosing resolved Session before prompting.");
  }
  const directory = { cwd: yield* cwd(), path: selected.directory };
  const prepared = yield* API.Files.operations.ensureDirectory(directory);
  if (!prepared.ok) {
    throw prepared.error;
  }
  const target = {
    cwd: selected.directory,
    path: `${encodeURIComponent(selected.name)}.json`,
  };
  const observed = identitySchema.parse({
    agent,
    name: selected.name,
    sessionKey: session.sessionKey,
    cwd: session.cwd,
    nativeId: session.agentSessionId ?? null,
    attempted: false,
    started: null,
  });
  const prior = yield* API.Files.operations.readTextFile(target);
  let established = observed;
  if (prior.ok) {
    established = identitySchema.parse(JSON.parse(prior.value));
    if (established.attempted && established.nativeId === null) {
      throw new Error(
        "The original workflow call was attempted without a confirmed identity. Preserve its failure and reconcile it before another prompt.",
      );
    }
    if (
      established.agent !== observed.agent ||
      established.name !== observed.name ||
      established.sessionKey !== observed.sessionKey ||
      established.cwd !== observed.cwd ||
      (established.nativeId !== null && established.nativeId !== observed.nativeId)
    ) {
      const mismatch = { ...target, path: target.path + ".mismatch.json" };
      const first = yield* API.Files.operations.readTextFile(mismatch);
      if (!first.ok) {
        if (parseFilesFailure(first.error)?.reason !== "missing") {
          throw first.error;
        }
        const saved = yield* API.Files.operations.writeTextFile({
          ...mismatch,
          content: JSON.stringify({ established, observed }),
        });
        if (!saved.ok) {
          throw saved.error;
        }
      }
      throw new Error(
        "Workflow session identity changed. Reconcile the original conversation before prompting; its identity receipt is unchanged.",
      );
    }
  } else if (parseFilesFailure(prior.error)?.reason !== "missing" || selected.requireExisting) {
    throw new Error(
      "The original workflow session identity receipt is unavailable. Reconcile it before prompting.",
      { cause: prior.error },
    );
  }
  const saved = yield* API.Files.operations.writeTextFile({
    ...target,
    content: JSON.stringify(established),
  });
  if (!saved.ok) {
    throw saved.error;
  }
  let assertedId: string | undefined;
  let attempted = established.attempted;
  let started = established.started;
  yield* ensure(function* () {
    // A fresh placement acquires its provider-native identity during the first turn.
    const nativeId = assertedId ?? session.agentSessionId;
    if (
      attempted !== established.attempted ||
      started !== established.started ||
      (established.nativeId === null && nativeId !== undefined)
    ) {
      const retained = yield* API.Files.operations.writeTextFile({
        ...target,
        content: JSON.stringify({
          ...established,
          attempted,
          started,
          nativeId: established.nativeId ?? nativeId ?? null,
        }),
      });
      if (!retained.ok) {
        throw retained.error;
      }
    }
  });
  yield* Agent.around({
    *prompt(args, next) {
      const stream = yield* next(...args);
      const observedStream: Stream<AgentPromptEvent, string> = {
        *[Symbol.iterator]() {
          attempted = true;
          const marked = yield* API.Files.operations.writeTextFile({
            ...target,
            content: JSON.stringify({ ...established, attempted }),
          });
          if (!marked.ok) {
            throw marked.error;
          }
          const subscription = yield* stream;
          return {
            *next() {
              const event = yield* subscription.next();
              if (!event.done && event.value.type === "started") {
                assertedId = event.value.session.agentSessionId;
                started ??= {
                  sessionKey: event.value.session.sessionKey,
                  cwd: event.value.session.cwd,
                  nativeId: assertedId ?? null,
                };
              }
              return event;
            },
          };
        },
      };
      return observedStream;
    },
  });
  return yield* Component.operations.content();
}
