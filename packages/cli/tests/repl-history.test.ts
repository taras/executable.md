/**
 * The recorded History rail (#881 PR 3, rows H1–H6).
 *
 * One real layout engine answers every width. Nothing here counts characters:
 * where a mark lands is a proportion of the rail's measured *columns*, and a
 * column is not a character — a band laid out by `String.length` puts its last
 * mark off the end of the pane the first time a caption holds something wider
 * than one cell.
 *
 * What is under test:
 *
 *   - **H1/H2** navigation is the whole file while content is one prefix, and
 *     nothing of a later position's payload crosses;
 *   - **H3** the head is derived from retained facts and work this process
 *     actually owns, in the frozen precedence;
 *   - **H4** the five rows are allocated by measurement: first and last
 *     positions, deterministic collisions, the entry/minor hierarchy, caption
 *     merging, and a head change that moves nothing;
 *   - **H5** every position is reachable in the drawer, group or not.
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, sleep } from "effection";
import type { Operation, Result } from "effection";
import { useTempFileCompiler } from "@executablemd/core";
import { InMemoryStream } from "@executablemd/durable-streams";

import { openReplSession } from "../src/repl/session.ts";
import type { ReplSession } from "../src/repl/session.ts";
import type { ReplExecution } from "../src/repl/journal.ts";

import {
  groupsOf,
  HISTORY_EMPTY,
  HISTORY_ROWS,
  HISTORY_TITLE,
  prepareRail,
  SELECTED_HEAD,
} from "../src/repl/history-rail.ts";
import { HEAD_LABELS, headOf, navigationOf, numbered, pointLabel } from "../src/repl/navigation.ts";
import type { ReplHistoryNavigation, ReplHeadState } from "../src/repl/navigation.ts";
import type { ReplCheckpoint } from "../src/repl/model.ts";
import { useReplRenderer } from "../src/repl/renderer.ts";
import type { ReplRenderer } from "../src/repl/renderer.ts";
import { runText } from "../src/repl/description.ts";
import type { ReplTerminalSize } from "../src/repl/terminal.ts";

const WIDE: ReplTerminalSize = { columns: 160, rows: 36 };

function execution(): ReplExecution {
  return { id: "history", stream: new InMemoryStream([]) };
}

function opened(result: Result<ReplSession>): ReplSession {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function accepted(result: Result<void>): void {
  if (!result.ok) {
    throw result.error;
  }
}
const NARROW: ReplTerminalSize = { columns: 72, rows: 20 };

function withRenderer<T>(body: (renderer: ReplRenderer) => Operation<T>): Operation<T> {
  return scoped(function* () {
    return yield* body(yield* useReplRenderer(WIDE));
  });
}

/** A history of the given kinds, in recorded order. */
function history(
  kinds: readonly ReplCheckpoint["kind"][],
  head: ReplHeadState = "settled",
): ReplHistoryNavigation {
  return navigationOf(
    kinds.map((kind, index) => ({ marker: `m${index + 1}`, kind, label: "unused" })),
    head,
  );
}

/** The text of one prepared row, rails and all. */
function rowText(rail: { readonly rows: readonly (readonly { text: string }[])[] }, row: number) {
  return runText(rail.rows[row] as never);
}

