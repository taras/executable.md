/**
 * Tier SE — Streaming emission tests + Tier BC — Block ID counter (spec §9, §6.1).
 *
 * Tests per-segment emission through the document stream returned by
 * execute, and blockId stability across per-segment expansion calls.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { withFailureJournal } from "@executablemd/testing";
import { API } from "@executablemd/runtime";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { exists, readdir } from "@effectionx/fs";
import { scoped } from "effection";
import type { Operation } from "effection";
import { join } from "node:path";
import process from "node:process";
import { Writable } from "node:stream";
import { useTestDiagnostics } from "../../cli/src/test-diagnostics.ts";
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

function runStreamingCase(
  path: string,
  check: (chunks: string[], fullOutput: string) => void,
  sink: DeliverySink = process.stderr,
): Operation<void> {
  return scoped(function* () {
    const diagnostics = yield* useTestDiagnostics(sink);
    yield* withFailureJournal(
      diagnostics.execution("root", path).journal(() => false),
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
    );
  });
}

describe("Tier SE — Streaming emission", () => {
  it("SE1: segments emitted in document order via stream", () =>
    runStreamingCase(MULTI, (chunks, fullOutput) => {
      expect(chunks.length).toBeGreaterThan(0);
      expect(fullOutput).toBe(chunks.join(""));
    }));

  it("SE10: no empty strings in output chunks", () =>
    runStreamingCase(SIMPLE, (chunks) => {
      for (const chunk of chunks) {
        expect(chunk.length).toBeGreaterThan(0);
      }
    }));

  it("SE9: output() inside durable workflow reaches stream consumer", () =>
    runStreamingCase(SIMPLE, (chunks) => {
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.join("")).toContain("Hello");
    }));

  it("saves the settled streaming journal only after a failing assertion", function* () {
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
    expect(yield* readdir(directoryWithJournal)).toEqual(["root-1.jsonl"]);
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
});
