/**
 * Tier XL — `command` is asked for at the `<TestAgent>` boundary, not before.
 *
 * A document that never mentions `<TestAgent>` needs no worker, so it must run
 * even where no entrypoint installed a command adapter. These suites install a
 * deliberately throwing adapter and assert what does and does not reach it.
 */
import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { API } from "@executablemd/runtime";
import { execute, useTempFileCompiler } from "@executablemd/core";
import { installAgentComponents } from "@executablemd/agent/host";
import { captureTestJournal } from "@executablemd/test-support/failure-journal";
import { useTesting } from "@executablemd/testing";
import type { TestResult } from "@executablemd/testing";
import { installTestAgentComponents } from "../src/components.ts";
import { cliBase } from "@executablemd/test-support/launch";

interface Asked {
  calls: string[][];
}

function* recordCommand(asked: Asked): Operation<void> {
  yield* API.Env.around({
    *command([args = []]) {
      asked.calls.push(args);
      return [...cliBase(), ...args];
    },
  });
}

function* refuseCommand(): Operation<void> {
  yield* API.Env.around({
    // deno-lint-ignore require-yield
    *command() {
      throw new Error("command must not be requested");
    },
  });
}

const OWNER = "packages/test-agent/tests/command-lazy.test.ts";
const SUITE = "Tier XL — lazy command resolution";

function* checkDocument(
  name: string,
  doc: string,
  install: () => Operation<void>,
  check: (run: { output: string; results: readonly TestResult[] }) => void,
  scenario = false,
): Operation<void> {
  const dir = path.join(os.tmpdir(), `xmd-xl-${randomUUID()}`);
  const docPath = path.join(dir, "doc.md");
  yield* captureTestJournal({ owner: OWNER, suite: SUITE, name }, docPath, function* (stream) {
    const result = yield* scoped(function* () {
      yield* ensureDir(dir);
      yield* ensure(() => rm(dir, { recursive: true, force: true }));
      yield* writeTextFile(docPath, doc);
      if (scenario) {
        yield* writeTextFile(
          path.join(dir, "agent.md"),
          '<WhenPrompt template="hi" />\n\nhello there\n',
        );
      }
      return yield* scoped(function* () {
        const testing = yield* useTesting();
        yield* install();
        yield* installTestAgentComponents();
        yield* installAgentComponents();
        const execution = yield* execute({ path: docPath, stream });
        const subscription = yield* execution.output;
        let next = yield* subscription.next();
        while (!next.done) {
          next = yield* subscription.next();
        }
        if (scenario) {
          yield* execution;
        }
        return { output: next.value, results: yield* testing.results };
      });
    });
    check(result);
  });
}

describe(SUITE, { sanitizeOps: false, sanitizeResources: false }, () => {
  beforeAll(() => useTempFileCompiler());

  it("XL1: installing the test-agent components does not ask for the command", function* () {
    yield* refuseCommand();
    yield* installTestAgentComponents();
  });

  const withoutAgent =
    "XL2: `xmd test` on a document without <TestAgent> runs where command throws";
  it(withoutAgent, () =>
    checkDocument(withoutAgent, "# plain\n\nno agents here\n", refuseCommand, ({ output }) => {
      expect(output).toContain("no agents here");
      expect(output).not.toContain("ERROR");
    }),
  );

  const withAgent = "XL3: a document using <TestAgent> asks for command(['test-agent'])";
  it(withAgent, function* () {
    const asked: Asked = { calls: [] };
    const doc = [
      "<TestAgent>",
      '  <TestAgent.Scenario src="./agent.md" />',
      '  <Test name="asks once">',
      '    <Prompt text="hi" />',
      "  </Test>",
      "</TestAgent>",
      "",
    ].join("\n");
    yield* checkDocument(
      withAgent,
      doc,
      () => recordCommand(asked),
      ({ results }) => {
        expect(results.map(({ status, error }) => ({ status, error }))).toEqual([
          { status: "pass", error: undefined },
        ]);
        // Each isolation boundary requests the worker subcommand once.
        expect(asked.calls.length).toBeGreaterThan(0);
        for (const args of asked.calls) {
          expect(args).toEqual(["test-agent"]);
        }
      },
      true,
    );
  });
});
