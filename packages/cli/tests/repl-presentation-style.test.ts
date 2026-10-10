/**
 * Semantic presentation, in the cells a frame actually wrote.
 *
 * One real engine pair, one real Freedom tree and the production
 * `commitReplFrame`, driven through the presentation fixture. What is under test
 * is that **what a row means is visible in the cells that row was drawn in** —
 * not that a palette value appears somewhere in the stream, and not that a
 * description carried a role nothing drew.
 *
 * Every assertion names a rectangle the committed frame published and reads the
 * characters and the attributes out of it. That is the whole discrimination: a
 * cyan code written anywhere else on the screen cannot satisfy a claim about the
 * selected field, and a role attached to a candidate the manifest left out paints
 * nothing at all.
 *
 * The frames are real readings of a real Journal: three entries run for real, one
 * settling `ok`, one failing and one never closing, so `[ok]`, `[err]` and
 * `[unfinished]` are outcomes the file recorded rather than strings a fixture
 * chose.
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  collect,
  Elicitation,
  inlineSource,
  retainedSource,
  useTempFileCompiler,
} from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { InMemoryStream } from "@executablemd/durable-streams";
import { fileURLToPath } from "node:url";
import type { DurableEvent, DurableStream, Json } from "@executablemd/durable-streams";
import { scoped, sleep, spawn } from "effection";
import type { Operation } from "effection";

import { entryInitialBindings, projectRepl } from "../src/repl/model.ts";
import type { ReplModel } from "../src/repl/model.ts";
import { EntrySegmentStream } from "../src/repl/entries.ts";
import {
  EMPTY_FORM,
  initialState,
  NO_AGENT,
  reduceRepl,
  viewFor,
} from "../src/repl/application.ts";
import { NO_LIFECYCLE } from "../src/repl/lifecycle.ts";
import { useReplElicitation } from "../src/repl/elicitation.ts";
import type { ReplQuestion } from "../src/repl/elicitation.ts";
import { encodeLocation } from "../src/repl/route.ts";
import type {
  ReplAction,
  ReplFormMessage,
  ReplLive,
  ReplState,
  ReplView,
} from "../src/repl/application.ts";
import type { ReplDispatched } from "../src/repl/reconcile.ts";
import type { ReplDrawerRef } from "../src/repl/route.ts";
import { FOOTER_ROWS, HISTORY_ROWS, NARROW } from "../src/repl/layout.ts";
import { HISTORY_TITLE } from "../src/repl/history-rail.ts";
import { ACTION_ROW, DRAWER_WINDOW, READING_WINDOW } from "../src/repl/application.ts";
import { navigationOf } from "../src/repl/navigation.ts";
import type { ReplBounds } from "../src/repl/layout.ts";
import { BOLD, REPL_PALETTE } from "../src/repl/presentation-style.ts";
import {
  REFERENCE_ARCHIVE,
  REFERENCE_BOLD,
  RETAINED,
  SEMANTIC,
  SURFACE,
  SYNTAX,
  LIFECYCLE,
  RAIL,
} from "./fixtures/repl/reference-style.ts";
import type { ReplTerminalSize } from "../src/repl/terminal.ts";
import {
  createGrid,
  regionBounds,
  usePresenter,
  viewportBounds,
} from "./fixtures/repl/presentation.ts";
import { referenceEvents } from "./fixtures/repl/reference.ts";
import { ordinaryEvaluationProfile } from "../src/evaluation-profile.ts";
import { submitReplEntry } from "../src/repl/session.ts";
import type { ReplSession } from "../src/repl/session.ts";
import type { CellStyle, Observed, Presenter, TerminalGrid } from "./fixtures/repl/presentation.ts";

const WIDE: ReplTerminalSize = { columns: 160, rows: 36 };
const MEDIUM: ReplTerminalSize = { columns: 120, rows: 30 };
const EXECUTION = "style";

/**
 * One entry that settles `ok`, binds a value and renders output of its own.
 *
 * Both rows matter: the binding is a fact about the event and the output is what
 * the run produced, and telling those apart on screen is what this file is about.
 */
const SETTLING = [
  "```js eval",
  'const kept = "alpha";',
  'output("the plan is ready to read");',
  "```",
  "",
  "One: {kept}",
  "",
].join("\n");

/**
 * One entry whose root closes `err` having recorded nothing to show.
 *
 * The same refusal the captures drive: a schema outside this REPL's form
 * language. Nothing renders before it, so the transcript has an outcome to draw
 * rather than a result, which is the branch that keeps the outcome accent.
 */
const FAILING = [
  "# A refused question",
  "",
  '<Elicit schema={{ type: "number" }} as="answer">This schema is outside the REPL\'s form language.</Elicit>',
  "",
].join("\n");

const NOTHING_LIVE: ReplLive = Object.freeze({
  output: "",
  question: undefined,
  expansion: "playing",
  pausable: false,
  running: false,
  agent: NO_AGENT,
  lifecycle: NO_LIFECYCLE,
});

/**
 * This process observing one element of the entry it is running.
 *
 * The lifecycle reading the session would publish, so a frame can be asked
 * what an observed element's badge looks like where it actually lands.
 */
function observing(
  entry: string,
  name: string,
  offset: number,
  phase: "active",
  path: string,
): ReplLive {
  return Object.freeze({
    ...NOTHING_LIVE,
    running: true,
    pausable: true,
    lifecycle: Object.freeze({
      entry,
      occurrences: Object.freeze([
        Object.freeze({
          key: `${entry}#1`,
          expansion: "x",
          name,
          parent: undefined,
          position: Object.freeze({
            path,
            generatedSource: undefined,
            offset,
            line: 1,
            column: 1,
          }),
          phase,
          waiting: Object.freeze([]),
        }),
      ]),
    }),
  });
}

/** This process part-way through an entry: output on the overlay, nothing closed. */
function streaming(output: string): ReplLive {
  return Object.freeze({ ...NOTHING_LIVE, output, running: true, pausable: true });
}

/** Run one entry at the end of `physical`, over a view of its own segment. */
function* runEntry(
  physical: DurableStream,
  source: string,
  initialBindings: Readonly<Record<string, Json>> = {},
): Operation<void> {
  const view = new EntrySegmentStream(physical);
  try {
    const execution = yield* executeInstalled({ ...inlineSource(source), stream: view }, [], {
      initialBindings,
    });
    yield* collect(execution);
  } catch {
    // How far an entry got is the point: a failing root closes `err`, and that
    // close is the record the catalog reads its outcome from.
  }
}

/**
 * The same entry submitted the way the command submits a host file: by its path.
 *
 * The path is what makes this fixture worth having. A document submitted from
 * the filesystem is recorded by where it came from, and in this checkout that
 * is longer than any pane the frame has room for — which is the metadata class
 * the gallery caught wrapping over the row beneath it.
 */
function* runHostEntry(physical: DurableStream, path: string, source: string): Operation<void> {
  const view = new EntrySegmentStream(physical);
  try {
    const execution = yield* executeInstalled(
      { ...retainedSource(path, source), stream: view },
      [],
    );
    yield* collect(execution);
  } catch {
    // As above: how far it got is the record the catalog reads.
  }
}

/** This file's own reference entry, by its absolute path in this checkout. */
const HOST_ENTRY_PATH = fileURLToPath(new URL("./fixtures/repl/entry.md", import.meta.url));

/** One real entry whose own metadata row is wider than the pane holding it. */
function* submittedByPath(): Operation<ReplModel> {
  const physical = new InMemoryStream();
  yield* runHostEntry(physical, HOST_ENTRY_PATH, SETTLING);
  return projected(yield* physical.readAll());
}

/**
 * One line of prose longer than any pane this frame has, and one unbroken
 * token no word boundary can break.
 *
 * The case R3 needs: text that would reach the pane beside it if nothing fitted
 * it. It is a document's own prose rather than a path, because what a reader
 * came for is exactly the text this screen must not shorten — so the only
 * honest way to keep it inside its pane is to measure it and wrap it.
 */
const LONG_SOURCE = [
  "One line of ordinary prose, written long enough that no pane this frame has " +
    "room for could hold it on a single row without reaching into the column " +
    "beside it, which is the artifact this case exists to catch.",
  "",
  `t${"t".repeat(200)}`,
  "",
].join("\n");

function* submittedWithLongSource(): Operation<ReplModel> {
  const physical = new InMemoryStream();
  yield* runHostEntry(physical, HOST_ENTRY_PATH, LONG_SOURCE);
  return projected(yield* physical.readAll());
}

/** The projected model, or the failure that stopped it. */
function projected(events: readonly DurableEvent[]): ReplModel {
  const result = projectRepl(events);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/**
 * One settled entry and one failed one, projected from bytes this run wrote.
 *
 * Both roots close, so the catalog holds a real `[ok]` beside a real `[err]`.
 */
function* settledAndFailed(): Operation<ReplModel> {
  return projected(yield* settledAndFailedJournal());
}

/**
 * The journal those two entries write.
 *
 * Returned as events as well as a model, because a reading frozen at a recorded
 * position needs the prefix that position names — and a prefix is a slice of
 * these bytes.
 */
function* settledAndFailedJournal(): Operation<DurableEvent[]> {
  const physical = new InMemoryStream();
  yield* runEntry(physical, SETTLING);
  yield* runEntry(physical, FAILING, entryInitialBindings(projected(yield* physical.readAll())));
  return yield* physical.readAll();
}

/**
 * The model as it stood at one recorded position.
 *
 * The projector takes the position and reads the prefix that names it, which is
 * what a reading frozen there is a reading of — a route naming a position its
 * model was never projected at is refused, and rightly.
 */
function prefixAt(events: readonly DurableEvent[], marker: string): ReplModel {
  const grown = projectRepl(events, marker);
  if (!grown.ok) {
    throw grown.error;
  }
  return grown.value;
}

/**
 * The same prefix with a third entry that never closed.
 *
 * Truncated at the last admission rather than built by hand: an unfinished entry
 * is a segment whose root has no close, which is exactly what a prefix read while
 * an entry is running holds.
 */
function* settledFailedAndRunning(): Operation<ReplModel> {
  const physical = new InMemoryStream();
  yield* runEntry(physical, SETTLING);
  yield* runEntry(physical, FAILING, entryInitialBindings(projected(yield* physical.readAll())));
  const settled = yield* physical.readAll();
  const third = new InMemoryStream();
  yield* runEntry(third, SETTLING);
  const whole = [...settled, ...(yield* third.readAll())];
  const closes = whole
    .map((event, at) => ({ event, at }))
    .filter((one) => one.event.type === "close");
  const last = closes[closes.length - 1];
  return projected(whole.slice(0, last.at));
}

function stateWith(over: Partial<ReplState>): ReplState {
  return Object.freeze({ ...initialState(EXECUTION), ...over });
}

/** The same state selecting one entry, the way the action selects it. */
function selecting(state: ReplState, ...scopes: readonly string[]): ReplState {
  return Object.freeze({
    ...state,
    route: Object.freeze({ ...state.route, scopes: Object.freeze([...scopes]) }),
  });
}

/** The same state with the History drawer over it, as the grammar refers to it. */
function opening(state: ReplState): ReplState {
  return Object.freeze({
    ...state,
    route: Object.freeze({
      ...state.route,
      drawers: Object.freeze([Object.freeze({ kind: "history" as const })]),
    }),
  });
}

/** The same state with one named drawer over it, as the grammar refers to them. */
function openingDrawer(state: ReplState, drawer: ReplDrawerRef): ReplState {
  return Object.freeze({
    ...state,
    route: Object.freeze({ ...state.route, drawers: Object.freeze([drawer]) }),
  });
}

/** The same state frozen at one recorded position, the way the action freezes it. */
function frozenAt(state: ReplState, marker: string): ReplState {
  return Object.freeze({
    ...state,
    route: Object.freeze({ ...state.route, at: marker, inspect: true }),
  });
}

/** The action one dispatch asked for, or a failure naming what it did instead. */
function asked(dispatched: ReplDispatched<ReplAction>): ReplAction {
  if (dispatched.outcome !== "action") {
    throw new Error(`this dispatch produced ${dispatched.outcome} rather than an action`);
  }
  return dispatched.action;
}

/** The view this state reads as, or the failure that stopped it. */
function reading(
  state: ReplState,
  model: ReplModel,
  live: ReplLive = NOTHING_LIVE,
  size: ReplTerminalSize = WIDE,
  focused?: string,
): ReplView {
  // The navigation a session would publish for this reading: every position
  // the file retained, with the head it is standing at. Derived from the
  // model here because these cases build the model directly rather than
  // running a session.
  const resolved = viewFor(
    state,
    model,
    live,
    size,
    focused,
    navigationOf(model.checkpoints, model.settled ? "settled" : "unfinished"),
  );
  if (!resolved.ok) {
    throw resolved.error;
  }
  return resolved.value;
}

/** Where one mounted row landed, or a failure naming the row that is missing. */
function placed(observed: Observed, key: string): ReplBounds {
  const bounds = observed.boundsOf(key);
  if (bounds === undefined) {
    throw new Error(`this frame drew no ${key}; it drew ${observed.keys.slice(0, 40).join(", ")}`);
  }
  return bounds;
}

/**
 * The style of the first cell one row actually put a character in.
 *
 * The first *written* cell, not the first cell of the rectangle: every row of
 * this product is indented by its own marker, and the leading blanks carry the
 * surface without carrying the foreground.
 */
function inkOf(grid: TerminalGrid, bounds: ReplBounds): CellStyle {
  for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
    if (grid.at(x, bounds.y) !== " ") {
      return grid.styleAt(x, bounds.y);
    }
  }
  throw new Error(`nothing was written in the row at ${bounds.x},${bounds.y}`);
}

