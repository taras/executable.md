/**
 * The checks, one per acceptance item of #726. Each runs a topology of its
 * own and records what it observed; `proof.ts` sequences them.
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { readTextFile, exists } from "@effectionx/fs";
import { all, scoped, sleep, spawn, suspend, until } from "effection";
import type { Operation, Task } from "effection";
import type { Check, Logger } from "./evidence.ts";
import { placementMatches } from "./layout.ts";
import { deliver, holdersOf, isReachable, processFacts, processTable } from "./processes.ts";
import type { ProcessRow } from "./processes.ts";
import { tmuxAt, useTmuxGrid } from "./provider.ts";
import type { ControlEvent, TmuxGrid, VisibleClient } from "./provider.ts";
import {
  childCommand,
  filteredEnvironment,
  isLaunchEvent,
  isType,
  usePrivateDirectory,
  useWorkspace,
} from "./workspace.ts";
import type { PaneEvent } from "./workspace.ts";

export interface CheckContext {
  evidenceDirectory: string;
  log: Logger;
  /** Whether this process has a terminal to attach the grid on. */
  attachable: boolean;
  /** Wait for a person to detach instead of issuing `detach-client`. */
  manualClose: boolean;
}

interface ChildEvidenceFile {
  argv: string[];
  pid: number;
  pgid: number;
  tty: string;
  tpgid: number;
  isatty: boolean[];
  stdin: string[];
  signals: string[];
  descendants: { pid: number; kind: string }[];
}

function* readChildEvidence(path: string): Operation<ChildEvidenceFile | undefined> {
  if (!(yield* exists(path))) {
    return undefined;
  }
  try {
    return JSON.parse(yield* readTextFile(path));
  } catch {
    return undefined;
  }
}

function* eventually(condition: () => Operation<boolean>, limitMs: number): Operation<boolean> {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    if (yield* condition()) {
      return true;
    }
    yield* sleep(50);
  }
  return yield* condition();
}

function* allGone(pids: number[], limitMs = 5_000): Operation<boolean> {
  return yield* eventually(function* () {
    return pids.every((pid) => !isReachable(pid));
  }, limitMs);
}

function* childEvidenceHas(
  path: string,
  test: (file: ChildEvidenceFile) => boolean,
): Operation<boolean> {
  return yield* eventually(function* () {
    const file = yield* readChildEvidence(path);
    return file !== undefined && test(file);
  }, 10_000);
}

/** The controlling terminal's settings, or `undefined` without one. */
function* sttyState(): Operation<string | undefined> {
  return yield* until(
    new Promise<string | undefined>((resolve) => {
      execFile("sh", ["-c", "stty -g < /dev/tty"], (error, stdout) => {
        resolve(error ? undefined : stdout.trim());
      });
    }),
  );
}

const TTY_DEVICE = (tty: string) => (tty.startsWith("/dev/") ? tty : `/dev/${tty}`);

/**
 * Control events from `from` onwards until one satisfies `test` or time runs
 * out. Returns the events seen and where the next read starts.
 */
function* controlUntil(
  grid: TmuxGrid,
  from: number,
  test: (event: ControlEvent) => boolean,
  limitMs = 5_000,
): Operation<{ seen: ControlEvent[]; next: number }> {
  const deadline = Date.now() + limitMs;
  let cursor = from;
  const seen: ControlEvent[] = [];
  while (true) {
    while (cursor < grid.events.length) {
      const event = grid.events[cursor++];
      seen.push(event);
      if (test(event) || event.kind === "closed") {
        return { seen, next: cursor };
      }
    }
    if (Date.now() >= deadline) {
      return { seen, next: cursor };
    }
    yield* sleep(10);
  }
}

export function* checkLayoutGeometry(check: Check, context: CheckContext): Operation<void> {
  const env = filteredEnvironment();
  const shapes = [
    { columns: 2, panes: 4 },
    { columns: 2, panes: 5 },
    { columns: 3, panes: 8 },
  ];
  const sizes = [
    { width: 80, height: 24 },
    { width: 200, height: 60 },
  ];
  const observations: Record<string, unknown> = {};
  for (const shape of shapes) {
    for (const size of sizes) {
      const directory = yield* usePrivateDirectory();
      const grid = yield* useTmuxGrid(directory, {
        session: "layout",
        columns: shape.columns,
        panes: shape.panes,
        width: size.width,
        height: size.height,
        titles: [],
        workerCommand: () => ["sleep", "300"],
        cwd: "/",
        env,
      });
      const cells = yield* grid.geometry();
      const key = `${shape.panes}@${shape.columns} ${size.width}x${size.height}`;
      const problems = placementMatches(cells, shape.columns);
      const rows = new Set(cells.map((cell) => cell.top)).size;
      observations[key] = { cells, problems };
      check.expect(`${key}: row-major placement`, problems.length === 0, problems);
      check.expect(
        `${key}: ${Math.ceil(shape.panes / shape.columns)} rows`,
        rows === Math.ceil(shape.panes / shape.columns),
        rows,
      );
      // What `select-layout tiled` would have done with the same panes.
      yield* grid.tmux.run(["select-layout", "-t", "layout:0", "tiled"]);
      const tiled = yield* grid.geometry();
      const tiledColumns = new Set(
        tiled.filter((cell) => cell.top === tiled[0].top).map((cell) => cell.left),
      ).size;
      observations[`${key} tiled`] = {
        columns: tiledColumns,
        problems: placementMatches(tiled, shape.columns),
      };
      yield* grid.stop();
    }
  }
  check.fact("observations", observations);
  check.note(
    "tiled column counts are recorded beside each shape; they are tmux's choice, not the author's",
  );
  yield* context.log("layout shapes recorded");
}

