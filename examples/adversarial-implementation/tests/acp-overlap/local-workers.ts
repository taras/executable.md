import { createAcpRuntime, createAcpxProvider, createAcpxSessionStore } from "@executablemd/acp";
import { AgentProviders, registerAgentProvider } from "@executablemd/core";
import { Component, Plugin } from "@executablemd/core/api";
import { API, command, env, readTextFile } from "@executablemd/runtime";
import { useTestAgentController } from "@executablemd/test-agent";
import { writeTextFile } from "@effectionx/fs";
import { ensure } from "effection";
import { actorEnv, actorSchema, fableFailure, overlapEnv, waitForFile } from "./receipts.ts";
import type { PromptReceipt } from "./receipts.ts";

export default Plugin({
  name: "delivery-acp-overlap",
  *install(request) {
    if (request.command !== "run") {
      throw new Error("Delivery ACP workers require a run invocation.");
    }
    const directory = yield* env(overlapEnv);
    const actor = actorSchema.parse(yield* env(actorEnv));
    if (!directory?.startsWith("/")) {
      throw new Error("Delivery ACP workers require an absolute fixture directory.");
    }
    const receipts: PromptReceipt[] = [];
    yield* ensure(() =>
      writeTextFile(`${directory}/${actor}-prompts.json`, JSON.stringify(receipts)),
    );
    const worker = yield* command(["test-agent"]);
    if (!worker.includes("--node-modules-dir=manual")) {
      throw new Error("Delivery ACP overlap requires the prepared Deno worker plugin.");
    }

    const controller = yield* useTestAgentController();
    yield* API.Fs.around({
      *readTextFile([path], next) {
        if (path === `${directory}/Gate.md`) {
          if (actor !== "winner") {
            throw new Error(`Unexpected Astra prompt from ${actor}.`);
          }
          yield* writeTextFile(`${directory}/ready`, "");
          if ((yield* waitForFile(`${directory}/release`, 45_000)).timeout) {
            throw new Error("Timed out waiting to release the matched Astra turn.");
          }
        }
        return yield* next(path);
      },
    });

    yield* AgentProviders.around(
      {
        *install([call], next) {
          if (call.intent === "install") {
            throw new Error(
              `Delivery ACP fixture did not install a local factory for ${call.name}.`,
            );
          }
          return yield* next(call);
        },
      },
      { at: "min" },
    );
    yield* Component.around({
      *expand([request], next) {
        if (request.expansion.name === "Elicit") {
          throw new Error("The Delivery ACP overlap fixture does not answer holds.");
        }
        if (request.expansion.name !== "AgentProvider") {
          return yield* next(request);
        }
        for (const provider of ["claude", "codex"] as const) {
          const fable = provider === "claude";
          const name = fable ? "claude-workflow-role" : "acpx";
          const model = fable ? "fable" : "gpt-6-astra";
          const path = fable ? "Fable.md" : "Astra.md";
          yield* registerAgentProvider(name, function* (options, coordinator) {
            const scenario = yield* controller.useScenario({
              document: { path, source: yield* readTextFile(`${directory}/${path}`) },
              rootDir: directory,
              models: { selected: model, options: [{ id: model }] },
            });
            yield* createAcpxProvider({
              sessionStore: createAcpxSessionStore(`${directory}/${actor}-${provider}`),
              advertiseNativeLaunch: [],
              advertiseClientNativeAttachment: [],
              agentRegistry: {
                list: () => [provider],
                resolve(selected) {
                  if (selected !== provider) {
                    throw new Error(`Unexpected Delivery ACP fixture agent ${selected}.`);
                  }
                  return [...worker, "--connect", scenario.route];
                },
              },
              createRuntime(options) {
                const pending = new Map<unknown, PromptReceipt>();
                return createAcpRuntime({
                  ...options,
                  onAcpMessage(direction, message) {
                    if (
                      direction === "outbound" &&
                      "method" in message &&
                      message.method === "session/prompt"
                    ) {
                      const receipt: PromptReceipt = { provider, disposition: "sent" };
                      receipts.push(receipt);
                      if ("id" in message) {
                        pending.set(message.id, receipt);
                      }
                    }
                    if (direction === "inbound" && "id" in message) {
                      const receipt = pending.get(message.id);
                      if (receipt !== undefined) {
                        pending.delete(message.id);
                        if ("error" in message) {
                          receipt.disposition =
                            message.error.code === -32603 && message.error.message === fableFailure
                              ? "failed"
                              : "other";
                        } else if (
                          "result" in message &&
                          typeof message.result === "object" &&
                          message.result !== null &&
                          "stopReason" in message.result &&
                          message.result.stopReason === "end_turn"
                        ) {
                          receipt.disposition = "completed";
                        } else {
                          receipt.disposition = "other";
                        }
                      }
                    }
                  },
                });
              },
            })(options, coordinator);
          });
        }
        return yield* next(request);
      },
    });
    return undefined;
  },
});
