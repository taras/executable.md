/**
 * A tmux server, modelled well enough to hold the composite to its contract.
 *
 * What matters here is the behaviour the production code exists to work
 * around, so the fake reproduces it deliberately:
 *
 * - **a layout string's leaves are filled in window-list order, and the pane
 *   ids written in them are ignored.** This is why authored order is imposed by
 *   swaps rather than by describing it, and a fake that honoured the ids would
 *   make the swap logic untestable and unnecessary-looking;
 * - `kill-server` leaves the socket file behind, so "gone" cannot be the file's
 *   absence;
 * - `detach-client` removes a client and lets its process leave, while
 *   `kill-server` ends everything at once.
 *
 * The server's own liveness is a number this fake owns, and the composite asks
 * the runtime's process seam about it — so a test can say "the server did not
 * go away" without there being a process to refuse to die.
 */

import { appendFile } from "node:fs/promises";
import { until } from "effection";
import type { Operation } from "effection";
import { TmuxCommandFailed } from "../../src/terminal/tmux.ts";
import type { Tmux } from "../../src/terminal/tmux.ts";

export interface FakePane {
  id: string;
  tty: string;
  pid: number;
  left: number;
  top: number;
  width: number;
  height: number;
  title: string;
  /** The command the pane was created with, so a test can read it back. */
  command: readonly string[];
}

export interface FakeTmuxOptions {
  /** The window's size, which the layout is computed against. */
  readonly width?: number;
  readonly height?: number;
  /** Where client fixtures read what the server did. */
  readonly script: string;
  /** The program a client fixture runs. */
  readonly clientCommand: (mode: "control" | "attach", script: string) => readonly string[];
  /** Fail this command once, with this message. */
  readonly failOnce?: { readonly command: string; readonly message: string };
  /** Name the server gives an attached client. */
  readonly clientName?: string;
  /**
   * A client that does not leave when it is asked.
   *
   * The server still reports the detach, but the client's process stays — which
   * is the only way to reach the escalation that follows the ask.
   */
  readonly stubbornClient?: boolean;
}

export interface FakeTmux extends Tmux {
  /** Every command the composite issued, in order, as one string each. */
  readonly issued: readonly string[];
  readonly panes: readonly FakePane[];
  /** The server pid the composite will ask the process seam about. */
  readonly serverPid: number;
  readonly alive: () => boolean;
  readonly clients: readonly string[];
  /** Say something on the control channel, as the server would. */
  say(line: string): Operation<void>;
}

/** Cells a layout string describes, in the order it lists them. */
function readLayoutCells(
  layout: string,
): { left: number; top: number; width: number; height: number }[] {
  const cells: { left: number; top: number; width: number; height: number }[] = [];
  const leaf = /(\d+)x(\d+),(\d+),(\d+),(\d+)(?![\dx])/g;
  let match = leaf.exec(layout);
  while (match !== null) {
    const [, width, height, left, top] = match;
    cells.push({
      left: Number(left),
      top: Number(top),
      width: Number(width),
      height: Number(height),
    });
    match = leaf.exec(layout);
  }
  return cells;
}