/** The text one row holds, with no attributes in it. */
function textOf(grid: TerminalGrid, bounds: ReplBounds): string {
  return grid.textIn(bounds)[0] ?? "";
}

/** The sidebar the catalog is drawn in. */
function sidebarRegion(observed: Observed): ReplBounds {
  const bounds = regionBounds(observed, "sidebar");
  if (bounds === undefined) {
    throw new Error("this frame published no sidebar region");
  }
  return bounds;
}

/** Whether one rectangle is inside another, so a row can be held to its pane. */
function within(inner: ReplBounds, outer: ReplBounds): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/**
 * One subordinate row, as the frame drew it.
 *
 * Before #881 PR 2 this was a transcript record row — a fact about the event
 * that produced the output beside it. The transcript now holds the entry's
 * reading, so the subordinate reading is taken from a row that still carries
 * it: what the frame says where it has nothing retained to list.
 */
function metadataKey(observed: Observed): string {
  const key = observed.keys.find((one) => one === "sessions:empty");
  if (key === undefined) {
    throw new Error(`this frame drew no subordinate row; it drew ${observed.keys.join(", ")}`);
  }
  return key;
}

/** Every mounted row whose cells carry the focus foreground. */
function focusedRows(observed: Observed, grid: TerminalGrid): string[] {
  const found: string[] = [];
  for (const key of observed.keys) {
    const bounds = observed.boundsOf(key);
    if (bounds === undefined) {
      continue;
    }
    for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
      if (grid.at(x, bounds.y) === " ") {
        continue;
      }
      if (grid.styleAt(x, bounds.y).foreground === REPL_PALETTE.focus) {
        found.push(key);
      }
      break;
    }
  }
  return found;
}

/** The key holding focus now, as the program reads it into the next view. */
function focusKeyOf(presenter: Presenter): string | undefined {
  const node = presenter.tree.focused();
  return node === undefined ? undefined : presenter.tree.keyOf(node);
}

/** Move focus until it reaches one key, or say where it got to instead. */
function* focusOn(presenter: Presenter, key: string, limit = 400): Operation<void> {
  const visited: string[] = [];
  for (let step = 0; step < limit; step += 1) {
    const moved = yield* presenter.tree.dispatch({ kind: "key", key: "Tab" });
    if (!moved.ok || moved.value.outcome !== "focus" || moved.value.focused === undefined) {
      break;
    }
    const at = presenter.tree.keyOf(moved.value.focused);
    if (at === key) {
      return;
    }
    if (at === undefined || visited.includes(at)) {
      break;
    }
    visited.push(at);
  }
  throw new Error(`Tab never reached ${key}; it visited ${visited.join(", ")}`);
}

describe("REPL presentation: what one row's cells say it is", () => {
  beforeAll(() => useTempFileCompiler());

  it("G1: output, metadata and the two outcomes are four different readings", function* () {
    const model = yield* settledAndFailed();
    const presenter = yield* usePresenter(WIDE);
    // The entry whose result is under test, selected: a reading belongs to an
    // entry, so which entry is being read is part of asking what it says.
    const observed = yield* presenter.commit(
      reading(selecting(stateWith({}), model.entries[0].key), model, NOTHING_LIVE, WIDE),
    );
    const { grid } = presenter;

    const transcript = regionBounds(observed, "transcript");
    if (transcript === undefined) {
      throw new Error("this frame published no transcript region");
    }

    // What the run produced, and a fact about the event that produced it.
    //
    // Re-anchored for #881 PR 2. These were adjacent transcript rows written by
    // one eval block; the transcript now holds the entry's *reading* — its
    // output and then its source — and the facts about events are the inspection
    // column's. The claim is unchanged: a result and a fact about the event that
    // produced it are two readings, and nothing but the style says which is
    // which.
    const output = placed(observed, "reading:output:0");
    const said = model.entries[0].terminal?.output.split("\n")[0] ?? "";
    expect(said.length).toBeGreaterThan(0);
    const metadata = placed(observed, metadataKey(observed));
    expect(inkOfSpan(grid, output, said).foreground).toBe(REPL_PALETTE.output);
    expect(inkOf(grid, metadata).foreground).toBe(REPL_PALETTE.muted);
    expect(inkOfSpan(grid, output, said).foreground).not.toBe(inkOf(grid, metadata).foreground);
    expect(within(output, transcript)).toBe(true);
    expect(within(metadata, sidebarRegion(observed))).toBe(true);

    // The two outcomes the file recorded, in the catalog that promises them.
    const sidebar = regionBounds(observed, "sidebar");
    if (sidebar === undefined) {
      throw new Error("this frame published no sidebar region");
    }
    const settled = placed(observed, "entry:entry-1");
    const failed = placed(observed, "entry:entry-2");
    expect(textOf(grid, settled)).toContain("[ok]");
    expect(textOf(grid, failed)).toContain("[err]");
    expect(inkOf(grid, settled).foreground).toBe(REPL_PALETTE.success);
    expect(inkOf(grid, failed).foreground).toBe(REPL_PALETTE.failure);
    expect(within(settled, sidebar)).toBe(true);
    expect(within(failed, sidebar)).toBe(true);

    // Four distinct readings, and the words survive without any of them.
    const colours = [
      inkOfSpan(grid, output, said).foreground,
      inkOf(grid, metadata).foreground,
      inkOf(grid, settled).foreground,
      inkOf(grid, failed).foreground,
    ];
    expect(new Set(colours).size).toBe(4);
  });

  it("G1: a settled document's recorded result is output, not an outcome", function* () {
    const model = yield* settledAndFailed();
    const presenter = yield* usePresenter(WIDE);

    // The root really did record a result, so the rows under test are the
    // rendered document rather than the word the root closed with.
    const settled = model.entries[0];
    const at = settled.transcript.findIndex((row) => row.kind === "terminal");
    const record = settled.transcript[at];
    if (record === undefined || record.kind !== "terminal") {
      throw new Error("this entry recorded no root close");
    }
    expect(record.status).toBe("ok");
    expect(record.output.length).toBeGreaterThan(0);

    // Selected, and with nothing live: the only copy of this text on the screen
    // is the durable one, so a bright live overlay cannot stand in for it.
    const observed = yield* presenter.commit(
      reading(selecting(stateWith({}), settled.key), model, NOTHING_LIVE, WIDE),
    );
    const { grid } = presenter;
    // Re-anchored for #881 PR 2: the entry's result is the Output half of its
    // reading rather than a transcript row keyed by the record's position. The
    // claim is unchanged — the rendered document reads as output, and not as the
    // word the root closed with.
    const first = placed(observed, "reading:output:0");
    const said = record.output.split("\n")[0];
    expect(textOf(grid, first)).toContain(said);
    // The text's own ink, not the row's first cell: every reading row opens
    // with its rail, which says which region the row is in rather than what the
    // row is.
    expect(inkOfSpan(grid, first, said).foreground).toBe(REPL_PALETTE.output);
    expect(inkOfSpan(grid, first, said).foreground).not.toBe(REPL_PALETTE.success);
    // And it is labelled as the retained result rather than as live text.
    expect(textOf(grid, placed(observed, "reading:caption:output"))).toContain("Output");
    expect(textOf(grid, placed(observed, "reading:caption:output"))).not.toContain("live");

    // The outcome keeps its accent where an outcome is what is shown.
    expect(inkOf(grid, placed(observed, `entry:${settled.key}`)).foreground).toBe(
      REPL_PALETTE.success,
    );
  });

  it("G1: a root that recorded no result shows its outcome and its reason", function* () {
    const model = yield* settledAndFailed();
    const presenter = yield* usePresenter(WIDE);

    const failed = model.entries[1];
    const at = failed.transcript.findIndex((row) => row.kind === "terminal");
    const record = failed.transcript[at];
    if (record === undefined || record.kind !== "terminal") {
      throw new Error("this entry recorded no root close");
    }
    expect(record.status).toBe("err");
    expect(record.output).toBe("");

    const observed = yield* presenter.commit(
      reading(selecting(stateWith({}), failed.key), model, NOTHING_LIVE, WIDE),
    );
    const { grid } = presenter;
    // With nothing recorded to show, the outcome itself is the row, and it keeps
    // the outcome accent; the reason recorded beside it is its own row.
    // Re-anchored for #881 PR 2 onto the reading's Output half; both claims and
    // both accents are unchanged, and the caption now says that the absence of
    // rendered text is what is being reported.
    expect(textOf(grid, placed(observed, "reading:caption:output"))).toContain(
      "No rendered output.",
    );
    const closed = placed(observed, "reading:output:outcome:0");
    expect(textOf(grid, closed)).toContain("closed err");
    expect(inkOfSpan(grid, closed, "closed err").foreground).toBe(REPL_PALETTE.failure);
    const reason = placed(observed, "reading:output:reason:0");
    expect(textOf(grid, reason)).toContain("failed:");
    expect(inkOfSpan(grid, reason, "failed:").foreground).toBe(REPL_PALETTE.failure);
  });

  it("G1: an entry that never closed reads as waiting, and says so", function* () {
    const model = yield* settledFailedAndRunning();
    const presenter = yield* usePresenter(WIDE);
    const observed = yield* presenter.commit(
      reading(stateWith({}), model, streaming("building the plan")),
    );
    const { grid } = presenter;

    const running = placed(observed, "entry:entry-3");
    expect(textOf(grid, running)).toContain("[unfinished]");
    expect(inkOf(grid, running).foreground).toBe(REPL_PALETTE.waiting);
    expect(inkOf(grid, running).foreground).not.toBe(
      inkOf(grid, placed(observed, "entry:entry-1")).foreground,
    );

    // The overlay is what this process is producing, so it reads as output
    // rather than as one more fact about an event. Re-anchored for #881 PR 2
    // onto the reading's Output half, which now also says it is still arriving.
    const live = placed(observed, "reading:output:live:0");
    expect(textOf(grid, live)).toContain("building the plan");
    expect(inkOfSpan(grid, live, "building the plan").foreground).toBe(REPL_PALETTE.output);
    expect(textOf(grid, placed(observed, "reading:caption:output"))).toContain("live");
  });

  it("G1: an empty screen's placeholders are subordinate, and the draft is a surface", function* () {
    const model = yield* scoped(function* () {
      const physical = new InMemoryStream();
      return projected(yield* physical.readAll());
    });
    const presenter = yield* usePresenter(WIDE);
    const observed = yield* presenter.commit(reading(stateWith({}), model));
    const { grid } = presenter;

    const none = placed(observed, "entry:none");
    expect(textOf(grid, none)).toContain("(not submitted)");
    expect(inkOf(grid, none).foreground).toBe(REPL_PALETTE.muted);
    const empty = placed(observed, "sessions:empty");
    expect(inkOf(grid, empty).foreground).toBe(REPL_PALETTE.muted);

    // The draft is where typing goes, so the whole row it was measured at
    // carries its own surface — blank cells included, which is the half a
    // foreground could never show.
    const draft = placed(observed, "footer:input");
    expect(draft.width).toBe(WIDE.columns);
    for (let x = draft.x; x < draft.x + draft.width; x += 1) {
      expect(grid.styleAt(x, draft.y).background).toBe(REPL_PALETTE.draftSurface);
    }
    // The guidance above it is prose rather than metadata, and reads as prose.
    expect(inkOf(grid, placed(observed, "guidance")).foreground).toBe(REPL_PALETTE.source);
  });

  it("G1: the History band keeps its own surface and accent at every size", function* () {
    const model = yield* settledAndFailed();
    for (const size of [WIDE, MEDIUM, NARROW]) {
      yield* scoped(function* () {
        const presenter = yield* usePresenter(size);
        const observed = yield* presenter.commit(reading(stateWith({}), model, NOTHING_LIVE, size));
        const band = observed.regionOf("box:footer:band");
        if (band === undefined) {
          throw new Error(`the ${size.columns}x${size.rows} frame published no History band`);
        }
        expect(band.height).toBe(5);
        const row = placed(observed, "footer:input").y - band.height;
        expect(band.y).toBe(row);
        // Re-anchored for #881 PR 3: the band was one accent and is now a
        // rail whose cells say what each of them is — the title, the rule,
        // an entry mark, a minor mark, the selection, the head. The claim is
        // the same and is why either exists: every cell in this band is the
        // band's own, and nothing foreign is painted here.
        const own = new Set<number>([
          REPL_PALETTE.historyTitle,
          REPL_PALETTE.historyRail,
          REPL_PALETTE.historyEntryEarlier,
          REPL_PALETTE.historyTickEarlier,
          REPL_PALETTE.historyMinorEarlier,
          REPL_PALETTE.historyEntryLater,
          REPL_PALETTE.historyMinorLater,
          REPL_PALETTE.historySelected,
          REPL_PALETTE.historyHeadLive,
          REPL_PALETTE.historyHead,
        ]);
        for (const written of presenter.grid.nonblank(band)) {
          const [at] = written.split("=");
          const [x, y] = at.split(",").map(Number);
          const ink = presenter.grid.styleAt(x, y).foreground;
          expect([at, ink !== undefined && own.has(ink)]).toEqual([at, true]);
        }
        for (let x = band.x; x < band.x + band.width; x += 1) {
          expect(presenter.grid.styleAt(x, band.y).background).toBe(REPL_PALETTE.historySurface);
        }
      });
    }
  });
});

