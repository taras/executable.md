/**
 * One hidden, invocation-private tmux composite
 * (architecture.md §Interactive terminal grids, §Atomic presentation).
 *
 * A grid is built entirely out of sight: its own server on its own socket, a
 * pane per authored ordinal each running that pane's worker, the authored
 * layout imposed explicitly, and a control-mode client that says what the
 * server sees. Nothing is visible until `attach()`, which core calls only after
 * every pane has reported a start — so a reader never watches a grid fill in,
 * and a grid that failed to start is taken down without ever having been shown.
 *
 * Three clients, kept apart because they answer different questions:
 *
 * - the **visible** client is the reader's, attached on this process's terminal
 *   with the streams inherited;
 * - the **control** client attaches with `-f no-output`, so pane bytes never
 *   travel through this process. What it reports — `%client-detached`,
 *   `%sessions-changed`, `%exit`, EOF — is how reader detach, server stop and
 *   control loss are told apart. An attach client's exit code cannot tell them
 *   apart: it is 0 after `detach-client`, 0 after `kill-session` and 1 after
 *   `kill-server`;
 * - the pane **workers** are not clients at all. They are the panes.
 *
 * Every tmux identifier — the socket path, session name, window, pane ids,
 * client names, the server pid — stays inside this module. None of it reaches a
 * request, a result, a retained record or a diagnostic.
 */

import { exec } from "@effectionx/process";
import { lines } from "@effectionx/stream-helpers";
import { ensure, resource, sleep, spawn } from "effection";
import type { Operation } from "effection";
import { processReachable } from "@executablemd/runtime";
import { layoutString, swapsInto } from "./layout.ts";
import type { LayoutCell } from "./layout.ts";
import { useAttachClient } from "./attach-client.ts";
import type { AttachClient } from "./attach-client.ts";
import { TerminalTeardownFailed } from "./tmux.ts";
import type { Tmux } from "./tmux.ts";

/** What one prepared pane is, from the composite's side. */
export interface TmuxPane {
  readonly ordinal: number;
  /** tmux's `%N`. Never leaves this module. */
  readonly id: string;
  /** `ttys003`, the pane's terminal, as the worker will name it. */
  readonly tty: string;
  readonly pid: number;
  readonly cell: LayoutCell;
}

/** What the control client saw, classified. */
export type ControlEvent =
  | { kind: "client-attached"; client: string }
  | { kind: "client-detached"; client: string }
  | { kind: "sessions-changed" }
  | { kind: "layout-change" }
  | { kind: "exit" }
  | { kind: "closed" }
  | { kind: "other"; line: string };

export interface TmuxGridRequest {
  readonly session: string;
  readonly columns: number;
  readonly panes: number;
  readonly width: number;
  readonly height: number;
  readonly titles: readonly string[];
  /** The command that runs one pane's worker. */
  workerCommand(ordinal: number): readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
}

/** What stopping the server established. */
export interface ServerStopped {
  /** The server process is no longer reachable. */
  readonly gone: boolean;
  /** The server refuses to answer for its session. */
  readonly refuses: boolean;
}

export interface VisibleClient {
  readonly client: AttachClient;
  /** tmux's name for this client once attached: its tty. */
  readonly name: string;
}

export interface TmuxGrid {
  readonly panes: readonly TmuxPane[];
  /** Everything the control client reported, classified, in order. */
  readonly events: readonly ControlEvent[];
  /** Pane geometry now, for checking placement after a resize. */
  geometry(): Operation<readonly LayoutCell[]>;
  /** Show the grid on this process's terminal. */
  attach(): Operation<VisibleClient>;
  /** Ask the visible client to leave, so it restores the terminal itself. */
  detach(client: VisibleClient): Operation<void>;
  /**
   * Stop the server, and establish that it is gone.
   *
   * Refuses rather than reporting: an unproved teardown throws, because a
   * document that continued past one would be continuing while a terminal may
   * still be held.
   */
  stop(): Operation<ServerStopped>;
}

const CLIENT_POLL_MS = 20;
const STOP_LIMIT_MS = 5_000;
const DETACH_LIMIT_MS = 1_000;

/**
 * Prepare the whole hidden composite.
 *
 * The teardown is registered before the first command, so a cancellation
 * anywhere below still takes the server down: a half-built grid is exactly the
 * state that would otherwise leave a server, its workers and their sockets
 * behind.
 */
