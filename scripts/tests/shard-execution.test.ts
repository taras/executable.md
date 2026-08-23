/**
 * What a shard does with real child processes: the claims an injected runner
 * cannot make.
 *
 * The corpus here is a temporary Deno workspace of its own — three tiny test
 * files, one of them deliberately failing — so a real `deno test` runs, exits
 * with a real status, and writes real output. `runtime-tests.test.ts` covers
 * ordering and argument vectors without paying for that.
 *
 * The fixture files are written as plain Deno source with no imports: they run
 * in a directory that has no `node_modules`, so Effection is not available to
 * them. That is the same fixture boundary `scripts/tests/fixtures` sits on.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { sleep, spawn } from "effection";
import type { Operation } from "effection";
import { ensureDir, exists, readdir, writeTextFile } from "@effectionx/fs";
import { exec, Stdio } from "@effectionx/process";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { chmod } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { until } from "effection";

import { runShardFiles } from "../lib/runtime-tests.ts";

const REPOSITORY = new URL("../../", import.meta.url);
const decoder = new TextDecoder();

interface Seen {
  stdout: string;
  stderr: string;
}

/**
 * Everything the children write, captured at the host's own writer.
 *
 * Suppressing rather than forwarding keeps the suite's log readable; what the
 * assertions need is that the complete text reached this point, which is the
 * last place before the terminal.
 */
function* watching(): Operation<Seen> {
  const seen: Seen = { stdout: "", stderr: "" };
  yield* Stdio.around(
    {
      *stdout([bytes]) {
        seen.stdout += decoder.decode(bytes);
      },
      *stderr([bytes]) {
        seen.stderr += decoder.decode(bytes);
      },
    },
    { at: "min" },
  );
  return seen;
}

function* workspace(files: Record<string, string>): Operation<URL> {
  const base = yield* useTempDirectory("shard-execution-");
  const root = pathToFileURL(`${base}/`);

  yield* writeTextFile(new URL("deno.json", root), "{}\n");
  yield* ensureDir(new URL("tests/", root));
  for (const [name, source] of Object.entries(files)) {
    yield* writeTextFile(new URL(`tests/${name}`, root), source);
  }
  return root;
}

function passing(marker: string): string {
  return `Deno.test("${marker}", () => {\n  console.log("${marker}_RAN");\n});\n`;
}

/** Multiline on both channels, so truncation or a summary would be visible. */
const FAILING = `console.log("B_STDOUT_ONE");
console.log("B_STDOUT_TWO");
console.error("B_STDERR_ONE");
console.error("B_STDERR_TWO");
Deno.test("fails", () => {
  throw new Error("B_FAILED_DELIBERATELY");
});
`;

/**
 * Marks that it started, leaves a grandchild that would mark the filesystem in
 * three seconds, then blocks. `Atomics.wait` blocks the thread rather than
 * suspending, so the child is genuinely occupied and the grandchild is
 * genuinely detached from this test's own scope.
 */
const SLOW = `Deno.test({ name: "slow", sanitizeOps: false, sanitizeResources: false }, () => {
  new Deno.Command("sh", { args: ["-c", "sleep 3; : > grandchild.marker"] }).spawn();
  Deno.writeTextFileSync("slow.marker", "");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
});
`;

const MARKS_LATER = `Deno.test("later", () => {
  Deno.writeTextFileSync("later.marker", "");
});
`;

function* waitFor(file: URL): Operation<boolean> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (yield* exists(file)) {
      return true;
    }
    yield* sleep(100);
  }
  return false;
}

describe("a shard running real children", () => {
  it("runs the files after a failing one and keeps its complete output", function* () {
    const root = yield* workspace({
      "a.test.ts": passing("A"),
      "b.test.ts": FAILING,
      "c.test.ts": passing("C"),
    });
    const assigned = ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts"];
    const seen = yield* watching();

    const outcome = yield* runShardFiles("deno", assigned, root);

    expect(outcome.ran).toEqual(assigned);
    expect(outcome.failure?.file).toEqual("tests/b.test.ts");
    expect(outcome.failure?.status).toBeGreaterThan(0);

    const displayed = `${seen.stdout}\n${seen.stderr}`;
    // The file after the failure ran, which is the whole point of continuing.
    expect(displayed).toContain("A_RAN");
    expect(displayed).toContain("C_RAN");
    // And the failure's own text survived, every line of it, on both channels.
    for (const line of [
      "B_STDOUT_ONE",
      "B_STDOUT_TWO",
      "B_STDERR_ONE",
      "B_STDERR_TWO",
      "B_FAILED_DELIBERATELY",
    ]) {
      expect(displayed).toContain(line);
    }
  });

  it("succeeds and stays quiet about failures when every file passes", function* () {
    const root = yield* workspace({ "a.test.ts": passing("A"), "c.test.ts": passing("C") });
    yield* watching();

    const outcome = yield* runShardFiles("deno", ["tests/a.test.ts", "tests/c.test.ts"], root);

    expect(outcome.failure).toBeUndefined();
    expect(outcome.ran).toEqual(["tests/a.test.ts", "tests/c.test.ts"]);
  });

  it("halts the running child's process group and starts no later file", function* () {
    const root = yield* workspace({ "a-slow.test.ts": SLOW, "b-later.test.ts": MARKS_LATER });
    yield* watching();

    const shard = yield* spawn(() =>
      runShardFiles("deno", ["tests/a-slow.test.ts", "tests/b-later.test.ts"], root),
    );

    expect(yield* waitFor(new URL("slow.marker", root))).toBe(true);
    yield* shard.halt();

    // The next assigned file was never started.
    expect(yield* exists(new URL("later.marker", root))).toBe(false);

    // The grandchild would have marked the filesystem three seconds in. It
    // belongs to the child's process group, not to the child, so only a signal
    // sent to the group stops it.
    yield* sleep(4_000);
    expect(yield* exists(new URL("grandchild.marker", root))).toBe(false);
    expect(yield* exists(new URL("later.marker", root))).toBe(false);

    // Nothing of the shard's own is left behind: it stages nothing and writes
    // nothing, so the only entries are the fixture's and the child's.
    const left = (yield* readdir(new URL(".", root))).sort();
    expect(left).toEqual(["deno.json", "slow.marker", "tests"]);
  });
});

