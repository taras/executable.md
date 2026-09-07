/**
 * Tier FL — the foreground native launcher (specs/native-agent-session-launch-spec.md
 * §CLI and discovery, §Ownership and concurrency).
 *
 * These start real children. The command shapes are the ones the built-in
 * adapters build — `claude --resume <id>` and `codex resume <id>` — served by
 * fake executables, so what is proven is the argument vector a native CLI
 * actually receives, the status it propagates back, and that a cancelled
 * launch leaves no process holding the terminal.
 *
 * The fake executables write what they saw to a file rather than to stdout:
 * a foreground child inherits this process's streams by design, and a test
 * that read its output would be reading the test runner's own terminal.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, sleep, spawn, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import process from "node:process";
import { spawn as spawnChild } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  flushOutput,
  nativeLaunch,
  NativeLauncher,
  NO_TERMINAL,
  reserveTerminal,
} from "../src/native-launcher.ts";
import { installForegroundLauncher, reap } from "../src/posix-launcher.ts";

const SENTINEL = "SENTINEL-PREPARED-CONTEXT-4b17";

interface Fake {
  /** Absolute path of the fake executable. */
  command: string;
  /** Everything the fake recorded, once it has run. */
  read(): Operation<{ argv: string[]; env: Record<string, string>; pid: number }>;
}

/**
 * A fake native CLI: records its argument vector and environment, then exits
 * with `exitCode` (or hangs, so cancellation has something to reap).
 */