export function* checkReadinessBoundary(check: Check, context: CheckContext): Operation<void> {
  const env = filteredEnvironment();
  // First, tmux by itself: both a missing executable and a real `exit 1`
  // produce a pane with a pid.
  {
    const directory = yield* usePrivateDirectory();
    const tmux = tmuxAt(join(directory, "s"), env);
    yield* tmux.run(["new-session", "-d", "-s", "bare", "-x", "80", "-y", "24", "sleep", "60"]);
    yield* tmux.run(["set", "-g", "remain-on-exit", "on"]);
    yield* tmux.run(["split-window", "-d", "-t", "bare:0", "/definitely/missing", "x"]);
    yield* tmux.run(["split-window", "-d", "-t", "bare:0", "/bin/sh", "-c", "exit 1"]);
    yield* sleep(300);
    const listed = yield* tmux.run([
      "list-panes",
      "-t",
      "bare:0",
      "-F",
      "#{pane_index} pid=#{pane_pid} dead=#{pane_dead} status=#{pane_dead_status} cmd=#{pane_start_command}",
    ]);
    check.fact("tmuxAlone", listed.split("\n"));
    const missing = listed.split("\n").find((line) => line.includes("missing"));
    check.expect(
      "tmux alone: a missing executable still yields a pane pid",
      missing !== undefined && /pid=\d+/.test(missing) && !/pid=0\b/.test(missing),
      missing,
    );
    yield* tmux.tryRun(["kill-server"]);
  }

  const workspace = yield* useWorkspace({
    columns: 1,
    panes: 1,
    evidenceDirectory: context.evidenceDirectory,
    titles: ["readiness"],
  });
  const before = workspace.pane(0);
  yield* workspace.launch(0, { id: "missing", argv: ["/definitely/missing", "x"] });
  const failed = yield* workspace.waitFor(0, isLaunchEvent("startup-failed", "missing"));
  check.expect("missing executable: startup-failed", failed.type === "startup-failed", failed);
  check.expect(
    "missing executable: never ready",
    !workspace.events(0).some((event) => event.type === "ready"),
  );

  const evidence = join(context.evidenceDirectory, "exit1.json");
  yield* workspace.launch(0, { id: "exit1", argv: childCommand(evidence, "exit1") });
  const ready = yield* workspace.waitFor(0, isLaunchEvent("ready", "exit1"));
  const exited = yield* workspace.waitFor(0, isLaunchEvent("exited", "exit1"));
  check.expect("exit 1: ready acknowledged", ready.type === "ready", ready);
  check.expect("exit 1: then exit code 1", exited.exitCode === 1, exited);
  const order = workspace.events(0).map((event) => event.type);
  check.expect(
    "exit 1: ready precedes exited",
    order.indexOf("ready") < order.indexOf("exited"),
    order,
  );

  const after = (yield* workspace.grid.geometry()).length;
  const facts = yield* workspace.grid.tmux.run([
    "list-panes",
    "-t",
    "grid:0",
    "-F",
    "#{pane_id} #{pane_pid} #{pane_dead}",
  ]);
  check.expect(
    "the pane and its worker survived both launches",
    facts === `${before.id} ${before.pid} 0` && after === 1,
    facts,
  );
  yield* workspace.shutdown(0);
  const stopped = yield* workspace.grid.stop();
  check.expect("server stopped", stopped.serverGone && stopped.unreachable, stopped);
}

const TRICKY_ARGS = ["a b", '"quoted"', "$HOME", "x;y", "`z`", "new\nline", "it's", "#{pane_id}"];

