/**
 * What a shard does with real child processes: the behaviors an injected runner
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
import { ensureDir, exists, readdir, readTextFile, writeTextFile } from "@effectionx/fs";
import { exec, Stdio } from "@effectionx/process";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { chmod } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { until } from "effection";

import { oneFileCommand, runShardFiles, spawnLaunch, TestRuns } from "../lib/runtime-tests.ts";
import type { ShardOutcome } from "../lib/runtime-tests.ts";

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
    const seen = yield* watching();

    let outcome: ShardOutcome | undefined;
    const shard = yield* spawn(function* () {
      outcome = yield* runShardFiles(
        "deno",
        ["tests/a-slow.test.ts", "tests/b-later.test.ts"],
        root,
      );
    });

    const marker = new URL("slow.marker", root);
    if (!(yield* waitFor(marker))) {
      const launch = oneFileCommand("deno", "tests/a-slow.test.ts");
      throw new Error(
        `child did not write expected startup marker ${fileURLToPath(marker)}\ncommand: ${launch.command} ${launch.arguments.join(" ")}\noutcome: ${JSON.stringify(outcome)}\nstdout:\n${seen.stdout}\nstderr:\n${seen.stderr}`,
      );
    }
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

const SUITES = "examples/adversarial-implementation/tests/";

/**
 * A corpus of Markdown suites, run through the real `xmd test` entrypoint with
 * its failure journals collected in a directory of the test's own rather than
 * wherever this process's environment points.
 */
function* suites(files: Record<string, string>): Operation<{ root: URL; journals: URL }> {
  const root = yield* workspace({});
  yield* ensureDir(new URL(SUITES, root));
  for (const [name, source] of Object.entries(files)) {
    yield* writeTextFile(new URL(`${SUITES}${name}`, root), source);
  }
  const journals = new URL("journals/", pathToFileURL(`${yield* useTempDirectory("journals-")}/`));
  yield* TestRuns.set((launch) =>
    spawnLaunch({
      ...launch,
      env:
        launch.env === undefined
          ? undefined
          : { ...launch.env, XMD_TEST_ARTIFACTS: fileURLToPath(journals) },
    }),
  );
  return { root, journals };
}

/** Waits for `release` before failing, so its start can be seen while it still runs. */
const HELD_FAILURE = `<Test name="fails deliberately">
\`\`\`bash exec
for attempt in $(seq 1 300); do test -e release && break; sleep 0.1; done
echo MD_FAILED_DELIBERATELY >&2
exit 3
\`\`\`
</Test>
`;

const MD_LATER = `<Test name="later">
\`\`\`bash exec
: > later.marker
\`\`\`
</Test>
`;

const MD_SLOW = `<Test name="slow" timeout="60s">
\`\`\`bash exec
: > slow.marker
sleep 3
: > outlived.marker
\`\`\`
</Test>
`;

function* collected(directory: URL): Operation<string[]> {
  const found: string[] = [];
  if (!(yield* exists(directory))) {
    return found;
  }
  for (const run of yield* readdir(directory)) {
    for (const name of yield* readdir(new URL(`${run}/`, directory))) {
      found.push(`${run}/${name}`);
    }
  }
  return found;
}

describe("a shard running real Markdown suites", () => {
  it("shows a suite's named start live, saves its journal, runs the files after it and keeps its failure first", function* () {
    const { root, journals } = yield* suites({
      "Held.test.md": HELD_FAILURE,
      "Later.test.md": MD_LATER,
    });
    yield* writeTextFile(new URL("tests/z.test.ts", root), FAILING);
    const seen = yield* watching();
    const held = `${SUITES}Held.test.md`;
    const assigned = [held, `${SUITES}Later.test.md`, "tests/z.test.ts"];

    let outcome: ShardOutcome | undefined;
    const shard = yield* spawn(function* () {
      outcome = yield* runShardFiles("deno", assigned, root);
    });

    const start = `[xmd test] start test "fails deliberately" at ${held}`;
    let visible = false;
    for (let attempt = 0; attempt < 300 && !visible; attempt += 1) {
      visible = seen.stderr.includes(start);
      if (!visible) {
        yield* sleep(100);
      }
    }
    // Seen while the suite is still waiting to be released, so before it settled.
    expect({ visible, settled: outcome !== undefined }).toEqual({ visible: true, settled: false });
    yield* writeTextFile(new URL("release", root), "");
    yield* shard;

    expect(outcome?.ran).toEqual(assigned);
    expect(outcome?.failure).toEqual({ file: held, status: 1 });
    expect(yield* exists(new URL("later.marker", root))).toBe(true);
    expect(seen.stderr).toContain("MD_FAILED_DELIBERATELY");
    expect(`${seen.stdout}\n${seen.stderr}`).toContain("B_FAILED_DELIBERATELY");

    const saved = yield* collected(journals);
    expect(saved.map((path) => path.replace(/^[^/]+\//, ""))).toEqual(["root-1.jsonl"]);
    expect(seen.stderr).toContain(`journal saved: ${fileURLToPath(new URL(saved[0], journals))}`);
    const lines = (yield* readTextFile(new URL(saved[0], journals))).trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(typeof JSON.parse(line)).toEqual("object");
    }
  });

  it("halts the running suite's process group and starts no later file", function* () {
    const { root } = yield* suites({ "Slow.test.md": MD_SLOW, "Later.test.md": MD_LATER });
    yield* watching();

    const shard = yield* spawn(() =>
      runShardFiles("deno", [`${SUITES}Slow.test.md`, `${SUITES}Later.test.md`], root),
    );
    if (!(yield* waitFor(new URL("slow.marker", root)))) {
      throw new Error("the slow suite never started its command");
    }
    yield* shard.halt();

    // The command is the suite's grandchild, so only a signal to the group stops it.
    yield* sleep(4_000);
    expect(yield* exists(new URL("outlived.marker", root))).toBe(false);
    expect(yield* exists(new URL("later.marker", root))).toBe(false);
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
   * A fixture count within the applicable corpus, independent of CI's shard
   * count. An index beyond it and a count beyond the corpus both parse as
   * `<index>/<count>`, so only the partition can reject them.
   */
  const FIXTURE_COUNT = 8;

  it("refuses an in-range-looking index before any runner starts", function* () {
    const sentinel = yield* runnerSentinel();

    const { code, stderr } = yield* driver(sentinel, `${FIXTURE_COUNT + 1}/${FIXTURE_COUNT}`);

    expect(code).toEqual(1);
    expect(stderr).toContain(`shard index ${FIXTURE_COUNT + 1} is outside 1..${FIXTURE_COUNT}`);
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

    const { code } = yield* driver(sentinel, `1/${FIXTURE_COUNT}`);

    expect(code).toEqual(0);
    expect(yield* exists(sentinel.marker)).toBe(true);
  });
});
