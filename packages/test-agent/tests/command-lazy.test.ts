/**
 * Tier XL — `command` is asked for at the `<TestAgent>` boundary, not before.
 *
 * A document that never mentions `<TestAgent>` needs no worker, so it must run
 * even where no entrypoint installed a command adapter. These suites install a
 * deliberately throwing adapter and assert what does and does not reach it.
 */
import { describe, it, beforeAll } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { API } from "@executablemd/runtime";
import { execute, installAgentComponents, useTempFileCompiler } from "@executablemd/core";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useTesting } from "@executablemd/testing";
import type { TestResult } from "@executablemd/testing";
import { installTestAgentComponents } from "../src/components.ts";

const CLI = path.resolve("packages/cli/src/deno.ts");

interface Asked {
  calls: string[][];
}

function* recordCommand(asked: Asked): Operation<void> {
  yield* API.Env.around({
    *command([args = []]) {
      asked.calls.push(args);
      return ["deno", "run", "--allow-all", CLI, ...args];
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

function* runDoc(
  doc: string,
  install: () => Operation<void>,
): Operation<{ output: string; results: readonly TestResult[] }> {
  const dir = path.join(os.tmpdir(), `xmd-xl-${randomUUID()}`);
  yield* ensureDir(dir);
  return yield* scoped(function* () {
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    yield* writeTextFile(path.join(dir, "doc.md"), doc);

    return yield* scoped(function* () {
      const testing = yield* useTesting();
      yield* install();
      yield* installTestAgentComponents();
      yield* installAgentComponents();
      const execution = yield* execute({
        path: path.join(dir, "doc.md"),
        stream: new InMemoryStream(),
      });
      const subscription = yield* execution.output;
      let next = yield* subscription.next();
      while (!next.done) {
        next = yield* subscription.next();
      }
      return { output: next.value, results: yield* testing.results };
    });
  });
}

describe(
  "Tier XL — lazy command resolution",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    beforeAll(() => useTempFileCompiler());

    it("XL1: installing the test-agent components does not ask for the command", function* () {
      yield* refuseCommand();
      yield* installTestAgentComponents();
    });

    it("XL2: `xmd test` on a document without <TestAgent> runs where command throws", function* () {
      const { output } = yield* runDoc("# plain\n\nno agents here\n", refuseCommand);
      expect(output).toContain("no agents here");
      expect(output).not.toContain("ERROR");
    });

    it("XL3: a document using <TestAgent> asks for command(['test-agent'])", function* () {
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
      const { results } = yield* runDocWithScenario(doc, asked);
      expect(results.map((entry) => entry.status)).toEqual(["pass"]);
      // One provider per isolation boundary — the <TestAgent> scope and each
      // <Test> lease — so the count tracks boundaries, not documents. What
      // matters is that every request is for the worker subcommand and nothing
      // else, and that each one appends it exactly once.
      expect(asked.calls.length).toBeGreaterThan(0);
      for (const args of asked.calls) {
        expect(args).toEqual(["test-agent"]);
      }
    });
  },
);

function* runDocWithScenario(
  doc: string,
  asked: Asked,
): Operation<{ results: readonly TestResult[] }> {
  const dir = path.join(os.tmpdir(), `xmd-xl-${randomUUID()}`);
  yield* ensureDir(dir);
  return yield* scoped(function* () {
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    yield* writeTextFile(path.join(dir, "doc.md"), doc);
    yield* writeTextFile(
      path.join(dir, "agent.md"),
      '<WhenPrompt template="hi" />\n\nhello there\n',
    );

    return yield* scoped(function* () {
      const testing = yield* useTesting();
      yield* recordCommand(asked);
      yield* installTestAgentComponents();
      yield* installAgentComponents();
      const execution = yield* execute({
        path: path.join(dir, "doc.md"),
        stream: new InMemoryStream(),
      });
      const subscription = yield* execution.output;
      let next = yield* subscription.next();
      while (!next.done) {
        next = yield* subscription.next();
      }
      yield* execution;
      return { results: yield* testing.results };
    });
  });
}
