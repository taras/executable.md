import { InMemoryStream } from "@executablemd/durable-streams";
import { rm } from "@effectionx/fs";
import { main, scoped, useScope } from "effection";
import { useHostFiles } from "@executablemd/runtime";
import { collect, retainedSource } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import type { AcpRuntimeOptions } from "@executablemd/acp";
import { createEmbeddedAdapters } from "@executablemd/acp/embedded-adapters";
import { join } from "node:path";
import process from "node:process";
import type { AgentStack } from "../../src/agent-stack.ts";
import { hostAcpDependencies, installAgentProviderStack } from "../../src/agent-stack.ts";
import { planWriterDependencies } from "../../src/plan-writer-profile.ts";
import { assembleReplProfile } from "../../src/repl-profile.ts";
import { NO_PLUGINS } from "../../src/plugin-host.ts";
import { createFakeAcp, makeStore, makeRegistry } from "../support/fake-acp.ts";
const root = process.argv[2]!;
const agent = process.argv[3] === "codex" ? "codex" : "claude";
const variable = agent === "codex" ? "CODEX_PATH" : "CLAUDE_CODE_EXECUTABLE";
const environment = { ...process.env };
main(function* () {
  yield* useHostFiles();
  const embedded = createEmbeddedAdapters(join(root, "adapters"));
  const adapters = { ...embedded, *materialize() {} };
  const stack: AgentStack = {
    provider: "acpx",
    defaultAgent: agent,
    permissionMode: "deny-all",
    adapters,
  };
  const results: {
    profile: string;
    inputs: {
      environment: AcpRuntimeOptions["agentProcessEnv"];
      command: ReturnType<AcpRuntimeOptions["agentRegistry"]["resolve"]>;
    }[];
  }[] = [];
  for (const profile of ["run", "plan", "repl", "custom", "other"]) {
    const fake = createFakeAcp();
    fake.script({ reply: "assembled" });
    yield* scoped(function* () {
      const host = yield* useScope();
      if (profile === "custom") {
        yield* rm(process.env[variable]!, { force: true });
      }
      const base = {
        ...hostAcpDependencies(stack),
        createRuntime: fake.create,
        sessionStore: makeStore(),
        advertiseNativeLaunch: [],
        advertiseClientNativeAttachment: [],
      };
      const dependencies =
        profile === "custom"
          ? { ...base, agentRegistry: makeRegistry({ [agent]: `custom-${agent}-command` }) }
          : base;
      if (profile === "repl") {
        yield* assembleReplProfile(stack, NO_PLUGINS, {
          acp: dependencies,
          planWriterRoot: join(root, "plans"),
        });
      } else {
        yield* installAgentProviderStack(
          { ...stack, defaultAgent: profile === "other" ? "gemini" : agent },
          profile === "plan"
            ? planWriterDependencies({ stack, acp: dependencies }, root, host)
            : dependencies,
        );
      }
      yield* collect(
        yield* executeInstalled(
          {
            ...retainedSource("assembly.md", "<Prompt>assembly</Prompt>"),
            stream: new InMemoryStream(),
          },
          [],
        ),
      );
      results.push({
        profile,
        inputs: fake.created.map((options) => ({
          environment: options.agentProcessEnv,
          command: options.agentRegistry.resolve(profile === "other" ? "gemini" : agent),
        })),
      });
    });
  }
  const environmentPreserved = [
    ...new Set([...Object.keys(environment), ...Object.keys(process.env)]),
  ].every((key) => environment[key] === process.env[key]);
  console.log(JSON.stringify({ results, environmentPreserved }));
});