/**
 * A stand-in for the real runner, on `PATH` under its own name.
 *
 * The driver spawns its runner by bare command name, so a shim named `deno`
 * ahead of the real one on `PATH` is what any launched runner actually
 * executes. It marks the filesystem and exits successfully — so the marker's
 * presence is a runner start, and its absence is proof that none happened.
 * Nothing about the driver's own logging is involved in that answer.
 */
interface Sentinel {
  /** Prepend to `PATH` so a launched runner resolves to the shim. */
  bin: string;
  /** Written the instant any runner starts. */
  marker: URL;
}

function* runnerSentinel(): Operation<Sentinel> {
  const base = yield* useTempDirectory("shard-sentinel-");
  const root = pathToFileURL(`${base}/`);
  const bin = new URL("bin/", root);
  yield* ensureDir(bin);

  const marker = new URL("runner-started", root);
  const shim = new URL("deno", bin);
  yield* writeTextFile(shim, `#!/bin/sh\n: > "${fileURLToPath(marker)}"\nexit 0\n`);
  yield* until(chmod(shim, 0o755));

  return { bin: fileURLToPath(bin), marker };
}

/** The real entrypoint, with a shimmed runner ahead of the real one on `PATH`. */
function* driver(
  sentinel: Sentinel,
  selection: string,
): Operation<{ code?: number; stderr: string }> {
  const result = yield* exec(Deno.execPath(), {
    arguments: ["run", "--allow-all", "--frozen", "scripts/runtime-tests.ts", "deno", selection],
    cwd: fileURLToPath(REPOSITORY),
    env: {
      PATH: `${sentinel.bin}:${Deno.env.get("PATH") ?? ""}`,
      HOME: Deno.env.get("HOME") ?? "",
    },
  }).join();
  return { code: result.code, stderr: result.stderr };
}

describe("a shard selection nobody assigned", () => {
  /**
   * The count `ci.yml` declares for Deno. An index beyond it, and a count beyond
   * the corpus, both parse — they are well-formed `<index>/<count>` — so nothing
   * before the partition can reject them.
   */
  const DECLARED = 8;

  it("refuses an in-range-looking index before any runner starts", function* () {
    const sentinel = yield* runnerSentinel();

    const { code, stderr } = yield* driver(sentinel, `${DECLARED + 1}/${DECLARED}`);

    expect(code).toEqual(1);
    expect(stderr).toContain(`shard index ${DECLARED + 1} is outside 1..${DECLARED}`);
    expect(yield* exists(sentinel.marker)).toBe(false);
  });

  it("refuses a count larger than the corpus before any runner starts", function* () {
    const sentinel = yield* runnerSentinel();

    const { code, stderr } = yield* driver(sentinel, "1/99999");

    expect(code).toEqual(1);
    expect(stderr).toContain("exceeds");
    expect(yield* exists(sentinel.marker)).toBe(false);
  });

  it("refuses a malformed selection before any runner starts", function* () {
    const sentinel = yield* runnerSentinel();

    const { code, stderr } = yield* driver(sentinel, "3/");

    expect(code).toEqual(1);
    expect(stderr).toContain("usage: runtime-tests.ts");
    expect(yield* exists(sentinel.marker)).toBe(false);
  });

  /**
   * The sentinel has to be capable of firing, or the three refusals above prove
   * nothing. A selection the partition accepts reaches the runner, and the shim
   * records it.
   */
  it("starts the runner for a selection the partition accepts", function* () {
    const sentinel = yield* runnerSentinel();

    const { code } = yield* driver(sentinel, `1/${DECLARED}`);

    expect(code).toEqual(0);
    expect(yield* exists(sentinel.marker)).toBe(true);
  });
});