describe("REPL presentation: selection and focus are two different facts", () => {
  beforeAll(() => useTempFileCompiler());

  it("G2: a selected entry stays selected while focus is somewhere else", function* () {
    const model = yield* settledAndFailed();
    const presenter = yield* usePresenter(WIDE);
    const state = selecting(stateWith({}), "entry-1");

    // One commit to mount the tree, so there is something for Tab to move
    // through, and a second to draw what that move settled.
    yield* presenter.commit(reading(state, model));
    yield* focusOn(presenter, "sessions:heading");
    // Carried into the next view the way the program carries it: a view that
    // said nothing held focus would let the draft claim it straight back.
    const observed = yield* presenter.commit(
      reading(state, model, NOTHING_LIVE, WIDE, focusKeyOf(presenter)),
    );
    const { grid } = presenter;

    const selected = placed(observed, "entry:entry-1");
    const unselected = placed(observed, "entry:entry-2");
    // Across the whole row the frame measured, blanks included: a selection
    // that stopped where the label stopped would be half a selection.
    for (let x = selected.x; x < selected.x + selected.width; x += 1) {
      expect(grid.styleAt(x, selected.y).background).toBe(REPL_PALETTE.selectedSurface);
    }
    expect(grid.styleAt(unselected.x, unselected.y).background).not.toBe(
      REPL_PALETTE.selectedSurface,
    );

    // Focus is elsewhere, so the selected row keeps its own outcome colour and
    // exactly one mounted row carries the focus foreground.
    expect(inkOf(grid, selected).foreground).toBe(REPL_PALETTE.success);
    expect(focusedRows(observed, grid)).toEqual(["sessions:heading"]);
    const heading = placed(observed, "sessions:heading");
    expect(inkOf(grid, heading).foreground).toBe(REPL_PALETTE.focus);
    expect(inkOf(grid, heading).attrs).toContain(BOLD);

    // And the whole reading survives with the colour thrown away.
    expect(textOf(grid, selected)).toContain("*");
    expect(textOf(grid, selected)).toContain("[ok]");
    expect(textOf(grid, unselected)).not.toContain("*");
    expect(textOf(grid, heading).trimStart().startsWith(">")).toBe(true);
  });

  it("G2: focus moving onto the selected row leaves its selection alone", function* () {
    const model = yield* settledAndFailed();
    const presenter = yield* usePresenter(WIDE);
    const state = selecting(stateWith({}), "entry-1");

    yield* presenter.commit(reading(state, model));
    yield* focusOn(presenter, "entry:entry-1");
    const observed = yield* presenter.commit(
      reading(state, model, NOTHING_LIVE, WIDE, focusKeyOf(presenter)),
    );
    const { grid } = presenter;

    const selected = placed(observed, "entry:entry-1");
    // The foreground is focus's; the surface is still selection's.
    expect(inkOf(grid, selected).foreground).toBe(REPL_PALETTE.focus);
    expect(inkOf(grid, selected).attrs).toContain(BOLD);
    for (let x = selected.x; x < selected.x + selected.width; x += 1) {
      expect(grid.styleAt(x, selected.y).background).toBe(REPL_PALETTE.selectedSurface);
    }
    expect(focusedRows(observed, grid)).toEqual(["entry:entry-1"]);
    expect(textOf(grid, selected)).toContain("*");
  });

  it("G2: a pointer and Enter on one row ask for the same thing", function* () {
    const model = yield* settledAndFailed();
    const presenter = yield* usePresenter(WIDE);
    const observed = yield* presenter.commit(reading(stateWith({}), model));

    const bounds = placed(observed, "entry:entry-2");
    const node = observed.nodeOf("entry:entry-2");
    if (node === undefined) {
      throw new Error("this frame mounted no node for entry-2");
    }
    const pointed = yield* presenter.tree.dispatch({
      kind: "pointer",
      target: observed.committed.rendered.map.at(bounds.x, bounds.y) ?? "",
      frame: observed.committed.rendered.tree,
    });
    yield* focusOn(presenter, "entry:entry-2");
    const pressed = yield* presenter.tree.dispatch({ kind: "key", key: "Enter" });
    if (!pointed.ok || !pressed.ok) {
      throw new Error("one of the two activations was refused");
    }
    expect(observed.committed.rendered.map.at(bounds.x, bounds.y)).toBe(node);
    expect(asked(pointed.value)).toEqual(asked(pressed.value));
  });
});

describe("REPL presentation: what an updated frame leaves behind", () => {
  beforeAll(() => useTempFileCompiler());

  it("G5: a long reading, then a short one, then a closed drawer, is fresh-C", function* () {
    const model = yield* settledAndFailed();
    const closed = selecting(stateWith({}), "entry-1");

    /** The whole terminal, every cell with its character and its style. */
    const whole = (grid: TerminalGrid, size: ReplTerminalSize): readonly string[] =>
      grid.styledIn({ x: 0, y: 0, width: size.columns, height: size.rows });

    // A: long labels, a long stream and the pausable action row. B: the short
    // versions of all three. C: a drawer opened wide, taken to narrow, brought
    // back wide, and closed.
    const incremental = yield* scoped(function* () {
      const presenter = yield* usePresenter(WIDE);
      yield* presenter.commit(
        reading(
          selecting(stateWith({ draft: "a".repeat(240) }), "entry-2"),
          model,
          streaming(`${"streaming a very long line of output ".repeat(6)}\nand another`),
          WIDE,
        ),
      );
      yield* presenter.commit(reading(stateWith({ draft: "b" }), model, streaming("short"), WIDE));
      const history = opening(closed);
      yield* presenter.commit(reading(history, model, NOTHING_LIVE, WIDE));
      presenter.resize(NARROW);
      yield* presenter.commit(reading(history, model, NOTHING_LIVE, NARROW));
      presenter.resize(WIDE);
      yield* presenter.commit(reading(history, model, NOTHING_LIVE, WIDE));
      const last = yield* presenter.commit(reading(closed, model, NOTHING_LIVE, WIDE));
      return { cells: whole(presenter.grid, WIDE), observed: last };
    });

    const fresh = yield* scoped(function* () {
      const presenter = yield* usePresenter(WIDE);
      const last = yield* presenter.commit(reading(closed, model, NOTHING_LIVE, WIDE));
      return { cells: whole(presenter.grid, WIDE), observed: last };
    });

    // Characters, foregrounds, backgrounds and blanks alike: a cell the
    // shortened row no longer reaches has to have been erased, and only a
    // comparison that carries the blanks can say so.
    expect(incremental.cells).toEqual(fresh.cells);
    expect(incremental.observed.keys.slice().sort()).toEqual(fresh.observed.keys.slice().sort());
    // The drawer went with its branch: nothing it mounted is still a target.
    expect(
      fresh.observed.targets.some((target) =>
        (fresh.observed.committed.manifest.root.key ?? "").startsWith("drawer:"),
      ),
    ).toBe(false);
    expect(incremental.observed.keys.some((key) => key.startsWith("drawer:"))).toBe(false);
  });

  it("G5: an open drawer's interior is opaque inside the bounds the engine gave it", function* () {
    const model = yield* settledAndFailed();
    const presenter = yield* usePresenter(WIDE);
    const base = selecting(stateWith({}), "entry-1");

    // Something long behind it, so a transparent interior would be visible as
    // the transcript rather than as blank cells.
    yield* presenter.commit(
      reading(base, model, streaming(`${"behind the modal ".repeat(9)}\n`.repeat(4)), WIDE),
    );
    const history = opening(base);
    const observed = yield* presenter.commit(reading(history, model, NOTHING_LIVE, WIDE));
    const rect = regionBounds(observed, "drawer");
    if (rect === undefined) {
      throw new Error("this frame published no drawer region");
    }
    expect({ ...rect }).toEqual({ x: 20, y: 3, width: 120, height: 23 });

    // Every cell of the rectangle carries the drawer's own surface. The ones
    // the drawer wrote nothing in are the ones that matter: those are where
    // the transcript would otherwise still be showing.
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        const style = presenter.grid.styleAt(x, y);
        // Any of this palette's own surfaces, and never the terminal default:
        // what the rectangle must not show is whatever is behind it.
        const surfaces: readonly number[] = [
          REPL_PALETTE.drawerSurface,
          REPL_PALETTE.selectedSurface,
          REPL_PALETTE.historySurface,
          REPL_PALETTE.fieldSurface,
          REPL_PALETTE.draftSurface,
        ];
        const surfaced = style.background !== undefined && surfaces.includes(style.background);
        if (!surfaced) {
          throw new Error(
            `the cell at ${x},${y} is inside the drawer and carries ${String(style.background)}`,
          );
        }
      }
    }

    // And nothing outside it was repainted into the modal's surface.
    const viewport = viewportBounds(observed, "sessions");
    if (viewport === undefined) {
      throw new Error("this frame published no sessions viewport");
    }
    for (let y = viewport.y; y < viewport.y + viewport.height; y += 1) {
      for (let x = viewport.x; x < Math.min(viewport.x + viewport.width, rect.x); x += 1) {
        expect(presenter.grid.styleAt(x, y).background).not.toBe(REPL_PALETTE.drawerSurface);
      }
    }
  });

  it("G5: the grid it all rests on retains the attributes a cell was written under", function* () {
    // A control, so a defect in the replay cannot be mistaken for a defect in
    // the product: these are the exact sequences this renderer emits.
    const grid = createGrid();
    const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
    grid.apply(
      encode("\u001B[0m\u001B[1m\u001B[38;2;127;211;232m\u001B[48;2;18;32;38m\u001B[1;1Hab"),
    );
    expect(grid.styleAt(0, 0)).toEqual({
      foreground: REPL_PALETTE.focus,
      background: REPL_PALETTE.selectedSurface,
      attrs: [BOLD],
    });
    // A reset drops the foreground and the weight and leaves the background the
    // sequence after it restates, which is exactly how a padded row arrives.
    grid.apply(encode("\u001B[0m\u001B[48;2;18;32;38m\u001B[1;3H c"));
    expect(grid.styleAt(2, 0)).toEqual({
      foreground: undefined,
      background: REPL_PALETTE.selectedSurface,
      attrs: [],
    });
    expect(grid.at(3, 0)).toBe("c");
    expect(grid.styledIn({ x: 0, y: 0, width: 2, height: 1 })).toEqual([
      "a|7fd3e8|122026|1 b|7fd3e8|122026|1",
    ]);
  });
});

