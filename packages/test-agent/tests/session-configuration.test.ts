import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { cliBase } from "@executablemd/test-support/launch";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { executeInstalled } from "@executablemd/core/host";
import { content, registerComponents } from "@executablemd/core";
import type { Json } from "@executablemd/core";
import { agentIdentityComponents, installAgentComponents } from "@executablemd/agent/host";
import { parseDurableEvent } from "@executablemd/durable-streams";
import type { InMemoryStream } from "@executablemd/durable-streams";
import { API } from "@executablemd/runtime";
import { useTesting } from "@executablemd/testing";
import type { TestResult } from "@executablemd/testing";
import { exists, readdir, readTextFile, writeTextFile } from "@effectionx/fs";
import { Err, Ok, scoped } from "effection";
import type { Operation, Result } from "effection";
import * as path from "node:path";
import process from "node:process";
import { Writable } from "node:stream";
import { captureTestJournal } from "../../test-support/failure-journal.ts";
import type { DeliverySink } from "../../cli/src/stdout-delivery.ts";
import { installTestAgentComponents } from "../src/components.ts";
import { NativeSessionObserver } from "../src/controller.ts";
import type { NativeSessionReport } from "../src/controller.ts";
import { useCommand } from "./command.ts";

const DOC = path.resolve("packages/test-agent/src/SessionConfiguration.replay.md");

const OWNER = "packages/test-agent/tests/session-configuration.test.ts";
const SUITE = "Session configuration through TestAgent";

function captureConfiguration(
  name: string,
  doc: string,
  body: (stream: InMemoryStream) => Operation<void>,
  sink: DeliverySink = process.stderr,
): Operation<void> {
  return captureTestJournal({ owner: OWNER, suite: SUITE, name }, doc, body, { sink });
}

/** A native session report stamped with milliseconds since the run began. */
interface TimedSessionReport extends NativeSessionReport {
  elapsedMs: number;
}

