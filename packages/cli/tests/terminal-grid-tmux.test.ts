/**
 * Tier TX — the tmux terminal-grid provider
 * (architecture.md §Interactive terminal grids, issue #732).
 *
 * The provider is the one production presentation for a grid, and these rows
 * hold it to the two things a document can observe about it: that the panes end
 * up where the author put them, and that nothing tmux-shaped leaks out of the
 * closure. Core lifecycle semantics are the controlled provider's to prove —
 * this tier does not restate them.
 *
 * Geometry first. `select-layout tiled` picks its own column count from the
 * window's dimensions, so the same four panes would be 2×2 in one terminal and
 * 4×1 in another; an authored `columns` has to be told to tmux rather than
 * asked of it. These rows check the string that tells it, at sizes a reader
 * would actually have.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  all,
  ensure,
  Ok,
  race,
  resource,
  scoped,
  sleep,
  spawn,
  suspend,
  until,
  withResolvers,
} from "effection";
import type { Operation } from "effection";
import { spawn as spawnChild } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import net from "node:net";
import type { Server, Socket } from "node:net";
import * as path from "node:path";
import process from "node:process";
import { cliCommand } from "@executablemd/test-support/launch";
import { ensureDir, exists, readTextFile, rm, stat, writeTextFile } from "@effectionx/fs";
import { realpath } from "node:fs/promises";
import { installControlledLauncher, nativeLaunch, reserveTerminal } from "@executablemd/runtime";
import type { TerminalComposite } from "@executablemd/runtime";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  installDenoTerminalProcesses,
  processReachable,
  TerminalProcesses,
} from "@executablemd/runtime";
import type { SignalDelivery } from "@executablemd/runtime";
import { useTmuxGrid } from "../src/terminal/tmux-grid.ts";
import type { ControlEvent, TmuxGrid } from "../src/terminal/tmux-grid.ts";
import { createFakeTmux } from "./fixtures/fake-tmux.ts";
import type { FakeTmux } from "./fixtures/fake-tmux.ts";
import {
  layoutString,
  placementProblems,
  rowMajorCells,
  swapsInto,
} from "../src/terminal/layout.ts";
import type { LayoutCell } from "../src/terminal/layout.ts";
import { usePaneChannels } from "../src/terminal/pane-channel.ts";
import { createGridTeardown, runInPane, tmuxGridProvider } from "../src/terminal/provider.ts";
import {
  foregroundTerminalGrid,
  underHangup,
  unsupportedTerminalGrid,
} from "../src/terminal/host.ts";
import {
  execute,
  installTerminalProvider,
  registerTerminalProvider,
  useTerminalInstallation,
} from "@executablemd/core";
import type { Json } from "@executablemd/core";
import type { Result } from "effection";
import { processTable, TerminalGrids } from "@executablemd/runtime";
import { chmod, readdir } from "node:fs/promises";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { PaneChannels, PaneLink } from "../src/terminal/pane-channel.ts";
import {
  FromWorkerSchema,
  paneSocketPath,
  paneTokenPath,
  readFrames,
  ToWorkerSchema,
  writeFrame,
} from "../src/terminal/pane-protocol.ts";
import {
  foregroundSignalListeners,
  PANE_WORKER_COMMAND,
  paneWorkerInvocation,
  runPaneWorker,
  useForegroundSignals,
} from "../src/terminal/pane-worker.ts";
import { usePaneChild } from "../src/terminal/pane-child.ts";
import type { PaneChild, PaneChildOutcome } from "../src/terminal/pane-child.ts";
import type { FromWorker, Settlement, ToWorker } from "../src/terminal/pane-protocol.ts";

/** The cells a layout string describes, read back out of it. */
function readCells(layout: string): LayoutCell[] {
  const cells: LayoutCell[] = [];
  // `WxH,left,top,paneId` — the leaves, in the order the string lists them,
  // which is the order tmux fills them in.
  const leaf = /(\d+)x(\d+),(\d+),(\d+),(\d+)(?![\dx])/g;
  let match = leaf.exec(layout);
  let ordinal = 0;
  while (match !== null) {
    const [, width, height, left, top] = match;
    cells.push({
      ordinal: ordinal++,
      left: Number(left),
      top: Number(top),
      width: Number(width),
      height: Number(height),
    });
    match = leaf.exec(layout);
  }
  return cells;
}

/** Where a fake server and its client fixtures meet. */
function useScript(): Operation<string> {
  return resource<string>(function* (provide) {
    const file = path.join(tmpdir(), `xmd-tmux-script-${randomUUID()}.txt`);
    yield* writeTextFile(file, "");
    yield* ensure(function* () {
      yield* rm(file, { force: true });
    });
    yield* provide(file);
  });
}

/** The fixture that stands in for one tmux client. */
function clientCommand(mode: "control" | "attach", script: string): readonly string[] {
  const fixture = path.resolve("packages/cli/tests/fixtures/tmux-client.ts");
  const invocation = cliCommand([]);
  // The same runtime the CLI runs under, pointed at the fixture instead.
  return [invocation.command, "run", "--allow-all", fixture, mode, script];
}

/** Every listener this process holds, across the names this code installs. */
function processListeners(): number {
  return (["SIGINT", "SIGQUIT", "SIGTSTP", "SIGHUP"] as NodeJS.Signals[]).reduce(
    (total, name) => total + foregroundSignalListeners(name),
    0,
  );
}

/**
 * Open a grid through the provider, with the host's prerequisites answered by
 * this row rather than by the machine.
 *
 * Goes through the real factory and the real installation handshake, so what a
 * refusal proves is what a document would meet.
 */
function useProbedProvider(options: {
  isTerminal: () => boolean;
  version?: string;
}): Operation<void> {
  return (function* (): Operation<void> {
    const authority = yield* useTerminalInstallation();
    yield* registerTerminalProvider(
      "tmux",
      tmuxGridProvider({
        isTerminal: options.isTerminal,
        env: { PATH: "/usr/bin:/bin" },
        // deno-lint-ignore require-yield
        *workerCommand() {
          return [];
        },
        size: () => ({ columns: 80, rows: 24 }),
        ...(options.version === undefined
          ? {}
          : {
              // deno-lint-ignore require-yield
              *askVersion() {
                return { code: 0, stdout: options.version ?? "" };
              },
            }),
      }),
    );
    yield* installTerminalProvider("tmux", { label: "tmux" }, authority);
    yield* TerminalGrids.operations.open({
      columns: 1,
      rows: 1,
      panes: [{ ordinal: 0, title: "Only", row: 0, column: 0, form: "paired" }],
    });
  })();
}

/** A directory a row can leave markers in. */
function useScratch(): Operation<string> {
  return resource<string>(function* (provide) {
    const room = path.join(tmpdir(), `xmd-tg20-${randomUUID()}`);
    yield* ensureDir(room);
    yield* ensure(function* () {
      yield* rm(room, { recursive: true, force: true });
    });
    yield* provide(room);
  });
}

/** Everything gone, for rows whose subject is not the observation. */
function useDeadObserver(): Operation<void> {
  return TerminalProcesses.around(
    {
      // deno-lint-ignore require-yield
      *table() {
        return [];
      },
      // deno-lint-ignore require-yield
      *holders() {
        return [];
      },
      // deno-lint-ignore require-yield
      *deliver(): Operation<SignalDelivery> {
        return "absent";
      },
      // deno-lint-ignore require-yield
      *reachable() {
        return false;
      },
    },
    { at: "min" },
  );
}

/** A composite whose pane endpoint is the production one, over these links. */
function paneComposite(links: readonly PaneLink[]): TerminalComposite {
  const refuse = (): never => {
    throw new Error("this row drives the pane endpoint only");
  };
  return {
    attach: refuse,
    update: refuse,
    display: refuse,
    shell: refuse,
    closed: refuse,
    destroy: refuse,
    launch: (ordinal, request, spawned) => runInPane(links[ordinal], request, spawned),
  };
}