describe("REPL presentation: the panes a reading is laid out in", () => {
  beforeAll(() => useTempFileCompiler());

  it("P1: each shared column is named, and says so while it is empty", function* () {
    const model = yield* settledAndFailed();
    for (const size of [WIDE, MEDIUM]) {
      const presenter = yield* usePresenter(size);
      // Nothing selected and nothing live: the Bindings column holds no row at
      // all, which is exactly the state a pane that named itself only when full
      // would read as a gap.
      const observed = yield* presenter.commit(reading(stateWith({}), model, NOTHING_LIVE, size));
      const { grid } = presenter;

      const transcript = placed(observed, "transcript:heading");
      const bindings = placed(observed, "inspection:heading");
      expect(textOf(grid, transcript).trim()).toBe("Transcript");
      expect(textOf(grid, bindings).trim()).toBe("Bindings");
      expect(inkOf(grid, transcript).attrs).toContain(BOLD);
      expect(inkOf(grid, bindings).attrs).toContain(BOLD);

      // Named, and not a control: a pane title is something you read.
      expect(
        observed.targets.some((target) => target.node === observed.nodeOf("transcript:heading")),
      ).toBe(false);
      expect(
        observed.targets.some((target) => target.node === observed.nodeOf("inspection:heading")),
      ).toBe(false);
    }
  });

  it("P1: a narrow frame has no pane to name, and names none", function* () {
    const model = yield* settledAndFailed();
    const presenter = yield* usePresenter(NARROW);
    const observed = yield* presenter.commit(reading(stateWith({}), model, NOTHING_LIVE, NARROW));
    // The two surface controls are the narrow frame's own headings; a pane title
    // described here would be mounted and placed nowhere.
    expect(observed.keys).toContain("sessions:heading");
    expect(observed.keys).toContain("entries:heading");
    expect(observed.keys).not.toContain("transcript:heading");
    expect(observed.keys).not.toContain("inspection:heading");
  });

  it("P1: a row is built to the inside of its pane, not to the pane", function* () {
    const model = yield* settledAndFailed();
    for (const size of [WIDE, MEDIUM]) {
      const presenter = yield* usePresenter(size);
      const observed = yield* presenter.commit(
        reading(selecting(stateWith({}), "entry-1"), model, NOTHING_LIVE, size),
      );

      for (const region of ["transcript", "inspection"] as const) {
        const outer = regionBounds(observed, region);
        const inside = observed.regionOf(`box:${region}:content`);
        if (outer === undefined || inside === undefined) {
          throw new Error(`the ${size.columns}x${size.rows} frame published no ${region} pane`);
        }
        // The edge is part of the pane and not part of the room in it.
        expect(inside.width).toBeLessThan(outer.width);
        expect(inside.x).toBeGreaterThan(outer.x - 1);
        // And every row of that pane is exactly the inside wide — a row sized
        // from the outer bound would reach into the column beside it.
        for (const key of observed.keys) {
          const bounds = observed.boundsOf(key);
          if (bounds === undefined || !within(bounds, inside)) {
            continue;
          }
          expect(bounds.width).toBe(inside.width);
        }
      }
    }
  });

  it("P2: the footer keeps seven rows, and the draft says what it is", function* () {
    const model = yield* settledAndFailed();
    for (const size of [WIDE, MEDIUM, NARROW]) {
      const presenter = yield* usePresenter(size);
      const drafted = Object.freeze({
        ...stateWith({}),
        draft: "first line\nsecond line\nthird line",
      });
      // Twice: the draft claims focus on the first frame and the cue it renders
      // is the view's, which is one frame behind the tree that settled it.
      yield* presenter.commit(reading(drafted, model, NOTHING_LIVE, size));
      const observed = yield* presenter.commit(
        reading(drafted, model, NOTHING_LIVE, size, focusKeyOf(presenter)),
      );
      const { grid } = presenter;

      const footer = regionBounds(observed, "footer");
      if (footer === undefined) {
        throw new Error("this frame published no footer");
      }
      expect(footer.height).toBe(FOOTER_ROWS);

      // One row, the full width, and the count of what is not on it.
      const draft = placed(observed, "footer:input");
      expect(draft.height).toBe(1);
      expect(draft.width).toBe(size.columns);
      const text = textOf(grid, draft);
      expect(text.startsWith(">> Draft: ")).toBe(true);
      expect(text).toContain("[2 lines] third line");

      // The band keeps its own five rows and now says which band it is.
      const band = observed.regionOf("box:footer:band");
      if (band === undefined) {
        throw new Error("this frame published no History band");
      }
      expect(band.height).toBe(HISTORY_ROWS);
      expect(textOf(grid, band).startsWith(HISTORY_TITLE)).toBe(true);
    }
  });

  it("P2: the draft is marked unfocused when focus is elsewhere", function* () {
    const model = yield* settledAndFailed();
    const presenter = yield* usePresenter(WIDE);
    const state = selecting(stateWith({ draft: "typed" }), "entry-1");
    yield* presenter.commit(reading(state, model));
    yield* focusOn(presenter, "entries:heading");
    const observed = yield* presenter.commit(
      reading(state, model, NOTHING_LIVE, WIDE, focusKeyOf(presenter)),
    );
    const text = textOf(presenter.grid, placed(observed, "footer:input"));
    expect(text.startsWith(" > Draft: typed")).toBe(true);
  });

  it("P3: the dedicated location is drawn nowhere and reserves nothing", function* () {
    const model = yield* settledAndFailed();
    for (const size of [WIDE, MEDIUM, NARROW]) {
      const presenter = yield* usePresenter(size);
      // A long multiline draft makes the canonical location longer than any row,
      // so a frame that still reserved room for it could not hide that.
      const state = Object.freeze({
        ...selecting(stateWith({}), "entry-1"),
        draft: "a long draft line\n".repeat(12),
      });
      const view = reading(state, model, NOTHING_LIVE, size);
      const observed = yield* presenter.commit(view);

      // The route still exists and still encodes exactly as it did.
      expect(view.location).toBe(encodeLocation(view.state.route));
      expect(view.location.startsWith("xmd://repl/")).toBe(true);

      // It is simply not on the screen: no candidate, no cell, no row.
      expect(observed.keys.filter((key) => key.startsWith("location:"))).toEqual([]);
      for (const row of presenter.grid.rows()) {
        expect(row).not.toContain("xmd://");
      }
      // And nothing was left blank where it used to be: the first body row is
      // the pane's own, which only holds if no row was reserved above it.
      const first =
        size === NARROW ? placed(observed, "guidance") : placed(observed, "transcript:heading");
      const body = regionBounds(observed, size === NARROW ? "content" : "transcript");
      if (body === undefined) {
        throw new Error("this frame published no body region");
      }
      expect(first.y).toBe(body.y);
    }
  });
});

describe("REPL presentation: what a drawer says it is showing", () => {
  beforeAll(() => useTempFileCompiler());

  it("D1: a binding drawer names the kind of reading and the binding", function* () {
    const model = yield* settledAndFailed();
    const binding = model.entries[0]?.bindings[0];
    if (binding === undefined) {
      throw new Error("this entry published no binding to inspect");
    }
    const presenter = yield* usePresenter(WIDE);
    const state = openingDrawer(selecting(stateWith({}), "entry-1"), {
      kind: "binding",
      name: binding.name,
    });
    const observed = yield* presenter.commit(reading(state, model, NOTHING_LIVE, WIDE));
    const { grid } = presenter;

    const title = placed(observed, "drawer:open");
    expect(textOf(grid, title)).toContain(`Binding · ${binding.name}`);
    // A title is a heading: bold, and read rather than activated.
    expect(inkOf(grid, title).attrs).toContain(BOLD);
    expect(observed.targets.some((one) => one.node === observed.nodeOf("drawer:open"))).toBe(false);
    // The value it holds reads as the JSON it is, not as the words around it —
    // and it sits on the surface an editable value sits on, across the whole row
    // the drawer measured for it, so what holds a value is visible before it is
    // read.
    const value = placed(observed, "drawer:value:0");
    expect(textOf(grid, value).trimEnd()).toBe(JSON.stringify(binding.value, undefined, 2));
    expect(inkOf(grid, value).foreground).toBe(REPL_PALETTE.string);
    expect(inkOf(grid, value).foreground).not.toBe(REPL_PALETTE.heading);
    for (let x = value.x; x < value.x + value.width; x += 1) {
      expect(grid.styleAt(x, value.y).background).toBe(REPL_PALETTE.fieldSurface);
    }
  });

  it("D1: a recorded answer says so, and keeps the origin it came from", function* () {
    // The reference entry, which asks a question and is answered — so this
    // history really holds a retained answer to inspect.
    const model = projected(yield* referenceEvents());
    const recorded = model.entries.flatMap((entry) => entry.scope.elicitations)[0];
    if (recorded === undefined) {
      throw new Error("this history retained no answer to inspect");
    }
    const presenter = yield* usePresenter(WIDE);
    const state = openingDrawer(selecting(stateWith({}), "entry-1"), {
      kind: "recorded-elicit",
      marker: recorded.marker,
    });
    const observed = yield* presenter.commit(reading(state, model, NOTHING_LIVE, WIDE));
    const { grid } = presenter;

    const title = placed(observed, "drawer:open");
    expect(textOf(grid, title)).toContain("Recorded answer · ");
    expect(textOf(grid, title)).toContain(recorded.location.slice(0, 12));
    expect(inkOf(grid, title).attrs).toContain(BOLD);

    // What was asked is a label, what was answered is a value, and the two are
    // not the same reading.
    const schema = placed(observed, "drawer:schema");
    const answered = placed(observed, "drawer:answered");
    expect(inkOf(grid, schema).attrs).toContain(BOLD);
    expect(inkOf(grid, answered).attrs).toContain(BOLD);
    expect(inkOf(grid, placed(observed, "drawer:schema:0")).foreground).toBe(REPL_PALETTE.muted);

    // The answer itself is one window further on: the drawer's own top rule and
    // side inset are part of its measured rectangle, and this schema is long.
    // Reached through the window action a person presses, against the admission
    // each frame measured, so what is asserted is what a reader would see.
    let advanced = state;
    for (let press = 0; press < 40; press += 1) {
      if (presenter.last()?.boundsOf("drawer:answer:1") !== undefined) {
        break;
      }
      const view = reading(advanced, model, NOTHING_LIVE, WIDE);
      advanced = reduceRepl(
        advanced,
        { kind: "scroll", delta: 1 },
        model,
        NOTHING_LIVE,
        yield* presenter.prepare(view),
      ).state;
      yield* presenter.commit(reading(advanced, model, NOTHING_LIVE, WIDE));
    }
    const scrolled = presenter.last();
    if (scrolled === undefined) {
      throw new Error("this presenter committed no frame");
    }
    // Read as the JSON it is: what the answer calls its field, and the value
    // recorded under it, are two readings and neither is the muted schema.
    const recordedAnswer = placed(scrolled, "drawer:answer:1");
    expect(inkOfSpan(grid, recordedAnswer, '"decision"').foreground).toBe(REPL_PALETTE.attribute);
    expect(inkOfSpan(grid, recordedAnswer, '"approve"').foreground).toBe(REPL_PALETTE.string);
    expect(inkOfSpan(grid, recordedAnswer, '"approve"').foreground).not.toBe(REPL_PALETTE.muted);
  });

  it("D1: History names itself, and its rows keep the band's own accent", function* () {
    const model = yield* settledAndFailed();
    const presenter = yield* usePresenter(WIDE);
    const state = opening(selecting(stateWith({}), "entry-1"));
    const observed = yield* presenter.commit(reading(state, model, NOTHING_LIVE, WIDE));
    const { grid } = presenter;

    expect(textOf(grid, placed(observed, "drawer:open")).trim()).toBe("History");
    const marker = model.checkpoints[0];
    if (marker === undefined) {
      throw new Error("this history retained no position");
    }
    const row = placed(observed, `drawer:marker:${marker.marker}`);
    expect(inkOf(grid, row).foreground).toBe(REPL_PALETTE.historical);
  });

  it("D2: a drawer's actions sit on their own surface, and only one is focused", function* () {
    const model = yield* settledAndFailed();
    const presenter = yield* usePresenter(WIDE);
    const state = opening(selecting(stateWith({}), "entry-1"));
    yield* presenter.commit(reading(state, model));
    yield* focusOn(presenter, "drawer:close");
    const observed = yield* presenter.commit(
      reading(state, model, NOTHING_LIVE, WIDE, focusKeyOf(presenter)),
    );
    const { grid } = presenter;

    // Every control of this drawer carries the surface a control carries, so a
    // reader can tell what acts from what explains before reading either.
    for (const key of ["drawer:scroll:up", "drawer:scroll:down", "drawer:close"]) {
      const bounds = placed(observed, key);
      expect(grid.styleAt(bounds.x, bounds.y).background).toBe(REPL_PALETTE.draftSurface);
    }
    // And exactly one of them is the one a keystroke reaches.
    expect(focusedRows(observed, grid)).toEqual(["drawer:close"]);
    expect(textOf(grid, placed(observed, "drawer:close"))).toContain("[close]");
  });

  it("D3: a recorded position reads as history, and returning live clears it", function* () {
    const events = yield* settledAndFailedJournal();
    const model = projected(events);
    const marker = model.checkpoints[0];
    if (marker === undefined) {
      throw new Error("this history retained no position");
    }

    const inspected = yield* scoped(function* (): Operation<CellStyle> {
      const presenter = yield* usePresenter(WIDE);
      const prefix = prefixAt(events, marker.marker);
      const state = frozenAt(stateWith({}), marker.marker);
      const observed = yield* presenter.commit(reading(state, prefix, NOTHING_LIVE, WIDE));
      return inkOf(presenter.grid, placed(observed, "guidance"));
    });
    // A reading of a recorded position says so in its own accent.
    expect(inspected.foreground).toBe(REPL_PALETTE.historical);

    const live = yield* scoped(function* (): Operation<CellStyle> {
      const presenter = yield* usePresenter(WIDE);
      const observed = yield* presenter.commit(
        reading(selecting(stateWith({}), "entry-1"), model, NOTHING_LIVE, WIDE),
      );
      return inkOf(presenter.grid, placed(observed, "guidance"));
    });
    // And the head reads as the head: the accent leaves with the reading.
    expect(live.foreground).toBe(REPL_PALETTE.source);
    expect(live.foreground).not.toBe(inspected.foreground);
  });
});

