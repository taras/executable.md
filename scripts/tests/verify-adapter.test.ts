import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, sleep, spawn, until, withResolvers } from "effection";
import type { Operation, Task } from "effection";
import { exists, readdir, rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { chmod, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  consumerCommand,
  descendants,
  emitAll,
  host,
  openSpool,
  producerCommand,
  SpoolSinks,
  useVerifyHost,
} from "../verify.ts";
import type { AdapterHost, CommandSpec, OpenSpool, Spool, WriteBytes } from "../verify.ts";
import { SETTLED } from "../lib/consumer-cycle.ts";
import { compareTracked, UnsupportedEntryError } from "../lib/tracked.ts";
import type { TrackedEntry, TrackedState } from "../lib/tracked.ts";
import type { VerifyHost } from "../lib/verify.ts";

/** A directory of this test's own. */
function scratch(prefix: string): Operation<string> {
  return useTempDirectory(`${prefix}-`);
}

/**
 * Identity and signing on the command line, never inherited. A developer whose
 * global config signs commits — this repository's own setup does, through an
 * external agent — would otherwise have these fixtures fail whenever that agent
 * is locked or busy, which is how a battery run came back with `git commit`
 * exiting 128.
 */
const COMMITTER = ["-c", "user.email=a@b.test", "-c", "user.name=T", "-c", "commit.gpgsign=false"];

function* git(cwd: string, ...args: string[]): Operation<void> {
  yield* scoped(function* () {
    const process = yield* exec("git", { arguments: args, cwd });
    yield* process.around({ *stdout() {}, *stderr() {} });
    const status = yield* process.join();
    if (status.code !== 0) {
      throw new Error(`git ${args.join(" ")} exited ${status.code}`);
    }
  });
}

/**
 * A repository with one commit, so `git ls-files` has something to say.
 *
 * The lockfile is part of what `owned()` digests, so a fixture without one
 * cannot be snapshotted at all — this is the smallest tree the adapter's own
 * comparison can describe.
 */
function* repository(prefix: string): Operation<string> {
  const root = yield* scratch(prefix);
  yield* git(root, "init", "-q", "-b", "main");
  yield* writeTextFile(path.join(root, "plain.txt"), "content\n");
  yield* writeTextFile(path.join(root, "deno.lock"), '{"version":"5"}\n');
  yield* git(root, "add", "-A");
  yield* git(root, ...COMMITTER, "commit", "-qm", "base");
  return root;
}

function* fixtureHost(root: string): Operation<{ target: AdapterHost; spools: string }> {
  const spools = yield* scratch("verify-spools");
  const control = yield* scratch("verify-control");
  return { target: host({ spools, control, root, log() {} }), spools };
}

/** Every tracked path, which is one part of the snapshot `owned()` returns. */
function* tracked(target: VerifyHost): Operation<TrackedState> {
  return (yield* target.owned()).tracked;
}

/** Runs a Deno script, which is how these tests drive a real child process. */
function* script(root: string, source: string, name = "fixture.ts"): Operation<CommandSpec> {
  const file = path.join(root, name);
  yield* writeTextFile(file, source);
  return { id: "fixture", program: "deno", args: ["run", "--allow-all", file] };
}

describe("the spool", () => {
  it("holds the child's bytes exactly, undecoded", function* () {
    const root = yield* repository("verify-bytes");
    const { target } = yield* fixtureHost(root);
    const command = yield* script(
      root,
      "Deno.stdout.writeSync(new Uint8Array([0, 255, 254, 65, 10]));\n",
    );

    expect((yield* target.start(command)).code).toEqual(0);
    expect([...(yield* target.spool("fixture"))]).toEqual([0, 255, 254, 65, 10]);
  });

  it("keeps the last bytes a child writes to stderr as it exits", function* () {
    const root = yield* repository("verify-drain");
    const { target } = yield* fixtureHost(root);
    const command = yield* script(
      root,
      [
        "const line = `${'e'.repeat(4096)}\\n`;",
        "for (let index = 0; index < 32; index += 1) {",
        "  Deno.stderr.writeSync(new TextEncoder().encode(line));",
        "}",
        "Deno.exit(3);",
      ].join("\n"),
    );

    expect((yield* target.start(command)).code).toEqual(3);
    const spooled = new TextDecoder().decode(yield* target.spool("fixture"));
    expect(spooled.length).toEqual(32 * 4097);
  });

  it("keeps two concurrent commands' bytes apart", function* () {
    const root = yield* repository("verify-interleave");
    const { target } = yield* fixtureHost(root);
    const write = (letter: string) =>
      [
        `const chunk = new TextEncoder().encode("${letter}".repeat(1024));`,
        "for (let index = 0; index < 64; index += 1) {",
        "  Deno.stdout.writeSync(chunk);",
        "}",
      ].join("\n");
    const first = { ...(yield* script(root, write("a"), "a.ts")), id: "first" };
    const second = { ...(yield* script(root, write("b"), "b.ts")), id: "second" };

    yield* scoped(function* () {
      const one = yield* spawn(() => target.start(first));
      const two = yield* spawn(() => target.start(second));
      yield* one;
      yield* two;
    });

    const one = new TextDecoder().decode(yield* target.spool("first"));
    const two = new TextDecoder().decode(yield* target.spool("second"));
    expect(new Set(one)).toEqual(new Set(["a"]));
    expect(new Set(two)).toEqual(new Set(["b"]));
    expect(one.length).toEqual(64 * 1024);
    expect(two.length).toEqual(64 * 1024);
  });
});

/**
 * Why the sink is synchronous, and what that buys.
 *
 * The harness promises complete, byte-exact, non-interleaved output. It does
 * not promise the child will ever be slowed down: `@effectionx/node`'s
 * `fromReadable` subscribes with `target.on("data", …)`, so the pipe is drained
 * in flowing mode whether or not the consumer keeps up.
 *
 * What the promise rests on is a sink that cannot fall behind. Holding one
 * mid-chunk and letting the child exit showed the pump halted at teardown with
 * its backlog still queued and those bytes gone — so the sink never suspends,
 * and the first test here is what keeps it that way.
 */
describe("the synchronous sink", () => {
  const MIB = 16 * 1024 * 1024;

  it("never suspends, so the pump can never fall behind", function* () {
    const directory = yield* scratch("verify-sync-sink");
    const spool = openSpool(path.join(directory, "probe.spool"));
    const writing = spool.write(new TextEncoder().encode("bytes"))[Symbol.iterator]();

    // One step finishes it: a sink that yielded here could be halted with a
    // backlog, which is how output goes missing.
    expect(writing.next().done).toBe(true);
    spool.close();
  });

  it("keeps all 16 MiB of a child that exits the moment it finishes writing", function* () {
    const root = yield* repository("verify-volume");
    const { target } = yield* fixtureHost(root);
    const command = yield* script(
      root,
      [
        `const payload = new Uint8Array(${MIB}).fill(0x61);`,
        "let written = 0;",
        "while (written < payload.length) {",
        "  written += Deno.stdout.writeSync(payload.subarray(written));",
        "}",
        "Deno.exit(0);",
      ].join("\n"),
    );

    expect((yield* target.start(command)).code).toEqual(0);
    const bytes = yield* target.spool("fixture");
    expect(bytes.length).toEqual(MIB);
    expect(bytes.every((byte) => byte === 0x61)).toBe(true);
  });
});

/**
 * Cancellation, observed rather than inferred, on two live invocations.
 *
 * A signalled process still answers `kill(pid, 0)` until it is reaped, and the
 * real battery spawns grandchildren, so each fixture spawns one too. Readiness
 * is signalled only after a beat has been written and flushed, so a halt cannot
 * race the first beat.
 *
 * Two invocations run at once because "cleans up after itself" and "leaves the
 * other one alone" are the same guarantee seen from two sides, and a pair run
 * one after the other cannot tell them apart.
 */
describe("cancellation", () => {
  interface Beating {
    /** Halting this stops the invocation and runs its cleanup. */
    task: Task<unknown>;
    beats: string;
    ready: string;
    spools: string;
    control: string;
  }

  /** An invocation whose command spawns a grandchild that never stops beating. */
  function* beating(name: string): Operation<Beating> {
    const root = yield* repository(`verify-${name}`);
    const spools = yield* scratch(`verify-${name}-spools`);
    const control = yield* scratch(`verify-${name}-control`);
    const beats = path.join(root, "beats");
    const ready = path.join(root, "ready");

    yield* writeTextFile(
      path.join(root, "grandchild.ts"),
      [
        `const beats = ${JSON.stringify(beats)};`,
        `const ready = ${JSON.stringify(ready)};`,
        "const pause = new Int32Array(new SharedArrayBuffer(4));",
        "let first = true;",
        "while (true) {",
        '  Deno.writeTextFileSync(beats, "x", { append: true });',
        "  if (first) {",
        "    first = false;",
        '    Deno.writeTextFileSync(ready, "ready");',
        "  }",
        "  Atomics.wait(pause, 0, 0, 50);",
        "}",
      ].join("\n"),
    );
    const command = yield* script(
      root,
      [
        "const child = new Deno.Command(Deno.execPath(), {",
        `  args: ["run", "--allow-all", ${JSON.stringify(path.join(root, "grandchild.ts"))}],`,
        "}).spawn();",
        "// Block without a promise: teardown signals the whole group.",
        "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
      ].join("\n"),
    );

    const task = yield* spawn(() =>
      scoped(function* () {
        const owned = yield* useVerifyHost({ spools, control, root, log() {} });
        yield* owned.signal("producing");
        yield* owned.start(command);
      }),
    );

    while (!(yield* exists(ready))) {
      yield* sleep(10);
    }
    expect((yield* until(readFile(beats))).length).toBeGreaterThan(0);
    return { task, beats, ready, spools, control };
  }

  /** Unchanged across several intervals; one sample cannot tell stopped from between beats. */
  function* stopped(beating: Beating): Operation<void> {
    const settled = (yield* until(readFile(beating.beats))).length;
    yield* sleep(500);
    expect((yield* until(readFile(beating.beats))).length).toEqual(settled);
  }

  it("stops one invocation's descendants, spools and controls, and leaves the other running", function* () {
    const first = yield* beating("cancel-first");
    const second = yield* beating("cancel-second");
    const beforeHalt = (yield* until(readFile(second.beats))).length;

    yield* first.task.halt();

    yield* stopped(first);
    expect(yield* exists(first.spools)).toBe(false);
    expect(yield* exists(first.control)).toBe(false);

    // The survivor is still beating, and still owns its spool and its controls.
    expect((yield* until(readFile(second.beats))).length).toBeGreaterThan(beforeHalt);
    expect(yield* exists(second.spools)).toBe(true);
    expect((yield* readdir(second.spools)).length).toEqual(1);
    expect(yield* readdir(second.control)).toEqual(["producing"]);

    yield* second.task.halt();

    yield* stopped(second);
    expect(yield* exists(second.spools)).toBe(false);
    expect(yield* exists(second.control)).toBe(false);
  });
});

describe("the fingerprint", () => {
  it("records content, executable mode, symlink target, and absence", function* () {
    const root = yield* repository("verify-fingerprint");
    yield* writeTextFile(path.join(root, "run.sh"), "#!/bin/sh\n");
    yield* until(chmod(path.join(root, "run.sh"), 0o755));
    yield* until(symlink("plain.txt", path.join(root, "link.txt")));
    yield* writeTextFile(path.join(root, "gone.txt"), "temporary\n");
    yield* git(root, "add", "-A");
    yield* git(root, ...COMMITTER, "commit", "-qm", "more");
    yield* rm(path.join(root, "gone.txt"));

    const { target } = yield* fixtureHost(root);
    const state = yield* tracked(target);

    expect(state.get("plain.txt")).toEqual({
      kind: "file",
      digest: expect.any(String),
      executable: false,
    });
    expect(state.get("run.sh")!.kind).toEqual("file");
    expect(state.get("run.sh")).toMatchObject({ executable: true });
    expect(state.get("link.txt")).toEqual({ kind: "symlink", target: "plain.txt" });
    expect(state.get("gone.txt")).toEqual({ kind: "absent" });
  });

  it("keeps filenames containing a tab or a newline", function* () {
    const root = yield* repository("verify-awkward");
    yield* writeTextFile(path.join(root, "tab\tname.txt"), "a\n");
    yield* writeTextFile(path.join(root, "new\nline.txt"), "b\n");
    yield* git(root, "add", "-A");
    yield* git(root, ...COMMITTER, "commit", "-qm", "awkward");

    const { target } = yield* fixtureHost(root);
    const state = yield* tracked(target);
    expect(state.has("tab\tname.txt")).toBe(true);
    expect(state.has("new\nline.txt")).toBe(true);
  });

  it("refuses a submodule whose working copy is present", function* () {
    const root = yield* submoduleRepository("verify-gitlink-present");
    const { target } = yield* fixtureHost(root);

    let raised: unknown;
    try {
      yield* tracked(target);
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(UnsupportedEntryError);
  });

  /**
   * The one an `lstat`-first fingerprint gets wrong: with the directory gone,
   * the path looks exactly like a deleted file.
   */
  it("refuses a submodule whose working copy is missing", function* () {
    const root = yield* submoduleRepository("verify-gitlink-absent");
    yield* rm(path.join(root, "vendored"), { recursive: true, force: true });
    const { target } = yield* fixtureHost(root);

    let raised: unknown;
    try {
      yield* tracked(target);
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(UnsupportedEntryError);
  });
});

function* submoduleRepository(prefix: string): Operation<string> {
  const inner = yield* repository(`${prefix}-inner`);
  const root = yield* repository(prefix);
  yield* git(
    root,
    "-c",
    "protocol.file.allow=always",
    ...COMMITTER,
    "submodule",
    "add",
    "-q",
    inner,
    "vendored",
  );
  yield* git(root, ...COMMITTER, "commit", "-qm", "submodule");
  return root;
}

/**
 * The fingerprint against real commands, which is the pairing that matters:
 * a check that dirties the tree is caught by comparing what the adapter read
 * before and after it ran.
 */
describe("cleanliness, end to end", () => {
  it("catches a command that rewrote a tracked file", function* () {
    const root = yield* repository("verify-dirty-content");
    const { target } = yield* fixtureHost(root);
    const command = yield* script(
      root,
      `Deno.writeTextFileSync(${JSON.stringify(path.join(root, "plain.txt"))}, "rewritten\\n");\n`,
    );

    const before = yield* tracked(target);
    yield* target.start(command);
    const moved = compareTracked(before, yield* tracked(target));

    expect(moved.length).toEqual(1);
    expect(moved[0]).toContain("plain.txt");
  });

  it("catches a command that only changed a tracked file's mode", function* () {
    const root = yield* repository("verify-dirty-mode");
    const { target } = yield* fixtureHost(root);
    const command = yield* script(
      root,
      `Deno.chmodSync(${JSON.stringify(path.join(root, "plain.txt"))}, 0o755);\n`,
    );

    const before = yield* tracked(target);
    yield* target.start(command);
    const moved = compareTracked(before, yield* tracked(target));

    expect(moved).toEqual(["plain.txt: " + describeBoth(before.get("plain.txt")!)]);
  });

  /** A failing command dirtying the tree is exactly the case that must not hide. */
  it("catches a dirtied tree even when the command failed", function* () {
    const root = yield* repository("verify-dirty-failing");
    const { target } = yield* fixtureHost(root);
    const command = yield* script(
      root,
      [
        `Deno.writeTextFileSync(${JSON.stringify(path.join(root, "plain.txt"))}, "half\\n");`,
        "Deno.exit(1);",
      ].join("\n"),
    );

    const before = yield* tracked(target);
    expect((yield* target.start(command)).code).toEqual(1);
    expect(compareTracked(before, yield* tracked(target)).length).toEqual(1);
  });

  /** A worktree that was already dirty is still one nothing may move further. */
  it("passes a tree that was dirty before the command and stayed put", function* () {
    const root = yield* repository("verify-already-dirty");
    yield* writeTextFile(path.join(root, "plain.txt"), "dirty before we started\n");
    const { target } = yield* fixtureHost(root);
    const command = yield* script(
      root,
      'Deno.stdout.writeSync(new TextEncoder().encode("quiet"));\n',
    );

    const before = yield* tracked(target);
    yield* target.start(command);

    expect(compareTracked(before, yield* tracked(target))).toEqual([]);
  });
});

function describeBoth(entry: TrackedEntry): string {
  if (entry.kind !== "file") {
    throw new Error("expected a file");
  }
  return `${entry.digest.slice(0, 12)} -> ${entry.digest.slice(0, 12)} +x`;
}

/**
 * The preflight, on a worktree nobody prepared.
 *
 * The adapter is replaced with a fixture whose first act is to write a
 * sentinel, so "it never started" is observed rather than inferred from a
 * missing log line.
 *
 * Unprepared means the worktree, not the cache: a fresh clone has no
 * `node_modules/.xmd-prepared`, which is what the preflight reads. The run
 * therefore inherits this process's `DENO_DIR` rather than a scratch one —
 * resolution finds what it needs already cached and the test costs seconds,
 * where a cold cache made it download the whole graph before refusing.
 *
 * Nothing here asserts what the dependency cache or `node_modules` do. `deno
 * task` resolves the workspace before the task command runs — the ordering
 * `AGENTS.md` records for lockfiles, which `lock.frozen` closed only for the
 * lock — and with root `nodeModulesDir: "auto"` that resolution creates
 * `node_modules/.deno` and the package links before a task command's own
 * `--node-modules-dir=none` can apply. Both are permitted, not required, and
 * asserting either presence or absence would pin behaviour the task command
 * cannot enforce (#279).
 */
describe("verify on an unprepared worktree", () => {
  it("never reaches the adapter, and leaves the worktree as it found it", function* () {
    const target = yield* scratch("verify-cold");
    const repo = fileURLToPath(new URL("../../", import.meta.url));
    yield* git(repo, "clone", "--shared", "--quiet", repo, target);

    const sentinel = path.join(target, "adapter-started");
    yield* writeTextFile(
      path.join(target, "scripts", "verify.ts"),
      `Deno.writeTextFileSync(${JSON.stringify(sentinel)}, "started");\n`,
    );

    const lock = path.join(target, "deno.lock");
    const before = yield* until(readFile(lock));

    const attempt = yield* scoped(function* () {
      const process = yield* exec(Deno.execPath(), {
        arguments: ["task", "verify"],
        cwd: target,
        env: Deno.env.toObject(),
      });
      const chunks: string[] = [];
      const decoder = new TextDecoder();
      yield* process.around({
        *stdout([bytes]) {
          chunks.push(decoder.decode(bytes, { stream: true }));
        },
        *stderr([bytes]) {
          chunks.push(decoder.decode(bytes, { stream: true }));
        },
      });
      const status = yield* process.join();
      return { code: status.code, output: chunks.join("") };
    });

    expect(yield* exists(sentinel)).toBe(false);
    expect(attempt.output).not.toContain("commands concurrently");
    expect(yield* until(readFile(lock))).toEqual(before);
    expect(attempt.code).not.toEqual(0);
    expect(attempt.output).toContain("deno task setup");
  });
});

describe("a conflicted worktree", () => {
  /**
   * `git ls-files --stage` reports three entries for a conflicted path. There
   * is no single "before" to compare against while a merge is in flight, so the
   * fingerprint refuses instead of picking a side.
   */
  it("is reported rather than fingerprinted", function* () {
    const root = yield* repository("verify-conflict");
    const committer = COMMITTER;
    yield* git(root, "checkout", "-qb", "other");
    yield* writeTextFile(path.join(root, "plain.txt"), "theirs\n");
    yield* git(root, "add", "-A");
    yield* git(root, ...committer, "commit", "-qm", "theirs");

    yield* git(root, "checkout", "-q", "main");
    yield* writeTextFile(path.join(root, "plain.txt"), "ours\n");
    yield* git(root, "add", "-A");
    yield* git(root, ...committer, "commit", "-qm", "ours");

    const merging = yield* scoped(function* () {
      const process = yield* exec("git", {
        arguments: [...committer, "merge", "other"],
        cwd: root,
      });
      yield* process.around({ *stdout() {}, *stderr() {} });
      return yield* process.join();
    });
    expect(merging.code).not.toEqual(0);

    const { target } = yield* fixtureHost(root);
    let raised: unknown;
    try {
      yield* tracked(target);
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(UnsupportedEntryError);
    expect(String(raised)).toContain("unmerged");
  });
});

/**
 * The report promises a failure's bytes complete, and one `writeSync` does not
 * promise that: it may accept part of what it was handed and return the count.
 * A single call would drop the remainder with nothing raised, so these use a
 * writer that shortens every chunk on purpose — a real file would accept
 * everything and prove nothing.
 */
describe("complete failure emission", () => {
  it("keeps writing until a short-accepting sink has taken every byte", function* () {
    const taken: number[] = [];
    const collected: number[] = [];
    const stingy: WriteBytes = (bytes) => {
      const accepted = Math.max(1, Math.floor(bytes.length / 3));
      collected.push(...bytes.subarray(0, accepted));
      taken.push(accepted);
      return accepted;
    };

    const payload = new TextEncoder().encode("every byte of a failing command's output");
    emitAll(stingy, payload);

    expect(new Uint8Array(collected)).toEqual(payload);
    expect(taken.length).toBeGreaterThan(1);
  });

  it("raises on a sink that stops accepting rather than looping forever", function* () {
    const stalled: WriteBytes = () => 0;

    expect(() => emitAll(stalled, new TextEncoder().encode("dropped"))).toThrow(
      /stopped accepting bytes after 0 of 7/,
    );
  });

  it("carries raw bytes through the host's emit, short writes and all", function* () {
    const directory = yield* useTempDirectory("xmd-emit-");
    const written: number[] = [];

    const target = host({
      spools: directory,
      control: directory,
      root: Deno.cwd(),
      log: () => {},
      write: (bytes) => {
        const accepted = Math.max(1, bytes.length - 1);
        written.push(...bytes.subarray(0, accepted));
        return accepted;
      },
    });

    const raw = new Uint8Array([0, 0xff, 0xfe, 10, 65]);
    target.emit(raw);

    expect(new Uint8Array(written)).toEqual(raw);
  });
});

/**
 * A grandchild in its *own* process group, which is the shape the battery
 * actually meets.
 *
 * `@effectionx/process` starts every `exec` in a new group, so a command that
 * execs something — `deno task test` reaching `deno bundle` — leaves that
 * grandchild outside the group teardown signals. A live wedge showed exactly
 * that: after a command was halted at its deadline, `deno bundle` and its
 * esbuild service were still running, both process-group leaders of their own.
 * The fixture reproduces it with `set -m`, which is how a shell puts a
 * background job in a new group.
 */
describe("descendants outside the command's process group", () => {
  it("collects a subtree deepest first from a ps snapshot", function* () {
    const snapshot = ["1 0", "10 1", "11 10", "12 11", "13 10", "99 1"].join("\n");

    expect(descendants(10, snapshot)).toEqual([12, 11, 13]);
    expect(descendants(99, snapshot)).toEqual([]);
  });

  it("ignores lines that are not two integers", function* () {
    const snapshot = ["  PID  PPID", "10 1", "not a row", "", "11 10"].join("\n");

    expect(descendants(10, snapshot)).toEqual([11]);
  });

  it("stops a grandchild the group signal cannot reach", function* () {
    const root = yield* repository("verify-regrouped");
    const spools = yield* scratch("verify-regrouped-spools");
    const beats = path.join(root, "beats");
    const ready = path.join(root, "ready");

    yield* writeTextFile(
      path.join(root, "grandchild.sh"),
      [
        "#!/bin/sh",
        `while true; do`,
        `  printf x >> ${JSON.stringify(beats)}`,
        `  [ -f ${JSON.stringify(ready)} ] || printf ready > ${JSON.stringify(ready)}`,
        "  sleep 0.05",
        "done",
      ].join("\n"),
    );
    yield* until(chmod(path.join(root, "grandchild.sh"), 0o755));

    // `set -m` puts the background job in a process group of its own, so the
    // group the harness signals is not the group the grandchild is in.
    const command: CommandSpec = {
      id: "regrouped",
      program: "bun",
      args: ["run", "--silent", "regrouped"],
    };
    yield* writeTextFile(
      path.join(root, "package.json"),
      JSON.stringify(
        { name: "regrouped", scripts: { regrouped: `set -m; ./grandchild.sh & wait` } },
        null,
        2,
      ),
    );

    const task = yield* spawn(() =>
      scoped(function* () {
        const control = yield* scratch("verify-control");
        const owned = yield* useVerifyHost({ spools, control, root, log() {} });
        yield* owned.start(command);
      }),
    );

    while (!(yield* exists(ready))) {
      yield* sleep(10);
    }
    const beating = (yield* until(readFile(beats))).length;
    expect(beating).toBeGreaterThan(0);

    yield* task.halt();

    // Several intervals: one sample cannot tell stopped from between beats.
    yield* sleep(300);
    const settled = (yield* until(readFile(beats))).length;
    yield* sleep(500);
    expect((yield* until(readFile(beats))).length).toEqual(settled);
  });
});

/**
 * The launches themselves. Under the repository's `"auto"` node_modules mode,
 * a bare `deno` process re-creates the workspace's `node_modules` links before
 * it reaches its own code — an unlink followed by a symlink, which another
 * participant resolving through the link in that instant observes as the
 * package not existing. Every deno process the proof starts therefore declines
 * that management, and the declined launch must still be able to consume the
 * layout it stands on.
 */
describe("participant launches", () => {
  it("declines node_modules management on every deno process the proof starts", function* () {
    expect(consumerCommand("deno", "/tree", "/control").args).toContain(
      "--node-modules-dir=manual",
    );
    expect(producerCommand().args).toContain("--node-modules-dir=manual");
  });

  it("consumes the prepared layout through the unmanaged deno launch", function* () {
    const spools = yield* scratch("verify-launch-spools");
    const control = yield* scratch("verify-launch-control");
    const workspace = fileURLToPath(new URL("../../", import.meta.url));
    const owned = yield* useVerifyHost({ spools, control, root: workspace, log() {} });
    yield* owned.signal(SETTLED);

    const settled = yield* owned.consume("deno");

    expect(settled.code).toEqual(0);
    expect((yield* owned.cycles("deno"))?.after).toEqual(1);
  });
});
