/**
 * One truthful append-only Journal, written as the durable records would
 * arrive.
 *
 * Truthful means the fold is the only way to learn what this execution
 * reached. Nothing here is a snapshot of an answer, nothing is derived from a
 * screen, and the awkward parts are awkward on purpose:
 *
 * - `entry-1` settles, `entry-2` fails, `entry-3` is still running. Top-level
 *   entries are serial, so each begins only after the one before it closed.
 * - `entry-1` nests `plan` inside `document` and completes both, so a
 *   historical marker exists on either side of a scope's settlement.
 * - `entry-2` publishes `release` and *then* fails, with both its scopes open.
 *   The binding survives; the scopes are abandoned, not settled.
 * - `entry-3` opens `publish` before `write` although `write` comes first in
 *   the document. The records carry each scope's source position, and the
 *   projection reads them in the document's order rather than the coroutines'.
 * - `entry-3` republishes `project`, so an earlier marker reconstructs the
 *   earlier value rather than merely missing a name.
 * - `r-22` is the expansion pause point, and `r-23` is a durable outcome that
 *   background work appended *after* it while expansion stayed held. The two
 *   positions are independent (#841), and only the second is the live head.
 *
 * The pause point is not written down here. `r-22` is an ordinary
 * `suspension.opened` record, and which marker expansion is held at is a fact
 * the live process owns — `overlay.ts` is where a test says it, and nothing in
 * the durable stream can.
 */

/** The execution these records belong to. A route naming another one refuses. */
export const EXECUTION = "e1";

/**
 * The marker the live process is holding expansion at.
 *
 * Declared beside the fixture because the evidence needs to name it, and
 * nowhere near the records, because the Journal has no field for it.
 */
export const PAUSE_MARKER = "r-22";

/** The newest marker: the background outcome appended while expansion was held. */
export const LIVE_HEAD = "r-23";

/**
 * Records as the durable stream holds them: plain JSON, of unknown shape until
 * `parseJournal()` reads them.
 */