describe("REPL presentation: a row stays inside the pane it was measured for", () => {
  beforeAll(() => useTempFileCompiler());

  it("R3: a long reading is fitted, and the row beneath it is its own", function* () {
    // An entry submitted by its host path, which in this checkout is longer
    // than any pane the frame has room for. The engine clips nothing, so a row
    // written unbounded wraps over the cells of the row beneath it: that is the
    // artifact the complete gallery caught in the Transcript pane.
    //
    // Re-anchored for #881 PR 2. The rows under test were the transcript's
    // metadata records, bounded by shortening them; the transcript now holds
    // the entry's reading, fitted by measuring it. Both claims are kept — what
    // is drawn in a row is what that row contributed, and no row reaches the
    // pane beside it — and the case still needs a row that would overflow if
    // nothing bounded it.
    const model = yield* submittedWithLongSource();
    let exercised = false;

    for (const size of [WIDE, MEDIUM]) {
      const presenter = yield* usePresenter(size);
      const observed = yield* presenter.commit(reading(stateWith({}), model, NOTHING_LIVE, size));
      const { grid } = presenter;

      const inside = observed.regionOf("box:transcript:content");
      if (inside === undefined) {
        throw new Error(`the ${size.columns}x${size.rows} frame published no transcript interior`);
      }

      const lines = observed.keys.filter((key) => key.startsWith("reading:"));

      // Every transcript row holds what its own node contributed and nothing
      // else. This is the whole discrimination: an unbounded row leaves its
      // tail on the cells of the row beneath it, so the row beneath stops
      // reading as itself before anything else goes wrong.
      for (const key of lines) {
        const bounds = placed(observed, key);
        const drawn = textOf(grid, bounds).trimEnd();
        const contributed = (observed.cells.get(key) ?? "").trimEnd();
        expect([size.columns, key, drawn]).toEqual([size.columns, key, contributed]);
      }

      // Every row of the reading, held to the pane it was measured for. Each
      // one is as wide as the interior and ends where the interior ends, so
      // nothing of it reaches the pane beside it — which is what the engine,
      // left to itself, does not do.
      expect(lines.length).toBeGreaterThan(0);
      for (const key of lines) {
        const bounds = placed(observed, key);
        expect([key, bounds.width]).toEqual([key, inside.width]);
        expect([size.columns, key, bounds.x + bounds.width]).toEqual([
          size.columns,
          key,
          inside.x + inside.width,
        ]);
        // A row that is the continuation of a longer line: without the
        // measurement that cut it, that line is what would have landed on the
        // cells of the row beneath.
        if (key.startsWith("reading:src:") && key.includes("+")) {
          exercised = true;
        }
      }
    }

    // One of those rows really did fill its pane, or this proves nothing: the
    // case needs a row that would overflow if nothing bounded it.
    expect(exercised).toBe(true);
  });
});

describe("REPL presentation: the one guidance row", () => {
  beforeAll(() => useTempFileCompiler());

  it("R6: what the row must say fits the room it was measured for, whole", function* () {
    // Focus on a mounted control that is not the draft. That is the branch
    // with the most to say — the state, what Enter does here, and the way back
    // to the draft are all required together — and it is the branch the
    // gallery caught running out of a medium transcript column.
    const model = yield* settledAndFailed();

    for (const size of [WIDE, MEDIUM, NARROW]) {
      const presenter = yield* usePresenter(size);
      const observed = yield* presenter.commit(
        reading(stateWith({}), model, NOTHING_LIVE, size, "entries:heading"),
      );
      const { grid } = presenter;
      const bounds = placed(observed, "guidance");
      const said = observed.cells.get("guidance") ?? "";

      // It fits the row it was measured for. This engine clips no text, so a
      // sentence longer than this is not a shortened sentence — it is a
      // sentence written across the row underneath.
      expect([size.columns, said.length, bounds.width]).toEqual([
        size.columns,
        said.length,
        bounds.width >= said.length ? bounds.width : said.length,
      ]);

      // And it still says the three things it exists to say, each whole: the
      // state it is in, what the focused control does, and the way back to the
      // draft. No ellipsis, because nothing required was cut to get here.
      expect([size.columns, said.startsWith("Ready for Entry ")]).toEqual([size.columns, true]);
      expect([size.columns, said.includes("Enter")]).toEqual([size.columns, true]);
      expect([size.columns, /Tab to (the )?draft/.test(said)]).toEqual([size.columns, true]);
      expect([size.columns, said.includes("…")]).toEqual([size.columns, false]);

      // What is drawn in the row is what the row contributed, and so is every
      // transcript row beneath it: an overlong sentence lands on the cells of
      // the row below, which is where it was seen.
      for (const key of [
        "guidance",
        ...observed.keys.filter((one) => one.startsWith("reading:")),
      ]) {
        // A narrow frame describes the reading's rows and places none of them,
        // so there is nothing of theirs on this screen to read.
        const at = key === "guidance" ? bounds : observed.boundsOf(key);
        if (at === undefined) {
          continue;
        }
        expect([size.columns, key, textOf(grid, at).trimEnd()]).toEqual([
          size.columns,
          key,
          (observed.cells.get(key) ?? "").trimEnd(),
        ]);
      }
    }
  });
});

/**
 * The frozen source example, exactly as the accepted presentation states it.
 *
 * Three lines of existing grammar: a heading, a tag with an attribute, a quoted
 * value and a reference, and a tag whose whole content is a reference. It is a
 * presentation example rather than a program — nothing here is executed — which
 * is why it is carried as a question's message and as a draft.
 */
const SOURCE_EXAMPLE: readonly string[] = Object.freeze([
  "# Create a project README",
  '<Elicit as="answers" schema={schema}>Enter the project details.</Elicit>',
  '<Plan as="draft">{answers}</Plan>',
]);

/**
 * One entry binding the frozen JSON example, and one value holding escapes.
 *
 * Bound by a real eval block in a real run, so what the inspector shows is a
 * value this Journal actually recorded and `detail()` actually serialized.
 */
const BINDING_EXAMPLE = [
  "```js eval",
  "const tokens = {",
  '  name: "Northstar",',
  "  count: 3,",
  "  approved: true,",
  "  empty: null,",
  '  quote: "say \\"hi\\" \\\\ once",',
  "};",
  "```",
  "",
].join("\n");

/** Project details, with the exact labels and hints the presentation freezes. */
const DETAILS_SCHEMA: { readonly [key: string]: Json } = {
  type: "object",
  title: "Project details",
  properties: {
    project: {
      type: "string",
      minLength: 1,
      title: "Project name",
      description: "Name your project.",
    },
    description: {
      type: "string",
      minLength: 1,
      title: "One-sentence description",
      description: "Describe its purpose.",
    },
  },
  required: ["project", "description"],
  additionalProperties: false,
};

/** One real entry whose eval block binds the frozen JSON example. */
function* boundExample(): Operation<ReplModel> {
  const physical = new InMemoryStream();
  yield* runEntry(physical, BINDING_EXAMPLE);
  return projected(yield* physical.readAll());
}

/**
 * Install the real provider, ask one real question, and hand back the pending
 * one.
 *
 * The provider's own question, so the form a drawer draws is the one Core
 * compiled from the request rather than a shape this file assembled.
 */
function* askingWith(
  schema: { readonly [key: string]: Json },
  message: string,
): Operation<ReplQuestion> {
  const elicitation = yield* useReplElicitation();
  yield* spawn(function* () {
    yield* Elicitation.operations.elicit({ message, schema: { ...schema } });
  });
  // The provider publishes before it suspends, so one turn is enough.
  yield* sleep(0);
  const question = elicitation.pending;
  if (question === undefined) {
    throw new Error("the provider published no question");
  }
  return question;
}

/** A live reading with one question waiting. */
function asking(question: ReplQuestion): ReplLive {
  return Object.freeze({ ...NOTHING_LIVE, question });
}

/** The same state with the live question's drawer over it and a form filled in. */
function answering(
  state: ReplState,
  values: Readonly<Record<string, string>>,
  messages: readonly ReplFormMessage[] = [],
): ReplState {
  return Object.freeze({
    ...openingDrawer(state, { kind: "live-elicit" }),
    form: Object.freeze({
      ...EMPTY_FORM,
      values: Object.freeze({ ...values }),
      messages: Object.freeze([...messages]),
    }),
  });
}

/**
 * What one stretch of a row was drawn with, found by where that stretch is.
 *
 * The whole stretch, and it has to be one colour: a span drawn half in one
 * foreground and half in another is not a classified token, and a helper that
 * returned its first cell would call that a pass. The span is located in the
 * characters the frame actually painted, so a row that drew something else has
 * no such stretch and says so.
 */
function inkOfSpan(grid: TerminalGrid, bounds: ReplBounds, span: string, from = 0): CellStyle {
  const row = textOf(grid, bounds);
  const at = row.indexOf(span, from);
  if (at < 0) {
    throw new Error(`the row ${JSON.stringify(row)} holds no ${JSON.stringify(span)}`);
  }
  const first = grid.styleAt(bounds.x + at, bounds.y);
  for (let step = 1; step < span.length; step += 1) {
    const next = grid.styleAt(bounds.x + at + step, bounds.y);
    if (next.foreground !== first.foreground) {
      throw new Error(
        `${JSON.stringify(span)} is drawn in two foregrounds: ` +
          `${String(first.foreground)} then ${String(next.foreground)} at column ` +
          `${bounds.x + at + step}`,
      );
    }
  }
  return first;
}

/**
 * The source rows of an open question drawer, in order.
 *
 * Found by the keys the frame placed rather than by searching the screen for
 * words: the message is arbitrary text, and a row of it may say anything.
 */
function messageRows(observed: Observed): readonly ReplBounds[] {
  const found: ReplBounds[] = [];
  for (let offset = 0; ; offset += 1) {
    const bounds = observed.boundsOf(`drawer:message:${offset}`);
    if (bounds === undefined) {
      return found;
    }
    found.push(bounds);
  }
}