function* runConfiguration(
  stream: InMemoryStream,
  xmd: string[],
  doc: string,
): Operation<{
  result: Result<Json>;
  output: string;
  results: readonly TestResult[];
  sessions: TimedSessionReport[];
}> {
  // The scope closes before the assertions run, so the provider and its
  // workers finish teardown and the completion settles.
  return yield* scoped(function* () {
    const sessions: TimedSessionReport[] = [];
    const origin = performance.now();
    yield* NativeSessionObserver.set((report) =>
      sessions.push({ ...report, elapsedMs: performance.now() - origin }),
    );
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

function configurationSucceeded(run: {
  result: Result<Json>;
  output: string;
  results: readonly TestResult[];
  sessions: readonly TimedSessionReport[];
}): void {
  if (!run.result.ok || run.results.some((entry) => entry.status !== "pass")) {
    throw new Error(
      JSON.stringify(
        {
          error: run.result.ok
            ? undefined
            : { message: run.result.error.message, stack: run.result.error.stack },
          output: run.output,
          results: run.results,
          sessions: run.sessions,
        },
        (_key, value) =>
          value instanceof Error ? { message: value.message, stack: value.stack } : value,
        2,
      ),
    );
  }
}

describe(SUITE, { sanitizeOps: false, sanitizeResources: false }, () => {
  const refusals =
    "refuses unknown, unsupported and unavailable Session selections before consuming the first stage";
  it(refusals, function* () {
    const doc = path.resolve("packages/test-agent/src/SessionConfiguration.refusals.md");
    yield* captureConfiguration(refusals, doc, function* (stream) {
      const run = yield* runConfiguration(stream, cliBase(), doc);
      configurationSucceeded(run);
      expect(run.results.map((entry) => entry.status)).toEqual(["pass", "pass"]);
      expect(new Set(run.sessions.map((report) => report.nativeSessionId)).size).toBe(2);
    });
  });

  const replay = "retains named native identity, isolates Tests, and replays without a worker";
  it(replay, function* () {
    yield* captureConfiguration(replay, DOC, function* (stream) {
      const live = yield* runConfiguration(stream, cliBase(), DOC);
      configurationSucceeded(live);
      expect(live.results.map((entry) => entry.status)).toEqual(["pass", "pass"]);
      const configuredReports = live.sessions.filter(
        (report) => report.scenarioId === live.sessions[0]?.scenarioId,
      );
      const independentReports = live.sessions.filter(
        (report) => report.scenarioId !== live.sessions[0]?.scenarioId,
      );
      expect(configuredReports.length).toBeGreaterThan(1);
      expect(independentReports.length).toBe(1);
      expect(new Set(configuredReports.map((report) => report.nativeSessionId)).size).toBe(1);
      expect(independentReports[0]?.nativeSessionId).not.toBe(
        configuredReports[0]?.nativeSessionId,
      );
      const events = JSON.stringify(yield* stream.readAll());
      expect(events).toContain('"configuration":{"model":"fixture-review","effort":"deep"}');
      const appended = stream.appendCount;
      const replay = yield* runConfiguration(
        stream,
        ["/nonexistent/xmd-configuration-must-not-spawn"],
        DOC,
      );
      configurationSucceeded(replay);
      expect(replay.results.map((entry) => entry.status)).toEqual(
        live.results.map((entry) => entry.status),
      );
      expect(replay.sessions).toEqual([]);
      expect(replay.output).toBe(live.output);
      expect(stream.appendCount).toBe(appended);
    });
  });

  const witness =
    "saves a journal after an assertion fails and leaves a passing execution unwritten";
  it(witness, function* () {
    const directory = yield* useTempDirectory("xmd-session-configuration-");
    const doc = path.join(directory, "journal-witness.md");
    const marker = "Configuration journal witness";
    yield* writeTextFile(
      doc,
      `<Test name="journal witness">

${marker}

</Test>
`,
    );
    const failureRoot = path.join(directory, "failed");
    const successRoot = path.join(directory, "passed");
    const failure = new Error("post-settlement assertion failed");

    function* runWitness(
      artifacts: string,
      assert: () => void,
    ): Operation<{ outcome: Result<void>; stderr: string }> {
      return yield* scoped(function* () {
        let stderr = "";
        const sink = new Writable({
          write(chunk, _encoding, callback) {
            stderr += String(chunk);
            callback();
          },
        });
        yield* API.Env.around({
          *env([name], next) {
            return name === "XMD_TEST_ARTIFACTS" ? artifacts : yield* next(name);
          },
        });

        try {
          yield* captureConfiguration(
            witness,
            doc,
            function* (stream) {
              const run = yield* runConfiguration(stream, [], doc);
              configurationSucceeded(run);
              expect(run.results.map((entry) => entry.status)).toEqual(["pass"]);
              expect(stream.appendCount).toBeGreaterThan(0);
              assert();
            },
            sink,
          );
        } catch (error) {
          if (!(error instanceof Error)) {
            throw error;
          }
          return { outcome: Err(error), stderr };
        }
        return { outcome: Ok(), stderr };
      });
    }

    const failed = yield* runWitness(failureRoot, () => {
      throw failure;
    });
    expect(failed.outcome.ok ? undefined : failed.outcome.error).toBe(failure);
    const invocations = yield* readdir(failureRoot);
    expect(invocations.length).toBe(1);
    const invocation = path.join(failureRoot, invocations[0]);
    expect((yield* readdir(invocation)).sort()).toEqual(["root-1.case.json", "root-1.jsonl"]);
    expect(JSON.parse(yield* readTextFile(path.join(invocation, "root-1.case.json")))).toEqual({
      owner: OWNER,
      suite: SUITE,
      name: witness,
      kind: "root",
      ordinal: 1,
      source: doc,
    });
    const journal = path.join(invocation, "root-1.jsonl");
    expect(failed.stderr).toBe(`[xmd test] journal saved: ${journal} (root 1 ${doc})
`);
    const jsonl = yield* readTextFile(journal);
    const events = jsonl
      .trimEnd()
      .split("\n")
      .map((line) => {
        const event = parseDurableEvent(line);
        if (!event.ok) {
          throw event.error;
        }
        return event.value;
      });
    expect(JSON.stringify(events)).toContain(marker);

    expect(yield* runWitness(successRoot, () => undefined)).toEqual({
      outcome: Ok(),
      stderr: "",
    });
    expect(yield* exists(successRoot)).toBe(false);
  });
});
