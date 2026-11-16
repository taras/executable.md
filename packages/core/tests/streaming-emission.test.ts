/**
 * Tier SE — Streaming emission tests + Tier BC — Block ID counter (spec §9, §6.1).
 *
 * Tests per-segment emission through the document stream returned by
 * execute, and blockId stability across per-segment expansion calls.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { API } from "@executablemd/runtime";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { exists, readdir, readTextFile } from "@effectionx/fs";
import { ensure, scoped, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import { join } from "node:path";
import process from "node:process";
import { Writable } from "node:stream";
import { captureTestJournal } from "../../test-support/failure-journal.ts";
import type { DeliverySink } from "../../cli/src/stdout-delivery.ts";
import { readRecords } from "../../cli/src/repl/journal-records.ts";
import { forEach } from "@effectionx/stream-helpers";
import { createBlockCounter } from "../src/expand.ts";
import { execute } from "../src/execute.ts";

describe("Tier BC — Block ID counter", () => {
  // BC1: Counter increments across calls
  it("BC1: counter increments across calls", function* () {
    const counter = createBlockCounter();
    expect(counter.next()).toBe(0);
    expect(counter.next()).toBe(1);
    expect(counter.next()).toBe(2);
  });

  // BC2: Separate counters are independent
  it("BC2: separate counters are independent", function* () {
    const c1 = createBlockCounter();
    const c2 = createBlockCounter();
    expect(c1.next()).toBe(0);
    expect(c2.next()).toBe(0);
    expect(c1.next()).toBe(1);
    expect(c2.next()).toBe(1);
  });
});

const SIMPLE = "packages/core/tests/fixtures/streaming/simple.md";
const MULTI = "packages/core/tests/fixtures/streaming/multi-segment.md";

const OWNER = "packages/core/tests/streaming-emission.test.ts";
const SUITE = "Tier SE — Streaming emission";

function runStreamingCase(
  name: string,
  path: string,
  check: (chunks: string[], fullOutput: string) => void,
  sink: DeliverySink = process.stderr,
): Operation<void> {
  return captureTestJournal(
    { owner: OWNER, suite: SUITE, name },
    path,
    function* (stream) {
      const chunks: string[] = [];
      const fullOutput = yield* scoped(function* () {
        const execution = yield* execute({ path, stream });
        const output = yield* forEach(function* (chunk: string) {
          chunks.push(chunk);
        }, execution.output);
        yield* execution;
        return output;
      });
      check(chunks, fullOutput);
    },
    { sink },
  );
}

describe(SUITE, () => {
  const segments = "SE1: segments emitted in document order via stream";
  it(segments, () =>
    runStreamingCase(segments, MULTI, (chunks, fullOutput) => {
      expect(chunks.length).toBeGreaterThan(0);
      expect(fullOutput).toBe(chunks.join(""));
    }),
  );

  const nonempty = "SE10: no empty strings in output chunks";
  it(nonempty, () =>
    runStreamingCase(nonempty, SIMPLE, (chunks) => {
      for (const chunk of chunks) {
        expect(chunk.length).toBeGreaterThan(0);
      }
    }),
  );

  const output = "SE9: output() inside durable workflow reaches stream consumer";
  it(output, () =>
    runStreamingCase(output, SIMPLE, (chunks) => {
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.join("")).toContain("Hello");
    }),
  );

  const witness =
    "saves a journal after an assertion fails and leaves a passing execution unwritten";
  it(witness, function* () {
    const directory = yield* useTempDirectory("xmd-streaming-journal-");
    const failed = join(directory, "failed");
    const passed = join(directory, "passed");
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });

    function runWitness(artifacts: string, expected: string): Operation<void> {
      return scoped(function* () {
        yield* API.Env.around({
          *env([name], next) {
            return name === "XMD_TEST_ARTIFACTS" ? artifacts : yield* next(name);
          },
        });
        yield* runStreamingCase(
          witness,
          SIMPLE,
          function (chunks) {
            expect(chunks.join("")).toContain("Hello");
            try {
              expect(chunks.join("")).toContain(expected);
            } catch (error) {
              assertionFailure = error;
              throw error;
            }
          },
          sink,
        );
      });
    }

    let assertionFailure: unknown;
    let caught: unknown;
    try {
      yield* runWitness(failed, "absent streaming witness text");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBe(assertionFailure);
    const invocations = yield* readdir(failed);
    expect(invocations).toHaveLength(1);
    const directoryWithJournal = join(failed, invocations[0]);
    expect((yield* readdir(directoryWithJournal)).sort()).toEqual([
      "root-1.case.json",
      "root-1.jsonl",
    ]);
    expect(JSON.parse(yield* readTextFile(join(directoryWithJournal, "root-1.case.json")))).toEqual(
      {
        owner: OWNER,
        suite: SUITE,
        name: witness,
        kind: "root",
        ordinal: 1,
        source: SIMPLE,
      },
    );
    const journal = join(directoryWithJournal, "root-1.jsonl");
    expect(lines).toEqual([
      `[xmd test] journal saved: ${journal} (root 1 ${SIMPLE})
`,
    ]);
    const events = yield* readRecords(journal);
    expect(events.at(-1)).toMatchObject({ type: "close", coroutineId: "root" });

    yield* runWitness(passed, "Hello");
    expect(yield* exists(passed)).toBe(false);
    expect(lines).toHaveLength(1);
  });
  const cancelled = "saves the streaming journal after cancellation joins teardown";
  it(cancelled, function* () {
    const artifacts = join(
      yield* useTempDirectory("xmd-streaming-cancellation-"),
      ".xmd",
      "test-artifacts",
    );
    yield* API.Env.around({
      *env([name], next) {
        return name === "XMD_TEST_ARTIFACTS" ? artifacts : yield* next(name);
      },
    });
    const { resolve, operation } = withResolvers<void>();
    const order: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        order.push(String(chunk));
        done();
      },
    });
    const task = yield* spawn(() =>
      captureTestJournal(
        { owner: OWNER, suite: SUITE, name: cancelled },
        SIMPLE,
        function* (stream) {
          const execution = yield* execute({ path: SIMPLE, stream });
          yield* forEach(function* (chunk: string) {
            expect(chunk.length).toBeGreaterThan(0);
          }, execution.output);
          yield* execution;
          yield* ensure(() => {
            order.push("teardown");
          });
          resolve();
          yield* suspend();
        },
        { sink },
      ),
    );
    yield* operation;
    yield* task.halt();
    expect(order[0]).toBe("teardown");
    const invocations = yield* readdir(artifacts);
    expect(invocations).toHaveLength(1);
    const directory = join(artifacts, invocations[0]);
    expect(JSON.parse(yield* readTextFile(join(directory, "root-1.case.json")))).toEqual({
      owner: OWNER,
      suite: SUITE,
      name: cancelled,
      kind: "root",
      ordinal: 1,
      source: SIMPLE,
    });
    const file = join(directory, "root-1.jsonl");
    expect(order[1]).toContain(file);
    expect((yield* readRecords(file)).at(-1)).toMatchObject({ type: "close", coroutineId: "root" });
  });
});
