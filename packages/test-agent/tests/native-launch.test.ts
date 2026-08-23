/**
 * Tier TL — native session launch through the whole TestAgent stack
 * (specs/native-agent-session-launch-spec.md §Testing).
 *
 * A real worker over a real ACP connection, driven by a document. Nothing is
 * stubbed between `<Session.Launch>` and the agent: the instruction layer
 * crosses the wire as `session/new` metadata, the worker asserts the
 * provider-native identity itself, and the only substitution is the launcher,
 * which records what it was asked to start instead of starting a UI.
 *
 * The behavior document keeps one unused `<WhenPrompt>` stage throughout. A
 * launch that secretly took a model turn would consume it, and the `<Prompt>`
 * that follows would find the scenario exhausted — so "no hidden prompt" is
 * asserted by the answer the later prompt gets, not by an absence.
 */
import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { agentIdentityComponents, useTempFileCompiler } from "@executablemd/core";
import { ensure, scoped } from "effection";
import type { Operation, Result } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import { installAgentComponents } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import type { Json } from "@executablemd/core";
import { API, installControlledLauncher, useHostFiles } from "@executablemd/runtime";
import type { NativeLaunchRequest } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { installTestAgentComponents } from "../src/components.ts";
import { NativeLaunchObserver, NativeSessionObserver } from "../src/controller.ts";
import type { NativeSessionReport } from "../src/controller.ts";
import { useTesting } from "@executablemd/testing";
import type { TestResult } from "@executablemd/testing";
import { useCommand } from "./command.ts";
import { cliBase } from "@executablemd/test-support/launch";

const WORKER = cliBase();

/** One unused stage, so a stolen turn is observable as a missing answer. */
const SCENARIO = '<WhenPrompt template="what changed?" />\n\nnothing yet\n';

interface Run {
  result: Result<Json>;
  output: string;
  results: readonly TestResult[];
  launches: NativeLaunchRequest[];
  sessions: NativeSessionReport[];
  events: DurableEvent[];
}

interface RunOptions {
  stream?: InMemoryStream;
  exitCode?: number;
  /** Install a host launcher too, to prove nothing under <TestAgent> reaches it. */
  hostLauncher?: (request: NativeLaunchRequest) => void;
}

function* runDoc(doc: string, options: RunOptions = {}): Operation<Run> {
  const dir = path.join(os.tmpdir(), `xmd-tl-${randomUUID()}`);
  yield* ensureDir(dir);
  const launches: NativeLaunchRequest[] = [];
  const sessions: NativeSessionReport[] = [];
  const stream = options.stream ?? new InMemoryStream();
  return yield* scoped(function* () {
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    yield* writeTextFile(path.join(dir, "scenario.md"), SCENARIO);
    yield* writeTextFile(path.join(dir, "role.md"), "Follow the approved plan.\n");
    yield* writeTextFile(path.join(dir, "doc.md"), doc);

    // The scope closes before the fixtures are removed, so workers and
    // controllers finish teardown while their scenario files still exist.
    return yield* scoped(function* () {
      yield* API.Env.around({
        // deno-lint-ignore require-yield
        *cwd() {
          return dir;
        },
      });
      yield* useHostFiles();
      yield* NativeSessionObserver.set((report) => sessions.push(report));
      // The launcher `<TestAgent>` installs for its own scope. What a harness
      // supplies is what that launcher records and answers — it does not
      // install one of its own, because a document under `<TestAgent>` reaches
      // the component's launcher, not the host's.
      yield* NativeLaunchObserver.set({
        record: (request) => launches.push(request),
        outcome: () => ({ exitCode: options.exitCode ?? 0 }),
      });
      if (options.hostLauncher) {
        const reached = options.hostLauncher;
        yield* installControlledLauncher({
          record: (request) => reached(request),
          outcome: () => ({ exitCode: 0 }),
        });
      }
      const testing = yield* useTesting();
      yield* useCommand(WORKER);
      yield* installTestAgentComponents();
      yield* installAgentComponents();

      const execution = yield* executeInstalled({ path: path.join(dir, "doc.md"), stream }, [
        { components: agentIdentityComponents() },
      ]);
      const subscription = yield* execution.output;
      let next = yield* subscription.next();
      while (!next.done) {
        next = yield* subscription.next();
      }
      return {
        result: yield* execution,
        output: next.value,
        results: yield* testing.results,
        launches,
        sessions,
        events: yield* stream.readAll(),
      };
    });
  });
}

