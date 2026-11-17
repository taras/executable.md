import { InMemoryStream, serializeDurableEvent } from "@executablemd/durable-streams";
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
import { boundedJournalResult } from "../../../test-support/subprocess-journal.ts";
import { ASSEMBLY_PROFILES, ASSEMBLY_SOURCE } from "../support/assembly-profiles.ts";

const root = process.argv[2]!;
const agent = process.argv[3] === "codex" ? "codex" : "claude";
const capture = process.argv[4] === "--capture-journal";
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
  const journals: string[][] = [];
  for (const profile of ASSEMBLY_PROFILES) {
    const fake = createFakeAcp();
    fake.script({
      reply:
        capture && process.argv[5] === "--oversized-plan" && profile === "plan"
          ? "assembled ".repeat(2_000)
          : "assembled",
    });
    const stream = new InMemoryStream();
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
            ...retainedSource(ASSEMBLY_SOURCE, "<Prompt>assembly</Prompt>"),
            stream,
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
    if (capture) {
      journals.push((yield* stream.readAll()).map(serializeDurableEvent));
    }
  }
  const environmentPreserved = [
    ...new Set([...Object.keys(environment), ...Object.keys(process.env)]),
  ].every((key) => environment[key] === process.env[key]);
  const result = { results, environmentPreserved };
  console.log(capture ? boundedJournalResult(result, journals) : JSON.stringify(result));
});