function* useFake(
  dir: string,
  name: string,
  options: {
    exitCode?: number;
    hang?: boolean;
    ignoreInterrupt?: boolean;
    /** Append to this file every 30ms, so liveness is observable. */
    heartbeat?: string;
  } = {},
): Operation<Fake> {
  const log = path.join(dir, `${name}.json`);
  const command = path.join(dir, name);
  const body = [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({`,
    "  argv: process.argv.slice(2),",
    "  env: process.env,",
    "  pid: process.pid,",
    "}));",
    options.ignoreInterrupt
      ? 'process.on("SIGINT", () => {}); process.on("SIGTERM", () => {});'
      : "",
    options.heartbeat
      ? `setInterval(() => fs.appendFileSync(${JSON.stringify(options.heartbeat)}, "."), 30);`
      : "",
    options.hang || options.heartbeat
      ? "setInterval(() => {}, 1000);"
      : `process.exit(${options.exitCode ?? 0});`,
    "",
  ].join("\n");
  yield* writeTextFile(command, body);
  yield* until(chmod(command, 0o755));
  return {
    command,
    *read() {
      const raw = yield* readTextFile(log);
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) {
        throw new Error(`fake ${name} recorded nothing usable`);
      }
      const { argv, env, pid } = parsed as { argv?: unknown; env?: unknown; pid?: unknown };
      if (!Array.isArray(argv) || typeof env !== "object" || env === null) {
        throw new Error(`fake ${name} recorded an unexpected shape`);
      }
      if (typeof pid !== "number") {
        throw new Error(`fake ${name} recorded no pid`);
      }
      return {
        argv: argv.map((entry) => String(entry)),
        env: env as Record<string, string>,
        pid,
      };
    },
  };
}

function* useTempDir(): Operation<string> {
  const dir = path.join(os.tmpdir(), `xmd-fl-${randomUUID()}`);
  yield* ensureDir(dir);
  yield* ensure(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("Tier FL — the foreground native launcher", () => {
  it("FL1: a fake claude receives exactly the resume vector, and no prepared text", function* () {
    const dir = yield* useTempDir();
    const fake = yield* useFake(dir, "claude");
    yield* installForegroundLauncher({ isTerminal: () => true });
    yield* reserveTerminal();

    const outcome = yield* nativeLaunch({
      command: [fake.command, "--resume", "session-abc"],
      cwd: dir,
    });

    expect(outcome.exitCode).toBe(0);
    const seen = yield* fake.read();
    expect(seen.argv).toEqual(["--resume", "session-abc"]);
    expect(JSON.stringify(seen.env)).not.toContain(SENTINEL);
  });

  it("FL2: a fake codex receives the resume subcommand form", function* () {
    const dir = yield* useTempDir();
    const fake = yield* useFake(dir, "codex");
    yield* installForegroundLauncher({ isTerminal: () => true });
    yield* reserveTerminal();

    yield* nativeLaunch({ command: [fake.command, "resume", "session-xyz"], cwd: dir });

    expect((yield* fake.read()).argv).toEqual(["resume", "session-xyz"]);
  });

  it("FL3: a nonzero native status is reported, not swallowed", function* () {
    const dir = yield* useTempDir();
    const fake = yield* useFake(dir, "claude", { exitCode: 12 });
    yield* installForegroundLauncher({ isTerminal: () => true });
    yield* reserveTerminal();

    const outcome = yield* nativeLaunch({
      command: [fake.command, "--resume", "session-abc"],
      cwd: dir,
    });

    expect(outcome.exitCode).toBe(12);
    expect(outcome.signal).toBe(undefined);
  });

  it("FL4: a host with no terminal refuses the reservation", function* () {
    yield* installForegroundLauncher({ isTerminal: () => false });
    let message = "";
    try {
      yield* reserveTerminal();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe(NO_TERMINAL);
  });

  it("FL5: one native UI owns the terminal at a time", function* () {
    yield* installForegroundLauncher({ isTerminal: () => true });
    let message = "";
    yield* scoped(function* () {
      yield* reserveTerminal();
      try {
        yield* scoped(function* () {
          yield* reserveTerminal();
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
    });
    expect(message).toContain("already holds this run's terminal");

    // Released with the scope that held it, so a later launch can reserve.
    yield* scoped(function* () {
      yield* reserveTerminal();
    });
  });

  it("FL6: the reader is caught up before the child is started", function* () {
    const dir = yield* useTempDir();
    const fake = yield* useFake(dir, "claude");
    const order: string[] = [];
    yield* installForegroundLauncher({
      isTerminal: () => true,
      // deno-lint-ignore require-yield
      drain: function* () {
        order.push("drain");
      },
    });
    yield* reserveTerminal();
    yield* flushOutput();
    order.push("launch");
    yield* nativeLaunch({ command: [fake.command, "--resume", "x"], cwd: dir });

    expect(order).toEqual(["drain", "launch"]);
  });

  it("FL8: the runtime's start event is reported once, before the child is waited on", function* () {
    const dir = yield* useTempDir();
    const fake = yield* useFake(dir, "claude");
    const order: string[] = [];
    yield* installForegroundLauncher({ isTerminal: () => true });
    yield* reserveTerminal();

    const outcome = yield* NativeLauncher.operations.launch(
      { command: [fake.command, "--resume", "session-abc"], cwd: dir },
      () => order.push("started"),
    );
    order.push("exited");

    expect(outcome.exitCode).toBe(0);
    // A start, then an exit. Reported from the runtime's own spawn event, so a
    // child that starts and closes at once has still started.
    expect(order).toEqual(["started", "exited"]);
    expect((yield* fake.read()).argv).toEqual(["--resume", "session-abc"]);
  });

  it("FL9: a child that never starts never reports a start", function* () {
    const dir = yield* useTempDir();
    const order: string[] = [];
    yield* installForegroundLauncher({ isTerminal: () => true });
    yield* reserveTerminal();

    let message = "";
    try {
      yield* NativeLauncher.operations.launch(
        { command: [path.join(dir, "not-a-program")], cwd: dir },
        () => order.push("started"),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toBe("");
    // Nothing ran, so nothing started — which is what keeps a pane whose launch
    // failed from being presented as one that is running.
    expect(order).toEqual([]);
  });

  it("FL7: cancellation stops a child that ignores the interrupt", function* () {
    const dir = yield* useTempDir();
    const heartbeat = path.join(dir, "heartbeat");
    const fake = yield* useFake(dir, "claude", { ignoreInterrupt: true, heartbeat });
    let child = 0;

    yield* scoped(function* () {
      yield* installForegroundLauncher({ isTerminal: () => true });
      yield* reserveTerminal();
      yield* spawn(function* () {
        yield* nativeLaunch({ command: [fake.command, "--resume", "hangs"], cwd: dir });
      });
      // The fake records itself as it starts, so a readable log is the
      // signal that a real child is running.
      while (child === 0) {
        try {
          child = (yield* fake.read()).pid;
        } catch {
          yield* sleep(20);
        }
      }
      // Leaving this scope cancels the launch. It may not return while the
      // child is still running, and the child ignores the interrupt, so
      // getting past this line at all is the escalation working.
    });

    expect(child).toBeGreaterThan(0);
    // Whether the operating system has been asked for the corpse yet is not
    // the question — whether the child is still doing anything is. It beat
    // once every 30ms while it lived.
    const before = yield* beats(heartbeat);
    yield* sleep(200);
    expect(yield* beats(heartbeat)).toBe(before);
  });

  /**
   * Counted on the child itself, after each launch has ended, which is when the
   * removal is supposed to have happened — and then the start event is replayed
   * on it, because a handler left attached is one that would report a start for
   * a launch nobody is waiting on any more.
   */
  it("FL10: a launch leaves nothing on its child, and none of them reports a late start", function* () {
    const dir = yield* useTempDir();
    const children: ChildProcess[] = [];
    const order: string[] = [];
    const listeners = (): number =>
      children.reduce(
        (total, child) =>
          total +
          (["spawn", "error", "exit"] as const).reduce(
            (count, name) => count + child.listenerCount(name),
            0,
          ),
        0,
      );
    const watch = (child: ChildProcess): void => {
      children.push(child);
    };

    // Delivery: a child that starts and exits.
    const fake = yield* useFake(dir, "claude", { exitCode: 0 });
    yield* scoped(function* () {
      yield* installForegroundLauncher({ isTerminal: () => true, observe: watch });
      yield* reserveTerminal();
      yield* NativeLauncher.operations.launch({ command: [fake.command], cwd: dir }, () =>
        order.push("started"),
      );
    });
    expect(children.length).toBe(1);
    expect(listeners()).toBe(0);
    expect(order).toEqual(["started"]);

    // Startup failure: `error` arrives and `spawn` never will, so the handler
    // that would report a start is one only the launch's own end takes off.
    children.length = 0;
    order.length = 0;
    yield* scoped(function* () {
      yield* installForegroundLauncher({ isTerminal: () => true, observe: watch });
      yield* reserveTerminal();
      try {
        yield* NativeLauncher.operations.launch(
          { command: [path.join(dir, "not-a-program")], cwd: dir },
          () => order.push("started"),
        );
      } catch {
        // That it refuses is FL9's claim; this row reads what it left behind.
      }
    });
    expect(children.length).toBe(1);
    expect(listeners()).toBe(0);
    // A child that never ran does not become one that started, however late
    // the event arrives.
    children[0]?.emit("spawn");
    expect(order).toEqual([]);

    // Cancellation, while the child is live and may not yet have been reported.
    children.length = 0;
    order.length = 0;
    const hanging = yield* useFake(dir, "hangs", { hang: true });
    yield* scoped(function* () {
      yield* installForegroundLauncher({ isTerminal: () => true, observe: watch });
      yield* reserveTerminal();
      const running = yield* spawn(function* () {
        yield* NativeLauncher.operations.launch({ command: [hanging.command], cwd: dir }, () =>
          order.push("started"),
        );
      });
      // Coordinated by the child existing, never by a duration.
      while (children.length === 0) {
        yield* sleep(15);
      }
      yield* running.halt();
    });
    expect(children.length).toBe(1);
    expect(listeners()).toBe(0);
    // Whatever this launch reported before it was cancelled, it reports no more.
    const reported = [...order];
    children[0]?.emit("spawn");
    expect(order).toEqual(reported);
  });
});

describe("native launcher — the reaper's own listener", () => {
  /**
   * The reaper waits on the child's `exit` from inside a bounded Promise, so
   * its handler is not covered by an Effection scope: `done()` is the only
   * funnel out — the event itself, the reachability poll, the escalation
   * deadline, and the refusal that rejects — and it is where the handler comes
   * off. The count is read after the reap has settled and before the event is
   * replayed, because a handler that removed itself on `exit` would leave the
   * same count behind as one that was released.
   */
  it("NLR1: releases the exit handler when the reap settles, and a later exit changes nothing", function* () {
    const dir = yield* useTempDir();
    // Deliberately deaf to the interrupt, so the reap is still in flight while
    // its handler is counted, and settles through the escalation rather than
    // through the event — which is the path a self-removing listener would not
    // have been released by.
    const fake = yield* useFake(dir, "stubborn", { ignoreInterrupt: true, hang: true });
    const child = spawnChild(fake.command, [], { stdio: "ignore" });
    const before = child.listenerCount("exit");

    // Not spawned: a Promise executor runs synchronously, so the handler is
    // attached by the time `reap` has returned, and the count below is read
    // with the reap unambiguously in flight rather than a turn after it.
    const reaping = reap(child);

    // At least one more, not exactly one: a runtime may hold handlers of its
    // own on this source, so the release below is measured against what was
    // live rather than against the baseline.
    const live = child.listenerCount("exit");
    expect(live).toBeGreaterThanOrEqual(before + 1);

    yield* until(reaping);

    expect(child.listenerCount("exit")).toBe(live - 1);

    child.emit("exit", 0, null);

    expect(child.listenerCount("exit")).toBe(live - 1);
  });

  /** A child already gone is answered without observing anything at all. */
  it("NLR2: installs nothing for a child that has already exited", function* () {
    const dir = yield* useTempDir();
    const fake = yield* useFake(dir, "brief", { exitCode: 0 });
    const child = spawnChild(fake.command, [], { stdio: "ignore" });
    const before = child.listenerCount("exit");

    yield* until(reap(child));
    yield* until(reap(child));

    expect(child.listenerCount("exit")).toBe(before);
  });
});

/** How many times the fake has beaten, or zero before its first beat. */
function* beats(file: string): Operation<number> {
  try {
    return (yield* readTextFile(file)).length;
  } catch {
    return 0;
  }
}