export function createFakeTmux(options: FakeTmuxOptions): FakeTmux {
  const width = options.width ?? 160;
  const height = options.height ?? 48;
  const issued: string[] = [];
  /** Window-list order — the order panes were created, which tmux fills by. */
  const panes: FakePane[] = [];
  const clients: string[] = [];
  let alive = false;
  let nextPane = 0;
  let nextPid = 4000;
  const serverPid = 3999;
  let failed = false;

  function pane(id: string): FakePane | undefined {
    return panes.find((candidate) => candidate.id === id);
  }

  /**
   * Create a pane, and put it in the window list where tmux would.
   *
   * A split inserts the new pane *immediately after the one it split*, not at
   * the end. That is what makes window-list order differ from creation order
   * once panes are split by size rather than in sequence — and therefore what
   * makes the authored order need imposing.
   */
  function create(command: readonly string[], after?: string): FakePane {
    const created: FakePane = {
      id: `%${nextPane++}`,
      tty: `ttys90${nextPane}`,
      pid: nextPid++,
      left: 0,
      top: 0,
      width,
      height,
      title: "",
      command,
    };
    const at = after === undefined ? -1 : panes.findIndex((entry) => entry.id === after);
    if (at < 0) {
      panes.push(created);
    } else {
      panes.splice(at + 1, 0, created);
    }
    return created;
  }

  /** The pane command trailing one tmux invocation, after its last flag. */
  function trailing(args: readonly string[], lastFlagValue: string): readonly string[] {
    const at = args.lastIndexOf(lastFlagValue);
    return at < 0 ? [] : args.slice(at + 1);
  }

  function* answer(args: readonly string[]): Operation<string | undefined> {
    issued.push(args.join(" "));
    const [command] = args;
    if (options.failOnce !== undefined && !failed && command === options.failOnce.command) {
      failed = true;
      return undefined;
    }
    if (command !== "kill-server" && command !== "new-session" && !alive) {
      // Every other command needs a server.
      return undefined;
    }
    switch (command) {
      case "new-session": {
        alive = true;
        // `... -c <cwd> <command...>`
        const cwd = args[args.indexOf("-c") + 1] ?? "";
        create(trailing(args, cwd));
        return "";
      }
      case "display": {
        const format = args.at(-1) ?? "";
        if (format === "#{pid}") {
          return String(serverPid);
        }
        if (format === "#{pane_id}") {
          return panes[0]?.id ?? "";
        }
        if (format === "#{window_width} #{window_height}") {
          return `${width} ${height}`;
        }
        return "";
      }
      case "set":
        return "";
      case "split-window": {
        // `... -t <target> -c <cwd> -P -F #{pane_id} <command...>`
        const target = args[args.indexOf("-t") + 1];
        return create(trailing(args, "#{pane_id}"), target).id;
      }
      case "list-panes": {
        const format = args.at(-1) ?? "";
        return panes
          .map((entry) =>
            format.includes("pane_tty")
              ? `${entry.id} /dev/${entry.tty} ${entry.pid} ${entry.left} ${entry.top} ` +
                `${entry.width} ${entry.height}`
              : `${entry.id} ${entry.width} ${entry.height}`,
          )
          .join("\n");
      }
      case "select-layout": {
        // The behaviour the swaps exist for: cells go to panes in window-list
        // order, and the ids the string names are ignored.
        const cells = readLayoutCells(args.at(-1) ?? "");
        for (const [index, entry] of panes.entries()) {
          const cell = cells[index];
          if (cell !== undefined) {
            entry.left = cell.left;
            entry.top = cell.top;
            entry.width = cell.width;
            entry.height = cell.height;
          }
        }
        return "";
      }
      case "swap-pane": {
        const source = pane(args[args.indexOf("-s") + 1] ?? "");
        const target = pane(args[args.indexOf("-t") + 1] ?? "");
        if (source === undefined || target === undefined) {
          return undefined;
        }
        // Panes exchange positions; the cells stay where they are.
        const held = {
          left: source.left,
          top: source.top,
          width: source.width,
          height: source.height,
        };
        source.left = target.left;
        source.top = target.top;
        source.width = target.width;
        source.height = target.height;
        target.left = held.left;
        target.top = held.top;
        target.width = held.width;
        target.height = held.height;
        return "";
      }
      case "select-pane": {
        const found = pane(args[args.indexOf("-t") + 1] ?? "");
        if (found === undefined) {
          return undefined;
        }
        found.title = args[args.indexOf("-T") + 1] ?? "";
        return "";
      }
      case "list-clients":
        return clients.join("\n");
      case "detach-client": {
        const name = args[args.indexOf("-t") + 1] ?? "";
        const at = clients.indexOf(name);
        if (at >= 0) {
          clients.splice(at, 1);
        }
        if (options.stubbornClient !== true) {
          yield* until(appendFile(options.script, "detached\n"));
        }
        yield* until(appendFile(options.script, `%client-detached ${name}\n`));
        return "";
      }
      case "has-session":
        return alive ? "" : undefined;
      case "kill-server": {
        if (alive) {
          alive = false;
          yield* until(appendFile(options.script, "detached\n%exit\n"));
        }
        clients.length = 0;
        return "";
      }
      default:
        return "";
    }
  }

  return {
    socket: "/fake/socket",
    issued,
    panes,
    serverPid,
    alive: () => alive,
    clients,
    argv(args) {
      const mode = args.includes("-C") ? "control" : "attach";
      if (mode === "attach") {
        // A visible client the server can list, named the way tmux names one.
        clients.push(options.clientName ?? "/dev/ttys999");
      }
      return options.clientCommand(mode, options.script);
    },
    *say(line) {
      yield* until(appendFile(options.script, `${line}\n`));
    },
    *run(args) {
      const answered = yield* answer(args);
      if (answered === undefined) {
        // The same failure the real surface raises, so what a caller sees on
        // this path is what a caller sees on that one.
        throw new TmuxCommandFailed(args[0] ?? "");
      }
      return answered;
    },
    *tryRun(args) {
      return yield* answer(args);
    },
  };
}
