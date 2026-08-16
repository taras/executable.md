/**
 * Tier WAC, continued — what survives a process, and what must not.
 *
 * The rest of the atomic Workspace suite ends its transactions in this
 * process: it commits, fails, or is cancelled, and Effection tears the scope
 * down. None of that is a crash. At the kill point the transaction is open;
 * `SIGKILL` then runs no application cleanup at all, so nothing commits and
 * nothing rolls back. The operating system closes the connection and releases
 * its locks, and the next connection to open the database recovers the
 * interrupted transaction to the last committed state. Whether the mutation,
 * the immutable root, the current-root pointer and the routed journal row
 * reappear is decided there rather than by any code here.
 *
 * So the proofs below are made of real processes. One is killed with SIGKILL
 * while it holds all four of those writes uncommitted; another, which has
 * never seen it, reopens the database and must find the baseline exactly. Two
 * more commit a Workspace history and then reconstruct an older event's root
 * from a cold start.
 *
 * The handshake is a line of JSON on standard output, never a sleep: the
 * parent kills the child at a point the child has said it has reached.
 */

import { readTextFile } from "@effectionx/fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { exec as execProcess } from "@effectionx/process";
import { exec } from "@executablemd/runtime";
import { guardDurableStream } from "@executablemd/durable-streams";
import { call, type Operation, race, scoped, spawn, until, withResolvers } from "effection";
import { setPrivateWorkspaceClock, transactWorkspaceRoots } from "../src/deno/workspace/private.ts";
import { createRun, runPath, useStorageRoot, withStorage } from "./support/storage.ts";
import {
  BASELINE_CLOCK,
  BASELINE_CONTENT,
  BASELINE_EFFECT,
  BASELINE_PATH,
  count,
  CRASH_CONTENT,
  CRASH_EFFECT,
  CRASH_PATH,
  HISTORICAL_CONTENT,
  HISTORICAL_PATH,
  NESTED_CONTENT,
  NESTED_PATH,
  REVISE_CLOCK,
  SEED_CLOCK,
} from "./support/workspace-process.ts";

const REPOSITORY = fileURLToPath(new URL("../../..", import.meta.url));
const CRASH_CHILD = fileURLToPath(new URL("./support/workspace-crash-child.ts", import.meta.url));
const RESTART_CHILD = fileURLToPath(
  new URL("./support/workspace-restart-child.ts", import.meta.url),
);

interface ReportedEvent {
  readonly eventId: string;
  readonly name?: string;
}

/**
 * Event names in order, with the run's terminating Close named too.
 *
 * `toEqual` treats a trailing `undefined` as absent, so a Close reported as an
 * unnamed event would let a comparison of names pass without it.
 */
function names(events: readonly ReportedEvent[]): string[] {
  return events.map((event) => event.name ?? "close");
}

interface ChildResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** One whole child process, reaped before the operation returns. */
function* runChild(script: string, args: string[]): Operation<ChildResult> {
  const result = yield* exec({
    command: [process.execPath, "run", "--allow-all", "--frozen", script, ...args],
    cwd: REPOSITORY,
  });
  return { code: result.exitCode, out: result.stdout, err: result.stderr };
}

function announced(result: ChildResult): Record<string, unknown> {
  if (result.code !== 0) {
    throw new Error(`the child exited ${result.code}: ${result.err}`);
  }
  return JSON.parse(result.out);
}

/**
 * Everything a second connection can see of the database right now.
 *
 * Raw SQLite rather than another DOFS wrapper: the question is only what has
 * been committed, and a second authoritative wrapper on the same path is the
 * thing the provider exists to prevent.
 */