describe("Tier TX — the tmux grid's geometry", () => {
  it("TX1: an authored column count survives every terminal size", function* () {
    // Four panes in two columns is 2×2 whatever the terminal is. `tiled` would
    // have made the wide one 4×1 and the tall one 1×4.
    const sizes: [number, number][] = [
      [80, 24],
      [200, 24],
      [80, 60],
      [211, 51],
    ];
    for (const [width, height] of sizes) {
      const cells = rowMajorCells(width, height, 2, 4);
      const rows = new Set(cells.map((cell) => cell.top));
      const columns = new Set(cells.map((cell) => cell.left));
      const size = `${width}x${height}`;
      expect(`${size}: ${rows.size} rows`).toBe(`${size}: 2 rows`);
      expect(`${size}: ${columns.size} columns`).toBe(`${size}: 2 columns`);
      expect(`${size}: ${placementProblems(cells, 2).join("; ")}`).toBe(`${size}: `);
    }
  });

  it("TX2: the cells tile the terminal exactly, with one separator between", function* () {
    const cells = rowMajorCells(80, 24, 2, 4);
    // Two panes and one separator span the width; two rows and one separator
    // span the height. A gap or an overlap would be a grid the reader can see
    // is wrong.
    const top = cells.filter((cell) => cell.top === 0);
    expect(top.reduce((total, cell) => total + cell.width, 0) + (top.length - 1)).toBe(80);
    const left = cells.filter((cell) => cell.left === 0);
    expect(left.reduce((total, cell) => total + cell.height, 0) + (left.length - 1)).toBe(24);
  });

  it("TX3: a short final row spans it, because tmux has no empty cells", function* () {
    // Three panes in two columns: two above, one below across the whole width.
    const cells = rowMajorCells(80, 24, 2, 3);
    expect(cells.length).toBe(3);
    const last = cells[2];
    expect(last?.left).toBe(0);
    expect(last?.width).toBe(80);
    expect(placementProblems(cells, 2)).toEqual([]);
  });

  it("TX4: one pane and one row need no tree at all", function* () {
    expect(rowMajorCells(80, 24, 1, 1)).toEqual([
      { ordinal: 0, left: 0, top: 0, width: 80, height: 24 },
    ]);
    // A single row is written flat: nesting one row inside a column tree is a
    // layout tmux accepts and a reader would never see the point of.
    const single = layoutString(80, 24, 2, [1, 2]);
    expect(single).not.toContain("[");
    expect(single).toContain("{");
  });

  it("TX5: the string is one tmux accepts — checksum, then the tree", function* () {
    const layout = layoutString(80, 24, 2, [1, 2, 3, 4]);
    const [sum, ...rest] = layout.split(",");
    expect(sum).toMatch(/^[0-9a-f]{4}$/);
    // Rows top to bottom, columns left to right, and every authored pane named.
    const body = rest.join(",");
    expect(body.startsWith("80x24,0,0[")).toBe(true);
    for (const pane of [1, 2, 3, 4]) {
      expect(body).toContain(`,${pane}`);
    }
    // And the geometry it describes is the geometry that was asked for.
    expect(placementProblems(readCells(layout), 2)).toEqual([]);
  });

  it("TX6: the checksum changes with the tree, so a stale string is rejected", function* () {
    const four = layoutString(80, 24, 2, [1, 2, 3, 4]);
    const swapped = layoutString(80, 24, 2, [1, 2, 4, 3]);
    expect(four.split(",")[0]).not.toBe(swapped.split(",")[0]);
  });

  it("TX7: authored order is imposed by swaps, because tmux ignores leaf ids", function* () {
    // tmux fills the leaves in window-list order, so a window holding panes in
    // the wrong order needs them moved rather than re-described.
    const swaps = swapsInto([3, 1, 4, 2], [1, 2, 3, 4]);
    const order = [3, 1, 4, 2];
    for (const swap of swaps) {
      const from = order[swap.from];
      const to = order[swap.to];
      if (from === undefined || to === undefined) {
        continue;
      }
      order[swap.to] = from;
      order[swap.from] = to;
    }
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("TX8: an order that is already authored is left alone", function* () {
    expect(swapsInto([1, 2, 3, 4], [1, 2, 3, 4])).toEqual([]);
  });

  it("TX9: a window missing an authored pane refuses rather than placing another", function* () {
    let message = "";
    try {
      swapsInto([1, 2, 9], [1, 2, 3]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("pane 3 is not in this window");
  });
});

/**
 * Start one real pane worker, as a real process, over the real socket.
 *
 * No tmux: a worker is an ordinary program that connects to a socket and does
 * what it is told, and every claim in this tier is about that program. tmux's
 * part — putting it in a pane with a terminal — is the next tier's.
 */
function useWorker(directory: string, ordinal: number): Operation<ChildProcess> {
  return resource<ChildProcess>(function* (provide) {
    const invocation = cliCommand([PANE_WORKER_COMMAND, String(ordinal), directory]);
    const child = spawnChild(invocation.command, invocation.arguments, {
      stdio: ["ignore", "pipe", "pipe"],
      // A pane's worker is tmux's session leader, so it is its own process
      // group. Modelled here, because a settlement sweeps the group it is in
      // and a worker sharing the test runner's group would be sweeping the
      // test runner.
      detached: true,
    });
    yield* ensure(function* () {
      child.kill("SIGKILL");
      yield* until(
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once("exit", () => resolve());
        }),
      );
    });
    yield* provide(child);
  });
}

/** Everything one pane's worker said, until it says the one being waited for. */
function untilFrame(link: PaneLink, type: FromWorker["type"]): Operation<FromWorker> {
  return (function* (): Operation<FromWorker> {
    while (true) {
      const frame = yield* link.next();
      if (frame === undefined) {
        throw new Error(`the worker closed before saying "${type}"`);
      }
      if (frame.type === type) {
        return frame;
      }
    }
  })();
}

/** A raw connection to a pane's socket, for the rows about admission. */
function useImpostor(directory: string, ordinal: number): Operation<net.Socket> {
  return resource<net.Socket>(function* (provide) {
    const socket = net.createConnection(paneSocketPath(directory, ordinal));
    const connected = withResolvers<void>();
    socket.once("connect", () => connected.resolve());
    socket.once("error", (error: Error) => connected.reject(error));
    yield* connected.operation;
    yield* ensure(() => {
      socket.destroy();
    });
    yield* provide(socket);
  });
}

/** Settle when a socket closes, or say it did not within the grace given. */
function closedWithin(socket: net.Socket, limitMs: number): Operation<boolean> {
  return (function* (): Operation<boolean> {
    const closed = withResolvers<boolean>();
    if (socket.destroyed) {
      return true;
    }
    socket.once("close", () => closed.resolve(true));
    return yield* race([
      closed.operation,
      (function* (): Operation<boolean> {
        yield* sleep(limitMs);
        return false;
      })(),
    ]);
  })();
}

describe("Tier TW — the pane worker and its private channel", () => {
  it("TW1: the private directory is 0700 and its tokens 0600", function* () {
    const channels: PaneChannels = yield* usePaneChannels(2);
    const directory = yield* stat(channels.directory);
    expect(directory.mode & 0o777).toBe(0o700);
    for (const ordinal of [0, 1]) {
      const token = yield* stat(paneTokenPath(channels.directory, ordinal));
      expect(`pane ${ordinal}: ${(token.mode & 0o777).toString(8)}`).toBe(`pane ${ordinal}: 600`);
      // The socket exists before any pane does, so a worker that starts finds
      // it listening rather than racing it.
      expect(yield* exists(paneSocketPath(channels.directory, ordinal))).toBe(true);
    }
  });

  it("TW2: the directory and everything in it goes with the grid", function* () {
    let directory = "";
    yield* scoped(function* () {
      const channels = yield* usePaneChannels(1);
      directory = channels.directory;
    });
    expect(yield* exists(directory)).toBe(false);
  });

  it("TW3: a real worker connects, proves which pane it is, and spends its token", function* () {
    const channels = yield* usePaneChannels(1);
    yield* useWorker(channels.directory, 0);
    const link = yield* channels.link(0);

    expect(link.hello.ordinal).toBe(0);
    expect(link.hello.pid).toBeGreaterThan(0);
    // Spent as it was read: a second worker for this pane finds no token, so
    // it has nothing to present.
    expect(yield* exists(paneTokenPath(channels.directory, 0))).toBe(false);
    expect(channels.refusals()).toEqual([]);
  });

  it("TW4: a connection that says nothing the protocol knows is closed", function* () {
    const channels = yield* usePaneChannels(1);
    const socket = yield* useImpostor(channels.directory, 0);
    socket.write("this is not a frame\n");

    expect(yield* closedWithin(socket, 2_000)).toBe(true);
    expect(channels.refusals().length).toBe(1);
  });

  it("TW5: a hello with the wrong token proves nothing and is closed", function* () {
    const channels = yield* usePaneChannels(1);
    const socket = yield* useImpostor(channels.directory, 0);
    yield* writeFrame(socket, {
      type: "hello",
      ordinal: 0,
      token: "0".repeat(32),
      pid: 1,
      pgid: 1,
      tty: "??",
      isatty: [false, false, false],
    });

    expect(yield* closedWithin(socket, 2_000)).toBe(true);
    expect(channels.refusals()[0]).toContain("could not prove it is this pane");
  });

  it("TW6: a second connection to an admitted pane is closed", function* () {
    const channels = yield* usePaneChannels(1);
    yield* useWorker(channels.directory, 0);
    yield* channels.link(0);

    // The real worker holds this pane. A second caller with the same socket
    // path — token or not — is not this pane's worker.
    const socket = yield* useImpostor(channels.directory, 0);
    yield* writeFrame(socket, {
      type: "hello",
      ordinal: 0,
      token: "0".repeat(32),
      pid: 1,
      pgid: 1,
      tty: "??",
      isatty: [false, false, false],
    });

    expect(yield* closedWithin(socket, 2_000)).toBe(true);
    expect(
      channels
        .refusals()
        .some((line) => line.includes("already admitted") || line.includes("second connection")),
    ).toBe(true);
  });

  it("TW7: a launch crosses exactly, and readiness is the runtime spawn event", function* () {
    const channels = yield* usePaneChannels(1);
    yield* useWorker(channels.directory, 0);
    const link = yield* channels.link(0);

    // Arguments a command parser would ruin: spaces, a semicolon, a quote and
    // a dollar sign. They cross the socket as bytes and reach the child as
    // the exact vector.
    const awkward = ["a b", "semi;colon", `quote"and'both`, "$HOME"];
    yield* link.send({
      type: "launch",
      id: "one",
      argv: ["/bin/echo", ...awkward],
      cwd: path.resolve("."),
      env: { PATH: "/usr/bin:/bin" },
    });

    const started = yield* untilFrame(link, "started");
    expect(started.type === "started" ? started.pid : 0).toBeGreaterThan(0);
    const exited = yield* untilFrame(link, "exited");
    if (exited.type !== "exited") {
      throw new Error("expected an exit");
    }
    expect(exited.exitCode).toBe(0);
    // Settlement follows the exit, and the pane is free only after it.
    expect(exited.settlement.quiet).toBe(true);
  });

  it("TW8: a child that never starts reports a failure and never readiness", function* () {
    const channels = yield* usePaneChannels(1);
    yield* useWorker(channels.directory, 0);
    const link = yield* channels.link(0);

    yield* link.send({
      type: "launch",
      id: "missing",
      argv: [path.join(channels.directory, "not-a-program")],
      cwd: path.resolve("."),
      env: {},
    });

    // `error` arrives instead of `spawn`, never after it — so the pane's
    // readiness latch is never tripped and the grid does not attach.
    const failure = yield* untilFrame(link, "start-failed");
    expect(failure.type === "start-failed" ? failure.reason : "").toContain("could not be started");
  });

  it("TW9: one pane admits one live child, and the next only after it settles", function* () {
    const channels = yield* usePaneChannels(1);
    yield* useWorker(channels.directory, 0);
    const link = yield* channels.link(0);

    const sleeper: ToWorker = {
      type: "launch",
      id: "first",
      argv: ["/bin/sleep", "30"],
      cwd: path.resolve("."),
      env: {},
    };
    yield* link.send(sleeper);
    yield* untilFrame(link, "started");

    // Asked for while the first is live.
    yield* link.send({ ...sleeper, id: "second" });
    const refused = yield* untilFrame(link, "busy");
    expect(refused.type === "busy" ? refused.id : "").toBe("second");

    // Cancelled, settled, and only then is the pane free again.
    yield* link.send({ type: "cancel", id: "first" });
    const quiet = yield* untilFrame(link, "quiet");
    expect(quiet.type === "quiet" ? quiet.settlement.quiet : false).toBe(true);

    yield* link.send({ ...sleeper, id: "third" });
    const third = yield* untilFrame(link, "started");
    expect(third.type === "started" ? third.id : "").toBe("third");
  });

  it("TW10: display is written to the pane and never read back from it", function* () {
    const channels = yield* usePaneChannels(1);
    const worker = yield* useWorker(channels.directory, 0);
    const link = yield* channels.link(0);

    const shown: string[] = [];
    worker.stdout?.setEncoding("utf8");
    worker.stdout?.on("data", (chunk: string) => shown.push(chunk));

    yield* link.send({ type: "display", seq: 1, text: "pane says hello\n" });
    const displayed = yield* untilFrame(link, "displayed");
    expect(displayed.type === "displayed" ? displayed.seq : 0).toBe(1);
    expect(shown.join("")).toContain("pane says hello");
  });

  it("TW11: shutdown settles, sweeps the terminal, and says goodbye", function* () {
    const channels = yield* usePaneChannels(1);
    yield* useWorker(channels.directory, 0);
    const link = yield* channels.link(0);

    yield* link.send({
      type: "launch",
      id: "one",
      argv: ["/bin/sleep", "30"],
      cwd: path.resolve("."),
      env: {},
    });
    yield* untilFrame(link, "started");

    yield* link.send({ type: "shutdown" });
    const quiet = yield* untilFrame(link, "quiet");
    expect(quiet.type === "quiet" ? quiet.settlement.quiet : false).toBe(true);
    // The pane's last sweep, by the only process that can still make it.
    const bye = yield* untilFrame(link, "bye");
    expect(bye.type).toBe("bye");
  });

  it("TW13: after a settlement that proved nothing, the pane stays unavailable", function* () {
    // The worker itself, run in this process against a real channel, with the
    // one thing a suite cannot arrange in another process substituted: a child
    // whose settlement cannot say the pane is free. A real SIGKILL always
    // works, and a sweep of a pane with no terminal always comes back empty.
    const channels = yield* usePaneChannels(1);
    const stopping = withResolvers<PaneChildOutcome>();
    const started: string[] = [];
    let refusal = "";

    const held: PaneChild = {
      started: (function* () {
        return Ok(4242);
      })(),
      exited: stopping.operation,
      // Everything the worker can do has been done, and something still holds
      // the pane's terminal.
      *settle(): Operation<Settlement> {
        return {
          method: "killed",
          quiet: false,
          child: 4242,
          swept: [],
          holders: [{ pid: 900, gone: false }],
        };
      },
    };

    yield* spawn(function* () {
      try {
        yield* runPaneWorker(0, channels.directory, {
          observe: false,
          // deno-lint-ignore require-yield
          *useChild(request) {
            started.push(request.argv.join(" "));
            return held;
          },
        });
      } catch (error) {
        // Read as a value: the refusal *is* the behaviour under test, so it
        // must not end the row that is testing for it.
        refusal = error instanceof Error ? error.message : String(error);
      }
    });
    yield* useDeadObserver();
    const link = yield* channels.link(0);

    yield* link.send({
      type: "launch",
      id: "first",
      argv: ["/bin/sleep", "30"],
      cwd: path.resolve("."),
      env: {},
    });
    yield* untilFrame(link, "started");

    // Cancelled, and the settlement cannot prove the pane free. Nothing
    // downstream may follow: no success frame, no cleared pane, no next child.
    yield* link.send({ type: "cancel", id: "first" });
    yield* link.send({
      type: "launch",
      id: "second",
      argv: ["/bin/sleep", "30"],
      cwd: path.resolve("."),
      env: {},
    });

    const said: string[] = [];
    while (true) {
      const frame = yield* link.next();
      if (frame === undefined) {
        break;
      }
      said.push(frame.type);
    }

    expect(refusal).toContain("could not be proved free");
    expect(said).not.toContain("quiet");
    expect(said).not.toContain("exited");
    // One child was ever started: the pane was never cleared, so the second
    // launch had nothing to start in.
    expect(started).toEqual(["/bin/sleep 30"]);
  });

  it("TW14: every emitter this code touches is left as it was found", function* () {
    // Counted on the emitters themselves — the child process, the socket, the
    // server, this process for signals — and after each scope has ended, which
    // is when the removal is supposed to have happened. Every `.off()` in the
    // touched code is load-bearing here: take one away and one of these counts
    // goes up.
    yield* installDenoTerminalProcesses();

    const signalsBefore = processListeners();
    yield* scoped(function* () {
      yield* useForegroundSignals();
      expect(processListeners()).toBeGreaterThan(signalsBefore);
    });
    expect(processListeners()).toBe(signalsBefore);

    const children: ChildProcess[] = [];
    const childListeners = (): number =>
      children.reduce(
        (total, one) =>
          total +
          (["spawn", "error", "exit"] as const).reduce(
            (count, name) => count + one.listenerCount(name),
            0,
          ),
        0,
      );

    // Delivery: a child that starts and exits.
    yield* scoped(function* () {
      const child = yield* usePaneChild(
        { argv: ["/bin/echo", "listener"], cwd: path.resolve("."), env: { PATH: "/usr/bin:/bin" } },
        undefined,
        (started) => children.push(started),
      );
      yield* child.started;
      yield* child.exited;
      // Startup is settled, so its pair is already gone; `exit` is still this
      // scope's, because a settlement may yet wait on it.
      expect(childListeners()).toBeGreaterThan(0);
    });
    expect(childListeners()).toBe(0);

    // No delivery, and startup failure: `error` arrives instead of `spawn`.
    children.length = 0;
    yield* scoped(function* () {
      const child = yield* usePaneChild(
        { argv: [path.join(tmpdir(), "not-a-program")], cwd: path.resolve("."), env: {} },
        undefined,
        (started) => children.push(started),
      );
      yield* child.started;
    });
    expect(childListeners()).toBe(0);

    // Cancellation, while the child is live and its settlement still open.
    children.length = 0;
    const room = yield* useScratch();
    yield* scoped(function* () {
      const running = yield* spawn(function* () {
        yield* scoped(function* () {
          const child = yield* usePaneChild(
            {
              argv: ["/bin/sh", "-c", `printf '' > "${room}/on"; while true; do sleep 0.05; done`],
              cwd: path.resolve("."),
              env: { PATH: "/usr/bin:/bin" },
            },
            undefined,
            (started) => children.push(started),
          );
          yield* child.started;
          yield* child.exited;
        });
      });
      // Coordinated by the child's own start, never by a duration.
      while (!(yield* exists(`${room}/on`))) {
        yield* sleep(15);
      }
      yield* running.halt();
    });
    expect(childListeners()).toBe(0);

    // And the channel's own emitters: the accepted socket and both servers.
    const sockets: Socket[] = [];
    const servers: Server[] = [];
    yield* scoped(function* () {
      const channels = yield* usePaneChannels(1, {
        onSocket: (socket) => sockets.push(socket),
        onServer: (server) => servers.push(server),
      });
      yield* useWorker(channels.directory, 0);
      yield* channels.link(0);
      expect(servers.length).toBe(1);
      expect(sockets.length).toBe(1);
    });
    const channelListeners = [
      ...sockets.map((socket) =>
        (["data", "close", "error"] as const).reduce(
          (count, name) => count + socket.listenerCount(name),
          0,
        ),
      ),
      ...servers.map((server) =>
        (["connection", "listening", "error"] as const).reduce(
          (count, name) => count + server.listenerCount(name),
          0,
        ),
      ),
    ];
    expect(channelListeners).toEqual([0, 0]);
  });

  it("TW12: naming the worker invocation is the only way to be one", function* () {
    // In no command table, so in no help output and no catalog. What makes it
    // safe is not obscurity: a worker that cannot present a pane's single-use
    // token is answered by nobody.
    expect(paneWorkerInvocation([PANE_WORKER_COMMAND, "0", "/tmp/x"])).toEqual({
      ordinal: 0,
      directory: "/tmp/x",
    });
    for (const shape of [
      [PANE_WORKER_COMMAND],
      [PANE_WORKER_COMMAND, "0"],
      [PANE_WORKER_COMMAND, "zero", "/tmp/x"],
      [PANE_WORKER_COMMAND, "0", "/tmp/x", "extra"],
      ["run", "0", "/tmp/x"],
    ]) {
      expect(`${shape.join(" ")}: ${paneWorkerInvocation(shape)}`).toBe(
        `${shape.join(" ")}: undefined`,
      );
    }
  });
});

/**
 * Tier TG — the hidden composite's lifecycle
 * (architecture.md §Atomic presentation and settlement).
 *
 * Against a fake server, deliberately. What is faked is tmux's *behaviour* —
 * including the one this code exists to work around, that a layout string's
 * leaves are filled in window-list order and the pane ids in them are ignored.
 * What is not faked is the composite: the same layout string, the same swap
 * decisions, the same control-mode line splitting and the same classifier run
 * here as on a real server.
 *
 * One thing this tier deliberately does not claim. A client fixture inherits a
 * pipe, so it cannot restore a terminal it never had; that a real `tmux attach`
 * gives the reader's terminal back when asked to detach is #726's evidence, on
 * real tmux, and nothing here stands in for it.
 */
/** Planted where a diagnostic could pick one up, and nowhere a reader looks. */
const SESSION_MARKER = "sessionmarker7f3a";
const DIR_MARKER = "/tmp/dirmarker7f3a";
const CLIENT_MARKER = "clientmarker7f3a";
const TITLE_MARKER = "titlemarker7f3a";
const ENV_MARKER = "envmarker7f3a";
const STDERR_MARKER = "stderrmarker7f3a";

describe("Tier TG — the tmux composite", () => {
  /** A host whose processes are all gone, so teardown proves itself. */
  function useDeadServer(): Operation<void> {
    return TerminalProcesses.around(
      {
        // deno-lint-ignore require-yield
        *table() {
          return [];
        },
        // deno-lint-ignore require-yield
        *holders() {
          return [];
        },
        // deno-lint-ignore require-yield
        *deliver(): Operation<SignalDelivery> {
          return "absent";
        },
        // deno-lint-ignore require-yield
        *reachable() {
          return false;
        },
      },
      { at: "min" },
    );
  }

  /** A composite over a fake server, with the pane workers stubbed out. */
  function useComposite(options: {
    panes: number;
    columns: number;
    titles?: string[];
    failOnce?: { command: string; message: string };
  }): Operation<{ grid: TmuxGrid; tmux: FakeTmux; script: string }> {
    return (function* () {
      const script = yield* useScript();
      const tmux = createFakeTmux({
        script,
        clientCommand,
        ...(options.failOnce === undefined ? {} : { failOnce: options.failOnce }),
      });
      // The server's liveness is the fake's to decide, and the composite asks
      // the runtime seam about it — so "the server did not go away" is a fact a
      // row can state without a process refusing to die.
      yield* TerminalProcesses.around(
        {
          // deno-lint-ignore require-yield
          *table() {
            return [];
          },
          // deno-lint-ignore require-yield
          *holders() {
            return [];
          },
          // deno-lint-ignore require-yield
          *deliver(): Operation<SignalDelivery> {
            return "absent";
          },
          // deno-lint-ignore require-yield
          *reachable([pid]) {
            return pid === tmux.serverPid && tmux.alive();
          },
        },
        { at: "min" },
      );
      const grid = yield* useTmuxGrid(tmux, {
        session: "grid",
        columns: options.columns,
        panes: options.panes,
        width: 160,
        height: 48,
        titles:
          options.titles ?? Array.from({ length: options.panes }, (_, index) => `pane ${index}`),
        workerCommand: (ordinal) => ["xmd", "terminal-worker", String(ordinal), "/private/dir"],
        cwd: path.resolve("."),
        env: { PATH: "/usr/bin:/bin" },
      });
      return { grid, tmux, script };
    })();
  }

  it("TG1: the server is private, unconfigured, and started hidden", function* () {
    const { tmux } = yield* useComposite({ panes: 2, columns: 2 });

    // Detached, so nothing is shown; sized explicitly, so the layout is
    // computed against a window rather than a guess.
    const created = tmux.issued.find((line) => line.startsWith("new-session"));
    expect(created).toContain("-d");
    expect(created).toContain("-x 160");
    expect(created).toContain("-y 48");
    // Every pane runs a worker, and tmux's parser sees only an ordinal and a
    // directory — never a launch's argv.
    expect(tmux.panes.length).toBe(2);
    for (const [ordinal, pane] of tmux.panes.entries()) {
      expect(pane.command.join(" ")).toBe(`xmd terminal-worker ${ordinal} /private/dir`);
    }
  });

  it("TG2: the authored order survives a server that ignores the layout's ids", function* () {
    const { grid, tmux } = yield* useComposite({
      panes: 4,
      columns: 2,
      titles: ["Planner", "Implementor", "Reviewer", "Shell"],
    });

    // The fake fills the leaves in window-list order and ignores the ids, which
    // is what tmux does. Without the swaps this would be the wrong order.
    expect(tmux.issued.some((line) => line.startsWith("swap-pane"))).toBe(true);
    const placed = [...grid.panes].sort(
      (left, right) => left.cell.top - right.cell.top || left.cell.left - right.cell.left,
    );
    expect(placed.map((pane) => pane.ordinal)).toEqual([0, 1, 2, 3]);
    expect(
      placementProblems(
        placed.map((pane) => pane.cell),
        2,
      ),
    ).toEqual([]);
    // And each pane carries the title the author wrote for that ordinal. Read
    // by pane id, because the server's window list is not the authored order —
    // which is the whole reason the swaps above exist.
    const titles = grid.panes.map(
      (pane) => tmux.panes.find((entry) => entry.id === pane.id)?.title,
    );
    expect(titles).toEqual(["Planner", "Implementor", "Reviewer", "Shell"]);
    // The window list really is a different order, so this row is not passing
    // because the two happened to coincide.
    expect(tmux.panes.map((pane) => pane.id)).not.toEqual(grid.panes.map((pane) => pane.id));
  });

  it("TG3: nothing is attached while the composite is being built", function* () {
    const { tmux } = yield* useComposite({ panes: 2, columns: 2 });

    // The control client is not the reader's: it attaches with `-f no-output`,
    // so pane bytes never reach this process. The visible one has not been
    // asked for.
    expect(tmux.issued.some((line) => line.startsWith("attach-session"))).toBe(false);
    expect(tmux.clients).toEqual([]);
  });

  it("TG4: attaching shows the grid, and the server lists the reader's client", function* () {
    const { grid, tmux } = yield* useComposite({ panes: 2, columns: 2 });

    const client = yield* grid.attach();
    expect(client.name).toBe("/dev/ttys999");
    expect(tmux.clients).toContain("/dev/ttys999");
  });

  it("TG5: a reader detach is asked for before anything is signalled", function* () {
    const { grid, tmux } = yield* useComposite({ panes: 2, columns: 2 });
    const client = yield* grid.attach();

    yield* grid.detach(client);

    // Asked to leave, and gone from the server's list. A client that was
    // signalled instead could not have restored the terminal — which is why
    // the ask comes first.
    const asked = tmux.issued.findIndex((line) => line.startsWith("detach-client"));
    expect(asked).toBeGreaterThan(-1);
    expect(tmux.clients).not.toContain("/dev/ttys999");
    expect(tmux.issued.slice(0, asked).some((line) => line.startsWith("kill-server"))).toBe(false);
  });

  it("TG6: reader detach, control loss and server stop are separate events", function* () {
    const { grid, tmux } = yield* useComposite({ panes: 1, columns: 1 });

    yield* tmux.say("%client-detached /dev/ttys999");
    yield* untilEvent(grid, "client-detached");
    yield* tmux.say("%sessions-changed");
    yield* untilEvent(grid, "sessions-changed");
    // `%exit` ends the control channel, and its EOF is its own event — an
    // attach client's exit code could not tell these three apart.
    yield* tmux.say("%exit");
    yield* untilEvent(grid, "closed");

    const kinds = grid.events.map((event) => event.kind);
    expect(kinds).toContain("client-detached");
    expect(kinds).toContain("sessions-changed");
    expect(kinds.indexOf("exit")).toBeLessThan(kinds.lastIndexOf("closed"));
  });

  it("TG7: stopping establishes the server is gone and refuses its session", function* () {
    const { grid, tmux } = yield* useComposite({ panes: 2, columns: 2 });

    const stopped = yield* grid.stop();
    expect(stopped.gone).toBe(true);
    expect(stopped.refuses).toBe(true);
    expect(tmux.alive()).toBe(false);
  });

  it("TG8: a server that will not go away is a teardown failure, not a report", function* () {
    const script = yield* useScript();
    const tmux = createFakeTmux({ script, clientCommand });
    // The server answers `kill-server` and stays anyway. That the command was
    // accepted is not evidence that it worked.
    yield* TerminalProcesses.around(
      {
        // deno-lint-ignore require-yield
        *table() {
          return [];
        },
        // deno-lint-ignore require-yield
        *holders() {
          return [];
        },
        // deno-lint-ignore require-yield
        *deliver(): Operation<SignalDelivery> {
          return "delivered";
        },
        // deno-lint-ignore require-yield
        *reachable() {
          return true;
        },
      },
      { at: "min" },
    );

    let refusal = "";
    try {
      yield* scoped(function* () {
        const grid = yield* useTmuxGrid(tmux, {
          session: SESSION_MARKER,
          columns: 1,
          panes: 1,
          width: 160,
          height: 48,
          titles: ["only"],
          workerCommand: (ordinal) => ["xmd", "terminal-worker", String(ordinal), DIR_MARKER],
          cwd: path.resolve("."),
          env: {},
        });
        yield* grid.stop();
      });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }

    // The document stops rather than continuing while a terminal may be held,
    // and it is told which fact could not be established — never the session or
    // socket that would name this invocation's private server.
    expect(refusal).toContain("could not be proved torn down");
    expect(refusal).toContain("did not stop");
    for (const marker of [SESSION_MARKER, DIR_MARKER, tmux.socket]) {
      expect(`${marker}: ${refusal.includes(marker)}`).toBe(`${marker}: false`);
    }
  });

  it("TG10: nothing private reaches a surfaced failure", function* () {
    // A marker in every place a tmux diagnostic could pick one up: the socket,
    // the session, the pane and client identifiers, the worker's private
    // directory, the arguments, and what the command wrote to stderr.
    const script = yield* useScript();
    const tmux = createFakeTmux({
      script,
      clientCommand,
      clientName: `/dev/${CLIENT_MARKER}`,
      failOnce: { command: "split-window", message: `stderr ${STDERR_MARKER}` },
    });
    yield* useDeadServer();

    let failure = "";
    try {
      yield* scoped(function* () {
        yield* useTmuxGrid(tmux, {
          session: SESSION_MARKER,
          columns: 2,
          panes: 2,
          width: 160,
          height: 48,
          titles: [TITLE_MARKER, TITLE_MARKER],
          workerCommand: (ordinal) => ["xmd", "terminal-worker", String(ordinal), DIR_MARKER],
          cwd: path.resolve("."),
          env: { PRIVATE: ENV_MARKER },
        });
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }

    // It says which step failed, because that is what a reader can act on.
    expect(failure).toContain("split-window");
    // And nothing else. A provider's private topology is private on the paths
    // taken when something goes wrong too — which are the paths a diagnostic
    // is actually read on.
    for (const marker of [
      SESSION_MARKER,
      DIR_MARKER,
      CLIENT_MARKER,
      TITLE_MARKER,
      ENV_MARKER,
      STDERR_MARKER,
      tmux.socket,
      ...tmux.panes.map((pane) => pane.id),
    ]) {
      expect(`${marker}: ${failure.includes(marker)}`).toBe(`${marker}: false`);
    }
  });

  it("TG11: ending the visible client signals that process and nothing else", function* () {
    const script = yield* useScript();
    // A client that is asked to leave and does not, so the escalation that
    // follows the ask is actually reached.
    const tmux = createFakeTmux({ script, clientCommand, stubbornClient: true });
    const signalled: string[] = [];
    let clientPid = -1;

    // A process table with company: XMD itself, its parent, and two more
    // processes sharing XMD's foreground group. A settlement of a pane's shape
    // pointed at this client would reach every one of them.
    yield* TerminalProcesses.around(
      {
        // deno-lint-ignore require-yield
        *table() {
          return [
            { pid: 900, ppid: 1, pgid: 900, tty: "ttys000", tpgid: 900, command: "shell" },
            { pid: 901, ppid: 900, pgid: 900, tty: "ttys000", tpgid: 900, command: "xmd" },
            { pid: 902, ppid: 901, pgid: 900, tty: "ttys000", tpgid: 900, command: "sibling" },
            { pid: 903, ppid: 1, pgid: 900, tty: "ttys000", tpgid: 900, command: "cousin" },
          ];
        },
        // deno-lint-ignore require-yield
        *holders() {
          // Everything holding the reader's terminal. None of it is this
          // client's to end.
          return [900, 901, 902, 903];
        },
        // deno-lint-ignore require-yield
        *deliver([pid, signal]): Operation<SignalDelivery> {
          signalled.push(`${pid}:${signal}`);
          return "delivered";
        },
        // deno-lint-ignore require-yield
        *reachable([pid]) {
          // The client refuses to leave until it has been signalled once.
          return pid === clientPid && !signalled.some((entry) => entry.startsWith(`${pid}:`));
        },
      },
      { at: "min" },
    );

    yield* scoped(function* () {
      const grid = yield* useTmuxGrid(tmux, {
        session: "visible",
        columns: 1,
        panes: 1,
        width: 160,
        height: 48,
        titles: ["only"],
        workerCommand: (ordinal) => ["xmd", "terminal-worker", String(ordinal), "/d"],
        cwd: path.resolve("."),
        env: {},
      });
      const visible = yield* grid.attach();
      clientPid = visible.client.pid;
      yield* grid.detach(visible);
    });

    // Asked first, and then exactly one process insisted on: not XMD, not its
    // parent, not a sibling in the same group, and not a holder of the
    // reader's terminal.
    expect(tmux.issued.some((line) => line.startsWith("detach-client"))).toBe(true);
    expect(signalled.length).toBeGreaterThan(0);
    for (const entry of signalled) {
      expect(entry.split(":")[0]).toBe(String(clientPid));
    }
    for (const bystander of [900, 901, 902, 903]) {
      expect(signalled.some((entry) => entry.startsWith(`${bystander}:`))).toBe(false);
    }
  });

  it("TG13: a visible client that survives every step refuses the teardown", function* () {
    const script = yield* useScript();
    // Asked to detach and stays; signalled and stays; killed and stays. There
    // is nothing further this may do, and nothing further it may claim.
    const tmux = createFakeTmux({
      script,
      clientCommand,
      clientName: `/dev/${CLIENT_MARKER}`,
      stubbornClient: true,
    });
    const signalled: string[] = [];
    let clientPid = -1;

    yield* TerminalProcesses.around(
      {
        // deno-lint-ignore require-yield
        *table() {
          return [
            { pid: 900, ppid: 1, pgid: 900, tty: "ttys000", tpgid: 900, command: "shell" },
            { pid: 901, ppid: 900, pgid: 900, tty: "ttys000", tpgid: 900, command: "xmd" },
            { pid: 902, ppid: 901, pgid: 900, tty: "ttys000", tpgid: 900, command: "sibling" },
          ];
        },
        // deno-lint-ignore require-yield
        *holders() {
          return [900, 901, 902];
        },
        // deno-lint-ignore require-yield
        *deliver([pid, signal]): Operation<SignalDelivery> {
          signalled.push(`${pid}:${signal}`);
          return "delivered";
        },
        // deno-lint-ignore require-yield
        *reachable([pid]) {
          // The client never goes. The server does, so the refusal that
          // surfaces is the client's rather than the server's.
          return pid === clientPid;
        },
      },
      { at: "min" },
    );

    let refusal = "";
    try {
      yield* scoped(function* () {
        const grid = yield* useTmuxGrid(tmux, {
          session: SESSION_MARKER,
          columns: 1,
          panes: 1,
          width: 160,
          height: 48,
          titles: [TITLE_MARKER],
          workerCommand: (ordinal) => ["xmd", "terminal-worker", String(ordinal), DIR_MARKER],
          cwd: path.resolve("."),
          env: { PRIVATE: ENV_MARKER },
        });
        const visible = yield* grid.attach();
        clientPid = visible.client.pid;
      });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }

    // It refuses rather than continuing: a document that carried on here would
    // carry on while a process still holds the reader's terminal.
    expect(refusal).toContain("could not be proved torn down");
    expect(refusal).toContain("visible client did not stop");
    // Nothing private in it.
    for (const marker of [
      SESSION_MARKER,
      DIR_MARKER,
      CLIENT_MARKER,
      TITLE_MARKER,
      ENV_MARKER,
      tmux.socket,
      "ttys000",
    ]) {
      expect(`${marker}: ${refusal.includes(marker)}`).toBe(`${marker}: false`);
    }
    // The boundary held all the way through the escalation: it was asked
    // first, and every signal after that named the client alone.
    expect(tmux.issued.some((line) => line.startsWith("detach-client"))).toBe(true);
    expect(signalled).toEqual([`${clientPid}:SIGTERM`, `${clientPid}:SIGKILL`]);
    for (const bystander of [900, 901, 902]) {
      expect(signalled.some((entry) => entry.startsWith(`${bystander}:`))).toBe(false);
    }
  });

  it("TG12: every socket and server closes before the private directory goes", function* () {
    const order: string[] = [];
    let directory = "";
    let atRemoval: { closed: number; total: number } | undefined;

    yield* scoped(function* () {
      const channels = yield* usePaneChannels(2, {
        onClosed: () => order.push("closed"),
        onRemoved: (facts) => {
          atRemoval = facts;
          order.push("removed");
        },
      });
      directory = channels.directory;
      // A worker on one of them, so there is an accepted connection to close as
      // well as the servers themselves.
      yield* useWorker(channels.directory, 0);
      yield* channels.link(0);
    });

    // Counted from the sockets' and servers' own close events, not from having
    // asked them to close: every one of them had actually closed by the time
    // the directory was removed.
    expect(order).toEqual(["closed", "removed"]);
    expect(atRemoval?.total).toBeGreaterThan(0);
    expect(`${atRemoval?.closed}/${atRemoval?.total}`).toBe(
      `${atRemoval?.total}/${atRemoval?.total}`,
    );
    expect(yield* exists(directory)).toBe(false);
  });
  it("TG9: a composite that fails while being built still takes the server down", function* () {
    const script = yield* useScript();
    let stopping = 0;
    const tmux = createFakeTmux({
      script,
      clientCommand,
      // The split for the second pane fails, half-way through preparation.
      failOnce: { command: "split-window", message: "no room" },
    });
    yield* TerminalProcesses.around(
      {
        // deno-lint-ignore require-yield
        *table() {
          return [];
        },
        // deno-lint-ignore require-yield
        *holders() {
          return [];
        },
        // deno-lint-ignore require-yield
        *deliver(): Operation<SignalDelivery> {
          return "absent";
        },
        // deno-lint-ignore require-yield
        *reachable() {
          return false;
        },
      },
      { at: "min" },
    );

    let failure = "";
    try {
      yield* scoped(function* () {
        yield* useTmuxGrid(tmux, {
          session: "grid",
          columns: 2,
          panes: 2,
          width: 160,
          height: 48,
          titles: ["a", "b"],
          workerCommand: (ordinal) => ["xmd", "terminal-worker", String(ordinal), "/d"],
          cwd: path.resolve("."),
          env: {},
        });
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }

    expect(failure).toContain("split-window");
    // Registered before the first command, so a half-built composite is still
    // taken down: no server is left behind for a grid nobody ever saw.
    stopping = tmux.issued.filter((line) => line.startsWith("kill-server")).length;
    expect(stopping).toBeGreaterThan(0);
    expect(tmux.alive()).toBe(false);
  });
});

/** Wait until the composite has classified an event of this kind. */
function untilEvent(grid: TmuxGrid, kind: ControlEvent["kind"]): Operation<void> {
  return (function* (): Operation<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (grid.events.some((event) => event.kind === kind)) {
        return;
      }
      yield* sleep(15);
    }
    throw new Error(
      `the composite never reported "${kind}"; it reported ` +
        JSON.stringify(grid.events.map((event) => event.kind)),
    );
  })();
}

/**
 * Tier TG20 — the pane's physical endpoint
 * (specs/executable-mdx-spec.md TG20, architecture commit 802b07df).
 *
 * A `<Session.Launch>` written inside a paired pane must run on *that pane's*
 * terminal. Before the amendment it delegated down the launcher chain and
 * reached the root foreground launcher — which on a real host inherits the root
 * terminal, the one terminal a pane exists to avoid. It now stops at the
 * composite's required pane operation.
 *
 * Nothing nearer intercepts here: no `<TestAgent>`, no controlled launcher in
 * front. The request goes to a real worker over a real socket, and a sentinel
 * stands where the root foreground launcher would be — entering it at all is
 * the failure this tier exists to catch.
 */
describe("Tier TG20 — a pane launch reaches its own worker", () => {
  /** A composite over a fake server that really starts its pane workers. */
  function useLiveComposite(panes: number): Operation<{
    composite: TerminalComposite;
    tmux: FakeTmux;
    channels: PaneChannels;
  }> {
    return (function* () {
      // The observer a foreground host installs beside the provider: teardown
      // proves what it claims, and refuses without it.
      yield* installDenoTerminalProcesses();
      const script = yield* useScript();
      const tmux = createFakeTmux({ script, clientCommand, spawnPanes: true });
      yield* ensure(() => {
        tmux.stopPanes();
      });
      const channels = yield* usePaneChannels(panes);
      const invocation = cliCommand([]);
      const grid = yield* useTmuxGrid(tmux, {
        session: "live",
        columns: panes,
        panes,
        width: 160,
        height: 48,
        titles: Array.from({ length: panes }, (_, index) => `pane ${index}`),
        workerCommand: (ordinal) => [
          invocation.command,
          ...invocation.arguments,
          PANE_WORKER_COMMAND,
          String(ordinal),
          channels.directory,
        ],
        cwd: path.resolve("."),
        env: { PATH: "/usr/bin:/bin" },
      });
      void grid;
      const links: PaneLink[] = [];
      for (let ordinal = 0; ordinal < panes; ordinal++) {
        links.push(yield* channels.link(ordinal));
      }
      const composite = paneComposite(links);
      return { composite, tmux, channels };
    })();
  }

  it("TG20a: the exact argv, cwd and environment arrive at that pane's worker", function* () {
    const { composite } = yield* useLiveComposite(1);
    const evidence = path.join(tmpdir(), `xmd-tg20-${randomUUID()}.json`);
    yield* ensure(function* () {
      yield* rm(evidence, { force: true });
    });

    // Arguments a command parser would ruin, an environment entry only this
    // launch names, and a working directory that is not the runner's.
    const marker = "tg20marker";
    let started = 0;
    const outcome = yield* composite.launch(
      0,
      {
        command: [
          "/bin/sh",
          "-c",
          `printf '%s' "$XMD_TG20:$PWD:$1" > "${evidence}"`,
          "sh",
          `a b;'"$${marker}`,
        ],
        cwd: tmpdir(),
        env: { PATH: "/usr/bin:/bin", XMD_TG20: marker },
      },
      () => started++,
    );

    expect(outcome.exitCode).toBe(0);
    // The spawn was reported once, by the worker that observed it.
    expect(started).toBe(1);
    const seen = yield* readTextFile(evidence);
    const [env, cwd, argument] = seen.split(":");
    expect(env).toBe(marker);
    expect(cwd).toBe(yield* until(realpath(tmpdir())));
    // Unchanged through the socket and past tmux, whose parser never saw it.
    expect(argument).toBe(`a b;'"$${marker}`);
  });

  it("TG20b: the root foreground launcher is never entered", function* () {
    const { composite } = yield* useLiveComposite(1);
    const reached: string[] = [];
    // A sentinel where the root launcher sits. A pane launch that delegated
    // past its endpoint would arrive here — and on a real host that is the
    // root terminal.
    yield* installControlledLauncher({
      record: (request) => reached.push(request.command.join(" ")),
      outcome: () => ({ exitCode: 0 }),
    });

    yield* composite.launch(
      0,
      { command: ["/bin/echo", "pane"], cwd: path.resolve("."), env: { PATH: "/usr/bin:/bin" } },
      () => {},
    );

    expect(reached).toEqual([]);
    // And the sentinel is a live one: a *root* launch does reach it.
    yield* scoped(function* () {
      yield* reserveTerminal();
      yield* nativeLaunch({ command: ["/bin/echo", "root"], cwd: path.resolve(".") });
    });
    expect(reached).toEqual(["/bin/echo root"]);
  });

  it("TG20c: distinct panes launch concurrently", function* () {
    const { composite } = yield* useLiveComposite(2);
    const room = yield* useScratch();

    // Each child announces itself and then blocks until *both* have. Two
    // children that ran one after the other could never get past this: the
    // first would be waiting for a second that had not been started yet.
    const child = (ordinal: number): string[] => [
      "/bin/sh",
      "-c",
      `printf '' > "${room}/started-${ordinal}"; ` +
        `while [ ! -f "${room}/go" ]; do sleep 0.02; done`,
    ];

    const releasing = yield* spawn(function* () {
      // Released by the starts themselves, never by elapsed time.
      while (true) {
        if ((yield* exists(`${room}/started-0`)) && (yield* exists(`${room}/started-1`))) {
          yield* writeTextFile(`${room}/go`, "");
          return;
        }
        yield* sleep(15);
      }
    });

    const outcomes = yield* all([
      composite.launch(
        0,
        { command: child(0), cwd: room, env: { PATH: "/usr/bin:/bin" } },
        () => {},
      ),
      composite.launch(
        1,
        { command: child(1), cwd: room, env: { PATH: "/usr/bin:/bin" } },
        () => {},
      ),
    ]);
    yield* releasing;

    expect(outcomes.map((outcome) => outcome.exitCode)).toEqual([0, 0]);
    // Both were live at the same moment: the release only happened once both
    // had announced themselves, and neither could finish before it.
    expect(yield* exists(`${room}/go`)).toBe(true);
  });

  it("TG20e: a cancelled pane launch does not return while its child lives", function* () {
    const { composite } = yield* useLiveComposite(1);
    const room = yield* useScratch();
    yield* installDenoTerminalProcesses();

    // Writes its pid, then stays. Nothing here ends it but the cancellation.
    const launching = yield* spawn(() =>
      composite.launch(
        0,
        {
          command: ["/bin/sh", "-c", `echo $$ > "${room}/pid"; while true; do sleep 0.05; done`],
          cwd: room,
          env: { PATH: "/usr/bin:/bin" },
        },
        () => {},
      ),
    );

    // Live, and known by pid — a fact this run produced.
    while (!(yield* exists(`${room}/pid`))) {
      yield* sleep(15);
    }
    const pid = Number((yield* readTextFile(`${room}/pid`)).trim());
    expect(pid).toBeGreaterThan(0);
    expect(yield* processReachable(pid)).toBe(true);

    yield* launching.halt();

    // The cancellation asked the pane to stop and waited for it to prove that
    // it had. Returning while the child was still live is the failure this row
    // exists for.
    expect(yield* processReachable(pid)).toBe(false);
  });

  it("TG20d: a composite that cannot run a pane's launch refuses", function* () {
    const { composite } = yield* useLiveComposite(1);
    let refusal = "";
    try {
      // No such pane. There is no fallback to fall back to: putting this on
      // the root terminal is the one thing that must not happen.
      yield* composite.launch(
        3,
        { command: ["/bin/echo", "nowhere"], cwd: path.resolve("."), env: {} },
        () => {},
      );
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toContain("cannot run that pane's launch");
  });
});

/**
 * Tier TH — which hosts open a grid, and which only describe one
 * (architecture.md §Interactive terminal grids).
 *
 * The Deno source entrypoint and the compiled binary present grids when the
 * invocation has a terminal and a usable tmux. Node and Bun keep the same
 * language and validation and install no operational provider, so a document
 * that asks for a grid there is refused before a pane starts.
 */
/** Settle once this child has gone, whether or not it already had. */
function exited(child: ChildProcess): Operation<void> {
  const done = withResolvers<void>();
  const onExit = (): void => done.resolve();
  if (child.exitCode !== null || child.signalCode !== null) {
    done.resolve();
  } else {
    child.on("exit", onExit);
  }
  return (function* (): Operation<void> {
    try {
      yield* done.operation;
    } finally {
      child.off("exit", onExit);
    }
  })();
}

/** A shell that says when it started, and stays until it is signalled. */
function useShellFixture(room: string): Operation<string> {
  return resource<string>(function* (provide) {
    const file = path.join(room, "shell");
    yield* writeTextFile(
      file,
      ["#!/bin/sh", `echo $$ > "${room}/shell-pid"`, "while true; do sleep 0.05; done", ""].join(
        "\n",
      ),
    );
    yield* until(chmod(file, 0o755));
    yield* provide(file);
  });
}

/** A settlement that proved its pane free. */
function quietSettlement(): Settlement {
  return { method: "exited", quiet: true, swept: [], holders: [] };
}

/** How one scripted worker answers what the parent tells it. */
type Reply = (
  frame: ToWorker,
  say: (message: FromWorker) => Operation<void>,
  socket: Socket,
) => Operation<void>;

interface ScriptedWorker {
  readonly socket: Socket;
  /** Everything the parent told this worker, in order. */
  readonly heard: ToWorker["type"][];
}

/**
 * One pane's worker, over that pane's real socket, saying what a row scripts.
 *
 * A real connection through the real admission handshake, because the order
 * being frozen is the order frames actually arrive in. What is scripted is the
 * worker's *answers* — which is where the protocol failures live, and the one
 * thing a real worker will not do on request.
 */
function useScriptedWorker(
  directory: string,
  ordinal: number,
  reply: Reply,
): Operation<ScriptedWorker> {
  return resource<ScriptedWorker>(function* (provide) {
    const socket = yield* useImpostor(directory, ordinal);
    const token = (yield* readTextFile(paneTokenPath(directory, ordinal))).trim();
    const heard: ToWorker["type"][] = [];
    const frames = yield* readFrames(socket, (value) => ToWorkerSchema.parse(value));
    yield* writeFrame(socket, {
      type: "hello",
      ordinal,
      token,
      pid: process.pid,
      pgid: process.pid,
      tty: "??",
      isatty: [false, false, false],
    });
    yield* spawn(function* () {
      let next = yield* frames.next();
      while (!next.done) {
        heard.push(next.value.type);
        yield* reply(next.value, (message) => writeFrame(socket, message), socket);
        next = yield* frames.next();
      }
    });
    yield* provide({ socket, heard });
  });
}

/** A worker that shuts down the way one that worked is supposed to. */
function quiesces(hold?: Operation<void>): Reply {
  return function* (frame, say, socket) {
    if (frame.type !== "shutdown") {
      return;
    }
    if (hold !== undefined) {
      yield* hold;
    }
    yield* say({ type: "quiet", settlement: quietSettlement() });
    yield* say({ type: "bye", holders: [] });
    // A worker that has said goodbye is leaving, and its channel closing is the
    // third thing the teardown requires. One that stayed would be a pane still
    // holding a connection to a grid that is going away.
    socket.destroy();
  };
}

/** The link the teardown drives, wrapped so the row sees what it observed. */
function loggedLink(link: PaneLink, log: string[]): PaneLink {
  return {
    ordinal: link.ordinal,
    hello: link.hello,
    *send(message) {
      log.push(`${message.type}:${link.ordinal}`);
      yield* link.send(message);
    },
    *next() {
      const frame = yield* link.next();
      log.push(frame === undefined ? `eof:${link.ordinal}` : `${frame.type}:${link.ordinal}`);
      return frame;
    },
    connected: () => link.connected(),
  };
}

interface Teardown {
  readonly log: string[];
  readonly directory: string;
  readonly run: () => Operation<void>;
  /** Every private socket and server this grid opened. */
  readonly handles: (Socket | Server)[];
}

/**
 * A teardown over real private channels, with the reader's client and the
 * server standing in for what tmux does with them.
 *
 * The channels are real, so the closures and the path removal in the frozen
 * order are the production ones. The two ends this fixture supplies are the two
 * whose failures a row has to be able to choose.
 */
function useTeardown(options: {
  readonly workers: readonly (Reply | undefined)[];
  readonly detach?: () => Operation<void>;
  readonly stop?: () => Operation<void>;
}): Operation<Teardown> {
  return resource<Teardown>(function* (provide) {
    const log: string[] = [];
    const handles: (Socket | Server)[] = [];
    // One server per pane, created in pane order. Which pane a closure belongs
    // to is read from the server that accepted the connection, so the order
    // this row freezes is per-pane rather than per-event.
    let panes = 0;
    const belongs = new Map<Socket, number>();
    const detachments: (() => void)[] = [];
    const noteSocket = (socket: Socket, what: () => string): void => {
      handles.push(socket);
      const onClose = (): void => {
        log.push(what());
      };
      socket.on("close", onClose);
      detachments.push(() => socket.off("close", onClose));
    };
    const noteServer = (server: Server, what: () => string): void => {
      handles.push(server);
      const onClose = (): void => {
        log.push(what());
      };
      server.on("close", onClose);
      detachments.push(() => server.off("close", onClose));
    };
    yield* ensure(() => {
      // This row's own listeners, off the emitters this row put them on.
      for (const detach of detachments) {
        detach();
      }
    });
    const channels = yield* usePaneChannels(options.workers.length, {
      onSocket: (socket) => noteSocket(socket, () => `socket-closed:${belongs.get(socket) ?? -1}`),
      onServer: (server) => {
        const ordinal = panes++;
        const onConnection = (socket: Socket): void => {
          belongs.set(socket, ordinal);
        };
        server.on("connection", onConnection);
        detachments.push(() => server.off("connection", onConnection));
        noteServer(server, () => `server-closed:${ordinal}`);
      },
    });
    for (const [ordinal, reply] of options.workers.entries()) {
      if (reply !== undefined) {
        yield* useScriptedWorker(channels.directory, ordinal, reply);
      }
    }
    const links: PaneLink[] = [];
    for (const [ordinal, reply] of options.workers.entries()) {
      if (reply !== undefined) {
        links.push(loggedLink(yield* channels.link(ordinal), log));
      }
    }
    const run = createGridTeardown({
      detachReader:
        options.detach ??
        function* () {
          log.push("detach");
        },
      links,
      *closeChannels() {
        yield* channels.close();
      },
      stopServer:
        options.stop ??
        function* () {
          log.push("server-stopped");
        },
    });
    yield* provide({ log, directory: channels.directory, run, handles });
  });
}

describe("Tier TD — the combined teardown", () => {
  it("TD1: concurrent destroys share one teardown, and every phase happens once", function* () {
    const held = withResolvers<void>();
    const fixture = yield* useTeardown({ workers: [quiesces(held.operation), quiesces()] });

    const first = yield* spawn(() => fixture.run());
    // Held inside the first worker's settlement, so the second destroy arrives
    // while the first teardown is genuinely part-way through rather than
    // racing it.
    while (!fixture.log.includes("shutdown:0")) {
      yield* sleep(5);
    }
    const second = yield* spawn(() => fixture.run());
    held.resolve();
    yield* first;
    yield* second;

    const once = (entry: string): number => fixture.log.filter((line) => line === entry).length;
    for (const entry of ["detach", "shutdown:0", "shutdown:1", "server-stopped"]) {
      expect([entry, once(entry)]).toEqual([entry, 1]);
    }
    // The channels too: one closure each, not one per caller.
    for (const ordinal of [0, 1]) {
      expect([ordinal, once(`socket-closed:${ordinal}`)]).toEqual([ordinal, 1]);
      expect([ordinal, once(`server-closed:${ordinal}`)]).toEqual([ordinal, 1]);
    }
  });

  it("TD2: a worker that was gone before it was asked refuses the teardown", function* () {
    const fixture = yield* useTeardown({ workers: [quiesces()] });
    fixture.handles.find((handle): handle is Socket => "destroy" in handle)?.destroy();
    while (!fixture.log.includes("socket-closed:0")) {
      yield* sleep(5);
    }

    let refusal = "";
    try {
      yield* fixture.run();
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toContain("gone before it was asked to stop");
  });

  it("TD3: a goodbye before a settlement refuses", function* () {
    const fixture = yield* useTeardown({
      workers: [
        function* (frame, say) {
          if (frame.type === "shutdown") {
            yield* say({ type: "bye", holders: [] });
          }
        },
      ],
    });

    let refusal = "";
    try {
      yield* fixture.run();
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toContain("said goodbye before it was proved free");
  });

  it("TD4: a settlement with no goodbye after it refuses", function* () {
    const fixture = yield* useTeardown({
      workers: [
        function* (frame, say, socket) {
          if (frame.type !== "shutdown") {
            return;
          }
          yield* say({ type: "quiet", settlement: quietSettlement() });
          // EOF where the goodbye belongs: settled, and never established free.
          socket.destroy();
        },
      ],
    });

    let refusal = "";
    try {
      yield* fixture.run();
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toContain("stopped answering before it was proved free");
    expect(fixture.log).toContain("eof:0");
  });

  it("TD5: one pane's failure strands neither the next pane, the channels, nor the server", function* () {
    const fixture = yield* useTeardown({
      workers: [
        function* (frame, say) {
          if (frame.type === "shutdown") {
            yield* say({ type: "bye", holders: [] });
          }
        },
        quiesces(),
      ],
    });

    let refusal = "";
    try {
      yield* fixture.run();
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }

    // The first pane's failure is what surfaced, and everything acquired after
    // it was still taken down.
    expect(refusal).toContain("said goodbye before it was proved free");
    expect(fixture.log).toContain("shutdown:1");
    expect(fixture.log).toContain("bye:1");
    for (const ordinal of [0, 1]) {
      expect(fixture.log).toContain(`socket-closed:${ordinal}`);
      expect(fixture.log).toContain(`server-closed:${ordinal}`);
    }
    expect(fixture.log).toContain("server-stopped");
  });

  it("TD6: the first failure is the one that surfaces", function* () {
    const fixture = yield* useTeardown({
      workers: [
        function* (frame, say) {
          if (frame.type === "shutdown") {
            yield* say({ type: "bye", holders: [] });
          }
        },
      ],
      // deno-lint-ignore require-yield
      *stop() {
        throw new Error("the server would not stop");
      },
    });

    let refusal = "";
    try {
      yield* fixture.run();
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    // The pane, not the server: a later failure does not replace the reason the
    // teardown could not establish this grid was gone.
    expect(refusal).toContain("said goodbye before it was proved free");
    expect(refusal).not.toContain("would not stop");
  });

  /** A worker that stays connected and says nothing. */
  // deno-lint-ignore require-yield
  const silent: Reply = function* () {};

  it("TD10: a retry resumes at the phase that failed and re-asks no finished one", function* () {
    const stops: string[] = [];
    let refuse = true;
    const fixture = yield* useTeardown({
      workers: [quiesces()],
      // deno-lint-ignore require-yield
      *stop() {
        stops.push("asked");
        if (refuse) {
          refuse = false;
          throw new Error("the server would not stop");
        }
      },
    });

    let refusal = "";
    try {
      yield* fixture.run();
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toContain("would not stop");

    // The retry finishes the grid, and the phases that were proved done are not
    // asked again: a worker that has already said goodbye and gone would answer
    // the second ask as "a worker that was gone", which would replace the
    // reason the first attempt could not finish with an artifact of its
    // succeeding.
    yield* fixture.run();
    expect(stops.length).toBe(2);
    expect(fixture.log.filter((line) => line === "shutdown:0").length).toBe(1);
    expect(fixture.log.filter((line) => line === "bye:0").length).toBe(1);
  });

  it("TD8: a close request that fails is retried, and what closed stays closed", function* () {
    const closed: string[] = [];
    let panes = 0;
    let refuse = true;
    const channels = yield* usePaneChannels(2, {
      onSocket(socket) {
        socket.on("close", () => closed.push("socket"));
      },
      onServer(server) {
        const ordinal = panes++;
        server.on("close", () => closed.push(`server:${ordinal}`));
        if (ordinal !== 0) {
          return;
        }
        // One handle that refuses to be *asked*, once. A close request is as
        // capable of failing as the wait after it, and the two have to be
        // inside the same boundary or the failure escapes the retry.
        const ask = server.close.bind(server);
        server.close = (callback?: (error?: Error) => void) => {
          if (refuse) {
            refuse = false;
            throw new Error("this handle refused to be closed");
          }
          return ask(callback);
        };
      },
    });
    yield* useScriptedWorker(channels.directory, 0, silent);
    yield* useScriptedWorker(channels.directory, 1, silent);
    yield* channels.link(0);
    yield* channels.link(1);

    let refusal = "";
    try {
      yield* channels.close();
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toContain("refused to be closed");
    // The handles after the failure were still asked, and closed.
    expect(closed.filter((name) => name === "socket").length).toBe(2);
    expect(closed).toContain("server:1");
    expect(closed).not.toContain("server:0");

    // The published settlement was cleared rather than remembered, so this call
    // asks the handle that refused again — and nothing that already closed is
    // closed a second time.
    yield* channels.close();
    for (const [name, times] of [
      ["socket", 2],
      ["server:0", 1],
      ["server:1", 1],
    ] as const) {
      expect([name, closed.filter((entry) => entry === name).length]).toEqual([name, times]);
    }
  });

  it("TD9: a teardown that fails refuses the run, and nothing after the grid goes", function* () {
    // The document-level end of the same claim: a grid whose teardown could not
    // establish the terminal was given back is a failed run, not a run with a
    // warning in it.
    const room = yield* useScratch();
    const shell = yield* useShellFixture(room);
    const script = yield* useScript();
    const invocation = cliCommand([]);
    // The server refuses to be killed the first time it is asked, so the last
    // phase of the teardown cannot establish it is gone.
    const tmux = createFakeTmux({
      script,
      clientCommand,
      spawnPanes: true,
      failOnce: { command: "kill-server", message: "refused" },
    });
    yield* ensure(() => {
      tmux.stopPanes();
    });
    yield* writeTextFile(
      path.join(room, "doc.md"),
      [
        "<Terminal.Grid columns={1}>",
        '<Terminal title="Only" />',
        "</Terminal.Grid>",
        "",
        "AFTER_THE_GRID",
        "",
      ].join("\n"),
    );
    yield* installControlledLauncher({ outcome: () => ({ exitCode: 0 }) });

    let outcome: Result<Json> | undefined;
    let output = "";
    yield* scoped(function* () {
      yield* foregroundTerminalGrid({
        isTerminal: () => true,
        createTmux: () => tmux,
        env: { PATH: "/usr/bin:/bin", SHELL: shell },
        // deno-lint-ignore require-yield
        *askVersion() {
          return { code: 0, stdout: "tmux 3.6a" };
        },
        workerCommand: function* (ordinal, at) {
          return [
            invocation.command,
            ...invocation.arguments,
            PANE_WORKER_COMMAND,
            String(ordinal),
            at,
          ];
        },
      })();

      yield* spawn(function* () {
        while (!(yield* exists(`${room}/shell-pid`))) {
          yield* sleep(15);
        }
        while (tmux.clients.length === 0) {
          yield* sleep(15);
        }
        yield* tmux.say(`%client-detached ${tmux.clients[0] ?? ""}`);
      });

      const execution = yield* execute({
        path: path.join(room, "doc.md"),
        stream: new InMemoryStream(),
        includes: [room],
      });
      const subscription = yield* execution.output;
      let next = yield* subscription.next();
      while (!next.done) {
        output = next.value;
        next = yield* subscription.next();
      }
      outcome = yield* execution;
    });

    expect(outcome?.ok).toBe(false);
    const refusal = outcome?.ok === false ? String(outcome.error) : "";
    expect(refusal).toContain("terminal server");
    // Nothing private in it, and nothing after the grid ran.
    expect(refusal).not.toContain(room);
    expect(output).not.toContain("AFTER_THE_GRID");
  });

  it("TD7: the combined order is the frozen one", function* () {
    const order: string[] = [];
    let directory = "";
    yield* scoped(function* () {
      // Registered before the channels exist, so it runs after they are gone:
      // the private paths are removed by the channels' own scope, last, once
      // everything inside it has closed.
      yield* ensure(function* () {
        if (directory !== "" && !(yield* exists(directory))) {
          order.push("paths-removed");
        }
      });
      const fixture = yield* useTeardown({ workers: [quiesces(), quiesces()] });
      directory = fixture.directory;
      yield* fixture.run();
      order.push(...fixture.log);
    });

    const at = (entry: string): number => order.indexOf(entry);
    const last = (entry: string): number => order.lastIndexOf(entry);
    // visible detach → worker settlements → holder-free goodbyes → worker
    // channel closures → channel servers closed → server disappearance →
    // private path removal.
    expect(at("detach")).toBe(0);
    for (const ordinal of [0, 1]) {
      expect(at(`shutdown:${ordinal}`)).toBeGreaterThan(at("detach"));
      expect(at(`quiet:${ordinal}`)).toBeGreaterThan(at(`shutdown:${ordinal}`));
      expect(at(`bye:${ordinal}`)).toBeGreaterThan(at(`quiet:${ordinal}`));
    }
    // Each pane's four phases are that pane's, in order — panes are quiesced
    // one at a time, so pane zero's channel closes while pane one has not been
    // asked yet. What is global is the boundary after them: no server closes
    // until every worker channel has.
    for (const ordinal of [0, 1]) {
      expect(at(`socket-closed:${ordinal}`)).toBeGreaterThan(at(`bye:${ordinal}`));
      expect(at("server-closed:0")).toBeGreaterThan(at(`socket-closed:${ordinal}`));
    }
    expect(at("server-closed:1")).toBeGreaterThan(at("server-closed:0") - 1);
    expect(at("server-stopped")).toBeGreaterThan(
      Math.max(at("server-closed:0"), at("server-closed:1")),
    );
    expect(at("paths-removed")).toBe(order.length - 1);
  });
});

/** One entrypoint's source, for the rows about what a host assembles. */
function entrypointSource(name: string): Operation<string> {
  return readTextFile(path.resolve("packages/cli/src", name));
}

describe("Tier TH — host installation", () => {
  it("TH1: without a terminal, a grid refuses before anything exists", function* () {
    const before = yield* until(readdir(tmpdir()));
    let refusal = "";
    try {
      yield* scoped(function* () {
        yield* installDenoTerminalProcesses();
        yield* useProbedProvider({ isTerminal: () => false });
      });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }

    expect(refusal).toContain("cannot open a terminal grid");
    expect(refusal).toContain("no terminal");
    // Before a directory, a socket, a token, a worker, a server or a pane: the
    // host left nothing behind for having tried.
    const after = yield* until(readdir(tmpdir()));
    expect(after.filter((name) => name.startsWith("xmd-grid-")).length).toBe(
      before.filter((name) => name.startsWith("xmd-grid-")).length,
    );
  });

  it("TH2: without a usable tmux, a grid refuses the same way", function* () {
    let refusal = "";
    try {
      yield* scoped(function* () {
        yield* installDenoTerminalProcesses();
        yield* useProbedProvider({
          isTerminal: () => true,
          // A tmux far too old for an explicit layout string.
          version: "tmux 1.8",
        });
      });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toContain("cannot open a terminal grid");
    expect(refusal).toContain("older than tmux");
  });

  it("TH4: the installed SIGHUP listener cancels the run and tears the grid down", function* () {
    const room = yield* useScratch();
    const shell = yield* useShellFixture(room);
    const script = yield* useScript();
    const invocation = cliCommand([]);
    const tmux = createFakeTmux({ script, clientCommand, spawnPanes: true });
    yield* ensure(() => {
      tmux.stopPanes();
    });
    yield* writeTextFile(
      path.join(room, "doc.md"),
      [
        "<Terminal.Grid columns={1}>",
        '<Terminal title="Only" />',
        "</Terminal.Grid>",
        "",
        "AFTER_THE_GRID",
        "",
      ].join("\n"),
    );
    // The run's foreground lease, which a grid takes before any provider.
    yield* installControlledLauncher({ outcome: () => ({ exitCode: 0 }) });

    const sighupBefore = foregroundSignalListeners("SIGHUP");
    let directory = "";
    let installed = 0;
    let outcome: Result<Json> | undefined;
    let output = "";
    yield* scoped(function* () {
      yield* foregroundTerminalGrid({
        isTerminal: () => true,
        createTmux: () => tmux,
        env: { PATH: "/usr/bin:/bin", SHELL: shell },
        // deno-lint-ignore require-yield
        *askVersion() {
          return { code: 0, stdout: "tmux 3.6a" };
        },
        workerCommand: function* (ordinal, at) {
          directory = at;
          return [
            invocation.command,
            ...invocation.arguments,
            PANE_WORKER_COMMAND,
            String(ordinal),
            at,
          ];
        },
      })();
      // The listener is the installer's, and this row uses that one.
      installed = foregroundSignalListeners("SIGHUP");

      yield* spawn(function* () {
        // Driven by the pane child's own start: the worker spawned, its channel
        // authenticated, and the shell it launched said so.
        while (!(yield* exists(`${room}/shell-pid`))) {
          yield* sleep(15);
        }
        process.kill(process.pid, "SIGHUP");
      });

      const execution = yield* execute({
        path: path.join(room, "doc.md"),
        stream: new InMemoryStream(),
        includes: [room],
      });
      const subscription = yield* execution.output;
      let next = yield* subscription.next();
      while (!next.done) {
        output = next.value;
        next = yield* subscription.next();
      }
      outcome = yield* execution;
    });

    // The installer put its listener on, and took it off with the run.
    expect(installed).toBe(sighupBefore + 1);
    expect(foregroundSignalListeners("SIGHUP")).toBe(sighupBefore);

    // Cancellation, not a reader close: the run failed and nothing after the
    // grid ran in that attempt.
    expect(outcome?.ok).toBe(false);
    expect(output).not.toContain("AFTER_THE_GRID");

    // Every teardown phase completed before the result was observed. The pane's
    // child is gone, the worker is gone, the server is gone, and the private
    // directory — which is removed last, after its sockets have closed — is
    // gone with them.
    const shellPid = Number((yield* readTextFile(`${room}/shell-pid`)).trim());
    expect(shellPid).toBeGreaterThan(0);
    yield* installDenoTerminalProcesses();
    expect(yield* processReachable(shellPid)).toBe(false);
    // Awaited on each process's own exit event, not sampled: a worker that had
    // not quite gone yet would make a sampled check pass or fail by timing.
    for (const child of tmux.started) {
      yield* exited(child);
    }
    expect(tmux.alive()).toBe(false);
    expect(directory).not.toBe("");
    expect(yield* exists(directory)).toBe(false);
  });

  it("TH5: an ordinary run shows the grid, and the reader's detach ends it", function* () {
    // The same host, the same document and the same live grid as TH4. What
    // differs is the ending: the reader leaves rather than the terminal going
    // away, so the grid settles and the document carries on — which is the
    // branch `useHangupCancellation()` has to hand the result back through.
    const room = yield* useScratch();
    const shell = yield* useShellFixture(room);
    const script = yield* useScript();
    const invocation = cliCommand([]);
    const tmux = createFakeTmux({ script, clientCommand, spawnPanes: true });
    yield* ensure(() => {
      tmux.stopPanes();
    });
    yield* writeTextFile(
      path.join(room, "doc.md"),
      [
        "<Terminal.Grid columns={1}>",
        '<Terminal title="Only" />',
        "</Terminal.Grid>",
        "",
        "AFTER_THE_GRID",
        "",
      ].join("\n"),
    );
    yield* installControlledLauncher({ outcome: () => ({ exitCode: 0 }) });

    let directory = "";
    let outcome: Result<Json> | undefined;
    let output = "";
    yield* scoped(function* () {
      yield* foregroundTerminalGrid({
        isTerminal: () => true,
        createTmux: () => tmux,
        env: { PATH: "/usr/bin:/bin", SHELL: shell },
        // deno-lint-ignore require-yield
        *askVersion() {
          return { code: 0, stdout: "tmux 3.6a" };
        },
        workerCommand: function* (ordinal, at) {
          directory = at;
          return [
            invocation.command,
            ...invocation.arguments,
            PANE_WORKER_COMMAND,
            String(ordinal),
            at,
          ];
        },
      })();

      yield* spawn(function* () {
        // Driven by the grid's own progress: the pane child started, and the
        // server has a reader's client to report the detach of. No SIGHUP.
        while (!(yield* exists(`${room}/shell-pid`))) {
          yield* sleep(15);
        }
        while (tmux.clients.length === 0) {
          yield* sleep(15);
        }
        yield* tmux.say(`%client-detached ${tmux.clients[0] ?? ""}`);
      });

      const execution = yield* execute({
        path: path.join(room, "doc.md"),
        stream: new InMemoryStream(),
        includes: [room],
      });
      const subscription = yield* execution.output;
      let next = yield* subscription.next();
      while (!next.done) {
        output = next.value;
        next = yield* subscription.next();
      }
      outcome = yield* execution;
    });

    // The exact result, handed back through the hangup wrapper rather than
    // swallowed by it: a handler that answered with nothing would be refused
    // for having returned before the document produced a result.
    expect(outcome).toEqual(Ok("\n\nAFTER_THE_GRID\n"));
    // The reader closed the grid; the document went on.
    expect(output).toContain("AFTER_THE_GRID");

    // And it went on over a grid that had actually been taken down: the pane's
    // child, the workers, the server and the private directory are all gone.
    const shellPid = Number((yield* readTextFile(`${room}/shell-pid`)).trim());
    expect(shellPid).toBeGreaterThan(0);
    yield* installDenoTerminalProcesses();
    expect(yield* processReachable(shellPid)).toBe(false);
    for (const child of tmux.started) {
      yield* exited(child);
    }
    expect(tmux.alive()).toBe(false);
    expect(directory).not.toBe("");
    expect(yield* exists(directory)).toBe(false);
  });

  it("TH6: the Deno and compiled entrypoints present grids; Node and Bun do not", function* () {
    for (const name of ["deno.ts", "compiled.ts"]) {
      expect((yield* entrypointSource(name)).includes("foregroundTerminalGrid()")).toBe(true);
    }
    for (const name of ["node.ts", "bun.ts"]) {
      // Not a different grid: no grid at all, and therefore the default the
      // shared entry declares — which is the installation that validates a grid
      // and presents none.
      expect((yield* entrypointSource(name)).includes("foregroundTerminalGrid")).toBe(false);
    }
    expect(yield* entrypointSource("cli.ts")).toContain(
      "installTerminalGrid: TerminalGridInstaller = unsupportedTerminalGrid",
    );
  });

  it("TH3: a host that installs no provider still validates the grid", function* () {
    // Node and Bun: the same language and the same validation, and core's own
    // refusal rather than a provider that half-works.
    yield* unsupportedTerminalGrid();
    let refusal = "";
    try {
      yield* TerminalGrids.operations.open({
        columns: 1,
        rows: 1,
        panes: [{ ordinal: 0, title: "Only", row: 0, column: 0, form: "paired" }],
      });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toContain("no terminal provider is installed");
  });
});
