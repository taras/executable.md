/**
 * One grid of pane workers, from the parent's point of view: the private
 * directory, the sockets, the tmux composite, and an admitted link per pane,
 * with every frame a worker sent kept in order so a check can wait for the
 * one it means by identity rather than by position.
 *
 * Ownership, innermost last:
 *
 *   workspace scope
 *   ├─ private directory (mode 0700; removed with the scope)
 *   ├─ pane sockets (servers + admitted connections; closed with the scope)
 *   ├─ tmux grid (server, panes, control client; `kill-server` with the scope)
 *   └─ one reader task per pane (halted with the scope)
 *
 * A worker is started by tmux, not by this process, so its lifetime is the
 * pane's: `shutdown` asks it to leave, and `kill-server` takes the pane's
 * terminal away from whatever is left.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createSignal, ensure, race, resource, sleep, spawn, until } from "effection";
import type { Operation } from "effection";
import { usePaneSockets } from "./ipc.ts";
import type { FromWorker, PaneLink, PaneSockets, QuiescenceProof } from "./ipc.ts";
import { useTmuxGrid } from "./provider.ts";
import type { PaneInfo, TmuxGrid } from "./provider.ts";

export type PaneEvent = FromWorker | { type: "closed" };

export interface WorkspaceOptions {
  columns: number;
  panes: number;
  width?: number;
  height?: number;
  titles?: string[];
  /** Called as the composite comes up; a cancellation check halts here. */
  onPhase?: (phase: WorkspacePhase, facts: { directory: string; serverPid?: number }) => void;
  /** Where child evidence files go; a longer path is fine here. */
  evidenceDirectory: string;
}

export type WorkspacePhase = "sockets" | "prepared" | "workers";

export interface LaunchSpec {
  id: string;
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface Workspace {
  directory: string;
  sockets: PaneSockets;
  grid: TmuxGrid;
  links: PaneLink[];
  env: Record<string, string>;
  pane(ordinal: number): PaneInfo;
  events(ordinal: number): PaneEvent[];
  /** Wait for the first event on `ordinal` satisfying `test`. */
  waitFor<T extends PaneEvent>(
    ordinal: number,
    test: (event: PaneEvent) => event is T,
    limitMs?: number,
  ): Operation<T>;
  display(ordinal: number, text: string): Operation<void>;
  launch(ordinal: number, spec: LaunchSpec): Operation<void>;
  cancel(ordinal: number, id: string): Operation<PaneEvent & { type: "quiescent" }>;
  shutdown(
    ordinal: number,
  ): Operation<{ proof: QuiescenceProof; ttyHolders: { pid: number; gone: boolean }[] }>;
  /** Everything typed into `ordinal` goes to whatever reads its terminal. */
  keys(ordinal: number, ...keys: string[]): Operation<void>;
  capture(ordinal: number): Operation<string>;
}

const REPO_ROOT = join(import.meta.dirname ?? ".", "..", "..", "..");
const PROOF_DIR = import.meta.dirname ?? ".";
const DEFAULT_LIMIT_MS = 15_000;

export class WaitTimeout extends Error {
  override name = "WaitTimeout";
  constructor(ordinal: number, what: string, seen: PaneEvent[]) {
    super(
      `pane ${ordinal}: no ${what} within the limit; seen ${JSON.stringify(seen.map((event) => event.type))}`,
    );
  }
}

/** The environment every process in the topology receives. */
export function filteredEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "SHELL", "LANG", "TMPDIR", "USER", "LOGNAME"]) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  env.TERM = "xterm-256color";
  return env;
}

export function workerCommand(directory: string): (ordinal: number) => string[] {
  return (ordinal) => [
    "deno",
    "run",
    "--allow-all",
    join(PROOF_DIR, "worker.ts"),
    String(ordinal),
    directory,
  ];
}

export function childCommand(evidenceFile: string, mode: string, ...args: string[]): string[] {
  return [
    "deno",
    "run",
    "--allow-all",
    join(PROOF_DIR, "child.ts"),
    "--evidence",
    evidenceFile,
    "--mode",
    mode,
    "--",
    ...args,
  ];
}

/**
 * A short private directory. `tmpdir()` on macOS is already 49 characters; a
 * socket path inside it must stay under 104.
 */
export function usePrivateDirectory(): Operation<string> {
  return resource(function* (provide) {
    // Synchronous so nothing suspends between creating and owning it.
    // oxlint-disable-next-line local/no-sync-filesystem
    const directory = mkdtempSync(join(tmpdir(), "xtg-"));
    yield* ensure(() =>
      until(rm(directory, { recursive: true, force: true }).catch(() => undefined)),
    );
    yield* until(chmod(directory, 0o700));
    yield* provide(directory);
  });
}

