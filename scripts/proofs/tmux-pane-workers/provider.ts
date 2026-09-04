/**
 * The tmux side of the topology: one hidden invocation-private server, an
 * explicit grid of panes each started on its worker, a control-mode client
 * that reports what the server sees, the one visible attachment, and a
 * teardown that proves the server is gone.
 *
 * Every tmux identifier here — socket path, session name, window, pane ids,
 * client names, the server pid — stays inside this module's values. The proof
 * writes them to its evidence and nowhere else.
 *
 * The control client attaches with `-f no-output`, so pane bytes never travel
 * through the parent: what it receives is `%client-detached`,
 * `%client-session-changed`, `%sessions-changed`, `%layout-change` and
 * `%exit`, which is exactly the set the proof classifies. An attach client's
 * exit code cannot do that classification: on this tmux it is 0 after
 * `detach-client`, 0 after `kill-session`, and 1 after `kill-server`.
 */

import { join } from "node:path";
import { exec } from "@effectionx/process";
import { lines } from "@effectionx/stream-helpers";
import { ensure, resource, sleep, spawn } from "effection";
import type { Operation } from "effection";
import { exists } from "@effectionx/fs";
import { useInteractiveProcess } from "./interactive-process.ts";
import type { InteractiveProcess } from "./interactive-process.ts";
import { layoutString, rowMajorCells } from "./layout.ts";
import type { Cell } from "./layout.ts";
import { isReachable } from "./processes.ts";

export interface Tmux {
  socket: string;
  /** Run one tmux command against the private server; stdout, trimmed. */
  run(args: string[]): Operation<string>;
  /** The same, returning `undefined` instead of throwing on failure. */
  tryRun(args: string[]): Operation<string | undefined>;
}

export class TmuxCommandFailed extends Error {
  override name = "TmuxCommandFailed";
  constructor(args: string[], stderr: string, code: number | undefined) {
    super(`tmux ${args.join(" ")} failed (${code ?? "signal"}): ${stderr.trim()}`);
  }
}

export function tmuxAt(socket: string, env: Record<string, string>): Tmux {
  const base = ["-S", socket, "-f", "/dev/null"];
  function* run(args: string[]): Operation<string> {
    const result = yield* exec("tmux", { arguments: [...base, ...args], env }).join();
    if (result.code !== 0) {
      throw new TmuxCommandFailed(args, result.stderr, result.code);
    }
    return result.stdout.trim();
  }
  return {
    socket,
    run,
    *tryRun(args) {
      const result = yield* exec("tmux", { arguments: [...base, ...args], env }).join();
      return result.code === 0 ? result.stdout.trim() : undefined;
    },
  };
}

export interface PaneInfo {
  ordinal: number;
  id: string;
  /** `/dev/ttys002` */
  tty: string;
  pid: number;
  cell: Cell;
}

export type ControlEvent =
  | { kind: "client-attached"; client: string }
  | { kind: "client-detached"; client: string }
  | { kind: "sessions-changed" }
  | { kind: "layout-change" }
  | { kind: "output"; pane: string }
  | { kind: "exit" }
  | { kind: "closed" }
  | { kind: "other"; line: string };

export interface GridRequest {
  session: string;
  columns: number;
  panes: number;
  width: number;
  height: number;
  titles: string[];
  workerCommand(ordinal: number): string[];
  cwd: string;
  env: Record<string, string>;
}

export interface VisibleClient {
  process: InteractiveProcess;
  /** tmux's name for this client once it is attached: its tty. */
  name: string;
}

export interface TmuxGrid {
  tmux: Tmux;
  session: string;
  serverPid: number;
  panes: PaneInfo[];
  /** Everything the control client reported, in order. */
  controlLog: string[];
  /** The same, classified; `closed` is appended when the client ends. */
  events: ControlEvent[];
  /** Current pane geometry, for verifying placement after a resize. */
  geometry(): Operation<Cell[]>;
  /** Attach on this process's terminal; resolves once tmux lists the client. */
  attach(): Operation<VisibleClient>;
  detach(client: VisibleClient): Operation<void>;
  /** `kill-server`, then wait until the server pid and socket are gone. */
  stop(): Operation<StopProof>;
}

