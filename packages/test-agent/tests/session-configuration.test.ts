import { describe, it } from "@executablemd/test-support/bdd";
import { executeInstalled } from "@executablemd/core/host";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation, Result } from "effection";
import * as path from "node:path";
import {
  agentIdentityComponents,
  content,
  registerComponents,
  inlineSource,
  installAgentComponents,
} from "@executablemd/core";
import { installAnswerProvider } from "@executablemd/core/host";
import type { ExecutionInstallation } from "@executablemd/core/host";
import { forEach } from "@effectionx/stream-helpers";
import { useHostFiles } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import { testHarnessInstallation, useTesting } from "@executablemd/testing";
import type {
  ChildInvocation,
  ChildSettlement,
  ExecutionHostProvider,
  TestResult,
} from "@executablemd/testing";
import { installTestAgentComponents } from "../src/components.ts";
import { installChildTestAgent, testAgentChildDeclaration } from "../src/child-configuration.ts";
import { useCommand } from "./command.ts";
import { cliBase, runCli } from "@executablemd/test-support/launch";
import type { Json } from "@executablemd/core";
import { NativeSessionObserver } from "../src/controller.ts";
import type { NativeSessionReport } from "../src/controller.ts";

const DOC = path.resolve("packages/test-agent/src/SessionConfiguration.test.md");

// The fixture relaunches xmd as a worker, so the run keeps this process's
// working directory and its whole environment.
const RUN = { inheritEnv: true, timeout: 120_000 };

/**
 * The trusted `run` profile, as this package can state it.
 *
 * The shipped one is the CLI's, and the CLI depends on this package — so what
 * stands in here is the same assembly the CLI performs for a declared child:
 * this package's provider built from the frozen scenario data, the Agent
 * defaults, `<Session>`, and core's matcher provider. The CLI case covers the real one.
 */
function nestedRunHost(worker: string[]): ExecutionHostProvider {
  return {
    *runChild(invocation: ChildInvocation): Operation<ChildSettlement> {
      const request = invocation.request;
      const installations: ExecutionInstallation[] = [];
      for (const configuration of request.configuration ?? []) {
        switch (configuration.kind) {
          case "test-agent":
            yield* installAgentComponents(
              (yield* installChildTestAgent(configuration, { workerCommand: worker })).components,
            );
            installations.push({ components: agentIdentityComponents() });
            break;
          case "answers":
            yield* installAnswerProvider(configuration);
            break;
        }
      }
      yield* useHostFiles();
      const execution = yield* executeInstalled(
        {
          ...inlineSource(request.source ?? ""),
          stream: new InMemoryStream(),
          props: request.props,
        },
        installations,
      );
      const output = yield* forEach(function* (chunk: string) {
        yield* invocation.chunk(chunk);
      }, execution.output);
      return { outcome: { kind: "settled", result: yield* execution }, output };
    },
  };
}

function* runConfiguration(
  stream: InMemoryStream,
  xmd: string[],
  doc = DOC,
): Operation<{
  result: Result<Json>;
  output: string;
  results: readonly TestResult[];
  sessions: NativeSessionReport[];
}> {
  // The scope closes before the assertions run, so the provider and its
  // workers finish teardown and the completion settles.
  return yield* scoped(function* () {
    const sessions: NativeSessionReport[] = [];
    yield* NativeSessionObserver.set((report) => sessions.push(report));
    // Session configuration refusals are raw Errors, outside AssertThrows' raised-segment contract.
    yield* registerComponents([
      {
        name: "ExpectRefusal",
        origin: "session-configuration.test.ts",
        props: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        },
        *fn(props) {
          let caught: unknown;
          try {
            yield* content();
          } catch (error) {
            caught = error;
          }
          expect(caught).toBeInstanceOf(Error);
          expect(caught instanceof Error ? caught.message : "").toContain(props.message);
          return "";
        },
      },
    ]);
    const testing = yield* useTesting();
    yield* useCommand(xmd);
    yield* installTestAgentComponents();
    yield* installAgentComponents();
    const execution = yield* executeInstalled({ path: doc, stream }, [
      { components: agentIdentityComponents() },
      testHarnessInstallation(nestedRunHost([...xmd, "test-agent"]), [testAgentChildDeclaration()]),
    ]);
    const subscription = yield* execution.output;
    let next = yield* subscription.next();
    while (!next.done) {
      next = yield* subscription.next();
    }
    const result = yield* execution;
    const results = yield* testing.results;
    return { result, output: next.value, results, sessions };
  });
}

describe(
  "Session configuration through TestAgent",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("runs configured Sessions and nested declarations through the source CLI and ACPX worker", function* () {
      const cli = yield* runCli(["test", DOC], RUN).join();
      expect(cli.code).toBe(0);
      expect(cli.stdout).toContain("review deep");
      expect(cli.stdout).not.toContain("ERROR");
    });

    it("refuses unknown, unsupported and unavailable Session selections before consuming the first stage", function* () {
      const run = yield* runConfiguration(
        new InMemoryStream(),
        cliBase(),
        path.resolve("packages/test-agent/src/SessionConfiguration.refusals.md"),
      );
      expect(run.result.ok ? "ok" : run.result.error.message).toBe("ok");
      expect(run.results.map((entry) => entry.status)).toEqual(["pass", "pass"]);
      expect(new Set(run.sessions.map((report) => report.nativeSessionId)).size).toBe(2);
    });

    it("retains named native identity, isolates Tests, and replays without a worker", function* () {
      const stream = new InMemoryStream();
      const live = yield* runConfiguration(stream, cliBase());
      expect(live.result.ok).toBe(true);
      expect(live.results.map((entry) => entry.status)).toEqual([
        "pass",
        "pass",
        "pass",
        "pass",
        "pass",
      ]);
      const byScenario = new Map<string, Set<string>>();
      for (const report of live.sessions) {
        const ids = byScenario.get(report.scenarioId) ?? new Set<string>();
        ids.add(report.nativeSessionId);
        byScenario.set(report.scenarioId, ids);
      }
      expect(byScenario.size).toBeGreaterThanOrEqual(4);
      expect([...byScenario.values()].every((ids) => ids.size === 1)).toBe(true);
      expect(new Set(live.sessions.map((report) => report.nativeSessionId)).size).toBe(
        byScenario.size,
      );
      expect(live.sessions.length).toBeGreaterThan(byScenario.size);
      const events = JSON.stringify(yield* stream.readAll());
      expect(events).toContain('"configuration":{"model":"fixture-review","effort":"deep"}');
      const appended = stream.appendCount;
      const replay = yield* runConfiguration(stream, [
        "/nonexistent/xmd-configuration-must-not-spawn",
      ]);
      expect(replay.result.ok).toBe(true);
      expect(replay.results.map((entry) => entry.status)).toEqual(
        live.results.map((entry) => entry.status),
      );
      expect(replay.sessions).toEqual([]);
      expect(replay.output).toBe(live.output);
      expect(stream.appendCount).toBe(appended);
    });
  },
);
