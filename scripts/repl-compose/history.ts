/**
 * One execution's history, and the projection that ends history-record access.
 *
 * `ReplHistory` is the immutable ordered execution records the REPL reads. In
 * production those records are read from the durable Journal — XMD's
 * append-only execution mechanism — and that read happens *above* this
 * experiment. Nothing here is a Journal: this implements no append, no replay,
 * no durability and no transaction, and #842 owns the real read. What is here
 * is a history fixture, hand-authored so that folding it is the only way to
 * learn what was open, what had settled and what was waiting at any recorded
 * moment. Deriving it from a screen would make the routing evidence compare a
 * projection with itself.
 *
 * `projectModel()` is the boundary. Everything above it reads history records;
 * everything below it reads a `ReplModel` and cannot reach a record at all.
 */

import { deepFreeze } from "./model.ts";
import type { Checkpoint, Entry, ReplModel, Scope, Suspension } from "./model.ts";

export type HistoryRecordKind =
  | "entry.submitted"
  | "scope.enter"
  | "scope.exit"
  | "suspension.opened"
  | "suspension.answered"
  | "entry.settled";

export interface HistoryRecord {
  /** The marker a URL names this moment by. */
  readonly marker: string;
  /** Recorded seconds, which is what the Execution History band measures. */
  readonly at: number;
  readonly kind: HistoryRecordKind;
  /** The entry the record was made in. */
  readonly entry: string;
  /**
   * Where inside that entry, outermost first. For `scope.enter` and
   * `scope.exit` this is the parent of the scope named by `detail`; for a
   * suspension it is the scope that owns the wait.
   */
  readonly scope: readonly string[];
  /** The entry's title, the scope's name, or the suspension's kind. */
  readonly detail: string;
  /** What the wait is asking. Only a `suspension.opened` carries one. */
  readonly prompt?: string;
}

export type ReplHistory = readonly HistoryRecord[];

/** The execution this history fixture records. A route naming another one refuses. */
export const EXECUTION = "e1";

/**
 * The representative execution: one entry, a nested scope tree, and two live
 * suspensions.
 *
 * The two-drawer stack is truthful rather than arranged. `document` runs `write`
 * and `publish` as concurrent branches; `write` opens a `project` elicitation
 * and waits, and `publish` then opens a `confirm` on top of it. Both are
 * unanswered at the head, so the stack is ordered by when each opened and the
 * top one is the interactive drawer — which is what makes closing `confirm`
 * expose `project`, its real parent, rather than an empty screen.
 *
 * The `plan` scope exists to be a *settled* nested scope: it opened a `review`
 * suspension, that suspension was answered, and the scope exited. It stays in
 * the tree, because leaving a scope closes it rather than erasing it.
 *
 * Entries in a session are sequential, so this execution has exactly one. The
 * evidence for suspension ownership uses `SERIAL_HISTORY` below, where a second
 * entry begins only after the first has settled.
 */
export const HISTORY: ReplHistory = [
  {
    marker: "cp-01",
    at: 2,
    kind: "entry.submitted",
    entry: "entry-1",
    scope: [],
    detail: "Add a README to the project",
  },
  {
    marker: "cp-02",
    at: 5,
    kind: "scope.enter",
    entry: "entry-1",
    scope: [],
    detail: "document",
  },
  {
    marker: "cp-03",
    at: 12,
    kind: "scope.enter",
    entry: "entry-1",
    scope: ["document"],
    detail: "plan",
  },
  {
    marker: "cp-04",
    at: 18,
    kind: "suspension.opened",
    entry: "entry-1",
    scope: ["document", "plan"],
    detail: "review",
    prompt: "Approve this plan before it runs?",
  },
  {
    marker: "cp-05",
    at: 24,
    kind: "suspension.answered",
    entry: "entry-1",
    scope: ["document", "plan"],
    detail: "review",
  },
  {
    marker: "cp-06",
    at: 30,
    kind: "scope.exit",
    entry: "entry-1",
    scope: ["document"],
    detail: "plan",
  },
  {
    marker: "cp-07",
    at: 34,
    kind: "scope.enter",
    entry: "entry-1",
    scope: ["document"],
    detail: "write",
  },
  {
    marker: "cp-08",
    at: 41,
    kind: "suspension.opened",
    entry: "entry-1",
    scope: ["document", "write"],
    detail: "project",
    prompt: "Which project should the README describe?",
  },
  {
    marker: "cp-09",
    at: 46,
    kind: "scope.enter",
    entry: "entry-1",
    scope: ["document"],
    detail: "publish",
  },
  {
    marker: "cp-10",
    at: 50,
    kind: "suspension.opened",
    entry: "entry-1",
    scope: ["document", "publish"],
    detail: "confirm",
    prompt: "Commit and push the README now?",
  },
];

