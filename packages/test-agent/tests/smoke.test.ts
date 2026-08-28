/**
 * Tier TG — test-agent smoke (specs/test-agent-spec.md acceptance
 * §3–§4). TG1 runs the fixture through the real `xmd test` CLI, so the
 * command's own component wiring is covered. TG2 runs the same fixture
 * in process to replay a completed journal — the CLI never loads an
 * existing journal, so replay cannot be exercised through it.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { executeInstalled } from "@executablemd/core/host";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation, Result } from "effection";
import * as path from "node:path";
import {
  agentIdentityComponents,
  execute,
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

const DOC = path.resolve("smoke-test/test-agent/README.md");

// The fixture relaunches xmd as a worker, so the run keeps this process's
// working directory and its whole environment.
const RUN = { inheritEnv: true, timeout: 120_000 };

/**
 * The trusted `run` profile, as this package can state it.
 *
 * The shipped one is the CLI's, and the CLI depends on this package — so what
 * stands in here is the same assembly the CLI performs for a declared child:
 * this package's provider built from the frozen scenario data, the Agent
 * defaults, `<Session>`, and core's matcher provider. TG1 covers the real one.
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
              yield* installChildTestAgent(configuration, { workerCommand: worker }),
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

function* runSmoke(
  stream: InMemoryStream,
  xmd: string[],
): Operation<{ result: Result<Json>; output: string; results: readonly TestResult[] }> {
  // The scope closes before the assertions run, so the provider and its
  // workers finish teardown and the completion settles.
  return yield* scoped(function* () {
    const testing = yield* useTesting();
    yield* useCommand(xmd);
    yield* installTestAgentComponents();
    yield* installAgentComponents();
    const execution = yield* executeInstalled({ path: DOC, stream }, [
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
    return { result, output: next.value, results };
  });
}

describe("Tier TG — test-agent smoke", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("TG1: `xmd test` runs the fixture through the real ACPX runtime and worker", function* () {
    const cli = yield* runCli(["test", DOC], RUN).join();
    expect(cli.code).toBe(0);
    expect(cli.stdout).toContain("The review of **packages/core** at `abc123` passed.");
    expect(cli.stdout).toContain("The review of **packages/core** passed.");
    // The nested child's own return, which only a declared TestAgent and a
    // declared answer could have produced.
    expect(cli.stdout).toContain("You chose to approve the review.");
    expect(cli.stdout).not.toContain("ERROR");
  });

  it("TG2: replay repeats the completed journal without contacting ACPX", function* () {
    const stream = new InMemoryStream();

    const live = yield* runSmoke(stream, cliBase());
    expect(live.results.map((entry) => entry.status)).toEqual(["pass", "pass"]);
    expect(live.result.ok).toBe(true);
    expect(live.output).not.toContain("ERROR");

    const appended = stream.appendCount;
    // An unspawnable worker command proves replay never contacts ACPX
    // or a worker.
    const replay = yield* runSmoke(stream, ["/nonexistent/xmd-test-agent-must-not-spawn"]);
    expect(replay.results.map((entry) => entry.status)).toEqual(["pass", "pass"]);
    expect(replay.result.ok).toBe(true);
    expect(replay.output).toBe(live.output);
    expect(stream.appendCount).toBe(appended);
  });
});