describe("H4 — the five rows are allocated by measurement", () => {
  it("puts the first position at the start and the last at the end", () =>
    withRenderer(function* (renderer) {
      const prepared = yield* prepareRail(
        renderer,
        WIDE,
        history(["entry", "binding", "terminal"]),
        undefined,
        120,
      );
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) {
        return;
      }
      const { groups, reservation } = prepared.value;
      expect(groups.length).toBe(3);
      expect(groups[0].column).toBe(0);
      expect(groups[groups.length - 1].column).toBe(reservation.rail - 1);
      // Spread between them, not bunched at either end.
      expect(groups[1].column).toBeGreaterThan(0);
      expect(groups[1].column).toBeLessThan(reservation.rail - 1);
    }));

  it("puts a lone position where the head is", () =>
    withRenderer(function* (renderer) {
      const prepared = yield* prepareRail(renderer, WIDE, history(["entry"]), undefined, 120);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) {
        return;
      }
      expect(prepared.value.groups[0].column).toBe(prepared.value.reservation.rail - 1);
    }));

  it("groups collisions deterministically, and keeps every member", () =>
    withRenderer(function* (renderer) {
      // Forty positions into a rail far narrower than forty columns.
      const kinds: ReplCheckpoint["kind"][] = Array.from({ length: 40 }, (_, at) =>
        at % 5 === 0 ? "entry" : "binding",
      );
      const crowded = history(kinds);
      const first = yield* prepareRail(renderer, NARROW, crowded, undefined, 60);
      const again = yield* prepareRail(renderer, NARROW, crowded, undefined, 60);
      expect(first.ok && again.ok).toBe(true);
      if (!first.ok || !again.ok) {
        return;
      }
      // Same count and same measured size, same groups: grouping is a
      // function of those two and of nothing else.
      expect(again.value.groups.map((one) => one.column)).toEqual(
        first.value.groups.map((one) => one.column),
      );
      expect(first.value.groups.length).toBeLessThan(40);
      // Not one position was dropped to make them fit.
      const members = first.value.groups.flatMap((one) => one.ordinals);
      expect(members.length).toBe(40);
      expect(new Set(members).size).toBe(40);
      expect(members.toSorted((a, b) => a - b)).toEqual(
        Array.from({ length: 40 }, (_, at) => at + 1),
      );
    }));

  it("keeps the entry's tall mark and the minor's stem when they share a column", () =>
    withRenderer(function* (renderer) {
      // Far more positions than the rail has columns, alternating, so an
      // entry and a minor one are bound to land together.
      const crowded = history(
        Array.from({ length: 200 }, (_, at) => (at % 2 === 0 ? "entry" : "binding")),
      );
      const prepared = yield* prepareRail(renderer, NARROW, crowded, undefined, NARROW.columns);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) {
        return;
      }
      // Everywhere but the rail's end, where the head's own marker wins the
      // cell below — a distinctive marker takes its cell and the category it
      // covers stays readable in the junction, the caption and the drawer.
      const end = prepared.value.reservation.rail - 1;
      const both = prepared.value.groups.filter(
        (one) => one.entry && one.minor && one.column !== end,
      );
      expect(both.length).toBeGreaterThan(0);
      for (const group of both) {
        // The upriser above, the stem below, and a heavier junction between.
        expect([group.column, rowText(prepared.value, 2)[group.column]]).toEqual([
          group.column,
          "┃",
        ]);
        expect([group.column, rowText(prepared.value, 4)[group.column]]).toEqual([
          group.column,
          "│",
        ]);
        expect([group.column, rowText(prepared.value, 3)[group.column]]).toEqual([
          group.column,
          "┳",
        ]);
      }
    }));

  it("merges entry captions into the span they actually cover", () =>
    withRenderer(function* (renderer) {
      // Eight entries in a rail with nowhere near room for eight captions.
      const prepared = yield* prepareRail(
        renderer,
        NARROW,
        history(Array.from({ length: 8 }, () => "entry" as const)),
        undefined,
        NARROW.columns,
      );
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) {
        return;
      }
      const captions = rowText(prepared.value, 1);
      // Merged, and only into ranges that exist: every number named is an
      // entry this history has.
      for (const [, from, to] of captions.matchAll(/Entry (\d+)(?:–(\d+))?/g)) {
        expect(Number(from)).toBeGreaterThanOrEqual(1);
        expect(Number(from)).toBeLessThanOrEqual(8);
        if (to !== undefined) {
          expect(Number(to)).toBeLessThanOrEqual(8);
          expect(Number(to)).toBeGreaterThan(Number(from));
        }
      }
      // Nothing clipped: no caption ends with a half-written number.
      expect(captions).not.toMatch(/Entry \d+–$/);
      // And none of them reached into the reserved right column.
      const rail = prepared.value.reservation.rail;
      expect(captions.slice(rail).trim()).toBe(SELECTED_HEAD);
    }));

  it("reserves the same right column for every head state", () =>
    withRenderer(function* (renderer) {
      const kinds: ReplCheckpoint["kind"][] = ["entry", "binding", "terminal"];
      const reservations: number[] = [];
      const rails: string[] = [];
      for (const head of Object.keys(HEAD_LABELS) as ReplHeadState[]) {
        const prepared = yield* prepareRail(renderer, WIDE, history(kinds, head), undefined, 120);
        expect([head, prepared.ok]).toEqual([head, true]);
        if (!prepared.ok) {
          return;
        }
        reservations.push(prepared.value.reservation.right);
        rails.push(rowText(prepared.value, 3).slice(0, prepared.value.reservation.rail));
      }
      // One reservation, so a head change re-cuts nothing.
      expect(new Set(reservations).size).toBe(1);
      // And the rail itself is identical under every head.
      expect(new Set(rails).size).toBe(1);
    }));

  it("fits its title and its longest head at 72 columns, with rail left over", () =>
    withRenderer(function* (renderer) {
      const prepared = yield* prepareRail(
        renderer,
        NARROW,
        history(["entry", "terminal"], "pausing"),
        undefined,
        NARROW.columns,
      );
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) {
        return;
      }
      expect(rowText(prepared.value, 0)).toContain(HISTORY_TITLE);
      expect(rowText(prepared.value, 0)).toContain(HEAD_LABELS.pausing);
      expect(prepared.value.reservation.rail).toBeGreaterThan(0);
      // Five rows, every one the band's full width.
      expect(prepared.value.rows.length).toBe(HISTORY_ROWS);
      for (const row of prepared.value.rows) {
        expect(runText(row).length).toBe(NARROW.columns);
      }
    }));

  it("keeps the diamond above and the head marker below on one column", () =>
    withRenderer(function* (renderer) {
      // One position: it lands at the rail's end, which is where the head is.
      const prepared = yield* prepareRail(renderer, WIDE, history(["entry"]), "m1", 120);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) {
        return;
      }
      const column = prepared.value.reservation.rail - 1;
      expect(rowText(prepared.value, 2)[column]).toBe("◆");
      expect(rowText(prepared.value, 4)[column]).toBe("▼");
      // Two markers, two colours: neither borrowed the other's cell.
      const above = prepared.value.rows[2].find((run) => run.text.includes("◆"));
      const below = prepared.value.rows[4].find((run) => run.text.includes("▼"));
      expect(above?.token).toBe("history-selected");
      expect(below?.token).not.toBe("history-selected");
    }));

  it("says so, and invents no mark, where nothing is recorded", () =>
    withRenderer(function* (renderer) {
      const prepared = yield* prepareRail(renderer, WIDE, history([], "empty"), undefined, 120);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) {
        return;
      }
      expect(prepared.value.groups).toEqual([]);
      expect(rowText(prepared.value, 1)).toContain(HISTORY_EMPTY);
      expect(rowText(prepared.value, 0)).toContain(HEAD_LABELS.empty);
      // No rule, no tick, no head marker: an empty reading has a label and
      // nothing to point at.
      expect(rowText(prepared.value, 2).trim()).toBe("");
      expect(rowText(prepared.value, 3).trim()).toBe("");
      expect(rowText(prepared.value, 4).trim()).toBe("");
    }));

  it("refuses rather than overwriting when the band cannot hold its title", () =>
    withRenderer(function* (renderer) {
      // Below the title plus the reserved head column, which is the band's
      // own minimum rather than a number this test chose.
      const prepared = yield* prepareRail(renderer, NARROW, history(["entry"]), undefined, 40);
      expect(prepared.ok).toBe(false);
    }));
});

