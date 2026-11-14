import { createAcpxProvider, createAcpxSessionStore } from "@executablemd/acp";
import { Plugin } from "@executablemd/core/api";
import { registerAgentProvider } from "@executablemd/core";
import { installInvocationAgentProvider } from "@executablemd/core/host";
import type { ReplPluginInstallation } from "@executablemd/cli/api";
import { env, readTextFile } from "@executablemd/runtime";
import { useTestAgentController } from "@executablemd/test-agent";
import { createContext } from "effection";
import type { Operation } from "effection";
import { basename, dirname, join } from "node:path";
import { denoCommand } from "./run.ts";

const AGENT = "scripted";
const Worker = createContext<string[]>("xmd.repl-bench.scripted-sidekick.worker");

export default Plugin({
  name: AGENT,
  *install({ command: selected }): Operation<ReplPluginInstallation | undefined> {
    if (selected !== "repl") {
      return undefined;
    }
    return {
      repl: {
        *initialize() {
          const path = yield* env("XMD_SIDEKICK_SCENARIO");
          if (path === undefined) {
            throw new Error("The scripted Sidekick requires XMD_SIDEKICK_SCENARIO.");
          }
          const source = yield* readTextFile(path);
          const controller = yield* useTestAgentController();
          const scenario = yield* controller.useScenario({
            document: { path: basename(path), source },
            rootDir: dirname(path),
          });
          const worker = denoCommand(["test-agent", "--connect", scenario.route]);
          yield* Worker.set(worker);
        },
        *sidekick() {
          const worker = yield* Worker.expect();
          const home = yield* env("HOME");
          if (home === undefined) {
            throw new Error("The scripted Sidekick requires a home directory for its sessions.");
          }
          const denoDir = yield* env("DENO_DIR");
          const factory = createAcpxProvider({
            permissions: "strict",
            mcpServers: [],
            newSessionOptions: { allowedTools: [] },
            agentRegistry: {
              resolve(name) {
                if (name !== AGENT) {
                  throw new Error(`The scripted Sidekick requires --sidekick-agent ${AGENT}.`);
                }
                return worker;
              },
              list: () => [AGENT],
            },
            sessionStore: createAcpxSessionStore(join(home, ".xmd-scripted-sidekick")),
            // ACPX's default allowlist omits DENO_DIR.
            agentProcessEnv: function* () {
              return denoDir === undefined ? undefined : { DENO_DIR: denoDir };
            },
          });
          yield* registerAgentProvider(AGENT, factory);
          yield* installInvocationAgentProvider(AGENT, {
            defaultAgent: AGENT,
            permissionMode: "deny-all",
          });
        },
      },
    };
  },
});