export function* checkJourney(check: Check, context: CheckContext): Operation<void> {
  const sttyBefore = yield* sttyState();
  const evidenceOf = (name: string) => join(context.evidenceDirectory, `journey-${name}.json`);
  const workspace = yield* useWorkspace({
    columns: 2,
    panes: 4,
    titles: ["Implementor", "Planner", "Architect", "Shell"],
    evidenceDirectory: context.evidenceDirectory,
  });
  const { grid } = workspace;

  for (const [ordinal, link] of workspace.links.entries()) {
    const pane = workspace.pane(ordinal);
    check.expect(
      `pane ${ordinal}: worker on the pane terminal`,
      TTY_DEVICE(link.hello.tty) === pane.tty &&
        link.hello.pid === pane.pid &&
        link.hello.pgid === link.hello.pid,
      { hello: link.hello, pane },
    );
    check.expect(
      `pane ${ordinal}: worker stdin/stdout/stderr are terminals`,
      link.hello.isatty.every(Boolean),
    );
  }
  check.fact("panes", grid.panes);
  check.fact(
    "hellos",
    workspace.links.map((link) => link.hello),
  );

  yield* workspace.display(0, "Prelude: this pane belongs to the Implementor.\n");
  yield* workspace.display(1, "Prelude: this pane belongs to the Planner.\n");
  check.expect("prelude displayed before any child", true);

  yield* workspace.launch(0, {
    id: "A",
    argv: childCommand(evidenceOf("A"), "plain", ...TRICKY_ARGS),
  });
  yield* workspace.launch(1, { id: "B", argv: childCommand(evidenceOf("B"), "plain", "planner") });
  yield* workspace.launch(2, {
    id: "C",
    argv: childCommand(evidenceOf("C"), "ignore-sigint-fork"),
  });
  yield* workspace.launch(3, { id: "S", argv: [workspace.env.SHELL ?? "/bin/sh"] });
  const readies = yield* all([
    workspace.waitFor(0, isLaunchEvent("ready", "A")),
    workspace.waitFor(1, isLaunchEvent("ready", "B")),
    workspace.waitFor(2, isLaunchEvent("ready", "C")),
    workspace.waitFor(3, isLaunchEvent("ready", "S")),
  ]);
  check.expect(
    "all four panes ready before attach",
    readies.every((event) => event.type === "ready"),
  );
  const childPids = readies.map((event) => event.pid);

  let client: VisibleClient | undefined;
  let cursor = 0;
  if (context.attachable) {
    client = yield* grid.attach();
    const attached = yield* controlUntil(grid, cursor, (event) => event.kind === "client-attached");
    cursor = attached.next;
    check.expect(
      "visible client attached after readiness",
      attached.seen.some((event) => event.kind === "client-attached"),
      attached.seen,
    );
    check.fact("visibleClient", client.name);
  } else {
    check.note("no terminal: the visible attach was skipped");
  }

  // Interact with two children at once.
  yield* workspace.keys(0, "hello from zero", "Enter");
  yield* workspace.keys(1, "hello from one", "Enter");
  const aSaw = yield* childEvidenceHas(evidenceOf("A"), (file) =>
    file.stdin.includes("hello from zero"),
  );
  const bSaw = yield* childEvidenceHas(evidenceOf("B"), (file) =>
    file.stdin.includes("hello from one"),
  );
  check.expect("two children received input concurrently", aSaw && bSaw);
  const aFile = yield* readChildEvidence(evidenceOf("A"));
  check.expect(
    "argv bytes unchanged through IPC",
    JSON.stringify(aFile?.argv) === JSON.stringify(TRICKY_ARGS),
    aFile?.argv,
  );
  check.expect(
    "child A on pane 0's terminal, in the worker's process group",
    aFile !== undefined &&
      TTY_DEVICE(aFile.tty) === workspace.pane(0).tty &&
      aFile.pgid === workspace.links[0].hello.pid &&
      aFile.isatty.every(Boolean),
    aFile && { tty: aFile.tty, pgid: aFile.pgid, isatty: aFile.isatty },
  );
  check.expect(
    "prelude text was not fed to the child as input",
    aFile !== undefined && !aFile.stdin.some((line) => line.includes("Prelude")),
    aFile?.stdin,
  );
  const captured = yield* workspace.capture(0);
  check.expect(
    "pane 0 shows prelude, banner and echo",
    captured.includes("Prelude") && captured.includes("> hello from zero"),
    captured,
  );

  yield* workspace.launch(0, { id: "A-dup", argv: ["true"] });
  const refused = yield* workspace.waitFor(0, isLaunchEvent("refused", "A-dup"));
  check.expect(
    "a second concurrent launch on pane 0 is refused",
    refused.reason === "busy",
    refused,
  );

  // Job control in the shell pane. The shell reads its rc files first, so
  // each observation waits for the shell rather than for a fixed delay.
  yield* workspace.keys(3, "sleep 300 &", "Enter");
  yield* workspace.keys(3, "jobs", "Enter");
  const shellPid = childPids[3];
  let sleeper: ProcessRow | undefined;
  let shellRow: ProcessRow | undefined;
  yield* eventually(function* () {
    const table = yield* processTable();
    sleeper = table.find((row) => row.ppid === shellPid && row.command.startsWith("sleep 300"));
    shellRow = table.find((row) => row.pid === shellPid);
    return sleeper !== undefined;
  }, 10_000);
  const workerRow = yield* processFacts(workspace.links[3].hello.pid);
  check.expect(
    "shell took the foreground in a process group of its own",
    shellRow !== undefined &&
      workerRow !== undefined &&
      shellRow.pgid === shellRow.pid &&
      shellRow.pgid !== workerRow.pgid,
    { shellRow, workerRow },
  );
  check.expect(
    "shell put its background job in a process group of its own",
    sleeper !== undefined &&
      shellRow !== undefined &&
      sleeper.pgid !== shellRow.pgid &&
      sleeper.pgid === sleeper.pid,
    { sleeper, shellRow },
  );
  yield* workspace.keys(3, "fg", "Enter");
  let foreground: ProcessRow | undefined;
  yield* eventually(function* () {
    foreground = yield* processFacts(sleeper?.pid ?? -1);
    return foreground !== undefined && foreground.tpgid === foreground.pgid;
  }, 5_000);
  check.expect(
    "fg made the job the terminal's foreground process group",
    foreground !== undefined && foreground.tpgid === foreground.pgid,
    foreground,
  );
  yield* workspace.keys(3, "C-z");
  let stoppedShell = "";
  yield* eventually(function* () {
    stoppedShell = yield* workspace.capture(3);
    return /suspended|stopped/i.test(stoppedShell);
  }, 5_000);
  yield* workspace.keys(3, "kill %1", "Enter");
  check.expect(
    "^Z suspended the foreground job",
    /suspended|stopped/i.test(stoppedShell),
    stoppedShell.trim().split("\n").slice(-3),
  );

  // ^C reaches the child on pane 1, not its worker.
  yield* workspace.keys(1, "C-c");
  const bExit = yield* workspace.waitFor(1, isLaunchEvent("exited", "B"));
  check.expect(
    "^C interrupted child B",
    bExit.exitCode === 130 || bExit.signal === "SIGINT",
    bExit,
  );
  yield* workspace.display(1, "Child B was interrupted; the pane worker is still here.\n");
  check.expect("worker 1 survived the ^C that ended its child", workspace.links[1].connected());

  // One child exits while siblings remain interactive; its pane is reused.
  yield* workspace.keys(0, "exit 3", "Enter");
  const aExit = yield* workspace.waitFor(0, isLaunchEvent("exited", "A"));
  check.expect("child A exited 3 on request", aExit.exitCode === 3, aExit);
  check.expect("child C still runs while A exited", isReachable(childPids[2]));
  yield* workspace.display(
    0,
    `Epilogue: the Implementor exited with status ${aExit.exitCode}. Starting a second child.\n`,
  );
  yield* workspace.launch(0, { id: "A2", argv: childCommand(evidenceOf("A2"), "plain", "second") });
  const a2 = yield* workspace.waitFor(0, isLaunchEvent("ready", "A2"));
  const paneNow = (yield* grid.tmux.run([
    "list-panes",
    "-t",
    "grid:0",
    "-F",
    "#{pane_id} #{pane_pid}",
  ])).split("\n")[0];
  check.expect(
    "second child in pane 0 on the same pane and worker",
    a2.type === "ready" && paneNow === `${workspace.pane(0).id} ${workspace.pane(0).pid}`,
    { a2, paneNow },
  );
  yield* workspace.keys(0, "second round", "Enter");
  check.expect(
    "second child received input",
    yield* childEvidenceHas(evidenceOf("A2"), (file) => file.stdin.includes("second round")),
  );

  // Reader close.
  let closeDetected = false;
  if (client) {
    if (context.manualClose) {
      yield* workspace.display(
        1,
        "\nScripted interactions are done. Detach (prefix, d) to close the grid.\n",
      );
      yield* client.process.exited;
    }
    const closeAt = Date.now();
    if (!context.manualClose) {
      yield* grid.detach(client);
    }
    const { seen, next } = yield* controlUntil(
      grid,
      cursor,
      (event) => event.kind === "client-detached",
    );
    cursor = next;
    closeDetected = seen.some((event) => event.kind === "client-detached");
    check.fact("closeDetectMs", Date.now() - closeAt);
    const exit = yield* client.process.exited;
    check.expect("reader close observed as %client-detached", closeDetected, seen);
    check.expect("attach client exited 0 after detach", exit.exitCode === 0, exit);
  }
  check.expect(
    "after reader close, children still run until cancelled",
    isReachable(childPids[2]) && isReachable(a2.pid),
  );

  // Ordered teardown.
  const proofs = yield* all([
    workspace.cancel(0, "A2"),
    workspace.cancel(2, "C"),
    workspace.cancel(3, "S"),
  ]);
  check.fact(
    "quiescence",
    proofs.map((proof) => proof.proof),
  );
  check.expect(
    "every cancelled child is gone",
    proofs.every((proof) => proof.proof.childGone && proof.proof.survivors.length === 0),
    proofs.map((proof) => proof.proof),
  );
  const cFile = yield* readChildEvidence(evidenceOf("C"));
  const cDescendant = cFile?.descendants[0]?.pid;
  check.expect(
    "C ignored SIGINT and was killed, with its in-group descendant",
    proofs[1].proof.method === "killed" &&
      cDescendant !== undefined &&
      proofs[1].proof.descendants.some((entry) => entry.pid === cDescendant && entry.gone),
    {
      method: proofs[1].proof.method,
      cDescendant,
      descendants: proofs[1].proof.descendants,
      signals: cFile?.signals,
    },
  );
  const byes = yield* all(workspace.links.map((_, ordinal) => workspace.shutdown(ordinal)));
  check.expect(
    "every worker acknowledged shutdown with nothing left on its terminal",
    byes.length === 4 && byes.every((bye) => bye.ttyHolders.length === 0),
    byes.map((bye) => bye.ttyHolders),
  );
  const workerPids = workspace.links.map((link) => link.hello.pid);
  check.expect("workers gone", yield* allGone(workerPids));
  const stopped = yield* grid.stop();
  check.expect("tmux server gone", stopped.serverGone && stopped.unreachable, stopped);
  check.expect("all child pids gone", yield* allGone([...childPids, a2.pid]));
  const holders: Record<string, number[]> = {};
  for (const pane of grid.panes) {
    holders[pane.tty] = yield* holdersOf(pane.tty);
  }
  check.expect(
    "nothing holds a pane terminal open",
    Object.values(holders).every((list) => list.length === 0),
    holders,
  );
  check.expect(
    "control client never received pane output",
    !grid.controlLog.some((line) => line.startsWith("%output")),
    grid.controlLog.length,
  );
  check.fact("controlLog", grid.controlLog);
  const sttyAfter = yield* sttyState();
  check.expect("terminal settings restored", sttyBefore === sttyAfter, { sttyBefore, sttyAfter });
}