function committed(path: string): Record<string, unknown> {
  const sqlite = new DatabaseSync(path, { readOnly: true });
  try {
    sqlite.exec("PRAGMA busy_timeout = 10000");
    const total = (table: string): number =>
      count(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.["count"]);
    return {
      currentRoot: sqlite.prepare("SELECT current_root_id FROM workspace_state").get()?.[
        "current_root_id"
      ],
      roots: total("workspace_roots"),
      manifestRefs: total("workspace_root_manifest_refs"),
      blobRefs: total("workspace_root_blob_refs"),
      manifests: total("vfs_manifests"),
      blobs: total("vfs_blobs"),
      names: sqlite
        .prepare("SELECT name FROM vfs_dirents ORDER BY name")
        .all()
        .map((row) => row["name"]),
      journal: sqlite
        .prepare("SELECT event_id, workspace_root_id, record FROM journal_events ORDER BY sequence")
        .all()
        .map((row) => ({
          eventId: row["event_id"],
          rootId: row["workspace_root_id"],
          name: JSON.parse(String(row["record"])).description?.name,
        })),
    };
  } finally {
    sqlite.close();
  }
}

/** The retained roots an event never named, so restoration cannot borrow them. */
function manifestsOf(path: string, rootId: string): string[] {
  const sqlite = new DatabaseSync(path, { readOnly: true });
  try {
    return sqlite
      .prepare(
        "SELECT hex(manifest_hash) AS hash FROM workspace_root_manifest_refs WHERE root_id = ?",
      )
      .all(rootId)
      .map((row) => String(row["hash"]).toLowerCase());
  } finally {
    sqlite.close();
  }
}

/**
 * A committed, non-empty Workspace and one filtered journal event.
 *
 * Recorded as a run that has not finished, rather than as a completed
 * `durableRun`: the crash process resumes this run, and a journal that already
 * holds a Close is a run with nothing left to execute. So the mutation and its
 * root are published through the private Workspace transaction, and the one
 * event is appended through a secret gate — the same two writes a coordinated
 * effect commits, in a shape the next process continues from.
 */
function* baseline(root: string, runId: string): Operation<void> {
  yield* withStorage(root, function* () {
    const database = yield* createRun({ runId });
    yield* setPrivateWorkspaceClock(database, () => BASELINE_CLOCK);
    const captured = yield* transactWorkspaceRoots(database, function* (workspace) {
      yield* workspace.filesystem.mkdir("/kept", { mode: 0o750 });
      yield* workspace.filesystem.writeFile(BASELINE_PATH, BASELINE_CONTENT, 0o640);
      yield* workspace.filesystem.writeFile(NESTED_PATH, NESTED_CONTENT, 0o600);
      return yield* workspace.capture({ publish: true });
    });
    if (!captured.ok) {
      throw captured.error;
    }
    const guarded = guardDurableStream(database.journal, function* () {});
    yield* guarded.append({
      type: "yield",
      coroutineId: "root",
      description: { type: "workspace-proof", name: BASELINE_EFFECT },
      result: { status: "ok", value: null },
    });
  });
}

