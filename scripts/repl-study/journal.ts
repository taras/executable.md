/**
 * Execution truth, as a record list.
 *
 * #842 owns the real journal. This is a fixture of one: the approved story's
 * twenty recorded moments, written out by hand so that folding them is the only
 * way to learn what was open, what had been published and what was waiting at
 * any of them.
 *
 * It is authored from the study rather than generated from `fixtures.ts` on
 * purpose. A journal derived from the fixtures would make the hydration case
 * compare the fixtures with themselves, and pass while proving nothing about
 * rebuilding a state from a URL.
 */

import type { FixtureName, TransportMode } from "./model.ts";
import type { DrawerKind } from "./fixtures.ts";

export type JournalKind =
  | "entry.submitted"
  | "scope.enter"
  | "scope.exit"
  | "binding.published"
  | "session.started"
  | "suspension.opened"
  | "suspension.answered"
  | "paused"
  | "resumed"
  | "entry.settled";

export interface JournalRecord {
  /** The marker a URL names this moment by. */
  readonly marker: string;
  /** Recorded seconds, which is what the Execution History band measures. */
  readonly at: number;
  readonly kind: JournalKind;
  /** The scope the record was made in, by the name a route segment uses. */
  readonly scope: string;
  /** The binding, session, drawer or entry the record is about. */
  readonly detail: string;
  /** The moment following the head here shows, which is one of the six. */
  readonly shows: FixtureName;
  /**
   * The moment *inspecting* this marker shows, when that is a different one.
   *
   * Following the head at 00:12 is the Plan opening live; reconstructing 00:12
   * is the read-only Plan scope with the head still out at the end. Same
   * marker, two pictures, and only a fold that is told which question it is
   * answering can tell them apart.
   */
  readonly reconstructs?: FixtureName;
}

export type JournalFixture = readonly JournalRecord[];

export const JOURNAL: JournalFixture = [
  {
    marker: "cp-01",
    at: 2,
    kind: "entry.submitted",
    scope: "repl",
    detail: "Entry 1",
    shows: "nested",
  },
  {
    marker: "cp-02",
    at: 5,
    kind: "scope.enter",
    scope: "document",
    detail: "document",
    shows: "nested",
  },
  {
    marker: "cp-03",
    at: 6,
    kind: "session.started",
    scope: "document",
    detail: "plan-a91f7c",
    shows: "nested",
  },
  {
    marker: "cp-04",
    at: 12,
    kind: "scope.enter",
    scope: "plan",
    detail: "plan",
    shows: "nested",
    reconstructs: "paused",
  },
  {
    marker: "cp-05",
    at: 18,
    kind: "binding.published",
    scope: "plan",
    detail: "inputs",
    shows: "nested",
  },
  {
    marker: "cp-06",
    at: 29,
    kind: "binding.published",
    scope: "plan",
    detail: "draft",
    shows: "nested",
  },
  {
    marker: "cp-07",
    at: 30,
    kind: "session.started",
    scope: "plan",
    detail: "review-b72e1d",
    shows: "nested",
  },
  {
    marker: "cp-08",
    at: 35,
    kind: "suspension.opened",
    scope: "plan",
    detail: "review",
    shows: "nested",
  },
  {
    marker: "cp-09",
    at: 41,
    kind: "suspension.answered",
    scope: "plan",
    detail: "review",
    shows: "nested",
  },
  {
    marker: "cp-10",
    at: 45,
    kind: "scope.exit",
    scope: "plan",
    detail: "plan",
    shows: "generated",
  },
  {
    marker: "cp-11",
    at: 46,
    kind: "scope.enter",
    scope: "preview",
    detail: "preview",
    shows: "generated",
  },
  {
    marker: "cp-12",
    at: 47,
    kind: "scope.exit",
    scope: "preview",
    detail: "preview",
    shows: "generated",
  },
  {
    marker: "cp-13",
    at: 48,
    kind: "session.started",
    scope: "document",
    detail: "implement-c31d2e",
    shows: "drawer",
  },
  {
    marker: "cp-14",
    at: 49,
    kind: "suspension.opened",
    scope: "document",
    detail: "project",
    shows: "drawer",
  },
  {
    marker: "cp-15",
    at: 52,
    kind: "suspension.answered",
    scope: "document",
    detail: "project",
    shows: "drawer",
  },
  {
    marker: "cp-16",
    at: 53,
    kind: "suspension.opened",
    scope: "document",
    detail: "confirm",
    shows: "drawer",
  },
  {
    marker: "cp-17",
    at: 54,
    kind: "suspension.answered",
    scope: "document",
    detail: "confirm",
    shows: "drawer",
  },
  {
    marker: "cp-18",
    at: 55,
    kind: "paused",
    scope: "document",
    detail: "Entry 1",
    shows: "paused",
  },
  {
    marker: "cp-19",
    at: 57,
    kind: "resumed",
    scope: "document",
    detail: "Entry 1",
    shows: "drawer",
  },
  {
    marker: "cp-20",
    at: 58,
    kind: "scope.enter",
    scope: "write",
    detail: "write",
    shows: "drawer",
  },
  {
    marker: "cp-21",
    at: 60,
    kind: "binding.published",
    scope: "write",
    detail: "readme",
    shows: "drawer",
  },
  {
    marker: "cp-22",
    at: 61,
    kind: "entry.settled",
    scope: "repl",
    detail: "Entry 1",
    shows: "settled",
  },
];