export function useTmuxGrid(tmux: Tmux, request: TmuxGridRequest): Operation<TmuxGrid> {
  return resource<TmuxGrid>(function* (provide) {
    const target = `${request.session}:0`;
    let serverPid = -1;

    /**
     * Take the server down, and prove it.
     *
     * `kill-server` succeeding is not the proof. What is asked afterwards, and
     * kept asking until both are true, is whether the process this grid started
     * is unreachable and whether the server refuses to answer for its own
     * session. The socket file is not part of it: it outlives the server.
     */
    function* stop(): Operation<ServerStopped> {
      yield* tmux.tryRun(["kill-server"]);
      const deadline = Date.now() + STOP_LIMIT_MS;
      let stopped: ServerStopped = { gone: false, refuses: false };
      do {
        stopped = {
          gone: serverPid < 0 || !(yield* processReachable(serverPid)),
          refuses: (yield* tmux.tryRun(["has-session", "-t", request.session])) === undefined,
        };
        if (stopped.gone && stopped.refuses) {
          return stopped;
        }
        yield* sleep(CLIENT_POLL_MS);
      } while (Date.now() < deadline);
      // Provider-neutral, deliberately: a reader is told which fact could not
      // be established, never the session name or socket that would identify
      // this invocation's private server.
      throw new TerminalTeardownFailed(
        stopped.gone
          ? "the terminal server still answers for its session"
          : "the terminal server did not stop",
      );
    }

    // Registered before the first command, so a preparation that fails halfway
    // is torn down under the same rule — and one that cannot be proved torn
    // down says so rather than passing quietly.
    yield* ensure(function* () {
      yield* stop();
    });

    yield* tmux.run([
      "new-session",
      "-d",
      "-s",
      request.session,
      "-x",
      String(request.width),
      "-y",
      String(request.height),
      "-c",
      request.cwd,
      ...request.workerCommand(0),
    ]);
    serverPid = Number(yield* tmux.run(["display", "-p", "#{pid}"]));
    // A pane whose worker has gone stays a pane, so its death is a fact the
    // composite can read rather than a pane that vanishes from under the
    // layout.
    yield* tmux.run(["set", "-g", "remain-on-exit", "on"]);
    yield* tmux.run(["set", "-g", "status", "off"]);
    yield* tmux.run(["set", "-g", "pane-border-status", "top"]);
    yield* tmux.run(["set", "-g", "pane-border-format", " #{pane_title} "]);

    // Split whichever pane has the most room, so a small window still fits
    // every pane. Where each one ends up is the explicit layout's business,
    // not this loop's.
    const paneIds: string[] = [yield* tmux.run(["display", "-p", "-t", target, "#{pane_id}"])];
    for (let ordinal = 1; ordinal < request.panes; ordinal++) {
      const roomiest = yield* largestPane(tmux, target);
      const direction = roomiest.width >= roomiest.height * 2 ? "-h" : "-v";
      paneIds.push(
        yield* tmux.run([
          "split-window",
          "-d",
          direction,
          "-t",
          roomiest.id,
          "-c",
          request.cwd,
          "-P",
          "-F",
          "#{pane_id}",
          ...request.workerCommand(ordinal),
        ]),
      );
    }

    const [width, height] = (yield* tmux.run([
      "display",
      "-p",
      "-t",
      target,
      "#{window_width} #{window_height}",
    ]))
      .split(" ")
      .map(Number);
    yield* tmux.run([
      "select-layout",
      "-t",
      target,
      layoutString(
        width ?? request.width,
        height ?? request.height,
        request.columns,
        paneIds.map(paneNumber),
      ),
    ]);

    // tmux fills the layout's leaves in window-list order and ignores the ids
    // the string names, so authored order is imposed here. Swapping preserves
    // the cells: what moves is which pane is in which one.
    const placed = (yield* readPanes(tmux, target, paneIds)).slice().sort(byPosition);
    for (const swap of swapsInto(
      placed.map((pane) => paneNumber(pane.id)),
      paneIds.map(paneNumber),
    )) {
      const from = placed[swap.from];
      const to = placed[swap.to];
      if (from === undefined || to === undefined) {
        continue;
      }
      yield* tmux.run(["swap-pane", "-d", "-s", from.id, "-t", to.id]);
      placed[swap.to] = from;
      placed[swap.from] = to;
    }

    for (const [ordinal, id] of paneIds.entries()) {
      yield* tmux.run([
        "select-pane",
        "-t",
        id,
        "-T",
        request.titles[ordinal] ?? `pane ${ordinal}`,
      ]);
    }
    const panes = yield* readPanes(tmux, target, paneIds);

    // The control client. `-f no-output` is what keeps pane bytes out of this
    // process: what arrives is the server's own account of its clients.
    const events: ControlEvent[] = [];
    yield* spawn(function* () {
      const [program = "tmux", ...argv] = tmux.argv([
        "-C",
        "attach-session",
        "-f",
        "no-output",
        "-t",
        request.session,
      ]);
      const client = yield* exec(program, { arguments: argv, env: request.env });
      const reported = yield* lines()(client.stdout);
      let next = yield* reported.next();
      while (!next.done) {
        events.push(classify(next.value));
        next = yield* reported.next();
      }
      // EOF on the control channel is its own event, and is not a detach.
      events.push({ kind: "closed" });
    });

    yield* provide({
      panes,
      events,
      *geometry() {
        return (yield* readPanes(tmux, target, paneIds)).map((pane) => pane.cell);
      },
      *attach() {
        // Its own lifecycle, not a pane child's. A pane child is settled by
        // sweeping its process group and its terminal; this client's terminal
        // is the reader's, and everything holding it is the run.
        let named: string | undefined;
        const client = yield* useAttachClient({
          argv: tmux.argv(["attach-session", "-t", request.session]),
          cwd: request.cwd,
          env: request.env,
          *askToLeave() {
            if (named === undefined) {
              return;
            }
            yield* tmux.tryRun(["detach-client", "-t", named]);
          },
        });
        named = yield* awaitClient(tmux);
        return { client, name: named };
      },
      *detach(client) {
        // The ask is inside `stop()`, which is what makes the order the same
        // however the grid ends: asked first, and only this exact process
        // insisted on afterwards.
        yield* client.client.stop();
      },
      stop,
    });
  });
}

