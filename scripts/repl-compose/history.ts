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
  | "suspension.answered";

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
    scopes: entry.scopes.map(snapshotScope),
  }));
  const stack: Suspension[] = suspensions.map((suspension) => ({
    kind: suspension.kind,
    scope: [...suspension.scope],
    prompt: suspension.prompt,
  }));
  return deepFreeze({ marker, at, entries: copied, suspensions: stack });
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
      entries.push({ id: record.entry, title: record.detail, scopes: [] });
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
          scope: [...record.scope],
          prompt: record.prompt ?? "",
        });
      }
      if (record.kind === "suspension.answered") {
        let answered = -1;
        for (let index = suspensions.length - 1; index >= 0 && answered === -1; index -= 1) {
          const suspension = suspensions[index];
          const owner =
            suspension.scope.length === record.scope.length &&
            suspension.scope.every((name, at) => name === record.scope[at]);
          if (suspension.kind === record.detail && owner) {
            answered = index;
          }
        }
        if (answered === -1) {
          throw new Error(`${where(record)} answers a suspension nothing opened`);
        }
        suspensions.splice(answered, 1);
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
