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
import {
  flushOutput,
  installForegroundLauncher,
  nativeLaunch,
  NativeLauncher,
  NO_TERMINAL,
  reserveTerminal,
} from "../launcher.ts";

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
});

/** How many times the fake has beaten, or zero before its first beat. */
function* beats(file: string): Operation<number> {
  try {
    return (yield* readTextFile(file)).length;
  } catch {
    return 0;
  }
}