function preparedRecords(events: DurableEvent[]): Record<string, Json>[] {
  return events.flatMap((event) => {
    if (
      event.type !== "yield" ||
      event.description.type !== "agent_session_launch" ||
      !event.description.name.endsWith("/prepared") ||
      event.result.status !== "ok" ||
      typeof event.result.value !== "object" ||
      event.result.value === null ||
      Array.isArray(event.result.value)
    ) {
      return [];
    }
    return [event.result.value];
  });
}

function testDoc(body: string): string {
  return [
    "<TestAgent>",
    '<TestAgent.Scenario src="scenario.md" session="implementor" />',
    "",
    '<Test name="launch">',
    body,
    "</Test>",
    "</TestAgent>",
    "",
  ].join("\n");
}

/**
 * A direct launch: the session it names does not exist yet, so this launch is
 * what constructs it. An enclosing `<Session>` would have established ACP-first
 * state first, and a launch does not convert one of those — see TL9.
 */
const LAUNCH_BODY = [
  '<Session.Launch session="implementor">',
  "You are the repository implementor.",
  '<File path="role.md" />',
  "</Session.Launch>",
].join("\n");

describe(
  "Tier TL — native launch through the TestAgent stack",
  {
    sanitizeOps: false,
    sanitizeResources: false,
  },
  () => {
    beforeAll(() => useTempFileCompiler());

    it("TL1: the rendered body installs as the agent's session instruction layer", function* () {
      const run = yield* runDoc(testDoc(LAUNCH_BODY));

      expect(run.result.ok ? "" : run.result.error.message).toBe("");
      // The launch constructs the session it names, so exactly one of the
      // agent's sessions carries prepared text and it is the one it prepared.
      const carrying = run.sessions.filter((report) => report.systemPrompt !== undefined);
      expect(carrying.length).toBe(1);
      const instructions = carrying[0]!.systemPrompt ?? "";
      // The agent received the launch body, and only the launch body.
      expect(instructions).toContain("You are the repository implementor.");
      expect(instructions).toContain("Follow the approved plan.");
      expect(instructions).not.toContain("TestAgent");
    });

    it("TL2: the native UI is started with the identity the agent asserted", function* () {
      const run = yield* runDoc(testDoc(LAUNCH_BODY));

      expect(run.launches.length).toBe(1);
      const nativeSessionId = run.sessions.at(-1)!.nativeSessionId;
      expect(nativeSessionId.startsWith("native-")).toBe(true);
      expect(run.launches[0]?.command).toEqual(["xmd-test-agent-ui", "--resume", nativeSessionId]);
      // And the retained record names that same identity.
      expect(preparedRecords(run.events)[0]?.nativeSessionId).toBe(nativeSessionId);
    });

    it("TL3: raw prepared instructions never reach argv or environment", function* () {
      const run = yield* runDoc(testDoc(LAUNCH_BODY));

      const request = run.launches[0]!;
      expect(request.command.join(" ")).not.toContain("repository implementor");
      expect(JSON.stringify(request.env ?? {})).not.toContain("repository implementor");
    });

    it("TL4: the launch takes no model turn, so the stage is still there afterwards", function* () {
      const run = yield* runDoc(
        testDoc(
          [
            LAUNCH_BODY,
            "",
            '<Session name="implementor">',
            "<Prompt>what changed?</Prompt>",
            "</Session>",
          ].join("\n"),
        ),
      );

      expect(run.result.ok ? "" : run.result.error.message).toBe("");
      // The one scripted stage answered the prompt that came *after* the
      // launch, which it could not have done had the launch consumed it.
      expect(run.output).toContain("nothing yet");
      expect(run.results.every((result) => result.status === "pass")).toBe(true);
    });

    it("TL5: a later prompt reattaches to the session the native UI was given", function* () {
      const run = yield* runDoc(
        testDoc(
          [
            LAUNCH_BODY,
            "",
            '<Session name="implementor">',
            "<Prompt>what changed?</Prompt>",
            "</Session>",
          ].join("\n"),
        ),
      );

      expect(run.result.ok).toBe(true);
      // Reattaching re-establishes the session rather than reusing the handle
      // that predates the handoff, and it lands on the provider-native state the
      // launch retained.
      const launched = preparedRecords(run.events)[0]?.nativeSessionId;
      expect(launched).toBeDefined();
      expect(run.sessions.at(-1)?.nativeSessionId).toBe(launched);
    });

    it("TL6: a nonzero native exit fails the test that launched", function* () {
      const run = yield* runDoc(testDoc(LAUNCH_BODY), { exitCode: 4 });

      expect(run.results.some((result) => result.status === "fail")).toBe(true);
      // The provider session facts survive the failure.
      expect(preparedRecords(run.events)[0]?.nativeSessionId).toBeDefined();
    });

    it("TL7: a launch under <TestAgent> never reaches the host's launcher", function* () {
      // The host has one, and it is the wrong one to reach: a scripted agent's
      // native UI does not exist, and the terminal a host would hand it belongs
      // to whoever is running the tests. Under `xmd test` there is no host
      // launcher at all, which is the same fact from the other side.
      const hostReached: NativeLaunchRequest[] = [];
      const run = yield* runDoc(testDoc(LAUNCH_BODY), {
        hostLauncher: (request) => hostReached.push(request),
      });

      expect(run.result.ok ? "" : run.result.error.message).toBe("");
      expect(hostReached).toEqual([]);
      // The component's own launcher took it instead.
      expect(run.launches.length).toBe(1);
    });

    it("TL9: two sibling tests naming one session each get a session of their own", function* () {
      // Identical agent, identical session name, identical cwd — so the natural
      // key a coordinator would exclude on is the same for both. What keeps
      // them apart is that each `<Test>` owns a complete provider partition,
      // with its own runtime, store, managed sessions, scenarios and
      // coordinator. Two sessions, not two owners of one.
      //
      // The layers differ deliberately: identical ones would resume, and a
      // shared partition would then look like an isolated pair.
      const run = yield* runDoc(
        [
          "<TestAgent>",
          '<TestAgent.Scenario src="scenario.md" session="implementor" />',
          "",
          '<Test name="first">',
          '<Session.Launch session="implementor">',
          "You are the repository implementor.",
          "</Session.Launch>",
          '<Session name="implementor">',
          "<Prompt>what changed?</Prompt>",
          "</Session>",
          "</Test>",
          "",
          '<Test name="second">',
          '<Session.Launch session="implementor">',
          "You are the repository reviewer.",
          "</Session.Launch>",
          '<Session name="implementor">',
          "<Prompt>what changed?</Prompt>",
          "</Session>",
          "</Test>",
          "</TestAgent>",
          "",
        ].join("\n"),
      );

      expect(run.result.ok ? "" : run.result.error.message).toBe("");
      expect(run.results.map((result) => result.status)).toEqual(["pass", "pass"]);

      // Each test's launch installed its own layer. A shared partition would
      // have refused the second: the session would already carry a different
      // one, and this provider replaces none.
      const layers = run.sessions
        .map((report) => report.systemPrompt)
        .filter((prompt): prompt is string => prompt !== undefined);
      expect(layers.length).toBe(2);
      expect(layers.some((layer) => layer.includes("implementor"))).toBe(true);
      expect(layers.some((layer) => layer.includes("reviewer"))).toBe(true);

      // Two native identities, so neither test saw the other's session — and
      // neither waited on the other, which a shared coordinator would have
      // made them do.
      const identities = new Set(run.launches.map((request) => request.command.at(-1)));
      expect(run.launches.length).toBe(2);
      expect(identities.size).toBe(2);

      // Each test's prompt was answered by a scenario of its own: one stage
      // exists per instance, and a shared one would have been exhausted.
      const answers = run.output.split("nothing yet").length - 1;
      expect(answers).toBe(2);
    });

    it("TL10: the provider is installed once, in <TestAgent>, not per test", function* () {
      // Outside every `<Test>`, so the only installation that can serve this
      // launch is the one the `<TestAgent>` invocation made. A provider
      // installed per test would leave this content with none.
      const run = yield* runDoc(
        [
          "<TestAgent>",
          '<TestAgent.Scenario src="scenario.md" session="implementor" />',
          "",
          '<Session.Launch session="implementor">',
          "You are the repository implementor.",
          "</Session.Launch>",
          "",
          // A testing session needs one, and this one is deliberately empty:
          // the launch above it is what reaches the installation.
          '<Test name="present">',
          "nothing to check here",
          "</Test>",
          "</TestAgent>",
          "",
        ].join("\n"),
      );

      expect(run.result.ok ? "" : run.result.error.message).toBe("");
      expect(run.launches.length).toBe(1);
      expect(run.sessions.filter((report) => report.systemPrompt !== undefined).length).toBe(1);
    });

    it("TL8: full replay contacts neither the agent nor the launcher", function* () {
      const stream = new InMemoryStream();
      const first = yield* runDoc(testDoc(LAUNCH_BODY), { stream });
      expect(first.result.ok).toBe(true);
      expect(first.launches.length).toBe(1);
      expect(first.sessions.length).toBeGreaterThan(0);

      const second = yield* runDoc(testDoc(LAUNCH_BODY), { stream });
      expect(second.result.ok).toBe(true);
      expect(second.launches.length).toBe(0);
      expect(second.sessions.length).toBe(0);
    });
  },
);
