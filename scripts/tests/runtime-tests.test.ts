/**
 * What a shard runs, in what order, and what it does when one file fails.
 *
 * These drive the shard through an injected runner rather than a real one, so
 * they can assert command routing and exact ordering without launching the
 * corpus. Independent literal vectors and signal handling live in the
 * "the one-file runner commands" and "launcher exit status" groups in
 * `runtime-exclusions.test.ts`. That a real child's output survives, and
 * that halting a shard halts its child, are behaviors an injected runner cannot
 * establish — `shard-execution.test.ts` verifies those against real processes.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, sleep, suspend, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm } from "@effectionx/fs";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { readlink, symlink } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  describeShard,
  localDenoTests,
  oneFileCommand,
  parseShardSelection,
  PREPARED_LINK,
  RUNNERS,
  runOneFile,
  runShardFiles,
  runSuite,
  TestRuns,
  withDeadline,
} from "../lib/runtime-tests.ts";
import type { RunLaunch } from "../lib/runtime-tests.ts";
import { applicableTestFiles } from "../lib/test-files.ts";
import { partitionTests } from "../lib/test-shards.ts";
import { RUNTIMES } from "../runtime-test-exclusions.ts";

const ROOT = new URL("../../", import.meta.url);

const ONE = "packages/alpha/tests/one.test.ts";
const TWO = "packages/alpha/tests/two.test.ts";
const THREE = "packages/beta/tests/three.test.ts";
const SUITE = "examples/adversarial-implementation/tests/Implementation.test.md";

function line(launch: { command: string; arguments: string[] }): string {
  return `${launch.command} ${launch.arguments.join(" ")}`;
}

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
      const file =
        launch.arguments.find((arg) => arg.endsWith(".test.ts") || arg.endsWith(".test.md")) ?? "";
      state.launches.push(line(launch));
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

  it("routes each runtime through its one-file command", function* () {
    for (const runtime of RUNTIMES) {
      const runs = recorder();
      yield* TestRuns.with(runs.run, () => runShardFiles(runtime, [ONE], ROOT));

      const launch = oneFileCommand(runtime, ONE);
      expect(runs.launches).toEqual([`${launch.command} ${launch.arguments.join(" ")}`]);
    }
  });

  it("routes a Markdown suite through its one-file command, from the repository", function* () {
    for (const runtime of RUNTIMES) {
      const seen: Array<{ line: string; cwd: string; env?: Record<string, string> }> = [];
      yield* TestRuns.with(
        function* (launch) {
          seen.push({ line: line(launch), cwd: launch.cwd, env: launch.env });
          return 0;
        },
        () => runShardFiles(runtime, [ONE, SUITE], ROOT),
      );

      expect(seen.map((entry) => entry.line)).toEqual([
        line(oneFileCommand(runtime, ONE)),
        line(oneFileCommand(runtime, SUITE, ROOT)),
      ]);
      expect(seen.map((entry) => entry.cwd)).toEqual([fileURLToPath(ROOT), fileURLToPath(ROOT)]);
      expect(seen[1].env).toEqual(oneFileCommand(runtime, SUITE, ROOT).env);
    }
  });

  it("keeps running after a failed Markdown suite and keeps its status first", function* () {
    const runs = recorder(SUITE);
    const outcome = yield* TestRuns.with(runs.run, () =>
      runShardFiles("bun", [SUITE, ONE, TWO], ROOT),
    );

    expect(runs.files).toEqual([SUITE, ONE, TWO]);
    expect(outcome.failure).toEqual({ file: SUITE, status: 7 });
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
      return runs.files.length + 2;
    };
    const outcome = yield* TestRuns.with(failing, () =>
      runShardFiles("deno", [ONE, TWO, THREE], ROOT),
    );

    expect(runs.files).toEqual([ONE, TWO, THREE]);
    expect(outcome.ran).toEqual([ONE, TWO, THREE]);
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

describe("the whole suite", () => {
  it("runs the TypeScript corpus in one native invocation, then each Markdown suite alone", function* () {
    for (const runtime of RUNTIMES) {
      const runs = recorder();
      const status = yield* TestRuns.with(runs.run, () => runSuite(runtime, ROOT));
      const applicable = yield* applicableTestFiles(runtime, ROOT);
      const runner = RUNNERS[runtime];

      expect(status).toEqual(0);
      expect(runs.launches).toEqual([
        line({
          command: runner.command,
          arguments: [...runner.prefix, ...applicable.filter((file) => file.endsWith(".ts"))],
        }),
        ...applicable
          .filter((file) => file.endsWith(".md"))
          .map((file) => line(oneFileCommand(runtime, file, ROOT))),
      ]);
      expect(runs.peak).toEqual(1);
    }
  });

  it("keeps the first failure across the two portions", function* () {
    const statuses = (native: number, suite: number): RunLaunch =>
      function* (launch) {
        yield* sleep(1);
        return launch.arguments.includes(SUITE) ? suite : native;
      };

    expect(yield* TestRuns.with(statuses(5, 3), () => runSuite("node", ROOT))).toEqual(5);
    expect(yield* TestRuns.with(statuses(0, 3), () => runSuite("node", ROOT))).toEqual(3);
    expect(yield* TestRuns.with(statuses(0, 0), () => runSuite("node", ROOT))).toEqual(0);
  });
});

describe("the local Deno suite", () => {
  const NATIVE = RUNNERS.deno.prefix;

  function* local(
    args: string[],
    failing?: string,
  ): Operation<{ status: number; launches: string[] }> {
    const runs = recorder(failing);
    const status = yield* TestRuns.with(runs.run, () => localDenoTests(args, ROOT));
    return { status, launches: runs.launches };
  }

  it("runs Deno's whole native suite and then every Markdown suite once when given nothing", function* () {
    const suites = (yield* applicableTestFiles("deno", ROOT)).filter((file) =>
      file.endsWith(".md"),
    );
    expect(suites).toContain(SUITE);

    expect((yield* local([])).launches).toEqual([
      line({ command: "deno", arguments: [...NATIVE] }),
      ...suites.map((file) => line(oneFileCommand("deno", file, ROOT))),
    ]);
  });

  it("forwards focused paths and flags to deno test verbatim", function* () {
    for (const args of [
      [ONE],
      ["--changed"],
      ["--changed=origin/main"],
      ["--related=packages/core/src/expand.ts"],
      ["--filter", "a name", ONE],
      ["--filter=README.md", ONE],
      ["--filter", "README.md", ONE],
      [ONE, "--filter", SUITE],
      ["--related", "README.md", ONE],
      ["--lock", "README.md", ONE],
      ["-Ac", "README.md", ONE],
      [ONE, "--", SUITE],
    ]) {
      expect((yield* local(args)).launches).toEqual([
        line({ command: "deno", arguments: [...NATIVE, ...args] }),
      ]);
    }
  });

  it("runs a named Markdown suite through its one-file command beside named TypeScript paths", function* () {
    expect((yield* local([SUITE])).launches).toEqual([line(oneFileCommand("deno", SUITE, ROOT))]);
    expect((yield* local([`./${SUITE}`])).launches).toEqual([
      line(oneFileCommand("deno", SUITE, ROOT)),
    ]);
    const mixed = yield* local([ONE, SUITE, TWO], ONE);
    expect(mixed.launches).toEqual([
      line({ command: "deno", arguments: [...NATIVE, ONE, TWO] }),
      line(oneFileCommand("deno", SUITE, ROOT)),
    ]);
    expect(mixed.status).toEqual(7);
    expect((yield* local([ONE, SUITE], SUITE)).status).toEqual(7);
  });

  it("refuses a Markdown path beside a flag, or one that is not a suite, before running anything", function* () {
    for (const args of [
      ["--filter", "x", SUITE],
      ["--filter", "README.md", SUITE],
      ["--filter", "--", SUITE],
      [SUITE, "--", "README.md"],
      [SUITE, "--changed"],
      ["examples/adversarial-implementation/tests/implementation-launch.md"],
      ["examples/adversarial-implementation/tests/nested/Implementation.test.md"],
    ]) {
      const { status, launches } = yield* local(args);
      expect({ args, status, launches }).toEqual({ args, status: 1, launches: [] });
    }
  });
});

describe("the prepared dependency link around a Markdown suite", () => {
  function* prepared(): Operation<URL> {
    const base = yield* useTempDirectory("prepared-link-");
    const root = pathToFileURL(`${base}/`);
    yield* ensureDir(new URL("node_modules/.pnpm/one/", root));
    yield* ensureDir(new URL("node_modules/.pnpm/two/", root));
    yield* until(symlink(".pnpm/one", fileURLToPath(new URL(PREPARED_LINK, root))));
    return root;
  }

  function* relink(root: URL, target: string | undefined): Operation<void> {
    const link = new URL(PREPARED_LINK, root);
    yield* rm(link, { force: true });
    if (target !== undefined) {
      yield* until(symlink(target, fileURLToPath(link)));
    }
  }

  /** A child that changes the link to `target` and then exits with `status`. */
  function changing(
    root: URL,
    target: string | undefined,
    status: number,
    launches: string[],
  ): RunLaunch {
    return function* (launch) {
      launches.push(line(launch));
      yield* relink(root, target);
      return status;
    };
  }

  it("fails a passing suite that changed or removed the link, after one launch", function* () {
    for (const target of [".pnpm/two", undefined]) {
      const root = yield* prepared();
      const launches: string[] = [];
      const status = yield* TestRuns.with(changing(root, target, 0, launches), () =>
        runOneFile("deno", SUITE, root),
      );

      expect({ target, status }).toEqual({ target, status: 1 });
      expect(launches).toEqual([line(oneFileCommand("deno", SUITE, root))]);
    }
  });

  it("keeps a failed suite's own status when it also changed the link", function* () {
    const root = yield* prepared();
    const status = yield* TestRuns.with(changing(root, ".pnpm/two", 6, []), () =>
      runOneFile("node", SUITE, root),
    );

    expect(status).toEqual(6);
  });

  it("passes a suite that left the link as it found it", function* () {
    const root = yield* prepared();
    const status = yield* TestRuns.with(changing(root, ".pnpm/one", 0, []), () =>
      runOneFile("bun", SUITE, root),
    );

    expect(status).toEqual(0);
    expect(yield* until(readlink(fileURLToPath(new URL(PREPARED_LINK, root))))).toEqual(
      ".pnpm/one",
    );
  });

  it("is a Markdown suite's obligation and not a TypeScript file's", function* () {
    const root = yield* prepared();
    const status = yield* TestRuns.with(changing(root, ".pnpm/two", 0, []), () =>
      runOneFile("deno", ONE, root),
    );

    expect(status).toEqual(0);
  });
});

describe("a Markdown suite's whole-launch deadline", () => {
  it("stops only that launch, joins its cleanup, and reports failure", function* () {
    let cleaned = false;
    const status = yield* withDeadline(SUITE, 20, function* () {
      yield* ensure(function* () {
        yield* sleep(5);
        cleaned = true;
      });
      yield* suspend();
      return 0;
    });

    expect({ status, cleaned }).toEqual({ status: 1, cleaned: true });
  });

  it("returns the launch's own status when it settles in time", function* () {
    const status = yield* withDeadline(SUITE, 1_000, function* () {
      yield* sleep(1);
      return 4;
    });

    expect(status).toEqual(4);
  });
});