/**
 * Two entries, one after the other, for proving who owns a suspension.
 *
 * `entry-1` opens a `project` wait in its `document` scope, answers it, leaves
 * the scope and settles. Only then is `entry-2` submitted, and it opens a
 * `project` wait at the same scope path. Every name is the same; only the owner
 * differs — which is the one thing a drawer path can be answered by.
 *
 * The scope exit is not bookkeeping. A settled entry with a scope still open is
 * two live scope trees at one moment, which is a shape the product never
 * reaches and which would carry a false active scope into everything that reads
 * the model.
 *
 * It is deliberately a separate fixture. The representative execution stays one
 * entry, because concurrent entry lifecycles are a state the product does not
 * create and routing must not be shown resolving against one.
 */
export const SERIAL_HISTORY: ReplHistory = [
  {
    marker: "sp-01",
    at: 2,
    kind: "entry.submitted",
    entry: "entry-1",
    scope: [],
    detail: "Add a README to the project",
  },
  {
    marker: "sp-02",
    at: 5,
    kind: "scope.enter",
    entry: "entry-1",
    scope: [],
    detail: "document",
  },
  {
    marker: "sp-03",
    at: 9,
    kind: "suspension.opened",
    entry: "entry-1",
    scope: ["document"],
    detail: "project",
    prompt: "Which project should the README describe?",
  },
  {
    marker: "sp-04",
    at: 14,
    kind: "suspension.answered",
    entry: "entry-1",
    scope: ["document"],
    detail: "project",
  },
  {
    marker: "sp-05",
    at: 17,
    kind: "scope.exit",
    entry: "entry-1",
    scope: [],
    detail: "document",
  },
  {
    marker: "sp-06",
    at: 18,
    kind: "entry.settled",
    entry: "entry-1",
    scope: [],
    detail: "Add a README to the project",
  },
  {
    marker: "sp-07",
    at: 22,
    kind: "entry.submitted",
    entry: "entry-2",
    scope: [],
    detail: "Update the changelog",
  },
  {
    marker: "sp-08",
    at: 26,
    kind: "scope.enter",
    entry: "entry-2",
    scope: [],
    detail: "document",
  },
  {
    marker: "sp-09",
    at: 31,
    kind: "suspension.opened",
    entry: "entry-2",
    scope: ["document"],
    detail: "project",
    prompt: "Which project's changelog is this?",
  },
];

/** The records up to and including one marker, which is the history as it stood. */
export function historyThrough(marker: string, history: ReplHistory = HISTORY): ReplHistory {
  const at = history.findIndex((record) => record.marker === marker);
  if (at === -1) {
    throw new Error(`no such history marker: ${marker}`);
  }
  return history.slice(0, at + 1);
}

interface DraftScope {
  name: string;
  settled: boolean;
  children: DraftScope[];
}

interface DraftEntry {
  id: string;
  title: string;
  settled: boolean;
  scopes: DraftScope[];
}

function findScope(entry: DraftEntry, path: readonly string[]): DraftScope | undefined {
  let level = entry.scopes;
  let found: DraftScope | undefined;
  for (const name of path) {
    found = level.find((scope) => scope.name === name);
    if (found === undefined) {
      return undefined;
    }
    level = found.children;
  }
  return found;
}

function scopesAt(entry: DraftEntry, path: readonly string[]): DraftScope[] | undefined {
  if (path.length === 0) {
    return entry.scopes;
  }
  return findScope(entry, path)?.children;
}

function snapshotScope(scope: DraftScope): Scope {
  return {
    name: scope.name,
    settled: scope.settled,
    children: scope.children.map(snapshotScope),
  };
}

function snapshot(
  marker: string,
  at: number,
  entries: readonly DraftEntry[],
  suspensions: readonly Suspension[],
): Checkpoint {
  const copied: Entry[] = entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    settled: entry.settled,
    scopes: entry.scopes.map(snapshotScope),
  }));
  const stack: Suspension[] = suspensions.map((suspension) => ({
    kind: suspension.kind,
    entry: suspension.entry,
    scope: [...suspension.scope],
    prompt: suspension.prompt,
  }));
  return deepFreeze({ marker, at, entries: copied, suspensions: stack });
}

/** The first scope anywhere in a tree that has not exited. */
function unsettledScope(scopes: readonly DraftScope[]): DraftScope | undefined {
  for (const scope of scopes) {
    if (!scope.settled) {
      return scope;
    }
    const deeper = unsettledScope(scope.children);
    if (deeper !== undefined) {
      return deeper;
    }
  }
  return undefined;
}