describe("REPL presentation: what the characters of a reading are", () => {
  beforeAll(() => useTempFileCompiler());

  it("P1-T1: a source row's delimiters, names, values and references are each their own", function* () {
    const model = yield* settledAndFailed();
    const question = yield* askingWith(DETAILS_SCHEMA, SOURCE_EXAMPLE.join("\n"));
    const presenter = yield* usePresenter(WIDE);
    const state = answering(stateWith({}), {});
    const observed = yield* presenter.commit(reading(state, model, asking(question), WIDE));
    const { grid } = presenter;

    // The whole example, preserved exactly: three rows, each holding the line
    // it was given and nothing the screen added to it.
    const rows = messageRows(observed);
    expect(rows.length).toBe(SOURCE_EXAMPLE.length);
    expect(rows.map((bounds) => textOf(grid, bounds).trimEnd())).toEqual([...SOURCE_EXAMPLE]);

    // A heading is the whole line, and it is a heading: its own colour, bold.
    const [heading, elicit, plan] = rows;
    expect(inkOfSpan(grid, heading, "# Create a project README").foreground).toBe(SYNTAX.head);
    expect(inkOfSpan(grid, heading, "# Create a project README").attrs).toContain(REFERENCE_BOLD);

    // And every part of a tag is read as the thing it is, in the cells it was
    // drawn in: one colour for the whole row would satisfy none of these.
    expect(inkOfSpan(grid, elicit, "<").foreground).toBe(SYNTAX.del);
    expect(inkOfSpan(grid, elicit, "Elicit").foreground).toBe(SEMANTIC.active);
    expect(inkOfSpan(grid, elicit, "as").foreground).toBe(SYNTAX.attr);
    expect(inkOfSpan(grid, elicit, "=").foreground).toBe(SYNTAX.punct);
    expect(inkOfSpan(grid, elicit, '"answers"').foreground).toBe(SYNTAX.str);
    expect(inkOfSpan(grid, elicit, "schema", 20).foreground).toBe(SYNTAX.attr);
    expect(inkOfSpan(grid, elicit, "{").foreground).toBe(SYNTAX.brace);
    expect(inkOfSpan(grid, elicit, "}").foreground).toBe(SYNTAX.brace);
    expect(inkOfSpan(grid, elicit, "Enter the project details.").foreground).toBe(SEMANTIC.src);
    expect(inkOfSpan(grid, elicit, "</").foreground).toBe(SYNTAX.del);
    // The reference inside the braces is neither the braces nor the attribute
    // whose value it is: three stretches, three colours, one row.
    const referenced = inkOfSpan(grid, elicit, "schema", 28);
    expect(referenced.foreground).toBe(SYNTAX.ref);
    expect(referenced.foreground).not.toBe(SYNTAX.brace);
    expect(referenced.foreground).not.toBe(SYNTAX.attr);
    expect(inkOfSpan(grid, plan, "answers").foreground).toBe(SYNTAX.ref);
    expect(inkOfSpan(grid, plan, "Plan").foreground).toBe(SEMANTIC.active);
    expect(inkOfSpan(grid, plan, '"draft"').foreground).toBe(SYNTAX.str);
  });

  it("P1-T1: a binding's JSON is read as JSON, escapes and all", function* () {
    const model = yield* boundExample();
    const binding = model.entries[0]?.bindings.find((one) => one.name === "tokens");
    if (binding === undefined) {
      throw new Error(
        `this entry bound ${(model.entries[0]?.bindings ?? [])
          .map((one) => one.name)
          .join(", ")} rather than tokens`,
      );
    }
    const presenter = yield* usePresenter(WIDE);
    const state = openingDrawer(selecting(stateWith({}), "entry-1"), {
      kind: "binding",
      name: "tokens",
    });
    const observed = yield* presenter.commit(reading(state, model, NOTHING_LIVE, WIDE));
    const { grid } = presenter;

    // The complete parsed value, line for line, exactly as it serializes.
    const serialized = (JSON.stringify(binding.value, undefined, 2) ?? "null").split("\n");
    const rows = serialized.map((_, offset) => placed(observed, `drawer:value:${offset}`));
    expect(rows.map((bounds) => textOf(grid, bounds).trimEnd())).toEqual(serialized);

    const of = (needle: string): ReplBounds => {
      const at = serialized.findIndex((line) => line.includes(needle));
      if (at < 0) {
        throw new Error(`this value serializes without ${needle}`);
      }
      return rows[at];
    };
    // A key is a key, a string is a string, and a brace is not either of them.
    expect(inkOfSpan(grid, of('"name"'), '"name"').foreground).toBe(SYNTAX.attr);
    expect(inkOfSpan(grid, of('"name"'), '"Northstar"').foreground).toBe(SYNTAX.jstr);
    expect(inkOfSpan(grid, of('"name"'), ":").foreground).toBe(SYNTAX.punct);
    expect(inkOfSpan(grid, of('"count"'), "3").foreground).toBe(SYNTAX.num);
    expect(inkOfSpan(grid, of('"approved"'), "true").foreground).toBe(SYNTAX.brace);
    expect(inkOfSpan(grid, of('"empty"'), "null").foreground).toBe(SEMANTIC.label);
    expect(inkOfSpan(grid, rows[0], "{").foreground).toBe(SYNTAX.punct);
    // An escaped quote and an escaped backslash are characters of the string
    // they are in, so the whole quoted run is one colour and nothing is lost.
    const quoted = of('"quote"');
    expect(inkOfSpan(grid, quoted, '"say \\"hi\\" \\\\ once"').foreground).toBe(SYNTAX.jstr);
  });

  it("P1-T1: an unfinished draft keeps every character it has", function* () {
    const model = yield* settledAndFailed();
    const presenter = yield* usePresenter(WIDE);
    const unfinished = '<Elicit as="ans';
    const observed = yield* presenter.commit(
      reading(stateWith({ draft: unfinished }), model, NOTHING_LIVE, WIDE),
    );
    const { grid } = presenter;

    const draft = placed(observed, "footer:input");
    // Every character, in order, with the row's own name in front of it: a
    // classifier that dropped the half-written attribute would be editing input.
    expect(textOf(grid, draft).trimEnd()).toBe(` > Draft: ${unfinished}`);
    expect(inkOfSpan(grid, draft, "<").foreground).toBe(SYNTAX.del);
    expect(inkOfSpan(grid, draft, "Elicit").foreground).toBe(SEMANTIC.active);
    expect(inkOfSpan(grid, draft, "as").foreground).toBe(SYNTAX.attr);
    expect(inkOfSpan(grid, draft, '"ans').foreground).toBe(SYNTAX.str);
    // And the row still says what it is, in its own colour rather than a token's.
    expect(inkOfSpan(grid, draft, "Draft:").foreground).toBe(SEMANTIC.src);
  });
});

describe("REPL presentation: focus marks the row without repainting it", () => {
  beforeAll(() => useTempFileCompiler());

  it("P1-T2: a focused draft keeps its token colours while the marker is the cyan", function* () {
    const model = yield* settledAndFailed();
    const presenter = yield* usePresenter(WIDE);
    const typed = '<Plan as="draft">{answers}</Plan>';
    const state = selecting(stateWith({ draft: typed }), "entry-1");

    yield* presenter.commit(reading(state, model, NOTHING_LIVE, WIDE));
    yield* focusOn(presenter, "footer:input");
    const observed = yield* presenter.commit(
      reading(state, model, NOTHING_LIVE, WIDE, focusKeyOf(presenter)),
    );
    const { grid } = presenter;

    const draft = placed(observed, "footer:input");
    // The marker is the one cyan thing on the row, and it is a column wide.
    expect(textOf(grid, draft).trimEnd()).toBe(`>> Draft: ${typed}`);
    expect(grid.styleAt(draft.x, draft.y).foreground).toBe(SEMANTIC.active);
    expect(grid.styleAt(draft.x, draft.y).attrs).toContain(REFERENCE_BOLD);
    // Everything after it keeps the colour it had, and gains the weight focus
    // adds: a focus that repainted the row would make all of these cyan.
    expect(grid.styleAt(draft.x + 1, draft.y).foreground).toBe(SEMANTIC.src);
    expect(inkOfSpan(grid, draft, "Plan").foreground).toBe(SEMANTIC.active);
    expect(inkOfSpan(grid, draft, '"draft"').foreground).toBe(SYNTAX.str);
    expect(inkOfSpan(grid, draft, '"draft"').attrs).toContain(REFERENCE_BOLD);
    expect(inkOfSpan(grid, draft, "answers").foreground).toBe(SYNTAX.ref);
    expect(inkOfSpan(grid, draft, "</").foreground).toBe(SYNTAX.del);

    // And the entry a reader chose is still the chosen one, whole width, with
    // the cue that survives colour being thrown away.
    const selected = placed(observed, "entry:entry-1");
    for (let x = selected.x; x < selected.x + selected.width; x += 1) {
      expect(grid.styleAt(x, selected.y).background).toBe(RETAINED.selectedSurface);
    }
    expect(textOf(grid, selected)).toContain("*");
    expect(inkOf(grid, selected).foreground).toBe(SEMANTIC.tick);
    expect(focusedRows(observed, grid)).toEqual(["footer:input"]);
  });
});

/**
 * A real session, held at a question it is actually waiting on.
 *
 * Everything else in this file hands the frame an observation it composed.
 * This one does not: the entry is submitted into a live session, the `<Elicit>`
 * inside it suspends for real, and the phase the badge is drawn from is the
 * one this process's own observer recorded while that invocation waited.
 */
const HELD_SOURCE = [
  "```js eval",
  `const decide = ${JSON.stringify({
    type: "object",
    properties: { decision: { type: "string", enum: ["Approve", "Stop"] } },
    required: ["decision"],
    additionalProperties: false,
  })};`,
  "```",
  "",
  '<Elicit schema={decide} as="answer">Hold here?</Elicit>',
  "",
].join("\n");

/** Wait until this session is asking something. */
function* held(session: ReplSession): Operation<void> {
  for (let turn = 0; turn < 500; turn += 1) {
    if (session.overlay.question !== undefined) {
      return;
    }
    yield* sleep(0);
  }
  // The entry's own outcome, because the usual reason a question never
  // arrives is that the entry failed before asking it.
  throw new Error(
    "this session never reached a question it had to wait at: " +
      (session.model.entries[0]?.terminal?.message ?? "it is still running"),
  );
}

describe("REPL presentation: a frame of a real held invocation", () => {
  beforeAll(() => useTempFileCompiler());

  it("P1-T4: the waiting invocation says so on its own row, in the archive's literal", () =>
    scoped(function* () {
      const opened = yield* submitReplEntry({
        execution: { id: "held", stream: new InMemoryStream([]) },
        installations: [{ evaluation: ordinaryEvaluationProfile() }],
        source: HELD_SOURCE,
      });
      if (!opened.ok) {
        throw opened.error;
      }
      const session = opened.value;
      yield* held(session);

      const entry = session.model.entries[0];
      if (entry === undefined) {
        throw new Error("a held session admitted no entry");
      }
      // The overlay the program reads, with this process's actual lifecycle
      // in it. Nothing here names a phase: what the badge says comes from the
      // invocation that is waiting as this frame is composed.
      const live: ReplLive = {
        output: session.overlay.output,
        question: session.overlay.question,
        expansion: session.expansion.state,
        pausable: session.controller !== undefined,
        running: session.live,
        agent: session.agent,
        lifecycle: session.lifecycle,
      };
      const resolved = viewFor(
        selecting(stateWith({}), entry.key),
        session.model,
        live,
        WIDE,
        undefined,
        session.navigation,
      );
      if (!resolved.ok) {
        throw resolved.error;
      }
      const presenter = yield* usePresenter(WIDE);
      const observed = yield* presenter.commit(resolved.value);
      const { grid } = presenter;

      const badge = `${LIFECYCLE.hold.glyph} ${LIFECYCLE.hold.word}`;
      const rows = observed.keys
        .filter((key) => key.startsWith("reading:"))
        .map((key) => ({ key, bounds: observed.boundsOf(key) }));
      const carrying = rows.find(
        (one) => one.bounds !== undefined && textOf(grid, one.bounds).includes(badge),
      );
      if (carrying?.bounds === undefined) {
        throw new Error(
          `no reading row says ${badge}; they say ${rows
            .map((one) => (one.bounds === undefined ? "" : textOf(grid, one.bounds).trim()))
            .join(" | ")}`,
        );
      }
      // The row it is on is the invocation that is waiting, not some other
      // element of the same entry.
      expect(textOf(grid, carrying.bounds)).toContain("<Elicit");
      // And it is drawn in the archive's own literal for a held call.
      expect(inkOfSpan(grid, carrying.bounds, badge).foreground).toBe(LIFECYCLE.hold.colour);
      // The source beside it keeps its own colours, so the badge is not
      // repainting the row it sits on.
      expect(inkOfSpan(grid, carrying.bounds, "<").foreground).not.toBe(LIFECYCLE.hold.colour);
    }));
});

