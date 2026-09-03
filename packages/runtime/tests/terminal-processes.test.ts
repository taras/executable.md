/**
 * Tier TP — what the host may claim about a terminal pane
 * (architecture.md §Interactive terminal grids).
 *
 * A pane is free when nothing a launch started can still act in it. These rows
 * are about the difference between establishing that and assuming it: a signal
 * that was delivered, a process that has gone while its children have not, a
 * terminal nobody is descended from but somebody still holds open, and a host
 * that cannot see any of it and must say so instead of answering "quiet".
 *
 * The reading half — `ps` and `lsof` — is exercised against this process, which
 * is a real process with a real parent and a real group. The deciding half is
 * exercised against a substituted handler, because a row about "a descendant is
 * still running" must not depend on this machine having one.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import process from "node:process";
import {
  descendantsOf,
  establishQuiescence,
  groupMembers,
  installPosixTerminalProcesses,
  paneOccupants,
  processReachable,
  processTable,
  TERMINAL_PROCESSES_UNAVAILABLE,
  TerminalProcesses,
  terminalHolders,
} from "../terminal-processes.ts";
import type { PaneOccupants, ProcessFacts, SignalDelivery, TerminalSignal } from "../mod.ts";

/** A table written by hand, so a row can describe a machine it is not on. */
function table(rows: readonly Partial<ProcessFacts>[]): readonly ProcessFacts[] {
  return rows.map((row) => ({
    pid: row.pid ?? 0,
    ppid: row.ppid ?? 1,
    pgid: row.pgid ?? row.pid ?? 0,
    tty: row.tty ?? "??",
    tpgid: row.tpgid ?? -1,
    command: row.command ?? "fake",
  }));
}

interface Substitute {
  /** Pids the kernel still knows. */
  running?: readonly number[];
  /** Pids still holding the device open, by device. */
  holding?: Record<string, readonly number[]>;
  /** Recorded, so a row can say what was asked rather than what was done. */
  asked?: string[];
}

/** A host whose answers a row decides, in place of one it cannot control. */
function useSubstitute(options: Substitute): Operation<void> {
  return TerminalProcesses.around(
    {
      // deno-lint-ignore require-yield
      *table(): Operation<readonly ProcessFacts[]> {
        return [];
      },
      // deno-lint-ignore require-yield
      *holders([device]): Operation<readonly number[]> {
        options.asked?.push(`holders:${device}`);
        return options.holding?.[device] ?? [];
      },
      // deno-lint-ignore require-yield
      *deliver([pid, signal]: [number, TerminalSignal]): Operation<SignalDelivery> {
        options.asked?.push(`deliver:${pid}:${signal}`);
        return "delivered";
      },
      // deno-lint-ignore require-yield
      *reachable([pid]): Operation<boolean> {
        options.asked?.push(`reachable:${pid}`);
        return (options.running ?? []).includes(pid);
      },
    },
    { at: "min" },
  );
}

