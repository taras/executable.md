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
import { ensure, race, resource, scoped, sleep, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { spawn as spawnChild } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import net from "node:net";
import * as path from "node:path";
import { cliCommand } from "@executablemd/test-support/launch";
import { exists, rm, stat, writeTextFile } from "@effectionx/fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { TerminalProcesses } from "@executablemd/runtime";
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
import type { PaneChannels, PaneLink } from "../src/terminal/pane-channel.ts";
import {
  FromWorkerSchema,
  paneSocketPath,
  paneTokenPath,
  writeFrame,
} from "../src/terminal/pane-protocol.ts";
import { PANE_WORKER_COMMAND, paneWorkerInvocation } from "../src/terminal/pane-worker.ts";
import type { FromWorker, ToWorker } from "../src/terminal/pane-protocol.ts";

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