describe("Tier WAC — Workspace effects across a process boundary", () => {
  it("WAC24: a real SIGKILL before commit leaves the baseline and nothing else", function* () {
    const root = yield* useStorageRoot();
    const runId = "crash-before-commit";
    yield* baseline(root, runId);

    // Taken after the provider scope closed, so nothing this process holds is
    // keeping the database open when the child starts.
    const path = runPath(root, runId);
    const before = committed(path);
    const baselineJournal = before["journal"] as (ReportedEvent & { rootId: string })[];
    expect(names(baselineJournal)).toEqual([BASELINE_EFFECT]);
    expect(before["roots"]).toBe(2);
    expect(baselineJournal[0].rootId).toBe(before["currentRoot"]);

    const during = yield* scoped(function* () {
      const child = yield* execProcess(process.execPath, {
        arguments: ["run", "--allow-all", "--frozen", CRASH_CHILD, "crash", root, runId],
        cwd: REPOSITORY,
      });
      const ready = withResolvers<Record<string, unknown>>();
      const decoder = new TextDecoder();
      let out = "";
      let err = "";
      yield* spawn(function* () {
        const subscription = yield* child.stdout;
        let next = yield* subscription.next();
        while (!next.done) {
          out += decoder.decode(next.value, { stream: true });
          const end = out.indexOf("\n");
          if (end >= 0) {
            ready.resolve(JSON.parse(out.slice(0, end)));
          }
          next = yield* subscription.next();
        }
      });
      yield* spawn(function* () {
        const subscription = yield* child.stderr;
        let next = yield* subscription.next();
        while (!next.done) {
          err += decoder.decode(next.value, { stream: true });
          next = yield* subscription.next();
        }
      });

      const announcement = yield* race([
        ready.operation,
        call(function* (): Operation<Record<string, unknown>> {
          const status = yield* child.join();
          throw new Error(
            `the crash child ended before its handshake (${JSON.stringify(status)}): ${err}`,
          );
        }),
      ]);

      // The child holds its transaction open here, so what a second connection
      // can see is the discriminating observation: it must still be exactly
      // the baseline, with no crash mutation, root, pointer change or event.
      const outside = committed(path);
      process.kill(child.pid, "SIGKILL");
      const status = yield* child.join();
      return { announcement, outside, status };
    });

    // The child died from the signal rather than from cleanup of its own.
    expect(during.status.signal).toBe("SIGKILL");
    expect(during.status.code ?? null).toBeNull();

    // Inside the crashed transaction all four writes existed.
    expect(during.announcement).toEqual({
      ready: true,
      content: CRASH_CONTENT,
      currentRoot: expect.any(String),
      retainedRoots: 3,
      currentRootRetained: 1,
      journalEventId: expect.any(String),
      journalRootId: during.announcement["currentRoot"],
      journalRows: baselineJournal.length + 1,
      gateCalls: 1,
      baselineExecutions: 0,
    });
    expect(during.announcement["currentRoot"]).not.toBe(before["currentRoot"]);

    // None of them was visible to anyone else while the child was alive. The
    // two readings are of one database at one moment, through the connection
    // that made the writes and through a connection that did not.
    expect(during.outside["currentRoot"]).not.toBe(during.announcement["currentRoot"]);
    expect(during.outside["roots"]).toBe(2);
    expect(during.outside).toEqual(before);

    // A different process, through a newly installed production provider,
    // finds the baseline and only the baseline.
    const inspected = announced(yield* runChild(CRASH_CHILD, ["inspect", root, runId]));
    expect(inspected["currentRoot"]).toBe(before["currentRoot"]);
    expect(inspected["tree"]).toEqual({
      "/baseline.txt": {
        kind: "file",
        mode: 0o640,
        mtime: BASELINE_CLOCK,
        size: BASELINE_CONTENT.length,
        content: BASELINE_CONTENT,
      },
      "/kept": { kind: "directory", mode: 0o750, mtime: BASELINE_CLOCK },
      [NESTED_PATH]: {
        kind: "file",
        mode: 0o600,
        mtime: BASELINE_CLOCK,
        size: NESTED_CONTENT.length,
        content: NESTED_CONTENT,
      },
    });
    const inspectedEvents = inspected["events"] as ReportedEvent[];
    expect(names(inspectedEvents)).toEqual([BASELINE_EFFECT]);
    expect(inspectedEvents.map((event) => event.eventId)).toEqual(
      baselineJournal.map((event) => event.eventId),
    );
    expect(JSON.stringify(inspected["tree"])).not.toContain(CRASH_PATH);

    // Recovery restored the file itself, not only what the adapter reads.
    expect(committed(path)).toEqual(before);
  });

  it("WAC25: a second process restores the committed Workspace and re-executes nothing", function* () {
    const root = yield* useStorageRoot();
    const runId = "workspace-restart";
    const marker = join(root, "restart-marker.txt");
    yield* until(writeFile(marker, ""));

    const first = announced(yield* runChild(RESTART_CHILD, ["commit", root, runId, marker]));
    expect(yield* readTextFile(marker)).toBe("seed\nrevise\n");

    const path = runPath(root, runId);
    const stored = committed(path);
    const second = announced(yield* runChild(RESTART_CHILD, ["read", root, runId, marker]));

    // Nothing ran twice: the second process restored both recorded results.
    expect(yield* readTextFile(marker)).toBe("seed\nrevise\n");
    expect(second["currentRoot"]).toBe(first["currentRoot"]);
    expect(second["tree"]).toEqual(first["tree"]);
    expect(second["tree"]).toEqual({
      "/tree": { kind: "directory", mode: 0o750, mtime: SEED_CLOCK },
      "/renamed.txt": {
        kind: "file",
        mode: 0o600,
        mtime: REVISE_CLOCK,
        size: 11,
        content: "later bytes",
      },
      "/latest.txt": { kind: "symlink", target: "/renamed.txt" },
      "/later": { kind: "directory", mode: 0o700, mtime: REVISE_CLOCK },
    });
    expect(second["events"]).toEqual(first["events"]);
    expect(names(second["events"] as ReportedEvent[])).toEqual(["seed", "revise", "close"]);

    // Each event keeps the root it was committed against, and the later one
    // is the current root a cold process reads.
    const journal = stored["journal"] as (ReportedEvent & { rootId: string })[];
    expect(names(journal)).toEqual(["seed", "revise", "close"]);
    expect(journal.map((row) => row.eventId)).toEqual(
      (first["events"] as ReportedEvent[]).map((event) => event.eventId),
    );
    expect(journal[0].rootId).not.toBe(journal[1].rootId);
    expect(journal[1].rootId).toBe(first["currentRoot"]);
    expect(journal[2].rootId).toBe(first["currentRoot"]);
    expect(committed(path)).toEqual(stored);
  });

  it("WAC26: an older event's root reconstructs exactly in a fresh process", function* () {
    const root = yield* useStorageRoot();
    const runId = "workspace-history";
    const marker = join(root, "history-marker.txt");
    yield* until(writeFile(marker, ""));

    const first = announced(yield* runChild(RESTART_CHILD, ["commit", root, runId, marker]));
    const path = runPath(root, runId);
    const stored = committed(path);
    const journal = stored["journal"] as (ReportedEvent & { rootId: string })[];
    expect(names(journal)).toEqual(["seed", "revise", "close"]);
    const historical = journal[0].rootId;
    const later = journal[1].rootId;
    expect(historical).not.toBe(later);

    // The retained content the older root needs is no longer reachable from
    // the live frontier, so restoration has to come from what that root
    // retains rather than from anything still live.
    const retired = manifestsOf(path, historical).filter(
      (hash) => !manifestsOf(path, later).includes(hash),
    );
    expect(retired.length).toBeGreaterThan(0);

    const replayed = announced(
      yield* runChild(RESTART_CHILD, ["restore", root, runId, marker, historical]),
    );
    expect(yield* readTextFile(marker)).toBe("seed\nrevise\n");

    const restored = replayed["restored"] as Record<string, unknown>;
    // The negative lookup happened first and was answered from the live
    // frontier, so the successful read after restoration is the authoritative
    // negative cache having been invalidated rather than never consulted.
    expect(restored["absent"]).toBe("WorkspaceFsError");
    expect(restored["selectedRoot"]).toBe(historical);
    // Two paths reading the same bytes are not yet one file. The canonical
    // manifest names the hardlink group, so a rebuild that gave them separate
    // inodes would resnapshot to a different identity than the one selected.
    expect(restored["resnapshotRoot"]).toBe(historical);
    expect(restored["currentRoot"]).toBe(historical);
    expect(restored["tree"]).toEqual({
      "/tree": { kind: "directory", mode: 0o750, mtime: SEED_CLOCK },
      [HISTORICAL_PATH]: {
        kind: "file",
        mode: 0o640,
        mtime: SEED_CLOCK,
        size: HISTORICAL_CONTENT.length,
        content: HISTORICAL_CONTENT,
      },
      "/tree/hardlink.txt": {
        kind: "file",
        mode: 0o640,
        mtime: SEED_CLOCK,
        size: HISTORICAL_CONTENT.length,
        content: HISTORICAL_CONTENT,
      },
      "/tree/current.txt": { kind: "symlink", target: "file.txt" },
    });
    expect(restored["manifestHashes"]).toEqual(expect.arrayContaining(retired));

    // The committed observations the same process made before restoring are
    // still the ones the first process published.
    const committedAgain = replayed["committed"] as Record<string, unknown>;
    expect(committedAgain["currentRoot"]).toBe(first["currentRoot"]);
    expect(committedAgain["events"]).toEqual(first["events"]);

    // Restoration published a root that was already retained; it created no
    // new one and lost no history.
    const after = committed(path);
    expect(after["roots"]).toBe(stored["roots"]);
    expect(after["currentRoot"]).toBe(historical);
    expect((after["journal"] as unknown[]).length).toBe(journal.length);
  });
});