/** What the execution had got to, and what was true there. */
export interface Moment {
  /** The marker this moment sits at, absent when nothing has been recorded. */
  readonly marker?: string;
  readonly at: number;
  readonly transport: TransportMode;
  /** The innermost scope that was open, by its route segment. */
  readonly scope: string;
  /** The bindings that scope had published by then, in the order they arrived. */
  readonly published: readonly string[];
  /** The suspension waiting for an answer, when one was. */
  readonly suspension?: DrawerKind;
  readonly sessions: number;
  readonly entry: "none" | "running" | "settled";
  readonly shows: FixtureName;
}

/** Every scope is opened inside this one, which the route spells as the entry. */
export const ROOT_SCOPE = "repl";

function isDrawerKind(value: string): value is DrawerKind {
  return value === "project" || value === "review" || value === "confirm";
}

/** The records up to and including one marker, which is the journal as it stood. */
export function journalThrough(
  marker: string | undefined,
  journal: JournalFixture = JOURNAL,
): JournalFixture {
  if (marker === undefined) {
    return [];
  }
  const at = journal.findIndex((record) => record.marker === marker);
  if (at === -1) {
    throw new Error(`no such journal marker: ${marker}`);
  }
  return journal.slice(0, at + 1);
}

/**
 * Fold a journal into the moment it describes.
 *
 * With `upTo` the fold stops at that marker and the result is a reconstruction:
 * the transport says `inspecting`, because what is on screen is a recorded
 * moment rather than the head. Without it the fold runs to the end of whatever
 * journal it was handed, which is the head by definition.
 */
export function fold(journal: JournalFixture, upTo?: string): Moment {
  const scopes: string[] = [ROOT_SCOPE];
  const published = new Map<string, string[]>([[ROOT_SCOPE, []]]);
  let sessions = 0;
  let suspension: DrawerKind | undefined;
  let entry: Moment["entry"] = "none";
  let transport: TransportMode = "idle";
  let shows: FixtureName = "empty";
  let marker: string | undefined;
  let at = 0;
  let reached = upTo === undefined;

  for (const record of journal) {
    if (record.kind === "entry.submitted") {
      entry = "running";
      transport = "live";
    }
    if (record.kind === "scope.enter") {
      scopes.push(record.detail);
      published.set(record.detail, []);
    }
    if (record.kind === "scope.exit") {
      const left = scopes.lastIndexOf(record.detail);
      if (left > 0) {
        scopes.splice(left, 1);
      }
      published.delete(record.detail);
    }
    if (record.kind === "binding.published") {
      published.get(scopes[scopes.length - 1])?.push(record.detail);
    }
    if (record.kind === "session.started") {
      sessions += 1;
    }
    if (record.kind === "suspension.opened" && isDrawerKind(record.detail)) {
      suspension = record.detail;
    }
    if (record.kind === "suspension.answered") {
      suspension = undefined;
    }
    if (record.kind === "paused") {
      transport = "paused";
    }
    if (record.kind === "resumed") {
      transport = "live";
    }
    if (record.kind === "entry.settled") {
      entry = "settled";
      transport = "idle";
      // A settled entry closes everything it opened, so what is left is the
      // REPL scope the next entry will be submitted into.
      scopes.splice(1);
    }
    marker = record.marker;
    at = record.at;
    shows = upTo === undefined ? record.shows : (record.reconstructs ?? record.shows);
    if (upTo !== undefined && record.marker === upTo) {
      reached = true;
      break;
    }
  }

  if (!reached) {
    throw new Error(`the journal handed to this fold never reaches ${upTo}`);
  }

  const scope = scopes[scopes.length - 1];
  return {
    marker,
    at,
    transport: upTo === undefined ? transport : "inspecting",
    scope,
    published: published.get(scope) ?? [],
    suspension,
    sessions,
    entry,
    shows,
  };
}

/** The markers a scrubber steps through, which is every recorded moment. */
export function markers(journal: JournalFixture): readonly string[] {
  return journal.map((record) => record.marker);
}

/** The first marker whose moment reconstructs to one of the six fixtures. */
/**
 * The moment a suspension of this kind opened.
 *
 * A capture of a drawer is a capture of the moment something was waiting, which
 * is a fact about the execution rather than about the screen. Mounting one
 * against the marker its fixture happens to be named after would put the form
 * at a moment where nothing had been asked.
 */
export function markerSuspending(
  kind: DrawerKind,
  journal: JournalFixture = JOURNAL,
): string | undefined {
  return journal.find((record) => record.kind === "suspension.opened" && record.detail === kind)
    ?.marker;
}

export function markerShowing(
  name: FixtureName,
  journal: JournalFixture = JOURNAL,
): string | undefined {
  return journal.find((record) => record.shows === name)?.marker;
}

/**
 * The scopes opened directly inside one parent path, in the order the execution
 * opened them.
 *
 * This is the sibling list structural navigation moves along. It is derived from
 * the journal rather than declared, because siblings are a fact about what the
 * execution did — which is why a scope that has not been entered yet is not one.
 */
export function siblingsOf(journal: JournalFixture, parents: readonly string[]): readonly string[] {
  const stack: string[] = [ROOT_SCOPE];
  const found: string[] = [];
  const inside = (): boolean =>
    stack.length === parents.length + 1 && parents.every((name, at) => stack[at + 1] === name);
  for (const record of journal) {
    if (record.kind === "scope.enter") {
      if (inside() && !found.includes(record.detail)) {
        found.push(record.detail);
      }
      stack.push(record.detail);
      continue;
    }
    if (record.kind === "scope.exit") {
      const left = stack.lastIndexOf(record.detail);
      if (left > 0) {
        stack.splice(left, 1);
      }
      continue;
    }
    if (record.kind === "entry.settled") {
      stack.splice(1);
    }
  }
  return found;
}
