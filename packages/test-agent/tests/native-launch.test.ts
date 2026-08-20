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
import { useTempFileCompiler } from "@executablemd/core";
import { ensure, scoped } from "effection";
import type { Operation, Result } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import { execute, installAgentComponents } from "@executablemd/core";
import type { Json } from "@executablemd/core";
import { API, installControlledLauncher, useHostFiles } from "@executablemd/runtime";
import type { NativeLaunchRequest } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { installTestAgentComponents } from "../src/components.ts";
import { NativeSessionObserver } from "../src/controller.ts";
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
  /** Leave the launcher out, as a host with no terminal does. */
  launcher?: false;
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
      if (options.launcher !== false) {
        yield* installControlledLauncher({
          record: (request) => launches.push(request),
          outcome: () => ({ exitCode: options.exitCode ?? 0 }),
        });
      }
      const testing = yield* useTesting();
      yield* useCommand(WORKER);
      yield* installTestAgentComponents();
      yield* installAgentComponents();

      const execution = yield* execute({ path: path.join(dir, "doc.md"), stream });
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

const LAUNCH_BODY = [
  '<Session name="implementor">',
  "<Session.Launch>",
  "You are the repository implementor.",
  '<File path="role.md" />',
  "</Session.Launch>",
  "</Session>",
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
      // `<Session name>` establishes the session first, and the launch installs
      // its instruction layer on it — so exactly one of the agent's sessions
      // carries prepared text, and it is the one the launch prepared.
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

    it("TL7: a host with no launcher refuses before the agent is asked for anything", function* () {
      const run = yield* runDoc(testDoc(LAUNCH_BODY), { launcher: false });

      expect(run.results.some((result) => result.status === "fail")).toBe(true);
      // The session `<Session name>` established is still there; what never
      // happened is the launch — nothing was prepared for a handoff, and no
      // ACP ownership moved.
      expect(preparedRecords(run.events).length).toBe(0);
      expect(run.launches.length).toBe(0);
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