export function useWorkspace(options: WorkspaceOptions): Operation<Workspace> {
  return resource(function* (provide) {
    const env = filteredEnvironment();
    const directory = yield* usePrivateDirectory();
    yield* until(mkdir(options.evidenceDirectory, { recursive: true }));
    const sockets = yield* usePaneSockets(directory, options.panes);
    options.onPhase?.("sockets", { directory });
    const grid = yield* useTmuxGrid(directory, {
      session: "grid",
      columns: options.columns,
      panes: options.panes,
      width: options.width ?? 160,
      height: options.height ?? 48,
      titles: options.titles ?? Array.from({ length: options.panes }, (_, i) => `pane ${i}`),
      workerCommand: workerCommand(directory),
      cwd: REPO_ROOT,
      env,
    });
    options.onPhase?.("prepared", { directory, serverPid: grid.serverPid });

    const links: PaneLink[] = [];
    for (let ordinal = 0; ordinal < options.panes; ordinal++) {
      links.push(yield* sockets.link(ordinal));
    }
    options.onPhase?.("workers", { directory, serverPid: grid.serverPid });

    const logs: PaneEvent[][] = links.map(() => []);
    const signals = links.map(() => createSignal<PaneEvent, never>());
    for (const [ordinal, link] of links.entries()) {
      yield* spawn(function* () {
        while (true) {
          const event = yield* link.next();
          const value: PaneEvent = event ?? { type: "closed" };
          logs[ordinal].push(value);
          signals[ordinal].send(value);
          if (event === undefined) {
            return;
          }
        }
      });
    }

    let seq = 0;

    function* waitFor<T extends PaneEvent>(
      ordinal: number,
      test: (event: PaneEvent) => event is T,
      limitMs: number = DEFAULT_LIMIT_MS,
    ): Operation<T> {
      // Subscribe before scanning, so an event between the scan and the wait
      // is not lost.
      const subscription = yield* signals[ordinal];
      const already = logs[ordinal].find(test);
      if (already) {
        return already;
      }
      const found = yield* race([
        (function* (): Operation<T | undefined> {
          while (true) {
            const next = yield* subscription.next();
            if (next.done) {
              return undefined;
            }
            if (test(next.value)) {
              return next.value;
            }
          }
        })(),
        (function* (): Operation<undefined> {
          yield* sleep(limitMs);
          return undefined;
        })(),
      ]);
      if (found === undefined) {
        throw new WaitTimeout(ordinal, test.name || "event", logs[ordinal]);
      }
      return found;
    }

    yield* provide({
      directory,
      sockets,
      grid,
      links,
      env,
      pane: (ordinal) => grid.panes[ordinal],
      events: (ordinal) => [...logs[ordinal]],
      waitFor,
      *display(ordinal, text) {
        const mine = ++seq;
        yield* links[ordinal].send({ type: "display", seq: mine, text });
        yield* waitFor(
          ordinal,
          (event): event is PaneEvent & { type: "displayed" } =>
            event.type === "displayed" && event.seq === mine,
        );
      },
      *launch(ordinal, spec) {
        yield* links[ordinal].send({
          type: "launch",
          id: spec.id,
          argv: spec.argv,
          cwd: spec.cwd ?? REPO_ROOT,
          env: spec.env ?? env,
        });
      },
      *cancel(ordinal, id) {
        yield* links[ordinal].send({ type: "cancel", id });
        return yield* waitFor(
          ordinal,
          (event): event is PaneEvent & { type: "quiescent" } =>
            isQuiescent(event) && event.id === id,
        );
      },
      *shutdown(ordinal) {
        yield* links[ordinal].send({ type: "shutdown" });
        const quiescent = yield* waitFor(
          ordinal,
          (event): event is PaneEvent & { type: "quiescent" } =>
            isQuiescent(event) && event.id === undefined,
        );
        const bye = yield* waitFor(ordinal, isType("bye"));
        yield* waitFor(ordinal, isType("closed"));
        return { proof: quiescent.proof, ttyHolders: bye.ttyHolders };
      },
      *keys(ordinal, ...keys) {
        yield* grid.tmux.run(["send-keys", "-t", grid.panes[ordinal].id, ...keys]);
      },
      *capture(ordinal) {
        return yield* grid.tmux.run(["capture-pane", "-p", "-J", "-t", grid.panes[ordinal].id]);
      },
    });
  });
}

function isQuiescent(event: PaneEvent): event is PaneEvent & { type: "quiescent" } {
  return event.type === "quiescent";
}

export function isType<K extends PaneEvent["type"]>(type: K) {
  return (event: PaneEvent): event is Extract<PaneEvent, { type: K }> => event.type === type;
}

export function isLaunchEvent<K extends "ready" | "startup-failed" | "refused" | "exited">(
  type: K,
  id: string,
) {
  return (event: PaneEvent): event is Extract<PaneEvent, { type: K }> =>
    event.type === type && "id" in event && event.id === id;
}