/** `headOf` over one neutral baseline, so each case names only its own fact. */
const facts = (over: Partial<Parameters<typeof headOf>[0]>) =>
  headOf({ entries: 1, outcome: false, working: false, paused: false, pausing: false, ...over });

describe("H3 — the head is derived from retained facts and owned work", () => {
  it("takes the frozen precedence, and never infers a pause", function* () {
    // 1 settling beats everything: an outcome is retained and the work this
    // process owns has not come down yet.
    expect(facts({ outcome: true, working: true, paused: true, pausing: true })).toBe("settling");
    expect(facts({ working: true, paused: true, pausing: true })).toBe("paused");
    expect(facts({ working: true, pausing: true })).toBe("pausing");
    expect(facts({ working: true })).toBe("live");
    expect(facts({ entries: 0 })).toBe("empty");
    expect(facts({ outcome: true })).toBe("settled");
    // No outcome and nothing holding it: stopped, not paused.
    expect(facts({})).toBe("unfinished");
    // An empty history with work already owned is live, not empty: the task
    // exists before its first record does.
    expect(facts({ entries: 0, working: true })).toBe("live");
  });

  it("is neutral about how a settled entry settled", function* () {
    // Success, failure and cancellation are all finished. The band says so
    // once; which of them it was belongs to the reading, not to the head.
    for (const _ of ["ok", "err", "cancelled"]) {
      expect(
        headOf({ entries: 1, outcome: true, working: false, paused: false, pausing: false }),
      ).toBe("settled");
    }
  });
});