describe("REPL presentation: the surfaces a reading is drawn on", () => {
  beforeAll(() => useTempFileCompiler());

  it("P1-T3: an observed badge ends at the pane's right inner edge, in its own ink", function* () {
    // The frozen requirement is that these align at the *measured source
    // pane's right inner edge*. Everything asserting it so far has read the
    // composed run strings, which is the model's answer — the same shape of
    // claim that let a clipped drawer preview pass its own regression. This
    // reads the cells.
    // An entry whose source holds an element the scanner reports — a fence is
    // not one, so observing at its offset would match nothing and prove
    // nothing.
    // Long enough that its opening delimiter wraps: "only the first visual row
    // carries each badge" says nothing about an element that fits on one row,
    // and a check written against one cannot see a badge repeated.
    const source = '<Json value={{ note: "' + "detail ".repeat(26).trim() + '" }} as="n" />\n';
    const model = yield* scoped(function* () {
      const physical = new InMemoryStream();
      yield* runEntry(physical, source);
      return projected(yield* physical.readAll());
    });
    const entry = model.entries[0];
    const at = entry.source.indexOf("<Json");
    expect(at).toBeGreaterThanOrEqual(0);
    const presenter = yield* usePresenter(WIDE);
    const observed = yield* presenter.commit(
      reading(
        selecting(stateWith({}), entry.key),
        model,
        observing(entry.key, "Json", at, "active", entry.scope.path),
        WIDE,
      ),
    );
    const { grid } = presenter;

    // The pane the reading is in, and its inside.
    const inside = observed.regionOf("box:transcript:content");
    if (inside === undefined) {
      throw new Error("this frame published no transcript interior");
    }
    // Whichever row carries the badge. Found by what it says, because which
    // row that is depends on where the window happens to be.
    const badge = `${LIFECYCLE.active.glyph} ${LIFECYCLE.active.word}`;
    const carrying = observed.keys
      .filter((key) => key.startsWith("reading:"))
      .map((key) => ({ key, bounds: observed.boundsOf(key) }))
      .find((one) => one.bounds !== undefined && textOf(grid, one.bounds).includes(badge));
    if (carrying?.bounds === undefined) {
      throw new Error(
        `no reading row says ${badge}; they say ${observed.keys
          .filter((key) => key.startsWith("reading:"))
          .map((key) => textOf(grid, observed.boundsOf(key) ?? inside).trim())
          .join(" | ")}`,
      );
    }
    const row = textOf(grid, carrying.bounds);
    const starts = row.indexOf(badge);
    // Its last cell is the pane interior's last cell: right inner edge, in
    // cells, not in a string this test composed for itself.
    expect([carrying.key, carrying.bounds.x + starts + badge.length]).toEqual([
      carrying.key,
      inside.x + inside.width,
    ]);
    // And it is drawn in the archive's own literal for that phase.
    expect(inkOfSpan(grid, carrying.bounds, badge).foreground).toBe(LIFECYCLE.active.colour);
    // The source beside it keeps its own colours, so the badge is not
    // repainting the row it sits on.
    expect(inkOfSpan(grid, carrying.bounds, "<").foreground).not.toBe(LIFECYCLE.active.colour);

    // Exactly one row says it. "Only the first visual row carries each badge"
    // is frozen, and a second one would say the phase changed between two
    // halves of one element — counted in cells, because that is where a
    // reader would see it twice.
    const saying = observed.keys
      .filter((key) => key.startsWith("reading:"))
      .map((key) => observed.boundsOf(key))
      .filter((bounds) => bounds !== undefined && textOf(grid, bounds).includes(badge));
    expect(saying.length).toBe(1);

    // And every row of the reading opens with its rail, in cells. The rail is
    // what says which region a row is in, so a reading drawn without one is a
    // reading with its structure removed — and until now nothing asked the
    // screen whether it was there.
    const railed = observed.keys
      .filter((key) => key.startsWith("reading:src:") || key.startsWith("reading:output:"))
      .map((key) => ({ key, bounds: observed.boundsOf(key) }))
      .filter((one) => one.bounds !== undefined);
    expect(railed.length).toBeGreaterThan(0);
    for (const one of railed) {
      const bounds = one.bounds;
      if (bounds === undefined) {
        continue;
      }
      expect([one.key, grid.at(bounds.x, bounds.y)]).toEqual([one.key, "\u2502"]);
      // In the rail's own ink, which for an observed region is not the
      // unobserved one: a rail painted the same everywhere says nothing.
      expect([one.key, grid.styleAt(bounds.x, bounds.y).foreground]).not.toEqual([
        one.key,
        REPL_PALETTE.source,
      ]);
    }
    // The observed region really is drawn in the archive's active rail, so
    // this is not satisfied by painting every row alike.
    const activeRail = railed.filter(
      (one) =>
        one.bounds !== undefined &&
        grid.styleAt(one.bounds.x, one.bounds.y).foreground === RAIL.active,
    );
    expect(activeRail.length).toBeGreaterThan(0);
  });

  it("P1-T3: an empty screen's panes, edges and uncovered area are each their own", function* () {
    const model = yield* settledAndFailed();
    const presenter = yield* usePresenter(WIDE);
    const observed = yield* presenter.commit(reading(stateWith({}), model, NOTHING_LIVE, WIDE));
    const { grid } = presenter;

    // Each pane's own surface, across the pane the engine admitted — and the
    // first column of a pane that begins with an edge is that edge.
    const surfaces: readonly { readonly region: string; readonly surface: number }[] = [
      { region: "sidebar", surface: SURFACE.side },
      { region: "transcript", surface: SURFACE.center },
      { region: "inspection", surface: SURFACE.bind },
    ];
    for (const { region, surface } of surfaces) {
      const bounds = regionBounds(observed, region);
      if (bounds === undefined) {
        throw new Error(`this frame published no ${region} region`);
      }
      expect([region, grid.styleAt(bounds.x + bounds.width - 1, bounds.y).background]).toEqual([
        region,
        surface,
      ]);
      // The bottom of the pane's own moving content, not the bottom of the
      // pane. Re-anchored for #881 PR 2: the transcript's last row is now the
      // reading's `[\u2193 later]` control, and a control carries the draft's
      // surface wherever it is — which is this terminal's existing rule, not a
      // new one. The claim is unchanged: the area a pane holds that no control
      // covers is that pane's own surface.
      const floor =
        viewportBounds(observed, region === "transcript" ? READING_WINDOW : region) ?? bounds;
      expect([
        region,
        grid.styleAt(bounds.x + bounds.width - 1, floor.y + floor.height - 1).background,
      ]).toEqual([region, surface]);
    }

    // The rule that parts two columns is the separator's own colour, drawn in
    // the first column of the pane that begins at it.
    const transcript = regionBounds(observed, "transcript");
    const footer = regionBounds(observed, "footer");
    if (transcript === undefined || footer === undefined) {
      throw new Error("this frame published no transcript or footer region");
    }
    expect(grid.styleAt(transcript.x, transcript.y).foreground).toBe(SURFACE.edge);
    // And the rule that parts the body from the footer, on the row above it.
    expect(grid.styleAt(transcript.x, footer.y - 1).foreground).toBe(SURFACE.edge);

    // What no row of its own covers is still this application's: the end of the
    // action row, where no control was placed.
    const actions = observed.regionOf(ACTION_ROW);
    if (actions === undefined) {
      throw new Error("this frame published no action row");
    }
    expect(grid.at(actions.x + actions.width - 1, actions.y)).toBe(" ");
    expect(grid.styleAt(actions.x + actions.width - 1, actions.y).background).toBe(SURFACE.app);

    // Both shared columns still say what they are while they hold nothing.
    expect(textOf(grid, placed(observed, "sessions:heading"))).toContain("Sessions");
    expect(inkOf(grid, placed(observed, "inspection:heading")).foreground).toBe(SEMANTIC.intro);
  });

  it("P1-T3: a question drawer is bounded, named as waiting, and read in groups", function* () {
    const model = yield* settledAndFailed();
    const question = yield* askingWith(DETAILS_SCHEMA, SOURCE_EXAMPLE.join("\n"));
    const presenter = yield* usePresenter(WIDE);
    const filled = answering(
      stateWith({}),
      {
        project: "Northstar",
        description: "A lightweight workspace for coordinating coding agents.",
      },
      [{ field: "project", message: "project is required" }],
    );
    const observed = yield* presenter.commit(reading(filled, model, asking(question), WIDE));
    const { grid } = presenter;

    const rect = regionBounds(observed, "drawer");
    if (rect === undefined) {
      throw new Error("this frame published no drawer region");
    }
    // One cell of rule along the top of the rectangle, inside it, across it.
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const style = grid.styleAt(x, rect.y);
      expect([x, style.foreground, style.background]).toEqual([x, SEMANTIC.hold, SURFACE.drawer]);
    }

    // The title is inside the rectangle, below the rule, inset from its side —
    // so it cannot be read as one more line of what the drawer is covering.
    const title = placed(observed, "drawer:open");
    expect(title.y).toBe(rect.y + 1);
    expect(title.x).toBe(rect.x + 1);
    expect(title.x + title.width).toBe(rect.x + rect.width - 1);
    expect(textOf(grid, title).trimEnd()).toBe("Project details");
    // A question nobody has answered yet says so before a word of it is read.
    expect(inkOfSpan(grid, title, "Project details").foreground).toBe(SEMANTIC.hold);
    expect(inkOfSpan(grid, title, "Project details").attrs).toContain(REFERENCE_BOLD);

    // A field's name, what it means and what is in it are three readings.
    const named = placed(observed, "drawer:field:project");
    expect(inkOfSpan(grid, named, "*Project name:").foreground).toBe(SEMANTIC.label);
    expect(inkOfSpan(grid, named, "Northstar").foreground).toBe(SEMANTIC.out);
    const hint = placed(observed, "drawer:field:project:about");
    expect(inkOfSpan(grid, hint, "Name your project.").foreground).toBe(SEMANTIC.dim);
    const edited = placed(observed, "drawer:value:project");
    expect(inkOfSpan(grid, edited, "Northstar").foreground).toBe(SEMANTIC.out);
    // The row text goes into sits on the surface that says so, whole width.
    for (let x = edited.x; x < edited.x + edited.width; x += 1) {
      expect(grid.styleAt(x, edited.y).background).toBe(SURFACE.field);
    }
    // The second field's group reads the same way, with its own words.
    const second = placed(observed, "drawer:field:description");
    expect(inkOfSpan(grid, second, "*One-sentence description:").foreground).toBe(SEMANTIC.label);
    expect(
      inkOfSpan(grid, second, "A lightweight workspace for coordinating coding agents.").foreground,
    ).toBe(SEMANTIC.out);
    expect(
      inkOfSpan(grid, placed(observed, "drawer:field:description:about"), "Describe its purpose.")
        .foreground,
    ).toBe(SEMANTIC.dim);

    // What the last submission was told, in the accent a refusal has.
    const invalid = placed(observed, "drawer:invalid:0");
    expect(textOf(grid, invalid)).toContain("project is required");
    expect(inkOfSpan(grid, invalid, "project is required").foreground).toBe(SEMANTIC.exit);
    // And the way to answer is still there, on a control's own surface.
    const submit = placed(observed, "drawer:form:submit");
    expect(textOf(grid, submit)).toContain("[submit]");
    expect(grid.styleAt(submit.x, submit.y).background).toBe(SURFACE.input);

    // Every cell of the rectangle is the drawer's, the unused ones included.
    const own: readonly number[] = [
      SURFACE.drawer,
      RETAINED.selectedSurface,
      SURFACE.field,
      SURFACE.input,
    ];
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        const background = grid.styleAt(x, y).background;
        if (background === undefined || !own.includes(background)) {
          throw new Error(
            `the cell at ${x},${y} is inside the drawer and shows ${String(background)}`,
          );
        }
      }
    }
  });

  it("P1-T3: a shorter reading and a closed drawer leave nothing behind", function* () {
    const model = yield* settledAndFailed();
    const question = yield* askingWith(DETAILS_SCHEMA, SOURCE_EXAMPLE.join("\n"));
    const live = asking(question);
    const long = answering(stateWith({}), {
      project: "Northstar",
      description: "A lightweight workspace for coordinating coding agents.",
    });
    const short = answering(stateWith({}), { project: "N", description: "x" });

    const incremental = yield* scoped(function* () {
      const presenter = yield* usePresenter(WIDE);
      yield* presenter.commit(reading(long, model, live, WIDE));
      const after = yield* presenter.commit(reading(short, model, live, WIDE));
      // The cells the longer value reached and the shorter one does not: still
      // the row's own surface, with nothing of the longer value left in them.
      const edited = placed(after, "drawer:value:description");
      // Its unfocused marker, its name and the one character left in it.
      expect(textOf(presenter.grid, edited).trimEnd()).toBe("   = x");
      for (let x = edited.x; x < edited.x + edited.width; x += 1) {
        expect(presenter.grid.styleAt(x, edited.y).background).toBe(SURFACE.field);
      }
      const closed = yield* presenter.commit(reading(stateWith({}), model, live, WIDE));
      return {
        cells: presenter.grid.styledIn({ x: 0, y: 0, width: WIDE.columns, height: WIDE.rows }),
        keys: closed.keys.slice().sort(),
      };
    });

    const fresh = yield* scoped(function* () {
      const presenter = yield* usePresenter(WIDE);
      const first = yield* presenter.commit(reading(stateWith({}), model, live, WIDE));
      return {
        cells: presenter.grid.styledIn({ x: 0, y: 0, width: WIDE.columns, height: WIDE.rows }),
        keys: first.keys.slice().sort(),
      };
    });

    // Every cell, its characters, its foreground, its background and its blanks:
    // a drawer that left its rule, its inset or a vacated value behind would
    // differ from a screen that never drew one.
    expect(incremental.cells).toEqual(fresh.cells);
    expect(incremental.keys).toEqual(fresh.keys);
    expect(incremental.keys.some((key) => key.startsWith("drawer:"))).toBe(false);
  });
});

