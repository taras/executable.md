import { ensure, scoped } from "effection";
import type { Operation, Stream } from "effection";
import { readTextFile } from "@effectionx/fs";
import { fileURLToPath } from "node:url";
import { API } from "@executablemd/runtime";
import { useStubFs } from "@executablemd/runtime/test";
import type { DurableStream } from "@executablemd/durable-streams";
import { InMemoryStream } from "@executablemd/durable-streams";
import { executeInstalled } from "../host.ts";
import type { HostExecution } from "../host.ts";
import { recordedFiles, useRecordedFiles } from "./support/fragment-files.ts";
import { useNormalizedOutput } from "../src/output/normalize.ts";
import { Agent } from "../src/agent/agent-api.ts";
import type { AgentPromptEvent, Session } from "../src/agent/agent-api.ts";
import { isSessionRequest } from "../src/agent/session-request.ts";
import { installAgentComponents, agentIdentityComponents } from "../src/agent/components.ts";
import { AgentPromptError } from "../src/agent/errors.ts";

export function fixture(name: string): Operation<string> {
  return readTextFile(
    fileURLToPath(new URL(`fixtures/try-catch-finally/${name}.md`, import.meta.url)),
  );
}

interface Provider {
  fail?: boolean;
  releaseError?: Error;
  release?: Operation<void>;
  releasing?: () => void;
  failure?: Error;
  trace: string[];
}

export function* start(
  source: string,
  stream: DurableStream = new InMemoryStream(),
  provider?: Provider,
  files: Record<string, string> = {},
): Operation<HostExecution> {
  yield* useStubFs({ "try.md": source, ...files });
  yield* useRecordedFiles(recordedFiles());
  yield* useNormalizedOutput();
  yield* API.Process.around({
    // deno-lint-ignore require-yield
    *exec([options]) {
      const failed = options.command.join(" ").includes("FAIL");
      return { exitCode: failed ? 1 : 0, stdout: "", stderr: failed ? "checked failure" : "" };
    },
  });
  if (provider !== undefined) {
    yield* installAgentComponents({
      rootProvider: {
        options: { defaultAgent: "claude", permissionMode: "deny-all" },
        *factory(_options, coordinator) {
          yield* Agent.around(
            {
              // deno-lint-ignore require-yield
              *agent([name]) {
                return name ?? "claude";
              },
              *session([name]) {
                const session: Session = {
                  sessionKey: `session:${typeof name === "string" ? name : "request"}`,
                  cwd: ".",
                };
                if (!isSessionRequest(name)) {
                  return session;
                }
                const setup = coordinator.sessionSetup(name);
                const active = yield* setup.activate("stub", "stub-command");
                if (!active.ok) {
                  throw active.error;
                }
                return yield* setup.finish(session, {
                  kind: "existing",
                  configure: function* (value) {
                    return value;
                  },
                });
              },
              // deno-lint-ignore require-yield
              *prompt([_text, options]): Operation<Stream<AgentPromptEvent, string>> {
                const agent = options?.agent ?? "claude";
                provider.trace.push(`prompt:${agent}`);
                const failure = provider.fail === true && agent === "claude";
                const session =
                  typeof options?.session === "object"
                    ? options.session
                    : { sessionKey: "stub", cwd: "." };
                const error =
                  provider.failure ??
                  new AgentPromptError("primary unavailable", {
                    agent,
                    sessionKey: session.sessionKey,
                    cause: new Error("saved cause"),
                    diagnostic: {
                      provider: "acp",
                      operation: "session/prompt",
                      stage: "runtime-turn",
                      code: "unavailable",
                      retryable: true,
                    },
                  });
                return {
                  *[Symbol.iterator]() {
                    yield* ensure(function* () {
                      provider.trace.push(`releasing:${agent}`);
                      provider.releasing?.();
                      if (agent === "claude" && provider.release !== undefined) {
                        yield* provider.release;
                      }
                      provider.trace.push(`released:${agent}`);
                      if (provider.releaseError !== undefined) {
                        throw provider.releaseError;
                      }
                    });
                    const events: AgentPromptEvent[] = [
                      { type: "started", agent, session },
                      {
                        type: "terminal",
                        status: failure ? "failed" : "completed",
                        ...(failure ? { error } : {}),
                      },
                    ];
                    let index = 0;
                    return {
                      // deno-lint-ignore require-yield
                      *next() {
                        const event = events[index++];
                        return event === undefined
                          ? { done: true, value: failure ? "" : "PASS" }
                          : { done: false, value: event };
                      },
                    };
                  },
                };
              },
            },
            { at: "min" },
          );
        },
      },
    });
  }
  return yield* executeInstalled(
    { path: "try.md", stream, secretDetection: false },
    provider === undefined ? [] : [{ components: agentIdentityComponents() }],
  );
}

export function run(
  source: string,
  provider?: Provider,
  stream = new InMemoryStream(),
  files: Record<string, string> = {},
) {
  return scoped(function* () {
    const execution = yield* start(source, stream, provider, files);
    const subscription = yield* execution.output;
    let next = yield* subscription.next();
    const chunks: string[] = [];
    while (!next.done) {
      chunks.push(next.value);
      next = yield* subscription.next();
    }
    return { result: yield* execution, output: chunks.join(""), events: stream.snapshot() };
  });
}
