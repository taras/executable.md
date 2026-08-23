/**
 * What a shard runs, in what order, and what it does when one file fails.
 *
 * These drive the shard through an injected runner rather than a real one, so
 * they can assert the exact argument vector and the exact ordering without
 * paying for hundreds of processes. That a real child's output survives, and
 * that halting a shard halts its child, are claims an injected runner cannot
 * make — `shard-execution.test.ts` makes those against real processes.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { sleep } from "effection";
import type { Operation } from "effection";

import {
  describeShard,
  oneFileCommand,
  parseShardSelection,
  runShardFiles,
  TestRuns,
} from "../lib/runtime-tests.ts";
import type { RunLaunch } from "../lib/runtime-tests.ts";
import { partitionTests } from "../lib/test-shards.ts";
import { RUNTIMES } from "../runtime-test-exclusions.ts";

const ROOT = new URL("../../", import.meta.url);

const ONE = "packages/alpha/tests/one.test.ts";
const TWO = "packages/alpha/tests/two.test.ts";
const THREE = "packages/beta/tests/three.test.ts";

interface Recorder {
  launches: string[];
  files: string[];
  /** The most children that were ever inside the runner at the same time. */
  peak: number;
  run: RunLaunch;
}

/** Records every launch and how many overlapped; fails the file named by `failing`. */
function recorder(failing?: string): Recorder {
  let active = 0;
  const state: Recorder = {
    launches: [],
    files: [],
    peak: 0,
    *run(launch) {
      const file = launch.arguments[launch.arguments.length - 1] ?? "";
      state.launches.push(`${launch.command} ${launch.arguments.join(" ")}`);
      state.files.push(file);
      active += 1;
      state.peak = Math.max(state.peak, active);
      // Suspends, so an implementation that started the next file without
      // waiting for this one would be caught by `peak` rather than hidden by a
      // runner that never yields.
      yield* sleep(1);
      active -= 1;
      return file === failing ? 7 : 0;
    },
  };
  return state;
}

function* shard(files: string[], failing?: string): Operation<Recorder> {
  const runs = recorder(failing);
  yield* TestRuns.with(runs.run, () => runShardFiles("deno", files, ROOT));
  return runs;
}

describe("a shard selection", () => {
  it("reads an index out of a count", function* () {
    expect(parseShardSelection("1/6")).toEqual({ index: 1, count: 6 });
    expect(parseShardSelection("3/6")).toEqual({ index: 3, count: 6 });
    expect(parseShardSelection("10/10")).toEqual({ index: 10, count: 10 });
  });

  it("refuses anything that is not exactly that shape", function* () {
    for (const value of [
      "",
      "3",
      "3/",
      "/6",
      "0/6",
      "3/0",
      "03/6",
      "3/06",
      "3/6/9",
      "a/b",
      "-1/6",
      "1.5/6",
      " 1/6",
      "1 / 6",
      "1\\6",
      "١/٦",
    ]) {
      expect({ value, parsed: parseShardSelection(value) }).toEqual({ value, parsed: undefined });
    }
  });
});

describe("running a shard", () => {
  it("invokes each assigned file alone, in order, one at a time", function* () {
    const runs = yield* shard([ONE, TWO, THREE]);

    expect(runs.files).toEqual([ONE, TWO, THREE]);
    expect(runs.peak).toEqual(1);
    expect(runs.launches).toEqual(
      [ONE, TWO, THREE].map((file) => {
        const launch = oneFileCommand("deno", file);
        return `${launch.command} ${launch.arguments.join(" ")}`;
      }),
    );
  });

  it("uses each runtime's own one-file command", function* () {
    for (const runtime of RUNTIMES) {
      const runs = recorder();
      yield* TestRuns.with(runs.run, () => runShardFiles(runtime, [ONE], ROOT));

      const launch = oneFileCommand(runtime, ONE);
      expect(runs.launches).toEqual([`${launch.command} ${launch.arguments.join(" ")}`]);
    }
  });

  it("runs the files after a failure and keeps the first one", function* () {
    const runs = recorder(TWO);
    const outcome = yield* TestRuns.with(runs.run, () =>
      runShardFiles("deno", [ONE, TWO, THREE], ROOT),
    );

    expect(runs.files).toEqual([ONE, TWO, THREE]);
    expect(outcome.ran).toEqual([ONE, TWO, THREE]);
    expect(outcome.failure).toEqual({ file: TWO, status: 7 });
  });

  it("keeps the first failure when more than one file fails", function* () {
    const runs = recorder();
    const failing: RunLaunch = function* (launch) {
      yield* runs.run(launch);
      return 3;
    };
    const outcome = yield* TestRuns.with(failing, () =>
      runShardFiles("deno", [ONE, TWO, THREE], ROOT),
    );

    expect(runs.files).toEqual([ONE, TWO, THREE]);
    expect(outcome.failure).toEqual({ file: ONE, status: 3 });
  });

  it("reports success only when every file succeeded", function* () {
    const outcome = yield* TestRuns.with(recorder().run, () =>
      runShardFiles("deno", [ONE, TWO], ROOT),
    );

    expect(outcome.failure).toBeUndefined();
    expect(outcome.ran).toEqual([ONE, TWO]);
  });

  it("runs nothing for an empty assignment", function* () {
    const runs = yield* shard([]);

    expect(runs.files).toEqual([]);
    expect(runs.peak).toEqual(0);
  });
});

describe("what a shard announces before it starts", () => {
  const CORPUS = [ONE, TWO, THREE];
  /** THREE is deliberately unrecorded, so exactly one shard carries a fallback. */
  const RECORDED: Record<string, number> = { [ONE]: 500, [TWO]: 300 };

  it("names the runtime, the selection, the prediction and every file", function* () {
    const [first] = partitionTests(CORPUS, RECORDED, 2);
    const announced = describeShard("node", first);

    expect(announced).toContain("node shard 1/2");
    expect(announced).toContain(`${first.weight}ms predicted`);
    expect(announced).toContain(`${first.files.length} files`);
    for (const file of first.files) {
      expect(announced).toContain(file);
    }
  });

  it("names every file charged the fallback weight, and only those", function* () {
    const shards = partitionTests(CORPUS, RECORDED, 2);
    const charged = "unmeasured, charged the heaviest recorded weight";

    expect(shards.flatMap((shard) => shard.unmeasured)).toEqual([THREE]);

    for (const shard of shards) {
      const announced = describeShard("bun", shard);
      for (const file of shard.files) {
        expect({ file, named: announced.includes(`${charged}: ${file}`) }).toEqual({
          file,
          named: shard.unmeasured.includes(file),
        });
      }
    }
  });
});