describe("H3 — the head a real session publishes", () => {
  beforeAll(() => useTempFileCompiler());

  it("is empty before an entry, live while one runs, settled once it has", function* () {
    const session = opened(yield* openReplSession({ execution: execution() }));
    // Nothing retained and nothing owned.
    expect(session.navigation.head).toBe("empty");
    expect(session.navigation.checkpoints).toEqual([]);

    accepted(yield* session.submit('<Json value={1} as="a" />\n'));
    // Owned work, from before its first record exists.
    expect(session.navigation.head).toBe("live");

    yield* session.join();
    yield* sleep(0);
    // The outcome is retained and nothing of the entry is still standing.
    expect(session.navigation.head).toBe("settled");
    expect(session.navigation.checkpoints.map((one) => one.kind)).toContain("entry");
    expect(session.navigation.checkpoints.map((one) => one.kind)).toContain("terminal");
  });

  it("is SETTLING while the outcome is retained and the entry is still coming down", function* () {
    // The window a reader watching a run end is actually in: the root closed,
    // and this process still owns what the entry acquired. A head taken from
    // the root Close alone would call this finished.
    let duringRelease: string | undefined;
    let held: ReplSession | undefined;
    const session = opened(
      yield* openReplSession({
        execution: execution(),
        installations: [
          {
            *install(): Operation<void> {
              yield* ensure(() => {
                duringRelease = held?.navigation.head;
              });
            },
          },
        ],
      }),
    );
    held = session;
    accepted(yield* session.submit('<Json value={1} as="a" />\n'));
    yield* session.join();
    yield* sleep(0);
    // Read at the moment this entry's own installation was released, which
    // is after its outcome was recorded and before its work was finished.
    expect(duringRelease).toBe("settling");
    // And neutral once it is down, however it went.
    expect(session.navigation.head).toBe("settled");
  });

  it("carries no payload from the entry it is describing", function* () {
    const session = opened(yield* openReplSession({ execution: execution() }));
    accepted(yield* session.submit('<Json value={{ secret: "shibboleth" }} as="a" />\n'));
    yield* session.join();
    yield* sleep(0);
    expect(JSON.stringify(session.navigation)).not.toContain("shibboleth");
    for (const point of session.navigation.checkpoints) {
      expect(Object.keys(point).toSorted()).toEqual(["kind", "marker"]);
    }
  });
});

