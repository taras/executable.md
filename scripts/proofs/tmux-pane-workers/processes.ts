/**
 * What the kernel says about processes: the table, reachability, and signal
 * delivery. Shared by the parent and the pane worker.
 *
 * `ps` rather than `/proc`, because this proof runs on macOS. `tpgid` is the
 * terminal's foreground process group, which is how a shell's job control is
 * observed from outside rather than inferred from what it printed.
 */

import { execFile } from "node:child_process";
import process from "node:process";
import { until } from "effection";
import type { Operation } from "effection";

export interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  /** `ttys002`, or `??` for a process with no controlling terminal. */
  tty: string;
  /** The controlling terminal's foreground process group, or -1. */
  tpgid: number;
  command: string;
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error && !("code" in error && typeof error.code === "number")) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function parseRow(line: string): ProcessRow | undefined {
  const match = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(-?\d+)\s+(.*)$/.exec(line);
  if (!match) {
    return undefined;
  }
  const [, pid, ppid, pgid, tty, tpgid, command] = match;
  return {
    pid: Number(pid),
    ppid: Number(ppid),
    pgid: Number(pgid),
    tty,
    tpgid: Number(tpgid),
    command,
  };
}

export function* processTable(): Operation<ProcessRow[]> {
  const output = yield* until(run("ps", ["-axo", "pid=,ppid=,pgid=,tty=,tpgid=,command="]));
  return output
    .split("\n")
    .map(parseRow)
    .filter((row): row is ProcessRow => row !== undefined);
}

export function* processFacts(pid: number): Operation<ProcessRow | undefined> {
  const rows = yield* processTable();
  return rows.find((row) => row.pid === pid);
}

/** Every process below `pid` by parent links, in the given table. */
export function descendantsOf(rows: ProcessRow[], pid: number): ProcessRow[] {
  const found: ProcessRow[] = [];
  const frontier = [pid];
  while (frontier.length > 0) {
    const parent = frontier.pop();
    for (const row of rows) {
      if (row.ppid === parent) {
        found.push(row);
        frontier.push(row.pid);
      }
    }
  }
  return found;
}

export function groupMembers(rows: ProcessRow[], pgid: number): ProcessRow[] {
  return rows.filter((row) => row.pgid === pgid);
}

/** Processes still holding the terminal device open, by `lsof`. */
export function* holdersOf(ttyDevice: string): Operation<number[]> {
  const output = yield* until(run("lsof", ["-t", ttyDevice]));
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(Number);
}

export type Delivery = "delivered" | "absent" | "refused";

/**
 * Send one signal by pid and report what that established. The same rule as
 * `packages/runtime/launcher.ts`: gone already is the outcome escalation was
 * asking for; anything but ESRCH is a delivery that did not happen.
 */
export function deliver(pid: number, name: "SIGINT" | "SIGTERM" | "SIGKILL"): Delivery {
  try {
    process.kill(pid, name);
    return "delivered";
  } catch (error) {
    return isNoSuchProcess(error) ? "absent" : "refused";
  }
}

export function isReachable(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isNoSuchProcess(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    Reflect.get(error, "code") === "ESRCH"
  );
}