describe("REPL presentation: decoration the frame measured", () => {
  beforeAll(() => useTempFileCompiler());

  it("P1-T4: the drawer's rule and inset are measured, and every row lands inside them", function* () {
    const model = yield* boundExample();
    for (const size of [WIDE, MEDIUM, NARROW]) {
      yield* scoped(function* () {
        const presenter = yield* usePresenter(size);
        const state = openingDrawer(selecting(stateWith({}), "entry-1"), {
          kind: "binding",
          name: "tokens",
        });
        const view = reading(state, model, NOTHING_LIVE, size);
        const admission = yield* presenter.prepare(view);
        const observed = yield* presenter.commit(view);
        const { grid } = presenter;

        const rect = regionBounds(observed, "drawer");
        const viewport = viewportBounds(observed, DRAWER_WINDOW);
        const footer = regionBounds(observed, "footer");
        if (rect === undefined || viewport === undefined || footer === undefined) {
          throw new Error(`${size.columns}x${size.rows} published no drawer or footer`);
        }
        // The rule is the rectangle's own first row, and the content begins
        // below it and one column in from each side.
        expect([size.columns, grid.styleAt(rect.x, rect.y).foreground]).toEqual([
          size.columns,
          SEMANTIC.hold,
        ]);
        expect([size.columns, viewport.y > rect.y]).toEqual([size.columns, true]);
        expect([size.columns, viewport.x]).toEqual([size.columns, rect.x + 1]);
        expect([size.columns, viewport.x + viewport.width]).toEqual([
          size.columns,
          rect.x + rect.width - 1,
        ]);

        // Capacity is the viewport the engine measured with the decoration
        // already in it, so what the window admits was never the undecorated
        // rectangle: padding worked out afterwards would admit a row too many.
        const admitted = admission.windows.get(DRAWER_WINDOW);
        if (admitted === undefined) {
          throw new Error(`${size.columns}x${size.rows} measured no drawer window`);
        }
        expect([size.columns, admitted.capacity]).toEqual([size.columns, viewport.height]);
        expect([size.columns, admitted.count <= admitted.capacity]).toEqual([size.columns, true]);

        // Every row the drawer placed is whole, inside the inset content area,
        // and below the rule — the window controls and the way out included.
        const inside: ReplBounds = {
          x: rect.x + 1,
          y: rect.y + 1,
          width: rect.width - 2,
          height: rect.height - 1,
        };
        const drawn = observed.keys.filter((key) => key.startsWith("drawer:"));
        expect([size.columns, drawn.length > 0]).toEqual([size.columns, true]);
        for (const key of drawn) {
          const bounds = observed.boundsOf(key);
          if (bounds === undefined) {
            continue;
          }
          expect([key, size.columns, within(bounds, inside)]).toEqual([key, size.columns, true]);
        }
        // And the footer is still the seven rows it always is.
        expect([size.columns, footer.height]).toEqual([size.columns, FOOTER_ROWS]);
      });
    }
  });

  it("P1-T4: a reading longer than the decorated window is in no cell and no target", function* () {
    const model = yield* boundExample();
    const presenter = yield* usePresenter(NARROW);
    const state = openingDrawer(selecting(stateWith({}), "entry-1"), {
      kind: "binding",
      name: "tokens",
    });
    const view = reading(state, model, NOTHING_LIVE, NARROW);
    const admission = yield* presenter.prepare(view);
    const observed = yield* presenter.commit(view);

    const admitted = admission.windows.get(DRAWER_WINDOW);
    if (admitted === undefined) {
      throw new Error("this frame measured no drawer window");
    }
    // The narrowest supported frame cannot hold this value whole, which is what
    // makes the window the thing under test rather than a formality.
    expect(admitted.total).toBeGreaterThan(admitted.capacity);
    expect(admitted.more).toBe(true);

    // Exactly the admitted rows mounted; the ones past the window are in no
    // cell, so they are in no pointer target and no Tab stop either.
    const shown = observed.keys.filter((key) => key.startsWith("drawer:value:"));
    expect(shown.length).toBe(admitted.count);
    expect(observed.boundsOf(`drawer:value:${admitted.total - 1}`)).toBe(undefined);
    for (const key of shown) {
      expect([key, observed.nodeOf(key) !== undefined]).toEqual([key, true]);
    }
    // And the way out of the drawer is still reachable at this size.
    expect(observed.keys).toContain("drawer:close");
  });
});

describe("REPL presentation: a row the frame cannot hold whole", () => {
  beforeAll(() => useTempFileCompiler());

  /** One tag far wider than any drawer at any supported size. */
  const OVERFLOWING =
    '<Elicit as="answers" schema={schema}>' +
    "Enter the project details, at length, so that this one line is wider ".repeat(4) +
    "</Elicit>";

  it("P1-T1: an overflowing source row keeps its roles and every character it shows", function* () {
    const model = yield* settledAndFailed();
    const question = yield* askingWith(DETAILS_SCHEMA, OVERFLOWING);
    const presenter = yield* usePresenter(WIDE);
    const observed = yield* presenter.commit(
      reading(answering(stateWith({}), {}), model, asking(question), WIDE),
    );
    const { grid } = presenter;

    const row = placed(observed, "drawer:message:0");
    const written = textOf(grid, row).replace(/\s+$/, "");
    // Whatever the row shows is a prefix of the line it was given, with no gap
    // where a stretch wrapped away: every written cell is the next character of
    // the source, in order.
    expect(written.length).toBeGreaterThan(40);
    expect(OVERFLOWING.startsWith(written)).toBe(true);
    expect(written).not.toContain("  ");

    // And every visible character still reads as the thing it is. A row drawn
    // as one stretch to dodge the engine's per-operation wrapping would make
    // all of these the same colour, which is the defect this rejects.
    expect(inkOfSpan(grid, row, "<").foreground).toBe(SYNTAX.del);
    expect(inkOfSpan(grid, row, "Elicit").foreground).toBe(SYNTAX.tag);
    expect(inkOfSpan(grid, row, "as").foreground).toBe(SYNTAX.attr);
    expect(inkOfSpan(grid, row, "=").foreground).toBe(SYNTAX.punct);
    expect(inkOfSpan(grid, row, '"answers"').foreground).toBe(SYNTAX.str);
    expect(inkOfSpan(grid, row, "{").foreground).toBe(SYNTAX.brace);
    expect(inkOfSpan(grid, row, "schema", 28).foreground).toBe(SYNTAX.ref);
    expect(inkOfSpan(grid, row, "Enter the project").foreground).toBe(SYNTAX.prose);
    // Nothing on the row is drawn in one colour throughout.
    const inks = new Set<number | undefined>();
    for (let x = row.x; x < row.x + row.width; x += 1) {
      if (grid.at(x, row.y) !== " ") {
        inks.add(grid.styleAt(x, row.y).foreground);
      }
    }
    expect(inks.size).toBeGreaterThan(3);
  });

  it("P1-T2: an overflowing focused row keeps its cue and its roles", function* () {
    const model = yield* settledAndFailed();
    const presenter = yield* usePresenter(NARROW);
    // A draft wider than the narrowest supported frame, with focus on it.
    const typed = `<Plan as="draft">{answers}</Plan> ${"and more source ".repeat(6)}`;
    const state = stateWith({ draft: typed });

    yield* presenter.commit(reading(state, model, NOTHING_LIVE, NARROW));
    yield* focusOn(presenter, "footer:input");
    const observed = yield* presenter.commit(
      reading(state, model, NOTHING_LIVE, NARROW, focusKeyOf(presenter)),
    );
    const { grid } = presenter;

    const draft = placed(observed, "footer:input");
    expect(textOf(grid, draft).startsWith(">> Draft: <Plan")).toBe(true);
    // The cue is still the one cyan thing, and the row is still read.
    expect(grid.styleAt(draft.x, draft.y).foreground).toBe(SEMANTIC.active);
    expect(grid.styleAt(draft.x, draft.y).attrs).toContain(REFERENCE_BOLD);
    expect(inkOfSpan(grid, draft, "Plan").foreground).toBe(SYNTAX.tag);
    expect(inkOfSpan(grid, draft, '"draft"').foreground).toBe(SYNTAX.str);
    expect(inkOfSpan(grid, draft, "answers").foreground).toBe(SYNTAX.ref);
  });

  it("P1-T3: a populated field keeps its name and its value apart at 72x20", function* () {
    const model = yield* settledAndFailed();
    const question = yield* askingWith(DETAILS_SCHEMA, SOURCE_EXAMPLE.join("\n"));
    const presenter = yield* usePresenter(NARROW);
    // The frozen values. At this size the second field's row is wider than the
    // drawer, which is exactly where a single-colour fallback painted the
    // visible value as though it were the field's name.
    let filled = answering(stateWith({}), {
      project: "Northstar",
      description: "A lightweight workspace for coordinating coding agents.",
    });
    const live = asking(question);
    let observed = yield* presenter.commit(reading(filled, model, live, NARROW));
    // The second field is one window further on at this size. Reached through
    // the drawer's own window action, against the admission each frame
    // measured, so the row asserted below is one a reader would be looking at.
    for (let press = 0; press < 40; press += 1) {
      if (observed.boundsOf("drawer:field:description") !== undefined) {
        break;
      }
      const view = reading(filled, model, live, NARROW);
      filled = reduceRepl(
        filled,
        { kind: "scroll", delta: 1 },
        model,
        live,
        yield* presenter.prepare(view),
      ).state;
      observed = yield* presenter.commit(reading(filled, model, live, NARROW));
    }
    const { grid } = presenter;

    const named = placed(observed, "drawer:field:description");
    expect(textOf(grid, named)).toContain("*One-sentence description:");
    expect(textOf(grid, named)).toContain("A lightweight");
    expect(inkOfSpan(grid, named, "*One-sentence description:").foreground).toBe(SEMANTIC.label);
    expect(inkOfSpan(grid, named, "A lightweight").foreground).toBe(SEMANTIC.out);
    expect(inkOfSpan(grid, named, "A lightweight").foreground).not.toBe(SEMANTIC.label);
  });

  it("P1-T1: a row the drawer does hold is read the same way", function* () {
    const model = yield* settledAndFailed();
    const short = yield* askingWith(DETAILS_SCHEMA, SOURCE_EXAMPLE.join("\n"));
    const presenter = yield* usePresenter(WIDE);
    const fitted = yield* presenter.commit(
      reading(answering(stateWith({}), {}), model, asking(short), WIDE),
    );
    expect(inkOfSpan(presenter.grid, placed(fitted, "drawer:message:1"), "Elicit").foreground).toBe(
      SYNTAX.tag,
    );
  });
});
