/**
 * What the host can observe about processes and terminals
 * (architecture.md §Interactive terminal grids, "there is no implicit grid
 * timeout").
 *
 * A terminal grid may not report a pane settled, admit the next launch into it,
 * or let the document continue while something a launch started can still act.
 * Deciding that is not a matter of having sent a signal: a PID, a successful
 * delivery, an attach client going away and an elapsed timeout each prove
 * nothing. What proves it is asking the kernel — is this process still there,
 * is anything still descended from it, is anything still in its process group,
 * does anything still hold its terminal open — and getting "no" to all four.
 *
 * That asking is host-specific, so it lives behind this seam. `ps` and `lsof`
 * are what a POSIX host has; a host with a cheaper primitive replaces the
 * handler without touching what a quiescence proof consists of, and a host that
 * can observe none of it refuses rather than guessing. The refusal matters as
 * much as the answers: a grid that cannot establish these facts is a grid whose
 * teardown failed, and the document stops.
 *
 * Nothing here decides policy. It reports, and the caller — a pane worker
 * finishing one launch, a provider tearing a grid down — decides what the
 * report means.
 */

import { type Api, createApi } from "@effectionx/context-api";
import { until } from "effection";
import type { Operation } from "effection";
import { execFile } from "node:child_process";
import process from "node:process";

/** One process, as the host's table describes it. */
export interface ProcessFacts {
  readonly pid: number;
  readonly ppid: number;
  /** The process group. A launch's group is what its job control acts on. */
  readonly pgid: number;
  /** `ttys002`, or `??` for a process with no controlling terminal. */
  readonly tty: string;
  /**
   * The controlling terminal's foreground process group, or -1.
   *
   * This is how a shell's job control is observed from outside, rather than
   * inferred from what it printed.
   */
  readonly tpgid: number;
  readonly command: string;
}

/** What a signal delivery established, which is not the same as what it did. */
export type SignalDelivery =
  /** The kernel accepted it. The process was there to receive it. */
  | "delivered"
  /** There was no such process. Gone is the outcome a signal was asking for. */
  | "absent"
  /** It could not be delivered. This says nothing about whether it is gone. */
  | "refused";

export type TerminalSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGKILL";

export interface TerminalProcessHandler {
  /** Every process the host can see, in one consistent reading. */
  table(): Operation<readonly ProcessFacts[]>;
  /**
   * Every process holding this terminal device open.
   *
   * The device is a path — `/dev/ttys002`. An empty answer is the fact a
   * teardown is looking for; a host that cannot enumerate holders must refuse
   * rather than answer empty, because "nobody" and "I cannot see" are the two
   * answers a quiescence proof must never confuse.
   */
  holders(device: string): Operation<readonly number[]>;
  /** Send one signal, and say what that established. */
  deliver(pid: number, signal: TerminalSignal): Operation<SignalDelivery>;
  /** Whether the kernel still knows this pid. */
  reachable(pid: number): Operation<boolean>;
}

export const TERMINAL_PROCESSES_API = "runtime.terminalProcesses";

export const TERMINAL_PROCESSES_UNAVAILABLE =
  "this host cannot observe processes or terminal holders, so it cannot prove " +
  "that a terminal pane is free. `xmd run` on a POSIX host installs the " +
  "observer; a host that installs none refuses rather than reporting a pane " +
  "quiet it has not checked.";

export class TerminalProcessesUnavailableError extends Error {
  override name = "TerminalProcessesUnavailableError";
  constructor(message: string = TERMINAL_PROCESSES_UNAVAILABLE) {
    super(message);
  }
}

/**
 * The observation surface. Its own default refuses every question.
 *
 * Refusing is the safe answer: every caller here is deciding whether something
 * may still be running, and a host that cannot see has not established that
 * nothing is.
 */
export const TerminalProcesses: Api<TerminalProcessHandler> = createApi<TerminalProcessHandler>(
  TERMINAL_PROCESSES_API,
  {
    // deno-lint-ignore require-yield
    *table(): Operation<readonly ProcessFacts[]> {
      throw new TerminalProcessesUnavailableError();
    },
    // deno-lint-ignore require-yield
    *holders(_device: string): Operation<readonly number[]> {
      throw new TerminalProcessesUnavailableError();
    },
    // deno-lint-ignore require-yield
    *deliver(_pid: number, _signal: TerminalSignal): Operation<SignalDelivery> {
      throw new TerminalProcessesUnavailableError();
    },
    // deno-lint-ignore require-yield
    *reachable(_pid: number): Operation<boolean> {
      throw new TerminalProcessesUnavailableError();
    },
  },
);

export function processTable(): Operation<readonly ProcessFacts[]> {
  return TerminalProcesses.operations.table();
}

export function terminalHolders(device: string): Operation<readonly number[]> {
  return TerminalProcesses.operations.holders(device);
}

export function deliverSignal(pid: number, signal: TerminalSignal): Operation<SignalDelivery> {
  return TerminalProcesses.operations.deliver(pid, signal);
}

export function processReachable(pid: number): Operation<boolean> {
  return TerminalProcesses.operations.reachable(pid);
}

/**
 * Every process below `pid` by parent links, in one reading of the table.
 *
 * Read from a snapshot rather than the live kernel on purpose: a child that is
 * killed reparents to init, so a table taken after the first signal no longer
 * says who its children were. The snapshot has to be older than the signal.
 */
export function descendantsOf(
  table: readonly ProcessFacts[],
  pid: number,
): readonly ProcessFacts[] {
  const found: ProcessFacts[] = [];
  const seen = new Set<number>([pid]);
  const frontier = [pid];
  while (frontier.length > 0) {
    const parent = frontier.pop();
    for (const row of table) {
      if (row.ppid === parent && !seen.has(row.pid)) {
        seen.add(row.pid);
        found.push(row);
        frontier.push(row.pid);
      }
    }
  }
  return found;
}