/** Whether one open suspension is the exact wait a record names. */
function owns(suspension: Suspension, record: HistoryRecord): boolean {
  return (
    suspension.entry === record.entry &&
    suspension.kind === record.detail &&
    suspension.scope.length === record.scope.length &&
    suspension.scope.every((name, at) => name === record.scope[at])
  );
}

function where(record: HistoryRecord): string {
  const path =
    record.scope.length === 0 ? record.entry : `${record.entry}/${record.scope.join("/")}`;
  return `${record.marker} (${record.kind} ${JSON.stringify(record.detail)} in ${path})`;
}

/**
 * Fold a history into the model it describes.
 *
 * Each record produces one checkpoint holding the complete moment that followed
 * it, so reconstructing a moment needs that checkpoint and nothing else. The
 * head is the newest one.
 */
export function projectModel(execution: string, history: ReplHistory = HISTORY): ReplModel {
  const entries: DraftEntry[] = [];
  const suspensions: Suspension[] = [];
  const checkpoints: Checkpoint[] = [];

  for (const record of history) {
    if (record.kind === "entry.submitted") {
      if (entries.some((entry) => entry.id === record.entry)) {
        throw new Error(`${where(record)} submits an entry that is already open`);
      }
      // Entries in a session are sequential. Two live at once is a state the
      // product does not create, so the projection refuses to describe one
      // rather than letting a fixture drift into proving routing against it.
      const running = entries.find((entry) => !entry.settled);
      if (running !== undefined) {
        throw new Error(`${where(record)} submits an entry while ${running.id} is still running`);
      }
      entries.push({ id: record.entry, title: record.detail, settled: false, scopes: [] });
    } else {
      const entry = entries.find((candidate) => candidate.id === record.entry);
      if (entry === undefined) {
        throw new Error(`${where(record)} names an entry no record submitted`);
      }
      if (record.kind === "scope.enter") {
        const level = scopesAt(entry, record.scope);
        if (level === undefined) {
          throw new Error(`${where(record)} names a parent scope no record entered`);
        }
        if (level.some((scope) => scope.name === record.detail)) {
          throw new Error(`${where(record)} enters a scope that is already open there`);
        }
        level.push({ name: record.detail, settled: false, children: [] });
      }
      if (record.kind === "scope.exit") {
        const leaving = findScope(entry, [...record.scope, record.detail]);
        if (leaving === undefined) {
          throw new Error(`${where(record)} exits a scope no record entered`);
        }
        leaving.settled = true;
      }
      if (record.kind === "suspension.opened") {
        if (findScope(entry, record.scope) === undefined && record.scope.length > 0) {
          throw new Error(`${where(record)} suspends in a scope no record entered`);
        }
        suspensions.push({
          kind: record.detail,
          entry: record.entry,
          scope: [...record.scope],
          prompt: record.prompt ?? "",
        });
      }
      if (record.kind === "suspension.answered") {
        // An answer names one wait completely: the entry, the exact scope path
        // inside it, and the kind. Matching on anything less lets an answer for
        // a finished entry consume a live wait belonging to the next one, which
        // reconstructs a moment that never happened.
        let answered = -1;
        for (let index = suspensions.length - 1; index >= 0 && answered === -1; index -= 1) {
          if (owns(suspensions[index], record)) {
            answered = index;
          }
        }
        if (answered === -1) {
          throw new Error(`${where(record)} answers no suspension this entry has open`);
        }
        suspensions.splice(answered, 1);
      }
      if (record.kind === "entry.settled") {
        const waiting = suspensions.find((suspension) => suspension.entry === record.entry);
        if (waiting !== undefined) {
          throw new Error(`${where(record)} settles an entry still waiting on ${waiting.kind}`);
        }
        // An entry that settled while a scope it opened had not exited would
        // leave a second live scope tree beside the next entry's. `settled`
        // records that a scope exited, so this refuses rather than marking one.
        const open = unsettledScope(entry.scopes);
        if (open !== undefined) {
          throw new Error(
            `${where(record)} settles an entry whose ${open.name} scope has not exited`,
          );
        }
        entry.settled = true;
      }
    }
    checkpoints.push(snapshot(record.marker, record.at, entries, suspensions));
  }

  const head = checkpoints[checkpoints.length - 1];
  if (head === undefined) {
    throw new Error("an execution with no records has no head to project");
  }
  return deepFreeze({ execution, head: head.marker, checkpoints });
}
