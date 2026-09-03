/**
 * What Deno and the compiled binary can observe about processes and terminals.
 *
 * The interface lives in `terminal-processes.ts`, shared by everything that
 * asks. This is the answer, and it is host-specific: `ps` and `lsof` are what a
 * POSIX host has. Node and Bun install neither this nor the tmux provider, so a
 * grid there is refused before a pane starts rather than being observed badly.
 *
 * Every path fails closed, because every caller is deciding whether something
 * may still be running:
 *
 * - `kill(pid, 0)` establishes *absence* only for `ESRCH`. `EPERM` means a
 *   process exists that this user may not signal — the opposite of absence —
 *   and every other error means the question was not answered. Both raise.
 * - a `ps` that would not run is not an empty process table. An empty table
 *   would make every descendant and group sweep trivially satisfied.
 * - `lsof -t` exits non-zero with no output when nothing holds the file, and
 *   that one documented result is the only failure read as "nobody". Any other
 *   numeric failure raises rather than becoming an empty holder list.
 */

import { until } from "effection";
import type { Operation } from "effection";
import { execFile } from "node:child_process";
import process from "node:process";
import { TerminalProcesses, TerminalProcessesUnavailableError } from "./terminal-processes.ts";
import type { ProcessFacts, SignalDelivery, TerminalSignal } from "./terminal-processes.ts";

/** What one observation ran, so a suite can answer for it. */
export interface ProcessProbes {
  /**
   * Run a tool, and report everything it said.
   *
   * `stderr` is part of the answer, not noise: `lsof -t` exits 1 with nothing
   * at all when a file has no holders, and exits 1 *with a diagnostic* when it
   * could not look. Without stderr those two are the same result, and one of
   * them means "nobody" while the other means "I do not know".
   */
  run(
    command: string,
    args: readonly string[],
  ): Operation<{ code: number; stdout: string; stderr: string }>;
  /** Deliver a signal. Throws with a `code` the way `process.kill` does. */
  kill(pid: number, signal: number | TerminalSignal): void;
}

/** The real ones. */
export function posixProcessProbes(): ProcessProbes {
  return {
    run(command, args) {
      return until(
        new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
          execFile(command, [...args], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error && !("code" in error && typeof error.code === "number")) {
              // The tool did not run at all. That is not a status.
              reject(error);
              return;
            }
            const code =
              error && "code" in error && typeof error.code === "number" ? error.code : 0;
            resolve({ code, stdout, stderr });
          });
        }),
      );
    },
    kill(pid, signal) {
      process.kill(pid, signal);
    },
  };
}

/** The error's `code`, when it has one. */
function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

/** Install the POSIX observer for this host. */
export function* installDenoTerminalProcesses(
  probes: ProcessProbes = posixProcessProbes(),
): Operation<void> {
  yield* TerminalProcesses.around(
    {
      *table(): Operation<readonly ProcessFacts[]> {
        const listed = yield* probes.run("ps", ["-axo", "pid=,ppid=,pgid=,tty=,tpgid=,command="]);
        if (listed.code !== 0) {
          // Not an empty table: an empty one would satisfy every descendant and
          // group sweep without having looked at anything.
          throw new TerminalProcessesUnavailableError(
            "this host could not read its process table, so nothing about a pane's " +
              "processes has been established.",
          );
        }
        return readTable(listed.stdout);
      },
      *holders([device]): Operation<readonly number[]> {
        const found = yield* probes.run("lsof", ["-t", device]);
        const said = found.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        // The exact supported empty result, and nothing near it: `lsof -t`
        // exits 1 saying nothing at all when a file has no holders. Exit 1 with
        // a diagnostic is a look that did not happen, and "nobody holds it" is
        // not the safe guess for it.
        if (found.code !== 0) {
          if (found.code === 1 && said.length === 0 && found.stderr.trim().length === 0) {
            return [];
          }
          throw new TerminalProcessesUnavailableError(
            "this host could not enumerate the holders of a terminal, so it is not " +
              "established that nobody holds it.",
          );
        }
        // A successful run whose output is not entirely pids is output this
        // does not understand. Dropping the lines it cannot read would turn a
        // partial answer into a confident one.
        if (!said.every((line) => /^\d+$/.test(line))) {
          throw new TerminalProcessesUnavailableError(
            "this host answered with terminal holders it could not read, so it is not " +
              "established who holds it.",
          );
        }
        return said.map(Number);
      },
      // deno-lint-ignore require-yield
      *deliver([pid, signal]): Operation<SignalDelivery> {
        try {
          probes.kill(pid, signal);
          return "delivered";
        } catch (error) {
          // Gone already is the outcome the signal was asking for. Anything
          // else is a delivery that did not happen, and says nothing about
          // whether the process stopped.
          return codeOf(error) === "ESRCH" ? "absent" : "refused";
        }
      },
      // deno-lint-ignore require-yield
      *reachable([pid]): Operation<boolean> {
        try {
          // Signal 0 delivers nothing: it asks the kernel whether the pid is
          // reachable, which is the whole question.
          probes.kill(pid, 0);
          return true;
        } catch (error) {
          const code = codeOf(error);
          if (code === "ESRCH") {
            return false;
          }
          // `EPERM` is a process this user may not signal — a process that
          // exists. Reading it as absence would be reading "I may not ask" as
          // "nothing is there".
          throw new TerminalProcessesUnavailableError(
            `this host could not establish whether a process is still running (${
              code ?? "unknown"
            }).`,
          );
        }
      },
    },
    { at: "min" },
  );
}

/**
 * One reading of `ps`, parsed row by row.
 *
 * Every non-empty line has to be a row. A reading with lines this cannot parse
 * is a reading it does not understand, and dropping them would answer a sweep
 * with the processes it happened to recognise — which is a smaller set than the
 * ones that are there.
 */
function readTable(output: string): readonly ProcessFacts[] {
  const rows: ProcessFacts[] = [];
  for (const line of output.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    const row = readRow(line);
    if (row === undefined) {
      throw new TerminalProcessesUnavailableError(
        "this host answered with a process table it could not read, so nothing about " +
          "a pane's processes has been established.",
      );
    }
    rows.push(row);
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