/** Every process in one process group, in one reading of the table. */
export function groupMembers(
  table: readonly ProcessFacts[],
  pgid: number,
): readonly ProcessFacts[] {
  return table.filter((row) => row.pgid === pgid);
}

/**
 * Who a launch is accountable for, taken before anything is signalled.
 *
 * Order matters and is the whole point: after the first signal a killed child's
 * children are reparented, so a snapshot taken then would name fewer processes
 * than the launch actually started.
 */
export interface PaneOccupants {
  /** The child the launch started. */
  readonly child: number;
  /** Everything descended from it when the snapshot was taken. */
  readonly descendants: readonly number[];
  /** Everything sharing its process group when the snapshot was taken. */
  readonly group: readonly number[];
  /** The pane's terminal device, when the host could name one. */
  readonly device?: string;
}

/** Take that snapshot from one reading of the table. */
export function paneOccupants(
  table: readonly ProcessFacts[],
  child: number,
  device?: string,
): PaneOccupants {
  const facts = table.find((row) => row.pid === child);
  const descendants = descendantsOf(table, child).map((row) => row.pid);
  const group =
    facts === undefined
      ? []
      : groupMembers(table, facts.pgid)
          .map((row) => row.pid)
          .filter((pid) => pid !== child);
  return {
    child,
    descendants,
    group,
    ...(device === undefined ? {} : { device }),
  };
}

/** What is still there, out of everything a launch was accountable for. */
export interface PaneQuiescence {
  /** True only when nothing below is still there. */
  readonly quiet: boolean;
  /** Snapshot members the kernel still knows. */
  readonly running: readonly number[];
  /** Processes still holding the pane's terminal open. */
  readonly holding: readonly number[];
}

/**
 * Ask whether everything that snapshot named has stopped, and whether anything
 * still holds the pane's terminal.
 *
 * Both questions, every time. A pane whose child is gone but whose terminal
 * something else still holds is not a pane the next launch may have, and a pane
 * nobody holds whose process group still has a member in it is not one either.
 */
export function establishQuiescence(occupants: PaneOccupants): Operation<PaneQuiescence> {
  return (function* (): Operation<PaneQuiescence> {
    const running: number[] = [];
    for (const pid of [occupants.child, ...occupants.descendants, ...occupants.group]) {
      if (running.includes(pid)) {
        continue;
      }
      if (yield* processReachable(pid)) {
        running.push(pid);
      }
    }
    // Asked even when processes remain, so one report says everything that is
    // still true rather than the first thing that was.
    const holding =
      occupants.device === undefined ? [] : [...(yield* terminalHolders(occupants.device))];
    return { quiet: running.length === 0 && holding.length === 0, running, holding };
  })();
}

/**
 * Install the POSIX observer: `ps` for the table, `lsof` for terminal holders.
 *
 * `ps` rather than `/proc`, because macOS is a supported foreground host. The
 * `lsof` sweep is the expensive half and grows with the process count, which is
 * why it is behind this seam: a host with a cheaper way to enumerate holders
 * replaces the handler and changes nothing about what has to be established.
 */
export function* installPosixTerminalProcesses(): Operation<void> {
  yield* TerminalProcesses.around(
    {
      *table(): Operation<readonly ProcessFacts[]> {
        const output = yield* until(run("ps", ["-axo", "pid=,ppid=,pgid=,tty=,tpgid=,command="]));
        return readTable(output);
      },
      *holders([device]): Operation<readonly number[]> {
        // `lsof -t` answers with pids and nothing else, and exits non-zero when
        // nobody holds the file — which is an answer, not a failure.
        const output = yield* until(run("lsof", ["-t", device]));
        return output
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => /^\d+$/.test(line))
          .map(Number);
      },
      // deno-lint-ignore require-yield
      *deliver([pid, signal]): Operation<SignalDelivery> {
        try {
          process.kill(pid, signal);
          return "delivered";
        } catch (error) {
          // Gone already is the outcome the signal was asking for. Anything
          // else is a delivery that did not happen, and is not evidence that
          // the process stopped.
          return noSuchProcess(error) ? "absent" : "refused";
        }
      },
      // deno-lint-ignore require-yield
      *reachable([pid]): Operation<boolean> {
        try {
          // Signal 0 delivers nothing: it asks the kernel whether the pid is
          // reachable, which is the whole question here.
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
    },
    { at: "min" },
  );
}

/** One reading of `ps`, parsed row by row; anything unreadable is dropped. */
function readTable(output: string): readonly ProcessFacts[] {
  const rows: ProcessFacts[] = [];
  for (const line of output.split("\n")) {
    const row = readRow(line);
    if (row !== undefined) {
      rows.push(row);
    }
  }
  return rows;
}

function readRow(line: string): ProcessFacts | undefined {
  const match = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(-?\d+)\s+(.*)$/.exec(line);
  if (match === null) {
    return undefined;
  }
  const [, pid, ppid, pgid, tty, tpgid, command] = match;
  if (
    pid === undefined ||
    ppid === undefined ||
    pgid === undefined ||
    tty === undefined ||
    tpgid === undefined ||
    command === undefined
  ) {
    return undefined;
  }
  return {
    pid: Number(pid),
    ppid: Number(ppid),
    pgid: Number(pgid),
    tty,
    tpgid: Number(tpgid),
    command,
  };
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      // A non-zero status with output is an answer: `lsof -t` exits 1 when
      // nothing holds the file. A failure to run the tool at all is not.
      if (error && !("code" in error && typeof error.code === "number")) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function noSuchProcess(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    Reflect.get(error, "code") === "ESRCH"
  );
}
