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
import { collect, inlineSource, useTempFileCompiler } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream, Json } from "@executablemd/durable-streams";
import { scoped } from "effection";
import type { Operation } from "effection";

import { entryInitialBindings, projectRepl } from "../src/repl/model.ts";
import type { ReplModel } from "../src/repl/model.ts";
import { EntrySegmentStream } from "../src/repl/entries.ts";
import { initialState, NO_AGENT, viewFor } from "../src/repl/application.ts";
import { encodeLocation } from "../src/repl/route.ts";
import type { ReplAction, ReplLive, ReplState, ReplView } from "../src/repl/application.ts";
import type { ReplDispatched } from "../src/repl/reconcile.ts";
import type { ReplDrawerRef } from "../src/repl/route.ts";
import { FOOTER_ROWS, HISTORY_LABEL, HISTORY_ROWS, NARROW } from "../src/repl/layout.ts";
import type { ReplBounds } from "../src/repl/layout.ts";
import { BOLD, REPL_PALETTE } from "../src/repl/presentation-style.ts";
import type { ReplTerminalSize } from "../src/repl/terminal.ts";
import {
  createGrid,
  regionBounds,
  usePresenter,
  viewportBounds,
} from "./fixtures/repl/presentation.ts";
import { referenceEvents } from "./fixtures/repl/reference.ts";
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
});

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
  const resolved = viewFor(state, model, live, size, focused);
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

/** Whether one rectangle is inside another, so a row can be held to its pane. */
function within(inner: ReplBounds, outer: ReplBounds): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/** The first transcript row of one kind, as the key the frame drew it under. */
function transcriptKey(model: ReplModel, kind: string): string {
  const at = model.transcript.findIndex((row) => row.kind === kind);
  if (at < 0) {
    throw new Error(
      `this prefix holds no ${kind} row; it holds ${model.transcript
        .map((row) => row.kind)
        .join(", ")}`,
    );
  }
  return `line:${at}:0`;
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
    const observed = yield* presenter.commit(reading(stateWith({}), model));
    const { grid } = presenter;

    const transcript = regionBounds(observed, "transcript");
    if (transcript === undefined) {
      throw new Error("this frame published no transcript region");
    }

    // What the run produced, and a fact about the event that produced it. The
    // same eval block wrote both, so they are adjacent lines in one column and
    // nothing but the style tells a reader which is which.
    const output = placed(observed, transcriptKey(model, "output"));
    const metadata = placed(observed, transcriptKey(model, "binding"));
    expect(inkOf(grid, output).foreground).toBe(REPL_PALETTE.output);
    expect(inkOf(grid, metadata).foreground).toBe(REPL_PALETTE.muted);
    expect(inkOf(grid, output).foreground).not.toBe(inkOf(grid, metadata).foreground);
    expect(within(output, transcript)).toBe(true);
    expect(within(metadata, transcript)).toBe(true);

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
      inkOf(grid, output).foreground,
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
    const first = placed(observed, `line:${at}:0`);
    expect(textOf(grid, first)).toContain(record.output.split("\n")[0]);
    expect(inkOf(grid, first).foreground).toBe(REPL_PALETTE.output);
    expect(inkOf(grid, first).foreground).not.toBe(REPL_PALETTE.success);

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
    const closed = placed(observed, `line:${at}:0`);
    expect(textOf(grid, closed)).toContain("closed err");
    expect(inkOf(grid, closed).foreground).toBe(REPL_PALETTE.failure);
    const reason = placed(observed, `line:${at}:1`);
    expect(textOf(grid, reason)).toContain("failed:");
    expect(inkOf(grid, reason).foreground).toBe(REPL_PALETTE.failure);
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
    // rather than as one more fact about an event.
    const live = placed(observed, "line:live:0");
    expect(textOf(grid, live)).toContain("building the plan");
    expect(inkOf(grid, live).foreground).toBe(REPL_PALETTE.output);
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
        for (const written of presenter.grid.nonblank(band)) {
          const [at] = written.split("=");
          const [x, y] = at.split(",").map(Number);
          expect(presenter.grid.styleAt(x, y).foreground).toBe(REPL_PALETTE.historical);
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
      expect(textOf(grid, band).startsWith(HISTORY_LABEL)).toBe(true);
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
    // The value it holds reads as a value, not as the words around it — and it
    // sits on the surface an editable value sits on, across the whole row the
    // drawer measured for it, so what holds a value is visible before it is read.
    const value = placed(observed, "drawer:value:0");
    expect(inkOf(grid, value).foreground).toBe(REPL_PALETTE.output);
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
    expect(inkOf(grid, placed(observed, "drawer:answer:0")).foreground).toBe(REPL_PALETTE.output);
    expect(inkOf(grid, placed(observed, "drawer:schema:0")).foreground).toBe(REPL_PALETTE.muted);
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