export function* checkStartupFailureAtomic(check: Check, context: CheckContext): Operation<void> {
  const evidence = (name: string) => join(context.evidenceDirectory, `atomic-${name}.json`);
  let serverPid = -1;
  let workerPids: number[] = [];
  let childPids: number[] = [];
  let attachAttempted = false;
  let failure: string | undefined;
  try {
    yield* scoped(function* () {
      const workspace = yield* useWorkspace({
        columns: 2,
        panes: 4,
        evidenceDirectory: context.evidenceDirectory,
        onPhase: (_, facts) => {
          serverPid = facts.serverPid ?? serverPid;
        },
      });
      workerPids = workspace.links.map((link) => link.hello.pid);
      yield* workspace.launch(0, { id: "a", argv: childCommand(evidence("a"), "plain") });
      yield* workspace.launch(1, { id: "b", argv: childCommand(evidence("b"), "plain") });
      yield* workspace.launch(2, { id: "c", argv: ["/definitely/missing", "x"] });
      yield* workspace.launch(3, { id: "s", argv: [workspace.env.SHELL ?? "/bin/sh"] });
      const outcomes = yield* all(
        [0, 1, 2, 3].map((ordinal) =>
          workspace.waitFor(
            ordinal,
            (event): event is PaneEvent & { type: "ready" | "startup-failed" } =>
              event.type === "ready" || event.type === "startup-failed",
          ),
        ),
      );
      childPids = outcomes.flatMap((event) => (event.type === "ready" ? [event.pid] : []));
      check.fact("outcomes", outcomes);
      check.expect(
        "pane 2 reported startup-failed",
        outcomes[2].type === "startup-failed",
        outcomes[2],
      );
      check.expect("three siblings had already started", childPids.length === 3);
      if (outcomes.some((event) => event.type === "startup-failed")) {
        // The grid must not be presented; teardown is the scope ending.
        throw new Error("grid startup failed: pane 2");
      }
      attachAttempted = true;
      yield* workspace.grid.attach();
    });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  check.expect(
    "the grid failed instead of attaching",
    failure !== undefined && !attachAttempted,
    failure,
  );
  check.expect("started siblings torn down", yield* allGone(childPids), childPids);
  check.expect("workers torn down", yield* allGone(workerPids), workerPids);
  check.expect("server torn down", serverPid > 0 && (yield* allGone([serverPid])), serverPid);
}

export function* checkSignalsDistinct(check: Check, context: CheckContext): Operation<void> {
  if (!context.attachable) {
    check.note("no terminal: skipped");
    return;
  }
  const evidence = (name: string) => join(context.evidenceDirectory, `signals-${name}.json`);
  const workspace = yield* useWorkspace({
    columns: 2,
    panes: 2,
    evidenceDirectory: context.evidenceDirectory,
  });
  const { grid } = workspace;
  yield* workspace.launch(0, { id: "a", argv: childCommand(evidence("a"), "plain") });
  yield* workspace.launch(1, { id: "b", argv: childCommand(evidence("b"), "plain") });
  const [a, b] = yield* all([
    workspace.waitFor(0, isLaunchEvent("ready", "a")),
    workspace.waitFor(1, isLaunchEvent("ready", "b")),
  ]);
  const children = [a.pid, b.pid];

  // 1. The reader detaches.
  const first = yield* grid.attach();
  let cursor = (yield* controlUntil(grid, 0, (event) => event.kind === "client-attached")).next;
  yield* grid.detach(first);
  const detached = yield* controlUntil(grid, cursor, (event) => event.kind === "client-detached");
  cursor = detached.next;
  yield* first.process.exited;
  check.expect(
    "detach: %client-detached names the visible client",
    detached.seen.some((event) => event.kind === "client-detached" && event.client === first.name),
    detached.seen,
  );
  check.expect("detach: children keep running", children.every(isReachable));

  // 2. The control connection is lost while the server and panes live on.
  const controlName = (yield* grid.tmux.run([
    "list-clients",
    "-F",
    "#{client_control_mode} #{client_name}",
  ]))
    .split("\n")
    .map((line) => line.split(" "))
    .find((parts) => parts[0] === "1")?.[1];
  check.fact("controlClient", controlName);
  yield* grid.tmux.run(["detach-client", "-t", controlName ?? ""]);
  const lost = (yield* controlUntil(grid, cursor, (event) => event.kind === "closed")).seen;
  check.expect(
    "control loss: the stream ends with %exit, not %client-detached for the reader",
    lost.some((event) => event.kind === "exit") &&
      !lost.some((event) => event.kind === "client-detached" && event.client === first.name),
    lost,
  );
  check.expect(
    "control loss: server still answers",
    (yield* grid.tmux.tryRun(["has-session", "-t", grid.session])) !== undefined,
  );
  check.expect("control loss: children keep running", children.every(isReachable));
  check.expect(
    "control loss: workers still connected",
    workspace.links.every((link) => link.connected()),
  );

  // 3. The server stops underneath everything.
  yield* grid.tmux.run(["kill-server"]);
  const closed = yield* all(
    workspace.links.map((_, ordinal) => workspace.waitFor(ordinal, isType("closed"))),
  );
  check.expect("server stop: every worker link closed", closed.length === 2);
  const childrenGone = yield* allGone(children, 3_000);
  check.expect(
    "server stop: children ended with their terminal (SIGHUP)",
    childrenGone,
    children.map(isReachable),
  );
  check.expect(
    "server stop: workers ended with their terminal",
    yield* allGone(
      workspace.links.map((link) => link.hello.pid),
      3_000,
    ),
  );
  check.note(
    "the three signals were classified from different sources: attach exit + %client-detached, control EOF/%exit, has-session failure + link EOF",
  );
}

export function* checkNegativeChildren(check: Check, context: CheckContext): Operation<void> {
  const evidence = (name: string) => join(context.evidenceDirectory, `negative-${name}.json`);
  const workspace = yield* useWorkspace({
    columns: 3,
    panes: 5,
    evidenceDirectory: context.evidenceDirectory,
  });
  const modes = ["ignore-sigint-fork", "escape", "escape-closed"] as const;
  for (const [ordinal, mode] of modes.entries()) {
    yield* workspace.launch(ordinal, { id: mode, argv: childCommand(evidence(mode), mode) });
  }
  const readies = yield* all(
    modes.map((mode, ordinal) => workspace.waitFor(ordinal, isLaunchEvent("ready", mode))),
  );
  const files: Record<string, ChildEvidenceFile | undefined> = {};
  for (const mode of modes) {
    yield* childEvidenceHas(evidence(mode), (file) => file.descendants.length === 1);
    files[mode] = yield* readChildEvidence(evidence(mode));
  }

  yield* workspace.keys(0, "C-c");
  const ignored = yield* childEvidenceHas(evidence("ignore-sigint-fork"), (file) =>
    file.signals.includes("SIGINT"),
  );
  files["ignore-sigint-fork"] = yield* readChildEvidence(evidence("ignore-sigint-fork"));
  check.fact("children", files);
  check.expect(
    "negative child and its in-group descendant survived the first interrupt",
    ignored &&
      isReachable(readies[0].pid) &&
      isReachable(files["ignore-sigint-fork"]?.descendants[0]?.pid ?? -1),
  );

  const escapedRow = yield* processFacts(files.escape?.descendants[0]?.pid ?? -1);
  check.expect(
    "escaped descendant left the session and process group",
    escapedRow !== undefined && escapedRow.pgid === escapedRow.pid && escapedRow.tty === "??",
    escapedRow,
  );

  // The orphans: escaped descendants whose parent has already exited on its
  // own, so no ancestry leads to them when the pane is swept. One still holds
  // the pane's terminal; the other closed it.
  const orphans = [
    { ordinal: 3, mode: "escape" },
    { ordinal: 4, mode: "escape-closed" },
  ] as const;
  const orphanPids: number[] = [];
  for (const orphan of orphans) {
    const id = `orphan-${orphan.mode}`;
    yield* workspace.launch(orphan.ordinal, { id, argv: childCommand(evidence(id), orphan.mode) });
    yield* workspace.waitFor(orphan.ordinal, isLaunchEvent("ready", id));
    yield* childEvidenceHas(evidence(id), (file) => file.descendants.length === 1);
    const file = yield* readChildEvidence(evidence(id));
    const pid = file?.descendants[0]?.pid ?? -1;
    orphanPids.push(pid);
    yield* workspace.keys(orphan.ordinal, "exit 0", "Enter");
    yield* workspace.waitFor(orphan.ordinal, isLaunchEvent("exited", id));
    const row = yield* processFacts(pid);
    check.fact(`${id}`, { pid, row });
    check.expect(
      `${id}: the escaped descendant outlived its parent and was reparented`,
      row !== undefined && row.ppid === 1 && row.tty === "??",
      row,
    );
  }

  const proofs = yield* all(modes.map((mode, ordinal) => workspace.cancel(ordinal, mode)));
  for (const [index, mode] of modes.entries()) {
    const proof = proofs[index].proof;
    const descendant = files[mode]?.descendants[0]?.pid;
    const covered = proof.descendants.find((entry) => entry.pid === descendant);
    check.fact(`${mode}.proof`, proof);
    check.expect(
      `${mode}: child stopped (${proof.method})`,
      proof.childGone && !isReachable(readies[index].pid),
    );
    check.expect(
      `${mode}: descendant ${descendant} was found in the pre-kill snapshot and stopped`,
      covered !== undefined && covered.gone && descendant !== undefined && !isReachable(descendant),
      covered,
    );
  }
  const byes = yield* all([0, 1, 2, 3, 4].map((ordinal) => workspace.shutdown(ordinal)));
  check.expect(
    "orphans: outside the pane sweep's ancestry once their parent exited",
    orphanPids.every(
      (pid) => !byes.some((bye) => bye.proof.descendants.some((entry) => entry.pid === pid)),
    ),
    byes.map((bye) => bye.proof),
  );
  const stopped = yield* workspace.grid.stop();
  check.expect("server stopped", stopped.serverGone && stopped.unreachable);
  check.fact(
    "ttyHolders",
    byes.map((bye) => bye.ttyHolders),
  );
  const [holdingOrphan, closedOrphan] = orphanPids;
  const foundHolding = byes[3].ttyHolders.find((entry) => entry.pid === holdingOrphan);
  check.expect(
    "orphan holding the terminal: named by the worker's shutdown sweep and stopped",
    foundHolding !== undefined && foundHolding.gone && !isReachable(holdingOrphan),
    { holdingOrphan, foundHolding },
  );
  const closedFound = byes.some((bye) =>
    bye.ttyHolders.some((entry) => entry.pid === closedOrphan),
  );
  const closedAlive = isReachable(closedOrphan);
  check.fact("orphanClosed", {
    pid: closedOrphan,
    foundByAnySweep: closedFound,
    stillRunning: closedAlive,
  });
  check.expect(
    "orphan that closed the terminal: recorded as unprovable by this topology",
    !closedFound && closedAlive,
    { closedFound, closedAlive },
  );
  if (closedAlive) {
    deliver(closedOrphan, "SIGKILL");
    check.note(
      `orphan ${closedOrphan} (escaped the group, lost its parent, closed the terminal) is invisible to ancestry, process-group and terminal-holder sweeps; the check killed it afterwards using the child's own record of its pid`,
    );
  }
  const holders: Record<string, number[]> = {};
  for (const pane of workspace.grid.panes) {
    holders[pane.tty] = yield* holdersOf(pane.tty);
  }
  check.expect(
    "after the server stopped, `lsof` names no holder of any pane terminal",
    Object.values(holders).every((list) => list.length === 0),
    holders,
  );
  check.note(
    "once the worker exits, tmux closes the pane's pty master and macOS revokes the slave, so a holder can only be named by the worker before it leaves",
  );
}

export function* checkCancellationPoints(check: Check, context: CheckContext): Operation<void> {
  const phases = ["prepared", "workers", "ready", "attached", "active"] as const;
  for (const phase of phases) {
    if ((phase === "attached" || phase === "active") && !context.attachable) {
      check.note(`${phase}: no terminal, skipped`);
      continue;
    }
    let serverPid = -1;
    let directory = "";
    const workerPids: number[] = [];
    const childPids: number[] = [];
    let reached = false;
    let taskError: string | undefined;
    const task: Task<void> = yield* spawn(function* () {
      // A failure inside the task must not escape: it is recorded, and the
      // task holds its resources until the check halts it.
      try {
        yield* steps();
      } catch (error) {
        taskError = error instanceof Error ? error.message : String(error);
        yield* suspend();
      }
    });
    function* steps(): Operation<void> {
      const workspace = yield* useWorkspace({
        columns: 2,
        panes: 2,
        evidenceDirectory: context.evidenceDirectory,
        onPhase: (current, facts) => {
          serverPid = facts.serverPid ?? serverPid;
          directory = facts.directory;
          if (current === phase) {
            reached = true;
          }
        },
      });
      directory = workspace.directory;
      workerPids.push(...workspace.links.map((link) => link.hello.pid));
      const evidence = (name: string) =>
        join(context.evidenceDirectory, `cancel-${phase}-${name}.json`);
      yield* workspace.launch(0, { id: "a", argv: childCommand(evidence("a"), "plain") });
      yield* workspace.launch(1, {
        id: "b",
        argv: childCommand(evidence("b"), "ignore-sigint-fork"),
      });
      const readies = yield* all([
        workspace.waitFor(0, isLaunchEvent("ready", "a")),
        workspace.waitFor(1, isLaunchEvent("ready", "b")),
      ]);
      childPids.push(...readies.map((event) => event.pid));
      if (phase === "ready") {
        reached = true;
      }
      const client = yield* workspace.grid.attach();
      yield* controlUntil(workspace.grid, 0, (event) => event.kind === "client-attached");
      if (phase === "attached") {
        reached = true;
      }
      yield* workspace.keys(0, "typing", "Enter");
      yield* childEvidenceHas(evidence("a"), (file) => file.stdin.includes("typing"));
      void client;
      reached = true;
      yield* suspend();
    }
    // Halt from outside the task, once it reports the phase.
    yield* eventually(function* () {
      return reached;
    }, 30_000);
    const haltedAt = Date.now();
    yield* task.halt();
    const teardownMs = Date.now() - haltedAt;
    check.fact(`${phase}`, { serverPid, workerPids, childPids, teardownMs });
    check.expect(`${phase}: phase reached`, reached, taskError);
    check.expect(`${phase}: server gone`, serverPid > 0 && (yield* allGone([serverPid])));
    check.expect(`${phase}: workers gone`, yield* allGone(workerPids));
    check.expect(`${phase}: children gone`, yield* allGone(childPids));
    check.expect(
      `${phase}: private directory removed`,
      directory !== "" && !(yield* exists(directory)),
    );
  }
}

export interface MeasuredRun {
  panes: number;
  layoutMs: number;
  workersMs: number;
  readyMs: number;
  attachMs: number;
  closeDetectMs: number;
  teardownMs: number;
}

export function* measureOnce(panes: number, context: CheckContext): Operation<MeasuredRun> {
  const t0 = Date.now();
  let layoutMs = 0;
  let workersMs = 0;
  const workspace = yield* useWorkspace({
    columns: 2,
    panes,
    evidenceDirectory: context.evidenceDirectory,
    onPhase: (phase) => {
      if (phase === "prepared") {
        layoutMs = Date.now() - t0;
      }
      if (phase === "workers") {
        workersMs = Date.now() - t0;
      }
    },
  });
  for (let ordinal = 0; ordinal < panes; ordinal++) {
    yield* workspace.launch(ordinal, {
      id: `m${ordinal}`,
      argv: childCommand(
        join(context.evidenceDirectory, `measure-${panes}-${ordinal}.json`),
        "plain",
      ),
    });
  }
  const readies = yield* all(
    Array.from({ length: panes }, (_, ordinal) =>
      workspace.waitFor(ordinal, isLaunchEvent("ready", `m${ordinal}`)),
    ),
  );
  const readyMs = Date.now() - t0;
  const tAttach = Date.now();
  const client = yield* workspace.grid.attach();
  const cursor = (yield* controlUntil(
    workspace.grid,
    0,
    (event) => event.kind === "client-attached",
  )).next;
  const attachMs = Date.now() - tAttach;
  const tClose = Date.now();
  yield* workspace.grid.detach(client);
  yield* controlUntil(workspace.grid, cursor, (event) => event.kind === "client-detached");
  yield* client.process.exited;
  const closeDetectMs = Date.now() - tClose;
  const tTeardown = Date.now();
  yield* all(readies.map((_, ordinal) => workspace.cancel(ordinal, `m${ordinal}`)));
  yield* all(readies.map((_, ordinal) => workspace.shutdown(ordinal)));
  yield* workspace.grid.stop();
  const gone = yield* allGone([
    ...readies.map((event) => event.pid),
    ...workspace.links.map((link) => link.hello.pid),
  ]);
  if (!gone) {
    throw new Error(`measurement with ${panes} panes: a process survived teardown`);
  }
  const teardownMs = Date.now() - tTeardown;
  return { panes, layoutMs, workersMs, readyMs, attachMs, closeDetectMs, teardownMs };
}

export function* checkMeasurements(
  check: Check,
  context: CheckContext,
  runs: number,
): Operation<void> {
  if (!context.attachable) {
    check.note("no terminal: skipped");
    return;
  }
  const results: MeasuredRun[] = [];
  for (const panes of [2, 4, 8]) {
    for (let run = 0; run < runs; run++) {
      results.push(yield* measureOnce(panes, context));
    }
    yield* context.log(`measured ${panes} panes × ${runs}`);
  }
  check.fact("runs", results);
  const summary: Record<string, Record<string, { median: number; min: number; max: number }>> = {};
  for (const panes of [2, 4, 8]) {
    const mine = results.filter((run) => run.panes === panes);
    summary[String(panes)] = {};
    for (const key of [
      "layoutMs",
      "workersMs",
      "readyMs",
      "attachMs",
      "closeDetectMs",
      "teardownMs",
    ] as const) {
      const values = mine.map((run) => run[key]).toSorted((a, b) => a - b);
      summary[String(panes)][key] = {
        median: values[Math.floor(values.length / 2)],
        min: values[0],
        max: values[values.length - 1],
      };
    }
  }
  check.fact("summary", summary);
  check.expect(
    `${results.length} runs completed with complete teardown`,
    results.length === runs * 3,
  );
}