describe("Tier TP — proving a terminal pane is free", () => {
  it("TP1: a host that installs no observer refuses every question", function* () {
    for (const ask of [
      () => processTable(),
      () => terminalHolders("/dev/ttys001"),
      () => processReachable(process.pid),
    ]) {
      let message = "";
      try {
        yield* ask();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      // Not "nothing is running" — a host that cannot see has established
      // nothing, and answering emptily would be answering for a pane it never
      // looked at.
      expect(message).toBe(TERMINAL_PROCESSES_UNAVAILABLE);
    }
  });

  it("TP2: the POSIX observer reads this process out of the real table", function* () {
    yield* installPosixTerminalProcesses();

    const rows = yield* processTable();
    const self = rows.find((row) => row.pid === process.pid);
    expect(self).toBeDefined();
    expect(self?.ppid).toBe(process.ppid);
    // A real reading, not a stub: this process is in the group it says it is.
    const group = self === undefined ? [] : groupMembers(rows, self.pgid);
    expect(group.some((row) => row.pid === process.pid)).toBe(true);
    // And the kernel agrees this process exists, while a pid nothing can own
    // does not.
    expect(yield* processReachable(process.pid)).toBe(true);
    expect(yield* processReachable(2 ** 30)).toBe(false);
  });

  it("TP3: descendants come from the snapshot, not from parent links after a kill", function* () {
    // A child, a grandchild, and a sibling that is not below the child at all.
    const rows = table([
      { pid: 100, ppid: 1, pgid: 100 },
      { pid: 200, ppid: 100, pgid: 100 },
      { pid: 300, ppid: 200, pgid: 100 },
      { pid: 400, ppid: 1, pgid: 400 },
    ]);

    expect(descendantsOf(rows, 100).map((row) => row.pid)).toEqual([200, 300]);
    expect(descendantsOf(rows, 400)).toEqual([]);
    // The same table after a kill reparents the grandchild to init. Read then,
    // it would name nobody — which is why the snapshot has to precede the
    // signal rather than follow it.
    const reparented = table([
      { pid: 300, ppid: 1, pgid: 100 },
      { pid: 400, ppid: 1, pgid: 400 },
    ]);
    expect(descendantsOf(reparented, 100)).toEqual([]);
  });

  it("TP4: a snapshot names the child, its descendants and its group", function* () {
    const rows = table([
      { pid: 100, ppid: 1, pgid: 100, tty: "ttys003" },
      { pid: 200, ppid: 100, pgid: 100 },
      { pid: 250, ppid: 1, pgid: 100 },
      { pid: 400, ppid: 1, pgid: 400 },
    ]);

    const occupants = paneOccupants(rows, 100, "/dev/ttys003");
    expect(occupants.child).toBe(100);
    expect(occupants.descendants).toEqual([200]);
    // The group member that is not a descendant is named too, and the child
    // itself is not repeated into it.
    expect(occupants.group).toEqual([200, 250]);
    expect(occupants.device).toBe("/dev/ttys003");
  });

  it("TP5: quiet means every one of them is gone and nobody holds the terminal", function* () {
    const asked: string[] = [];
    yield* scoped(function* () {
      yield* useSubstitute({ running: [], holding: {}, asked });
      const quiescence = yield* establishQuiescence({
        child: 100,
        descendants: [200],
        group: [250],
        device: "/dev/ttys003",
      });
      expect(quiescence.quiet).toBe(true);
      expect(quiescence.running).toEqual([]);
      expect(quiescence.holding).toEqual([]);
    });
    // Every member was asked about, and so was the terminal. A proof that
    // checked the child alone would pass a pane its grandchild is still in.
    expect(asked).toEqual([
      "reachable:100",
      "reachable:200",
      "reachable:250",
      "holders:/dev/ttys003",
    ]);
  });

  it("TP6: a descendant or a group member still running is not quiet", function* () {
    for (const [what, running] of [
      ["the child", [100]],
      ["a descendant", [200]],
      ["a group member", [250]],
    ] as const) {
      yield* scoped(function* () {
        yield* useSubstitute({ running });
        const quiescence = yield* establishQuiescence({
          child: 100,
          descendants: [200],
          group: [250],
          device: "/dev/ttys003",
        });
        expect(`${what}: ${quiescence.quiet}`).toBe(`${what}: false`);
        expect(`${what}: ${quiescence.running.join()}`).toBe(`${what}: ${running.join()}`);
      });
    }
  });

  it("TP7: a terminal somebody still holds is not quiet, whoever they are", function* () {
    // Nothing the launch started is left, and the pane is still not free:
    // something outside the snapshot has the terminal open.
    yield* useSubstitute({ running: [], holding: { "/dev/ttys003": [999] } });
    const quiescence = yield* establishQuiescence({
      child: 100,
      descendants: [],
      group: [],
      device: "/dev/ttys003",
    });
    expect(quiescence.quiet).toBe(false);
    expect(quiescence.running).toEqual([]);
    expect(quiescence.holding).toEqual([999]);
  });

  it("TP8: everything still true is reported, not just the first thing", function* () {
    yield* useSubstitute({ running: [200], holding: { "/dev/ttys003": [999] } });
    const quiescence = yield* establishQuiescence({
      child: 100,
      descendants: [200],
      group: [],
      device: "/dev/ttys003",
    });
    // A caller deciding what to escalate needs both, so neither short-circuits
    // the other.
    expect(quiescence.running).toEqual([200]);
    expect(quiescence.holding).toEqual([999]);
  });

  it("TP9: a pane with no terminal device asks nobody about one", function* () {
    const asked: string[] = [];
    yield* scoped(function* () {
      yield* useSubstitute({ running: [], asked });
      const occupants: PaneOccupants = { child: 100, descendants: [], group: [] };
      const quiescence = yield* establishQuiescence(occupants);
      expect(quiescence.quiet).toBe(true);
    });
    expect(asked).toEqual(["reachable:100"]);
  });
});