const RECORDS: readonly Record<string, unknown>[] = [
  { id: "r-01", seq: 1, at: 2, kind: "entry.submitted", entry: "entry-1", title: "Add a README" },
  {
    id: "r-02",
    seq: 2,
    at: 4,
    kind: "scope.opened",
    entry: "entry-1",
    scope: [],
    name: "document",
    source: 0,
  },
  {
    id: "r-03",
    seq: 3,
    at: 7,
    kind: "scope.opened",
    entry: "entry-1",
    scope: ["document"],
    name: "plan",
    source: 0,
  },
  {
    id: "r-04",
    seq: 4,
    at: 11,
    kind: "suspension.opened",
    entry: "entry-1",
    scope: ["document", "plan"],
    wait: "review",
    prompt: "Approve this plan before it runs?",
  },
  {
    id: "r-05",
    seq: 5,
    at: 16,
    kind: "suspension.answered",
    entry: "entry-1",
    scope: ["document", "plan"],
    wait: "review",
  },
  {
    id: "r-06",
    seq: 6,
    at: 18,
    kind: "scope.completed",
    entry: "entry-1",
    scope: ["document"],
    name: "plan",
  },
  {
    id: "r-07",
    seq: 7,
    at: 21,
    kind: "binding.published",
    entry: "entry-1",
    name: "project",
    value: "executable.md",
  },
  {
    id: "r-08",
    seq: 8,
    at: 24,
    kind: "scope.completed",
    entry: "entry-1",
    scope: [],
    name: "document",
  },
  { id: "r-09", seq: 9, at: 25, kind: "entry.settled", entry: "entry-1" },

  {
    id: "r-10",
    seq: 10,
    at: 30,
    kind: "entry.submitted",
    entry: "entry-2",
    title: "Tag the release",
  },
  {
    id: "r-11",
    seq: 11,
    at: 32,
    kind: "scope.opened",
    entry: "entry-2",
    scope: [],
    name: "document",
    source: 0,
  },
  {
    id: "r-12",
    seq: 12,
    at: 35,
    kind: "scope.opened",
    entry: "entry-2",
    scope: ["document"],
    name: "tag",
    source: 0,
  },
  {
    id: "r-13",
    seq: 13,
    at: 38,
    kind: "binding.published",
    entry: "entry-2",
    name: "release",
    value: "0.13.0",
  },
  {
    id: "r-14",
    seq: 14,
    at: 41,
    kind: "entry.failed",
    entry: "entry-2",
    reason: "tag 0.13.0 already exists on the remote",
  },

  {
    id: "r-15",
    seq: 15,
    at: 48,
    kind: "entry.submitted",
    entry: "entry-3",
    title: "Write the changelog",
  },
  {
    id: "r-16",
    seq: 16,
    at: 50,
    kind: "scope.opened",
    entry: "entry-3",
    scope: [],
    name: "document",
    source: 0,
  },
  {
    id: "r-17",
    seq: 17,
    at: 53,
    kind: "scope.opened",
    entry: "entry-3",
    scope: ["document"],
    name: "publish",
    source: 1,
  },
  {
    id: "r-18",
    seq: 18,
    at: 54,
    kind: "scope.opened",
    entry: "entry-3",
    scope: ["document"],
    name: "write",
    source: 0,
  },
  {
    id: "r-19",
    seq: 19,
    at: 57,
    kind: "binding.published",
    entry: "entry-3",
    name: "changelog",
    value: "CHANGELOG.md",
  },
  {
    id: "r-20",
    seq: 20,
    at: 59,
    kind: "binding.published",
    entry: "entry-3",
    name: "project",
    value: "executable.md@0.13.1",
  },
  {
    id: "r-21",
    seq: 21,
    at: 62,
    kind: "suspension.opened",
    entry: "entry-3",
    scope: ["document", "write"],
    wait: "source",
    prompt: "Which project should the changelog describe?",
  },
  {
    id: "r-22",
    seq: 22,
    at: 66,
    kind: "suspension.opened",
    entry: "entry-3",
    scope: ["document", "publish"],
    wait: "confirm",
    prompt: "Commit and push the changelog now?",
  },
  {
    id: "r-23",
    seq: 23,
    at: 74,
    kind: "outcome.recorded",
    entry: "entry-3",
    scope: ["document", "publish"],
    label: "remote tags fetched",
  },
];

/**
 * The durable stream as a reader receives it: plain JSON of unknown shape,
 * until `parseJournal()` reads it.
 */
export const JOURNAL: readonly unknown[] = RECORDS;

function renumber(records: readonly Record<string, unknown>[]): readonly unknown[] {
  return records.map((record, index) => ({ ...record, seq: index + 1 }));
}

/**
 * The representative journal with one record's fields changed.
 *
 * Every refusal case is this journal with one thing wrong, so what fails is
 * the one thing named rather than a fixture written to fail.
 */
export function journalChanging(at: number, changes: Record<string, unknown>): readonly unknown[] {
  return RECORDS.map((record, index) => (index === at ? { ...record, ...changes } : record));
}

/** The representative journal with one record replaced outright. */
export function journalWith(at: number, record: unknown): readonly unknown[] {
  return RECORDS.map((one, index) => (index === at ? record : one));
}

/** The representative journal with one field cut out of one record. */
export function journalDropping(at: number, field: string): readonly unknown[] {
  return RECORDS.map((record, index) => {
    if (index !== at) {
      return record;
    }
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key !== field) {
        kept[key] = value;
      }
    }
    return kept;
  });
}

/** The representative journal with one record removed and its position left as a gap. */
export function journalMissing(at: number): readonly unknown[] {
  return RECORDS.filter((_, index) => index !== at);
}

/** The representative journal with one record removed and positions closed up. */
export function journalWithout(at: number): readonly unknown[] {
  return renumber(RECORDS.filter((_, index) => index !== at));
}

/** The representative journal cut short after `count` records. */
export function truncatedAfter(count: number): readonly unknown[] {
  return RECORDS.slice(0, count);
}

/** Where one record sits in the representative journal. */
export function positionOf(id: string): number {
  const at = RECORDS.findIndex((record) => record.id === id);
  if (at === -1) {
    throw new Error(`no such record: ${id}`);
  }
  return at;
}
