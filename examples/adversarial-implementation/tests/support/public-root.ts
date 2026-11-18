import { createAcpxProvider, createAcpxSessionStore } from "@executablemd/acp";
import {
  parsePromptRecord,
  agentIdentityComponents,
  installAgentComponents,
} from "@executablemd/agent/host";
import { Agent, AgentProviders, registerAgentProvider } from "@executablemd/agent/api";
import { Component } from "@executablemd/core/api";
import { executeInstalled } from "@executablemd/core/host";
import { useHostFiles, useQuietProcessOutput, Permissions } from "@executablemd/runtime";
import { useComponentModuleLoader } from "@executablemd/test-support/host";
import { cliRuntime, cliCommand } from "@executablemd/test-support/launch";
import { useTestAgentController } from "@executablemd/test-agent";
import { InMemoryStream, serializeDurableEvent } from "@executablemd/durable-streams";
import { forEach } from "@effectionx/stream-helpers";
import { type Operation, ensure, scoped, spawn } from "effection";
import { readTextFile, writeTextFile } from "@effectionx/fs";
import { join } from "node:path";
import { describe } from "../../components/Ticket/text-storage.ts";
import boundary from "../fixtures/joined-response-owner/git-boundary.ts";

export function* publicRoots(directory: string, includes: string[]) {
  yield* useHostFiles();
  yield* useQuietProcessOutput();
  const controller = yield* useTestAgentController();
  const store = createAcpxSessionStore(join(directory, "sessions"));
  const worker = cliCommand(["test-agent"]);
  if (cliRuntime() === "deno") {
    if (worker.arguments[0] !== "run") {
      throw new Error("Unsupported Deno worker prefix");
    }
    worker.arguments.splice(1, 0, "--node-modules-dir=manual", "--cached-only", "--frozen");
  }
  const routes = new Map<string, string>();
  for (const [session, provider, model] of [
    ["original-haiku", "claude", "haiku"],
    ["original-sol", "codex", "gpt-6.1-sol"],
    ["original-architect", "codex", "gpt-6.1-sol"],
    ["controlled-diagnosis", "claude", "haiku"],
  ]) {
    const scenario = yield* controller.useScenario({
      document: {
        path: session + ".md",
        source: Array.from(
          { length: 12 },
          (_, index) =>
            '<WhenPrompt template="{?request}" />\n\n<File path="reply.md" as="reply' +
            index +
            '" />\n\n{reply' +
            index +
            "}\n\n",
        ).join("\n"),
      },
      rootDir: directory,
      models: {
        selected: model,
        options: [model, "opus"].map((id) => ({
          id,
          efforts: { selected: "high", options: ["high", "medium"] },
        })),
      },
    });
    routes.set(session + ":" + provider, scenario.route);
  }
  const prompts: string[] = [];
  const turns: { handle: { sessionKey: string } }[] = [];
  const hooks: { beforePrompt?: () => Operation<void>; cleanup?: () => Operation<void> } = {};
  const journals: string[] = [];
  let ordinal = 0;
  function run(source: string, session = "original-haiku", selectedIncludes = includes) {
    return scoped(function* () {
      const invocation = ordinal++;
      const path = join(directory, "root-" + invocation + ".md");
      yield* writeTextFile(path, source);
      const stream = new InMemoryStream();
      const result = yield* scoped(function* () {
        yield* ensure(function* () {
          if (hooks.cleanup) {
            yield* hooks.cleanup();
          }
        });
        yield* useHostFiles();
        yield* Permissions.around({ files: () => true }, { at: "min" });
        yield* useComponentModuleLoader();
        yield* installAgentComponents({
          defaultAgent: "claude",
          rootProvider: {
            options: { defaultAgent: "claude", permissionMode: "deny-all" },
            factory: createAcpxProvider({
              sessionStore: store,
              advertiseNativeLaunch: [],
              advertiseClientNativeAttachment: [],
              agentRegistry: {
                list: () => ["claude", "codex"],
                resolve(actor) {
                  const route = routes.get(session + ":" + actor);
                  if (!route) {
                    throw new Error("Unknown fixture actor: " + actor);
                  }
                  return [worker.command, ...worker.arguments, "--connect", route];
                },
              },
            }),
          },
        });
        yield* AgentProviders.around(
          {
            *install([call], next) {
              if (call.intent === "install") {
                throw new Error("Unconfigured fixture provider: " + call.name);
              }
              return yield* next(call);
            },
          },
          { at: "min" },
        );
        yield* Agent.around({
          *session([routed], next) {
            const name = typeof routed === "string" ? routed : routed?.name;
            if (
              name !== undefined &&
              name !== session &&
              !(session === "controlled-diagnosis" && name.startsWith("controlled-diagnosis-"))
            ) {
              throw new Error("Unknown fixture session: " + name);
            }
            return yield* next(routed);
          },
          *prompt(args, next) {
            if (hooks.beforePrompt) {
              yield* hooks.beforePrompt();
            }
            prompts.push(args[0]);
            const result = yield* next(...args);
            return result;
          },
        });
        yield* Component.around({
          *expand([request], next) {
            if (request.expansion.name === "AgentProvider") {
              for (const name of ["acpx", "claude-workflow-role", "diagnostic-acpx"]) {
                yield* registerAgentProvider(
                  name,
                  createAcpxProvider({
                    sessionStore: store,
                    advertiseNativeLaunch: [],
                    advertiseClientNativeAttachment: [],
                    agentRegistry: {
                      list: () => ["claude", "codex"],
                      resolve(actor) {
                        const route = routes.get(session + ":" + actor);
                        if (route === undefined) {
                          throw new Error("Unknown fixture actor: " + actor);
                        }
                        return [worker.command, ...worker.arguments, "--connect", route];
                      },
                    },
                  }),
                );
              }
            }
            return yield* next(request);
          },
        });
        if (boundary.install) {
          yield* boundary.install({ command: "run", args: [] });
        }
        const execution = yield* executeInstalled({ path, includes: selectedIncludes, stream }, [
          { components: agentIdentityComponents() },
        ]);
        const output = yield* spawn(function* () {
          yield* forEach(function* () {}, execution.output);
        });
        const result = yield* execution;
        yield* output;
        return result;
      });
      for (const event of stream.snapshot()) {
        if (
          event.type === "yield" &&
          event.description.type === "agent_prompt" &&
          event.result.status === "ok"
        ) {
          const prompt = parsePromptRecord(event.result.value);
          if (prompt) {
            turns.push({ handle: { sessionKey: prompt.sessionKey } });
          }
        }
      }
      const journal = join(directory, "root-" + invocation + ".jsonl");
      yield* writeTextFile(journal, stream.snapshot().map(serializeDurableEvent).join(""));
      journals.push(journal);
      const settlement = join(directory, "root-" + invocation + "-settlement.json");
      yield* writeTextFile(
        settlement,
        JSON.stringify({
          schema: "joined-response-run-settlement.v1",
          root: describe(path, source),
          journal: describe(journal, yield* readTextFile(journal)),
          outcome: { kind: "settled", result },
        }),
      );
      if (!result.ok) {
        throw result.error;
      }
      return { value: result.value, journal, settlement };
    });
  }
  return {
    run,
    prompts,
    turns,
    journals,
    hooks,
    *script(reply: string) {
      yield* writeTextFile(join(directory, "reply.md"), reply);
    },
  };
}