export interface StopProof {
  serverGone: boolean;
  unreachable: boolean;
  socketFileRemains: boolean;
}

export function serverSocketPath(directory: string): string {
  return join(directory, "s");
}

const CLIENT_POLL_MS = 20;
const STOP_LIMIT_MS = 5_000;

/**
 * Prepare the whole hidden composite: server, panes on their workers, explicit
 * layout, titles, control client. Nothing is visible until `attach()`.
 */
export function useTmuxGrid(directory: string, request: GridRequest): Operation<TmuxGrid> {
  return resource(function* (provide) {
    const tmux = tmuxAt(serverSocketPath(directory), request.env);
    const target = `${request.session}:0`;
    let serverPid = -1;

    // Registered first: a halt anywhere below must still take the server down.
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
    yield* tmux.run(["set", "-g", "remain-on-exit", "on"]);
    yield* tmux.run(["set", "-g", "status", "off"]);
    yield* tmux.run(["set", "-g", "pane-border-status", "top"]);
    yield* tmux.run(["set", "-g", "pane-border-format", " #{pane_title} "]);

    // Panes are created by splitting whichever pane has the most room, so a
    // small window still fits every pane; the explicit layout below decides
    // where each one ends up.
    const paneIds: string[] = [yield* tmux.run(["display", "-p", "-t", target, "#{pane_id}"])];
    for (let ordinal = 1; ordinal < request.panes; ordinal++) {
      const roomiest = yield* largestPane(tmux, target);
      const direction = roomiest.width >= roomiest.height * 2 ? "-h" : "-v";
      const id = yield* tmux.run([
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
      ]);
      paneIds.push(id);
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
    const layout = layoutString(
      width,
      height,
      request.columns,
      paneIds.map((id) => Number(id.slice(1))),
    );
    yield* tmux.run(["select-layout", "-t", target, layout]);
    // tmux assigns panes to the layout's leaves in window-list order and
    // ignores the ids written in the string, so the authored order is imposed
    // afterwards: a pane found at the wrong visual position is swapped with
    // the one that belongs there. Swapping preserves the cells.
    for (let pass = 0; pass < paneIds.length; pass++) {
      const visual = (yield* paneFacts(tmux, target, paneIds)).toSorted(
        (a, b) => a.cell.top - b.cell.top || a.cell.left - b.cell.left,
      );
      const misplaced = visual.findIndex((pane, index) => pane.id !== paneIds[index]);
      if (misplaced < 0) {
        break;
      }
      yield* tmux.run(["swap-pane", "-d", "-s", paneIds[misplaced], "-t", visual[misplaced].id]);
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
    const panes = yield* paneFacts(tmux, target, paneIds);

    const controlLog: string[] = [];
    const events: ControlEvent[] = [];
    yield* spawn(function* () {
      const client = yield* exec("tmux", {
        arguments: [
          "-S",
          tmux.socket,
          "-f",
          "/dev/null",
          "-C",
          "attach-session",
          "-f",
          "no-output",
          "-t",
          request.session,
        ],
        env: request.env,
      });
      const subscription = yield* lines()(client.stdout);
      let next = yield* subscription.next();
      while (!next.done) {
        controlLog.push(next.value);
        events.push(classify(next.value));
        next = yield* subscription.next();
      }
      events.push({ kind: "closed" });
    });

    // The socket file outlives the server on this tmux, so "gone" is the
    // server pid being unreachable and nothing answering on the socket.
    function* stop(): Operation<StopProof> {
      yield* tmux.tryRun(["kill-server"]);
      const deadline = Date.now() + STOP_LIMIT_MS;
      let proof: StopProof;
      do {
        proof = {
          serverGone: serverPid < 0 || !isReachable(serverPid),
          unreachable: (yield* tmux.tryRun(["has-session", "-t", request.session])) === undefined,
          socketFileRemains: yield* exists(tmux.socket),
        };
        if (proof.serverGone && proof.unreachable) {
          return proof;
        }
        yield* sleep(CLIENT_POLL_MS);
      } while (Date.now() < deadline);
      return proof;
    }

    yield* provide({
      tmux,
      session: request.session,
      serverPid,
      panes,
      controlLog,
      events,
      *geometry() {
        return (yield* paneFacts(tmux, target, paneIds)).map((pane) => pane.cell);
      },
      *attach() {
        const before = new Set(yield* clientNames(tmux));
        const process = yield* useInteractiveProcess({
          command: [
            "tmux",
            "-S",
            tmux.socket,
            "-f",
            "/dev/null",
            "attach-session",
            "-t",
            request.session,
          ],
          cwd: request.cwd,
          env: request.env,
        });
        const ready = yield* process.ready;
        if (!ready.ok) {
          throw ready.error;
        }
        let name: string | undefined;
        // Registered after the process, so it runs first on teardown: a client
        // asked to detach restores the terminal itself, and a client that is
        // signalled instead may not. The process's own escalation remains
        // behind it for a client that does not leave.
        yield* ensure(function* () {
          if (name === undefined) {
            return;
          }
          yield* tmux.tryRun(["detach-client", "-t", name]);
          const deadline = Date.now() + 1_000;
          while (Date.now() < deadline && (yield* clientNames(tmux)).includes(name)) {
            yield* sleep(CLIENT_POLL_MS);
          }
        });
        while (true) {
          const now = yield* clientNames(tmux);
          const added = now.find((candidate) => !before.has(candidate));
          if (added !== undefined) {
            name = added;
            return { process, name: added };
          }
          yield* sleep(CLIENT_POLL_MS);
        }
      },
      *detach(client) {
        yield* tmux.run(["detach-client", "-t", client.name]);
      },
      stop,
    });
  });
}

function classify(line: string): ControlEvent {
  const [tag, ...rest] = line.split(" ");
  switch (tag) {
    case "%client-session-changed":
      return { kind: "client-attached", client: rest[0] ?? "" };
    case "%client-detached":
      return { kind: "client-detached", client: rest[0] ?? "" };
    case "%sessions-changed":
      return { kind: "sessions-changed" };
    case "%layout-change":
      return { kind: "layout-change" };
    case "%output":
      return { kind: "output", pane: rest[0] ?? "" };
    case "%exit":
      return { kind: "exit" };
    default:
      return { kind: "other", line };
  }
}

/** Non-control clients only: the visible attachments. */
function* clientNames(tmux: Tmux): Operation<string[]> {
  const listed = yield* tmux.tryRun([
    "list-clients",
    "-F",
    "#{client_control_mode} #{client_name}",
  ]);
  if (listed === undefined) {
    return [];
  }
  return listed
    .split("\n")
    .map((line) => line.trim().split(" "))
    .filter((parts) => parts[0] === "0" && parts[1] !== undefined)
    .map((parts) => parts[1]);
}

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
    const [id, width, height] = line.split(" ");
    const candidate = { id, width: Number(width), height: Number(height) };
    if (best === undefined || candidate.width * candidate.height > best.width * best.height) {
      best = candidate;
    }
  }
  if (best === undefined) {
    throw new Error("no panes listed");
  }
  return best;
}

function* paneFacts(tmux: Tmux, target: string, paneIds: string[]): Operation<PaneInfo[]> {
  const listed = yield* tmux.run([
    "list-panes",
    "-t",
    target,
    "-F",
    "#{pane_id} #{pane_tty} #{pane_pid} #{pane_left} #{pane_top} #{pane_width} #{pane_height}",
  ]);
  const byId = new Map<string, PaneInfo>();
  for (const line of listed.split("\n")) {
    const [id, tty, pid, left, top, width, height] = line.split(" ");
    const ordinal = paneIds.indexOf(id);
    if (ordinal < 0) {
      continue;
    }
    byId.set(id, {
      ordinal,
      id,
      tty,
      pid: Number(pid),
      cell: {
        ordinal,
        left: Number(left),
        top: Number(top),
        width: Number(width),
        height: Number(height),
      },
    });
  }
  return paneIds.map((id) => {
    const info = byId.get(id);
    if (info === undefined) {
      throw new Error(`pane ${id} disappeared`);
    }
    return info;
  });
}

export { rowMajorCells };