/** `%3` → `3`, which is what a layout string names a pane by. */
function paneNumber(id: string): number {
  return Number(id.replace(/^%/, ""));
}

function byPosition(left: TmuxPane, right: TmuxPane): number {
  return left.cell.top - right.cell.top || left.cell.left - right.cell.left;
}

/** Every pane the window holds now, in the order `paneIds` names them. */
function* readPanes(
  tmux: Tmux,
  target: string,
  paneIds: readonly string[],
): Operation<readonly TmuxPane[]> {
  const listed = yield* tmux.run([
    "list-panes",
    "-t",
    target,
    "-F",
    "#{pane_id} #{pane_tty} #{pane_pid} #{pane_left} #{pane_top} #{pane_width} #{pane_height}",
  ]);
  const found = new Map<string, TmuxPane>();
  for (const line of listed.split("\n")) {
    const [id, tty, pid, left, top, paneWidth, paneHeight] = line.trim().split(/\s+/);
    if (id === undefined || tty === undefined || pid === undefined) {
      continue;
    }
    found.set(id, {
      ordinal: paneIds.indexOf(id),
      id,
      // The worker reports `ttys003`; tmux reports `/dev/ttys003`.
      tty: tty.replace(/^\/dev\//, ""),
      pid: Number(pid),
      cell: {
        ordinal: paneIds.indexOf(id),
        left: Number(left),
        top: Number(top),
        width: Number(paneWidth),
        height: Number(paneHeight),
      },
    });
  }
  const panes: TmuxPane[] = [];
  for (const id of paneIds) {
    const pane = found.get(id);
    if (pane !== undefined) {
      panes.push(pane);
    }
  }
  return panes;
}

/** The pane with the most room, which is where the next split goes. */
function* largestPane(
  tmux: Tmux,
  target: string,
): Operation<{ id: string; width: number; height: number }> {
  const listed = yield* tmux.run([
    "list-panes",
    "-t",
    target,
    "-F",
    "#{pane_id} #{pane_width} #{pane_height}",
  ]);
  let best: { id: string; width: number; height: number } | undefined;
  for (const line of listed.split("\n")) {
    const [id, width, height] = line.trim().split(/\s+/);
    if (id === undefined || width === undefined || height === undefined) {
      continue;
    }
    const pane = { id, width: Number(width), height: Number(height) };
    if (best === undefined || pane.width * pane.height > best.width * best.height) {
      best = pane;
    }
  }
  if (best === undefined) {
    throw new Error("this grid's window holds no panes");
  }
  return best;
}

function* clientNames(tmux: Tmux): Operation<readonly string[]> {
  const listed = yield* tmux.tryRun(["list-clients", "-F", "#{client_name}"]);
  return listed === undefined || listed.length === 0 ? [] : listed.split("\n");
}

/** The client that just attached, once the server lists one it did not have. */
function* awaitClient(tmux: Tmux): Operation<string> {
  const deadline = Date.now() + DETACH_LIMIT_MS * 5;
  while (Date.now() < deadline) {
    const names = yield* clientNames(tmux);
    // The control client attaches with no tty of its own, so a named client is
    // the visible one.
    const visible = names.filter((name) => name.length > 0 && name !== "(none)");
    const found = visible.at(-1);
    if (found !== undefined) {
      return found;
    }
    yield* sleep(CLIENT_POLL_MS);
  }
  throw new Error("the grid was shown, but the server never listed a client for it");
}

/** One control-mode line, as the lifecycle event it reports. */
export function classify(line: string): ControlEvent {
  if (line.startsWith("%client-detached")) {
    return { kind: "client-detached", client: line.split(/\s+/)[1] ?? "" };
  }
  if (line.startsWith("%client-session-changed") || line.startsWith("%client-attached")) {
    return { kind: "client-attached", client: line.split(/\s+/)[1] ?? "" };
  }
  if (line.startsWith("%sessions-changed")) {
    return { kind: "sessions-changed" };
  }
  if (line.startsWith("%layout-change")) {
    return { kind: "layout-change" };
  }
  if (line.startsWith("%exit")) {
    return { kind: "exit" };
  }
  return { kind: "other", line };
}
