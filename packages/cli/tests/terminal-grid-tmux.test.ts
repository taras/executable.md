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
import { stat } from "node:fs/promises";
import * as path from "node:path";
import { cliCommand } from "@executablemd/test-support/launch";
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
import type { FromWorker } from "../src/terminal/pane-protocol.ts";

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
    for (const [width, height] of [
      [80, 24],
      [200, 24],
      [80, 60],
      [211, 51],
    ] as const) {
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
    const directory = yield* until(stat(channels.directory));
    expect(directory.mode & 0o777).toBe(0o700);
    for (const ordinal of [0, 1]) {
      const token = yield* until(stat(paneTokenPath(channels.directory, ordinal)));
      expect(`pane ${ordinal}: ${(token.mode & 0o777).toString(8)}`).toBe(`pane ${ordinal}: 600`);
      // The socket exists before any pane does, so a worker that starts finds
      // it listening rather than racing it.
      yield* until(stat(paneSocketPath(channels.directory, ordinal)));
    }
  });

  it("TW2: the directory and everything in it goes with the grid", function* () {
    let directory = "";
    yield* scoped(function* () {
      const channels = yield* usePaneChannels(1);
      directory = channels.directory;
    });
    const gone = yield* until(
      stat(directory).then(
        () => false,
        () => true,
      ),
    );
    expect(gone).toBe(true);
  });

  it("TW3: a real worker connects, proves which pane it is, and spends its token", function* () {
    const channels = yield* usePaneChannels(1);
    yield* useWorker(channels.directory, 0);
    const link = yield* channels.link(0);

    expect(link.hello.ordinal).toBe(0);
    expect(link.hello.pid).toBeGreaterThan(0);
    // Spent as it was read: a second worker for this pane finds no token, so
    // it has nothing to present.
    const spent = yield* until(
      stat(paneTokenPath(channels.directory, 0)).then(
        () => false,
        () => true,
      ),
    );
    expect(spent).toBe(true);
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

    const sleeper = {
      type: "launch" as const,
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