describe("H1/H2 — the whole order, and nothing of what it holds", () => {
  beforeAll(() => useTempFileCompiler());

  it("offers later positions from an earlier one, with the prefix's content", function* () {
    const holder = execution();
    const first = opened(yield* openReplSession({ execution: holder }));
    accepted(yield* first.submit('<Json value={{ early: 1 }} as="a" />\n'));
    yield* first.join();
    const early = first.navigation.checkpoints[0].marker;
    accepted(yield* first.submit('<Json value={{ late: 2 }} as="b" />\n'));
    yield* first.join();
    yield* sleep(0);
    const whole = first.navigation.checkpoints.length;
    expect(whole).toBeGreaterThan(2);

    // Reopened at the earliest position. Its content is that prefix's — the
    // second entry had not happened — and its navigation is the whole
    // file's, because the positions after it are where a reader can go.
    const inspecting = opened(yield* openReplSession({ execution: holder, selection: early }));
    expect(inspecting.model.entries.length).toBe(1);
    expect(inspecting.navigation.checkpoints.length).toBe(whole);
    // The content channel is live and is the prefix's: it carries the first
    // entry's payload and not the second's. Against that, navigation holds
    // neither — it is an order, not a reading.
    const content = JSON.stringify(inspecting.model);
    expect(content).toContain("early");
    expect(content).not.toContain("late");
    const order = JSON.stringify(inspecting.navigation);
    expect(order).not.toContain("early");
    expect(order).not.toContain("late");
  });

  it("refuses the whole reading when a later segment is malformed", function* () {
    const holder = execution();
    const first = opened(yield* openReplSession({ execution: holder }));
    accepted(yield* first.submit('<Json value={1} as="a" />\n'));
    yield* first.join();
    yield* sleep(0);
    const early = first.navigation.checkpoints[0].marker;

    // A record nothing can read, appended after the position being asked
    // for. Reopening at that earlier marker must refuse: a plausible prefix
    // beside navigation that cannot be built is the worst of both.
    const events = yield* holder.stream.readAll();
    // The control: the same reconstruction, minus the bad record, opens at
    // this very marker. So the refusal below is the record's, not the
    // reconstruction's.
    const rebuilt = { id: "history", stream: new InMemoryStream([...events]) };
    expect((yield* openReplSession({ execution: rebuilt, selection: early })).ok).toBe(true);
    const corrupted = {
      id: "history",
      stream: new InMemoryStream([
        ...events,
        { type: "nonsense-this-reader-cannot-validate" } as never,
      ]),
    };
    const reopened = yield* openReplSession({ execution: corrupted, selection: early });
    expect(reopened.ok).toBe(false);
  });
});

describe("H1/H5 — every retained position keeps its own identity", () => {
  it("says what each kind is, with its full ordinal and entry number", function* () {
    const navigation = history([
      "entry",
      "scope",
      "binding",
      "generated",
      "elicit",
      "agent",
      "terminal",
      "entry",
      "terminal",
    ]);
    expect(
      numbered(navigation).map((one) => pointLabel(one.point, one.ordinal, one.entry)),
    ).toEqual([
      "1 · Entry 1 admitted",
      "2 · Component admitted",
      "3 · Bindings recorded",
      "4 · Generated XMD admitted",
      "5 · Answer recorded",
      "6 · Agent turn recorded",
      "7 · Entry outcome recorded",
      "8 · Entry 2 admitted",
      "9 · Entry outcome recorded",
    ]);
  });

  it("keeps a grouped position selectable as itself", function* () {
    // Two positions on one column: the group is how they are drawn and never
    // how they are counted, so each keeps its own ordinal and marker.
    const navigation = history(["binding", "binding"]);
    const groups = groupsOf(navigation, undefined, 1);
    expect(groups.length).toBe(1);
    expect(groups[0].ordinals).toEqual([1, 2]);
    expect(groups[0].members.map((one) => one.marker)).toEqual(["m1", "m2"]);
  });

  it("carries no payload at all", function* () {
    const navigation = navigationOf(
      [{ marker: "m1", kind: "binding", label: 'tokens = { name: "Northstar" }' }],
      "settled",
    );
    // The label the checkpoint had does not travel: a reader at an earlier
    // position learns that a later one exists and what kind it is, and
    // nothing about what it holds.
    expect(Object.keys(navigation.checkpoints[0])).toEqual(["marker", "kind"]);
    expect(JSON.stringify(navigation)).not.toContain("Northstar");
  });

  it("colours each category by its own members, not by the group", function* () {
    // A group holding an entry the reader has passed and a minor position
    // they have not. Saying that with one colour would lose half of it.
    const navigation = history(["entry", "binding"]);
    const groups = groupsOf(navigation, "m1", 1);
    expect(groups.length).toBe(1);
    expect(groups[0].entryEarlier).toBe(true);
    expect(groups[0].minorEarlier).toBe(false);
  });
});
