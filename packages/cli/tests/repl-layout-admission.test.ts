/**
 * Measured admission (#875 TL2–TL5).
 *
 * The invariant the whole boundary rests on: **the rows and controls a person
 * can see, focus and click are exactly the rows and controls the measured frame
 * admitted.** It is asked of the running command, which is driven by terminal
 * input and read from the frame it presented beside the cells Termless shows,
 * and of the measured pipeline itself, driven over a real journal.
 *
 * Every number asserted here comes from the frame — the geometry it published,
 * the window it measured, the cells it painted. Nothing in this file works out
 * where a row ought to be: a test that computed the answer would agree with
 * itself while the product drew something else, which is the defect the measured
 * pipeline exists to make impossible. The rows over `admitActions` state their
 * measured inputs as literals, because that function decides from what it is
 * told and from nothing else.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { collect, inlineSource, useTempFileCompiler } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { readQuestionForm } from "../src/repl/elicitation.ts";
import { Ok, scoped } from "effection";
import type { Operation } from "effection";

import { skeletonOps } from "../src/repl/layout.ts";
import { projectRepl } from "../src/repl/model.ts";
import type { ReplModel } from "../src/repl/model.ts";
import { EntrySegmentStream } from "../src/repl/entries.ts";
import { navigationOf } from "../src/repl/navigation.ts";
import { NO_LIFECYCLE } from "../src/repl/lifecycle.ts";
import type { ReplActionCandidate, ReplBounds } from "../src/repl/layout.ts";
import { admitActions } from "../src/repl/layout-admission.ts";
import type {
  ReplSidekickReading,
  ReplLive,
  ReplState,
  ReplView,
} from "../src/repl/application.ts";
import type { ReplRenderer } from "../src/repl/renderer.ts";
import { prepareFrame } from "../src/repl/program.ts";
import {
  ACTION_ROW,
  offering,
  DRAWER_WINDOW,
  initialState,
  NO_AGENT,
  READING_WINDOW,
  reduceRepl,
  SESSIONS_WINDOW,
  viewFor,
  withWorkspace,
  workspaceOf,
} from "../src/repl/application.ts";
import type { ReplTerminalSize } from "../src/repl/terminal.ts";
import { usePresenter, viewportBounds, windowOf } from "./fixtures/repl/presentation.ts";
import type { Observed, Presenter } from "./fixtures/repl/presentation.ts";
import { journalModel, projected } from "./fixtures/repl/journals.ts";
import { referenceEvents } from "./fixtures/repl/reference.ts";
import { useReplPage } from "./support/repl-page.ts";
import type { ReplPage } from "./support/repl-page.ts";
import { entrySettles, pasteDraft } from "./support/screen-journeys.ts";

/**
 * The two cells in front of a control's label that its focus marker draws in.
 *
 * Every control is measured with them, because a control measured without its
 * marker comes out two columns narrower than the one drawn in its place.
 */
const CONTROL_ROOM = "  ";

const WIDE: ReplTerminalSize = { columns: 160, rows: 36 };
const MEDIUM: ReplTerminalSize = { columns: 120, rows: 30 };
const NARROW: ReplTerminalSize = { columns: 72, rows: 20 };

/** What a REPL at rest holds: nothing running, nothing asked, no Sidekick. */
const IDLE: ReplLive = Object.freeze({
  output: "",
  question: undefined,
  expansion: "playing" as const,
  pausable: false,
  running: false,
  agent: NO_AGENT,
  lifecycle: NO_LIFECYCLE,
});

/** The reference entry's journal, read the way the application reads one. */
function* referenceModel(): Operation<ReplModel> {
  yield* useTempFileCompiler();
  return projected(yield* referenceEvents());
}

/**
 * A journal of this many settled entries, each of which really ran.
 *
 * A catalog that fits needs no admission decision, so what the count is for is
 * the window: the measurement the rows below read is about the one that does
 * not fit.
 */
function* entriesModel(count: number): Operation<ReplModel> {
  return yield* journalModel(
    Array.from({ length: count }, (_unused, at) => {
      const order = at + 1;
      return `# Entry ${order}\n\nThe ${order} th reading of this history.\n`;
    }),
  );
}

/** The view the application draws for one model, as the program hands it to a frame. */
function viewOf(
  model: ReplModel,
  size: ReplTerminalSize,
  options: { readonly state?: ReplState; readonly focused?: string } = {},
): ReplView {
  const view = viewFor(
    options.state ?? initialState("reference"),
    model,
    IDLE,
    size,
    options.focused,
    navigationOf(model.checkpoints, "live"),
  );
  if (!view.ok) {
    throw view.error;
  }
  return withWorkspace(view.value, workspaceOf(model));
}

/** Whether one rectangle is drawn wholly inside another. */
function within(outer: ReplBounds | undefined, inner: ReplBounds | undefined): boolean {
  if (outer === undefined || inner === undefined) {
    return false;
  }
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/** The key of the control holding focus in this tree, or none. */
function focusedKey(presenter: Presenter): string | undefined {
  const node = presenter.tree.focused();
  return node === undefined ? undefined : presenter.tree.keyOf(node);
}

/**
 * One whole focus cycle from wherever focus is, in the direction this key walks.
 *
 * Traversal arrives as an event, the way it does from a terminal: the tree has
 * no other way in, so what this walks is the ring the product offers.
 */
function* ring(presenter: Presenter, key: "Tab" | "Backtab"): Operation<readonly string[]> {
  const first = focusedKey(presenter) ?? "";
  const walked: string[] = [first];
  for (let press = 0; press < 200; press += 1) {
    yield* presenter.tree.dispatch({ kind: "key", key });
    const at = focusedKey(presenter) ?? "";
    if (at === first) {
      return walked;
    }
    walked.push(at);
  }
  throw new Error(`focus never came back round with ${key}`);
}

/** Walk the ring until this key holds focus, the way a person reaches one. */
function* focusKey(presenter: Presenter, key: string): Operation<void> {
  for (let press = 0; press < 200; press += 1) {
    if (focusedKey(presenter) === key) {
      return;
    }
    yield* presenter.tree.dispatch({ kind: "key", key: "Tab" });
  }
  throw new Error(`focus never reached ${key}`);
}

/** Submit one entry through the Draft and wait for the History rail to mark it settled. */
function* submit(page: ReplPage, order: number, source: string): Operation<void> {
  yield* pasteDraft(page, source);
  yield* page.key("Enter");
  yield* entrySettles(page, order, "ok");
}

const CATALOG_ENTRIES = 10;
const entryKey = (order: number): string => `entry:entry-${order}`;
const entryLabel = (order: number): string => `${order}. [ok] entry-${order}`;

/** One presenter and journal, with the state that has the catalog open. */
interface Catalog {
  readonly presenter: Presenter;
  readonly model: ReplModel;
  /** The state the drawer's own action leaves behind. */
  readonly state: ReplState;
  /** The control the mounted tree answered focus for before it opened. */
  readonly focused: string | undefined;
}

/**
 * The Entries catalog open over ten entries at the narrowest size.
 *
 * The catalog's window holds six rows there, so ten of them overflow it: a
 * window that fits has nothing to decide, and every row below is about the one
 * that does not. It is opened from a frame whose focus the mounted tree
 * answered for, because the drawer is a modal and only what it holds may take
 * focus while it is open.
 */
function* catalogOverEntries(): Operation<Catalog> {
  const model = yield* entriesModel(CATALOG_ENTRIES);
  const presenter = yield* usePresenter(NARROW);
  yield* presenter.commit(viewOf(model, NARROW));
  const focused = focusedKey(presenter);
  const closed = viewOf(model, NARROW, { focused });
  yield* presenter.commit(closed);
  const state = reduceRepl(closed.state, { kind: "open-catalog" }, model, IDLE).state;
  return { presenter, model, state, focused };
}

/** Draw this catalog at this state, and answer what the frame placed. */
function* shownAt(catalog: Catalog, state: ReplState): Operation<Observed> {
  const view = viewOf(catalog.model, catalog.presenter.grid.size, {
    state,
    focused: catalog.focused,
  });
  return yield* catalog.presenter.commit(view);
}

/**
 * Move the catalog's window one row at a time until the frame holds of it.
 *
 * Each step reduces against the admission the frame it is looking at actually
 * drew, which is what the running command's own scroll control gives it: a step
 * taken against anything else would be moving from a window nobody saw.
 */
function* scrolledUntil(
  catalog: Catalog,
  from: ReplState,
  delta: 1 | -1,
  holds: (observed: Observed) => boolean,
): Operation<{ readonly state: ReplState; readonly observed: Observed }> {
  let state = from;
  let observed = yield* shownAt(catalog, state);
  for (let press = 0; press < 40 && !holds(observed); press += 1) {
    state = reduceRepl(
      state,
      { kind: "scroll-entries", delta },
      catalog.model,
      IDLE,
      observed.committed.admission,
    ).state;
    observed = yield* shownAt(catalog, state);
  }
  if (!holds(observed)) {
    throw new Error(`the catalog's window never reached what was asked of it, moving ${delta}`);
  }
  return { state, observed };
}

/** A reading long enough that no region holds it: forty paragraphs, one row each. */
const LONG_READING = Array.from({ length: 40 }, (_unused, at) => `VACATED-${at}`).join("\n\n");

/** The measured extent of one control on a one-row action row. */
const extentAt = (x: number, width: number): ReplBounds => ({
  x,
  y: 0,
  width,
  height: 1,
});

/** Controls offered to an action row, each measured under the id `box:` and its key. */
const offered = (...keys: string[]): readonly ReplActionCandidate[] =>
  keys.map((key) => ({ key, id: `box:${key}`, control: true }));

/** The row's answer to "where did this control land", from literal extents. */
const boundsIn =
  (extents: Readonly<Record<string, ReplBounds>>) =>
  (id: string): ReplBounds | undefined =>
    extents[id.replace(/^box:/, "")];

/** The keys of the controls one frame published a pointer target for. */
function targetKeys(presenter: Presenter, observed: Observed): readonly string[] {
  return observed.targets.flatMap((one) => {
    const key = presenter.tree.keyOf(one.node);
    return key === undefined ? [] : [key];
  });
}

/** The rows the reading's viewport holds on the screen this frame left. */
function readingRows(presenter: Presenter, observed: Observed): readonly string[] {
  const viewport = viewportBounds(observed, READING_WINDOW);
  if (viewport === undefined) {
    throw new Error("this frame placed no reading viewport");
  }
  return presenter.grid.textIn(viewport);
}

describe("REPL layout: what an empty measurement describes", () => {
  it("TL2: a measured viewport holds no node, no cell and no target", function* () {
    const model = yield* referenceModel();
    const presenter = yield* usePresenter(WIDE);
    // The measuring pass describes every scrolling viewport empty. It is the
    // same walk the commit uses, so if it mounted anything the commit would be
    // reconciling against a tree the measurement had already changed.
    const admission = yield* presenter.prepare(viewOf(model, WIDE));
    expect(windowOf(admission, SESSIONS_WINDOW).capacity).toBeGreaterThan(0);
    expect(windowOf(admission, READING_WINDOW).capacity).toBeGreaterThan(0);
    // Nothing was mounted, nothing was painted and no frame was committed.
    expect(presenter.tree.mounted()).toEqual([]);
    expect(presenter.grid.rows()).toEqual([]);
    expect(presenter.renderer.last()).toBeUndefined();
    const drawn = yield* presenter.commit(viewOf(model, WIDE));
    expect(drawn.targets.length).toBeGreaterThan(0);
  });

  it("TL2: capacity describes the region, not whatever is overflowing it", function* () {
    const one = yield* journalModel(["# Entry one\n\nEntry one.\n"]);
    const overflowing = yield* journalModel([`# Entry two\n\n${LONG_READING}\n`]);
    const presenter = yield* usePresenter(WIDE);
    const few = windowOf(yield* presenter.prepare(viewOf(one, WIDE)), READING_WINDOW);
    expect(few.total).toBeLessThanOrEqual(few.capacity);

    const many = windowOf(yield* presenter.prepare(viewOf(overflowing, WIDE)), READING_WINDOW);
    expect(many.total).toBeGreaterThan(few.capacity);
    // The same region, so the same room. A capacity that moved with the length
    // of the reading would be measuring the reading.
    expect(many.capacity).toBe(few.capacity);
    expect(many.total).toBeGreaterThan(many.capacity);
    expect(many.count).toBeLessThanOrEqual(many.capacity);
  });

  it("TL2: an action label is measured with the focus marker it draws with", function* () {
    const model = yield* referenceModel();
    // Each control is as wide as its own label and the room its marker draws
    // in, so a pointer aimed at one reaches it and not its neighbour.
    for (const size of [WIDE, NARROW]) {
      const presenter = yield* usePresenter(size);
      const observed = yield* presenter.commit(viewOf(model, size));
      for (const [key, label] of [
        ["footer:history", "[history]"],
        ["footer:exit", "[exit]"],
        ["draft:send", "[send]"],
      ]) {
        expect(observed.cells.get(key)?.trim()).toBe(label);
        expect(observed.boundsOf(key)?.width).toBe(label.length + CONTROL_ROOM.length);
      }
    }
  });
});

describe("REPL layout: what a window admits", () => {
  it("TL3: a row outside the window is in no node, cell, target or Tab stop", function* () {
    const catalog = yield* catalogOverEntries();
    const observed = yield* shownAt(catalog, catalog.state);
    const held = windowOf(observed.committed.admission, DRAWER_WINDOW);
    expect(held.total).toBe(CATALOG_ENTRIES);
    expect(held.capacity).toBeLessThan(held.total);
    expect(held.more).toBe(true);

    const orders = Array.from({ length: CATALOG_ENTRIES }, (_unused, at) => at + 1);
    const shown = orders.slice(held.from, held.from + held.count);
    const hidden = orders.filter((order) => !shown.includes(order));
    expect(hidden.length).toBeGreaterThan(0);

    const drawn = targetKeys(catalog.presenter, observed);
    for (const order of hidden) {
      // Not placed, so there is nothing to draw, nothing to aim at and nothing
      // for traversal to stop on.
      expect(observed.keys).not.toContain(entryKey(order));
      expect(drawn).not.toContain(entryKey(order));
      expect(catalog.presenter.grid.rows().some((line) => line.includes(entryLabel(order)))).toBe(
        false,
      );
    }
    const forward = yield* ring(catalog.presenter, "Tab");
    const backward = yield* ring(catalog.presenter, "Backtab");
    for (const order of hidden) {
      expect(forward).not.toContain(entryKey(order));
      // And the same in reverse: a hidden row is not reachable from either side.
      expect(backward).not.toContain(entryKey(order));
    }
    for (const order of shown) {
      expect(forward).toContain(entryKey(order));
    }
  });

  it("TL3: no row is drawn outside the viewport it was admitted to", function* () {
    const catalog = yield* catalogOverEntries();
    const observed = yield* shownAt(catalog, catalog.state);
    const viewport = viewportBounds(observed, DRAWER_WINDOW);
    if (viewport === undefined) {
      throw new Error("this frame placed no drawer viewport");
    }
    const held = windowOf(observed.committed.admission, DRAWER_WINDOW);
    const rows = catalog.presenter.grid.textIn(viewport);
    expect(held.count).toBeGreaterThan(0);
    for (let order = held.from + 1; order <= held.from + held.count; order += 1) {
      expect(within(viewport, observed.boundsOf(entryKey(order)))).toBe(true);
      expect(rows.some((line) => line.includes(entryLabel(order)))).toBe(true);
    }
  });

  it("TL3: earlier and later reach every row, including the last", function* () {
    const catalog = yield* catalogOverEntries();
    const last = entryKey(CATALOG_ENTRIES);
    const opened = yield* shownAt(catalog, catalog.state);
    expect(opened.keys).not.toContain(last);

    // Move the window to the end the way a person does, one press at a time,
    // and stop when the final row is genuinely placed.
    const reached = yield* scrolledUntil(catalog, catalog.state, 1, (one) =>
      one.keys.includes(last),
    );
    expect(windowOf(reached.observed.committed.admission, DRAWER_WINDOW).from).toBeGreaterThan(0);
    // Visible, so it is a real control with real geometry and a Tab stop.
    expect(reached.observed.cells.get(last)?.trim()).toBe(entryLabel(CATALOG_ENTRIES));
    expect(targetKeys(catalog.presenter, reached.observed)).toContain(last);
    yield* focusKey(catalog.presenter, last);
    expect(focusedKey(catalog.presenter)).toBe(last);

    // And back: the first row is reachable again from the far end.
    const first = entryKey(1);
    expect(reached.observed.keys).not.toContain(first);
    const back = yield* scrolledUntil(catalog, reached.state, -1, (one) =>
      one.keys.includes(first),
    );
    expect(windowOf(back.observed.committed.admission, DRAWER_WINDOW).from).toBe(0);
  });

  it("TL3: the first scroll after a resize moves from the clamp that is drawn", function* () {
    const catalog = yield* catalogOverEntries();

    // Scrolled to the very end of the smaller region, which is as far as this
    // reading goes while the terminal is this size.
    const end = yield* scrolledUntil(
      catalog,
      catalog.state,
      1,
      (one) => !windowOf(one.committed.admission, DRAWER_WINDOW).more,
    );
    const atEnd = windowOf(end.observed.committed.admission, DRAWER_WINDOW);
    expect(atEnd.from).toBe(atEnd.total - atEnd.capacity);
    expect(atEnd.from).toBeGreaterThan(1);

    // The terminal grows. A taller region holds more rows, so the last window
    // starts further back — the position scrolled to is now past it, and what
    // the frame draws is the clamp.
    catalog.presenter.resize({
      columns: NARROW.columns,
      rows: NARROW.rows + 2,
    });
    const grown = yield* shownAt(catalog, end.state);
    const clamped = windowOf(grown.committed.admission, DRAWER_WINDOW);
    expect(clamped.capacity).toBeGreaterThan(atEnd.capacity);
    expect(clamped.from).toBeLessThan(atEnd.from);
    expect(clamped.from).toBe(clamped.total - clamped.capacity);
    // And the clamp is what is on screen: the last row really is the last one.
    expect(clamped.more).toBe(false);
    expect(grown.keys).toContain(entryKey(CATALOG_ENTRIES));

    // So the next press moves from there. Going one row earlier than the drawn
    // clamp lands one row earlier; a window that had moved from the position
    // scrolled to instead would land two rows further on.
    const moved = yield* shownAt(
      catalog,
      reduceRepl(
        end.state,
        { kind: "scroll-entries", delta: -1 },
        catalog.model,
        IDLE,
        grown.committed.admission,
      ).state,
    );
    const after = windowOf(moved.committed.admission, DRAWER_WINDOW);
    expect(after.from).toBe(clamped.from - 1);
    expect(after.more).toBe(true);
  });
});

describe("REPL layout: what an action row admits", () => {
  /** A row 72 cells wide, and the measured extent of six controls offered to it. */
  const ROW: ReplBounds = { x: 0, y: 0, width: 72, height: 1 };

  /** Controls wide enough that the narrowest supported row cannot hold them all. */
  const CROWDED = [
    "footer:history",
    "footer:exit",
    "footer:pause",
    "footer:continue",
    "footer:live",
    "footer:answer",
  ];
  const CROWDED_EXTENTS: Readonly<Record<string, ReplBounds>> = {
    "footer:history": extentAt(0, 11),
    "footer:exit": extentAt(11, 8),
    "footer:pause": extentAt(19, 23),
    "footer:continue": extentAt(42, 26),
    "footer:live": extentAt(68, 28),
    "footer:answer": extentAt(96, 29),
  };

  it("TL4: a row too narrow for everything admits a whole prefix only", function* () {
    const { admitted } = admitActions({
      row: ROW,
      controls: offered(...CROWDED),
      boundsOf: boundsIn(CROWDED_EXTENTS),
    });
    const kept = CROWDED.filter((key) => admitted.has(key));
    const omitted = CROWDED.filter((key) => !admitted.has(key));
    expect(omitted.length).toBeGreaterThan(0);

    // A contiguous prefix of the offered order, and nothing after the break.
    expect(kept).toEqual(CROWDED.slice(0, kept.length));
    expect(kept).toEqual(["footer:history", "footer:exit", "footer:pause", "footer:continue"]);
    // The way out stays, because it comes first.
    expect(admitted.has("footer:history")).toBe(true);
    expect(admitted.has("footer:exit")).toBe(true);
    expect(omitted).toEqual(["footer:live", "footer:answer"]);
  });

  it("TL4: every admitted control is drawn whole, inside the row", function* () {
    const edge = ROW.x + ROW.width;
    // The last control ends exactly on the row's edge, and the next starts there.
    const extents: Readonly<Record<string, ReplBounds>> = {
      "footer:history": extentAt(0, 11),
      "footer:exit": extentAt(11, 8),
      "footer:flush": extentAt(19, edge - 19),
      "footer:beyond": extentAt(edge, 3),
    };
    const { admitted } = admitActions({
      row: ROW,
      controls: offered("footer:history", "footer:exit", "footer:flush", "footer:beyond"),
      boundsOf: boundsIn(extents),
    });
    expect([...admitted]).toEqual(["footer:history", "footer:exit", "footer:flush"]);
    for (const key of admitted) {
      const bounds = extents[key];
      // Whole: its own trailing edge is inside the row's, so no part of it is
      // drawn off the end where a person could see it and not hit it.
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(edge);
    }

    // The running command places its controls the same way at every size.
    const model = yield* referenceModel();
    for (const size of [WIDE, MEDIUM, NARROW]) {
      const where = `${size.columns}x${size.rows}`;
      const presenter = yield* usePresenter(size);
      const observed = yield* presenter.commit(viewOf(model, size));
      const actions = observed.regionOf(ACTION_ROW);
      for (const key of ["footer:history", "footer:exit"]) {
        expect({ where, key, inside: within(actions, observed.boundsOf(key)) }).toEqual({
          where,
          key,
          inside: true,
        });
      }
    }
  });

  it("TL4: a control the row cannot hold does not let a narrower one past it", function* () {
    // The third control is far too wide for the narrowest row; the fourth fits
    // in what is left of it. Order is priority, so neither is admitted.
    const extents: Readonly<Record<string, ReplBounds>> = {
      "footer:history": extentAt(0, 11),
      "footer:exit": extentAt(11, 8),
      "footer:wide": extentAt(19, 92),
      "footer:narrow": extentAt(60, 3),
    };
    const { admitted } = admitActions({
      row: ROW,
      controls: offered("footer:history", "footer:exit", "footer:wide", "footer:narrow"),
      boundsOf: boundsIn(extents),
    });
    expect(admitted.has("footer:history")).toBe(true);
    expect(admitted.has("footer:exit")).toBe(true);
    expect(admitted.has("footer:wide")).toBe(false);
    // The whole point: it fits, and it is still not admitted, because the row
    // stopped at the first control it could not hold whole.
    expect(admitted.has("footer:narrow")).toBe(false);
  });
});

describe("REPL layout: what a shrinking reading leaves behind", () => {
  /** One journal whose whole reading is the long one, and one that is short. */
  function* readings(): Operation<{ long: ReplModel; short: ReplModel }> {
    return {
      long: yield* journalModel([`# Long\n\n${LONG_READING}\n`]),
      short: yield* journalModel(["# Short\n\nShort.\n"]),
    };
  }

  it("TL5: cells a filtered reading vacates are blank, not merely undescribed", function* () {
    const { long, short } = yield* readings();
    const presenter = yield* usePresenter(WIDE);
    const first = yield* presenter.commit(viewOf(long, WIDE));
    const before = readingRows(presenter, first);

    // Pre-assert: the area about to be vacated really had text in it. Without
    // this the assertion below would pass on an empty screen.
    expect(before.some((line) => line.includes("VACATED-3"))).toBe(true);
    const second = yield* presenter.commit(viewOf(short, WIDE));
    const after = readingRows(presenter, second);
    // Counted rather than read with `findLastIndex`: the Node typecheck's
    // `lib` is ES2022, and that reader is ES2023. Zero where every row is blank.
    const kept = after.reduce((last, line, at) => (line.trim().length > 0 ? at + 1 : last), 0);
    expect(kept).toBeGreaterThan(0);
    expect(before.slice(kept).some((line) => line.trim().length > 0)).toBe(true);

    // The reading becomes a short one. This is the one shape where a shared
    // measure-and-draw engine leaves the old text: the measurement skeleton
    // leaves these cells blank too, so a shared instance's diff has nothing to
    // say about them. Asserted against the cells the frame's own bytes left on
    // an emulated screen, so this is what a person would be looking at rather
    // than what the frame described.
    expect(after.join("\n")).not.toContain("VACATED-");
    expect(after.slice(kept).every((line) => line.trim().length === 0)).toBe(true);
    expect(presenter.grid.rows().join("\n")).not.toContain("VACATED-");
  });

  it("TL5: the rows that remain are still drawn where the frame says", function* () {
    const { long, short } = yield* readings();
    const presenter = yield* usePresenter(WIDE);
    yield* presenter.commit(viewOf(long, WIDE));
    const observed = yield* presenter.commit(viewOf(short, WIDE));
    const drawn = targetKeys(presenter, observed);
    expect(drawn.length).toBeGreaterThan(0);
    for (const key of drawn) {
      expect((observed.cells.get(key) ?? "").trim()).not.toBe("");
    }
    expect(observed.cells.get("entries:heading")?.trim()).toBe("Entries");
    expect(observed.cells.get("footer:history")?.trim()).toBe("[history]");
    expect(readingRows(presenter, observed).some((line) => line.includes("Short."))).toBe(true);
  });

  it("TL5: the running command shows none of the longer reading afterwards", function* () {
    // The same shape end to end, where the readings are two entries a person
    // really submitted: whatever the frames in between did, the terminal is
    // left showing the short one and no part of the long one.
    const page = yield* useReplPage({ size: WIDE });
    yield* submit(page, 1, LONG_READING);
    yield* page.until("the long entry being read", (one) => one.shows("VACATED-3"));
    yield* submit(page, 2, "Short.");
    const settled = yield* page.until("the short entry being read", (one) => one.shows("Short."));
    expect(settled.occurrences("VACATED-")).toBe(0);
  });
});

describe("REPL layout: the profiles this product supports", () => {
  it("TL1: every supported size keeps its columns and its two footer rows", function* () {
    const model = yield* referenceModel();
    for (const { size, profile } of [
      { size: WIDE, profile: "wide" },
      { size: MEDIUM, profile: "medium" },
      { size: NARROW, profile: "narrow" },
    ]) {
      const presenter = yield* usePresenter(size);
      const observed = yield* presenter.commit(viewOf(model, size));
      expect(observed.committed.manifest.profile).toBe(profile);
      const bounds = (id: string): ReplBounds | undefined => observed.regionOf(id);
      // One identity row, the body between, then one compact History row and
      // one row of guidance, at every size.
      expect(bounds("box:identity")).toEqual({
        x: 0,
        y: 0,
        width: size.columns,
        height: 1,
      });
      expect(bounds("box:body")).toEqual({
        x: 0,
        y: 1,
        width: size.columns,
        height: size.rows - 3,
      });
      expect(bounds("box:history")).toEqual({
        x: 0,
        y: size.rows - 2,
        width: size.columns,
        height: 1,
      });
      expect(bounds("box:guidance")).toEqual({
        x: 0,
        y: size.rows - 1,
        width: size.columns,
        height: 1,
      });
      expect(presenter.grid.rows()[size.rows - 2]).toContain("HISTORY");
      expect(within(bounds("box:history"), observed.boundsOf("footer:history"))).toBe(true);
      expect(within(bounds("box:draft"), observed.boundsOf("footer:input"))).toBe(true);
    }

    const presenter = yield* usePresenter(WIDE);
    const wide = yield* presenter.commit(viewOf(model, WIDE));
    // The first composition gives the columns 36, 66 and 58 cells, dividers
    // included, the body 33 rows and the Draft four of the centre's.
    expect(wide.regionOf("box:sidebar")).toMatchObject({
      x: 0,
      width: 36,
      height: 33,
    });
    expect(wide.regionOf("box:transcript")).toMatchObject({
      x: 36,
      width: 66,
      height: 33,
    });
    expect(wide.regionOf("box:inspection")).toMatchObject({
      x: 102,
      width: 58,
      height: 33,
    });
    expect(wide.regionOf("box:draft")?.height).toBe(4);
  });
});

describe("REPL layout: what the application admits at each size", () => {
  it("A2: every measured window is whole, bounded and reachable", function* () {
    const model = yield* referenceModel();
    for (const size of [WIDE, MEDIUM, NARROW]) {
      const where = `${size.columns}x${size.rows}`;
      const presenter = yield* usePresenter(size);
      // The opening frame, where the Draft's own focus is taken; then the
      // frame composed with the control the mounted tree answered for.
      yield* presenter.commit(viewOf(model, size));
      const node = presenter.tree.focused();
      const focused = node === undefined ? undefined : presenter.tree.keyOf(node);
      const observed = yield* presenter.commit(viewOf(model, size, { focused }));
      const { admission, manifest } = observed.committed;

      // A window holds whole rows, never more than its capacity, and never a
      // capacity it did not measure.
      expect({ where, windows: admission.windows.size > 0 }).toEqual({
        where,
        windows: true,
      });
      for (const slot of manifest.viewports) {
        const window = windowOf(admission, slot.window);
        const bounds = observed.regionOf(slot.id);
        expect({ where, window: slot.window, measured: bounds !== undefined }).toEqual({
          where,
          window: slot.window,
          measured: true,
        });
        expect({
          where,
          window: slot.window,
          whole: Number.isInteger(window.capacity) && Number.isInteger(window.count),
        }).toEqual({ where, window: slot.window, whole: true });
        expect({ where, window: slot.window, room: window.capacity >= 0 }).toEqual({
          where,
          window: slot.window,
          room: true,
        });
        expect({
          where,
          window: slot.window,
          within: window.count <= window.capacity && window.from + window.count <= window.total,
        }).toEqual({ where, window: slot.window, within: true });
      }

      // Every admitted action was drawn, and nothing the row left out was.
      const drawn = new Set(
        observed.targets.flatMap((one) => {
          const key = presenter.tree.keyOf(one.node);
          return key === undefined ? [] : [key];
        }),
      );
      expect((manifest.actions?.controls ?? []).length).toBeGreaterThan(0);
      for (const candidate of manifest.actions?.controls ?? []) {
        const admitted = admission.actions.has(candidate.key);
        expect({
          where,
          key: candidate.key,
          admitted,
          drawn: drawn.has(candidate.key),
        }).toEqual({
          where,
          key: candidate.key,
          admitted,
          drawn: admitted,
        });
      }
    }
  });

  // The queue-specific form of this measurement — an empty moving tray with
  // its own controls around it — is not run: this build draws no Queue tray
  // (specs/repl-spec.md). The obligation it carried is the case below, over
  // the catalog this build actually offers.

  /**
   * The same question, about the catalog this build actually offers.
   *
   * A window is admitted against the room the frame will draw, and the only way
   * to know the room was the right one is to watch the preparation measure it:
   * a viewport still holding its own rows reports the space its contents wanted,
   * and one measured before the controls around it reports a rectangle that is
   * about to move. Nothing here changes an operation or a returned rectangle —
   * the production `prepareFrame` runs against the same real engine, and this
   * reads what went past.
   */
  it("A2: an overflowing Entries catalog is admitted from its last empty coherent measurement", function* () {
    const model = yield* entriesModel(9);
    const size = NARROW;
    const presenter = yield* usePresenter(size);
    // The closed screen first, so the catalog is opened from a frame whose
    // focus the mounted tree actually answered for — the drawer is a modal, and
    // only what it contains may hold focus while it is open.
    yield* presenter.commit(viewOf(model, size));
    const node = presenter.tree.focused();
    const focused = node === undefined ? undefined : presenter.tree.keyOf(node);
    const closed = viewOf(model, size, { focused });
    yield* presenter.commit(closed);
    const opened = reduceRepl(closed.state, { kind: "open-catalog" }, model, IDLE).state;
    const view = viewOf(model, size, { state: opened, focused });
    const viewport = `box:${DRAWER_WINDOW}:viewport`;
    const row = /^box:drawer:.*:row:\d+:row$/;
    const seen: {
      bounds: ReplBounds | undefined;
      rows: number;
      earlier: boolean;
      later: boolean;
      chrome: boolean;
    }[] = [];
    const delegate = presenter.renderer;
    const watching: ReplRenderer = {
      *measure(ops, measured) {
        const result = yield* delegate.measure(ops, measured);
        const ids = ops.flatMap((op) => ("id" in op && typeof op.id === "string" ? [op.id] : []));
        if (result.ok && ids.includes(viewport)) {
          seen.push({
            bounds: result.value.boundsOf(viewport),
            rows: ids.filter((id) => row.test(id)).length,
            earlier: ids.includes("box:drawer:drawer:scroll:up"),
            later: ids.includes("box:drawer:drawer:scroll:down"),
            chrome:
              ids.includes("box:drawer:drawer:open") && ids.includes("box:drawer:drawer:close"),
          });
        }
        return result;
      },
      draw: (input) => delegate.draw(input),
      resize: (next) => delegate.resize(next),
      last: () => delegate.last(),
      engines: () => delegate.engines(),
    };
    const prepared = yield* prepareFrame(watching, view);
    if (!prepared.ok) {
      throw prepared.error;
    }
    // More rows than the drawer was given, which is the case a moving window
    // exists for at all.
    const window = windowOf(prepared.value.admission, DRAWER_WINDOW);
    expect({ beyond: window.total > window.capacity }).toEqual({
      beyond: true,
    });

    // The last measurement that held the viewport is the one that admission
    // came from: no rows of its own inside it, both of its own controls and
    // the drawer's fixed chrome around it.
    const last = seen[seen.length - 1];
    if (last === undefined || last.bounds === undefined) {
      throw new Error("this preparation measured no catalog viewport");
    }
    expect({
      rows: last.rows,
      earlier: last.earlier,
      later: last.later,
      chrome: last.chrome,
    }).toEqual({ rows: 0, earlier: true, later: true, chrome: true });
    // And it is a region with room in it. A window admitted against nothing
    // would satisfy every rule below and show no reading at all.
    expect({
      width: last.bounds.width > 0,
      height: last.bounds.height > 0,
      whole: Number.isInteger(last.bounds.width) && Number.isInteger(last.bounds.height),
    }).toEqual({ width: true, height: true, whole: true });

    // The same rectangle the finished frame places that viewport at, measured
    // by the same engine from the manifest it published.
    const final = yield* delegate.measure(
      skeletonOps(prepared.value.presentation.manifest.root),
      size,
    );
    if (!final.ok) {
      throw final.error;
    }
    expect(last.bounds).toEqual(final.value.boundsOf(viewport));
    const above = final.value.boundsOf("box:drawer:drawer:scroll:up");
    const below = final.value.boundsOf("box:drawer:drawer:scroll:down");
    if (above === undefined || below === undefined) {
      throw new Error("this frame drew the catalog without its own controls");
    }
    expect({
      above: above.y + above.height <= last.bounds.y,
      below: below.y >= last.bounds.y + last.bounds.height,
    }).toEqual({ above: true, below: true });

    // And a row the first frame does not show is reached by the control that
    // moves the window, with a whole target of its own inside that viewport.
    const first = yield* presenter.commit(view);
    const shown = (observed: typeof first) =>
      observed.keys.filter((key) => key.startsWith("entry:")).sort();
    const moved = reduceRepl(
      opened,
      { kind: "scroll-entries", delta: 1 },
      model,
      IDLE,
      prepared.value.admission,
    ).state;
    const after = yield* presenter.commit(viewOf(model, size, { state: moved, focused }));
    const reached = shown(after).filter((key) => !shown(first).includes(key));
    expect({
      hidden: shown(first).length < window.total,
      reached: reached.length > 0,
    }).toEqual({
      hidden: true,
      reached: true,
    });
    const reachedNode = after.nodeOf(reached[0]);
    const target =
      reachedNode === undefined ? undefined : after.targets.find((one) => one.node === reachedNode);
    const bounds = after.boundsOf(reached[0]);
    if (target === undefined || bounds === undefined) {
      throw new Error(`${reached[0]} was drawn with no target of its own`);
    }
    expect({ target: target.bounds }).toEqual({ target: bounds });
    expect({
      whole:
        Number.isInteger(bounds.x) &&
        Number.isInteger(bounds.width) &&
        Number.isInteger(bounds.y) &&
        Number.isInteger(bounds.height),
      inside:
        bounds.y >= last.bounds.y && bounds.y + bounds.height <= last.bounds.y + last.bounds.height,
    }).toEqual({ whole: true, inside: true });
  });

  // The accepted wide row is a fitted map, a gap and the controls. The gap and
  // the controls both grew, so the engine divided what the map left between
  // them — in halves, and half of an odd number of cells is not a cell. The
  // accepted fixture's map happens to leave an even remainder, so nothing said
  // the arrangement only worked for even ones. An ordinary empty root leaves an
  // odd one, and every control after the gap landed on half a cell.
  /**
   * #971: the paused narrow History row gives its controls whole cells.
   *
   * The row holds the compact map and the footer's controls side by side. A
   * paused entry offers four of them — History, Exit, Pause and Continue — with
   * the phase stated between them, and that is the widest this row ever gets.
   *
   * What this holds the row to is that none of them is compressed. Measured
   * before the correction, a 72-cell row gave its map the 29 cells its own text
   * wanted and left the controls 43 where they need 51, and the engine answered
   * every one of them with part of a cell — which the renderer then refused.
   * The map yields first now, and the split is stated from a measurement of the
   * two parts taken apart rather than of each under the other's pressure.
   */
  it("A3: a paused narrow History row admits every control on whole cells", function* () {
    const empty = projectRepl([]);
    if (!empty.ok) {
      throw empty.error;
    }
    const model = empty.value;
    // Paused, and stably so: `pausable` with expansion `paused` is the one
    // state that offers Pause, the phase and Continue at once, and it is held
    // fixed so every preparation pass sees the same four controls.
    const paused: ReplLive = {
      output: "",
      question: undefined,
      expansion: "paused" as const,
      pausable: true,
      running: true,
      agent: NO_AGENT,
      lifecycle: NO_LIFECYCLE,
    };
    for (const size of [MEDIUM, NARROW]) {
      const where = `${size.columns}x${size.rows}`;
      yield* scoped(function* (): Operation<void> {
        const view = viewFor(
          initialState("paused-root"),
          model,
          paused,
          size,
          undefined,
          navigationOf(model.checkpoints, "live"),
        );
        if (!view.ok) {
          throw view.error;
        }
        const presenter = yield* usePresenter(size);
        const staged = withWorkspace(view.value, workspaceOf());
        // Committing is itself part of the assertion: the renderer refuses a
        // control on part of a cell rather than rounding it, so a frame that
        // drew at all drew on whole ones. Said again below over every
        // published rectangle, because "it did not throw" is not the claim.
        const first = yield* presenter.commit(staged);
        const node = presenter.tree.focused();
        const focused = node === undefined ? undefined : presenter.tree.keyOf(node);
        const committed = yield* presenter.commit({ ...staged, focused });

        // Every control this state offers is admitted — Continue included, by
        // being measured rather than appended after the fact — and each is
        // drawn whole, inside the row, with its own complete label.
        const labels: Readonly<Record<string, string>> = {
          "footer:history": "[history]",
          "footer:exit": "[exit]",
          "footer:pause": "[pause]",
          "footer:continue": "[continue]",
        };
        const row = committed.regionOf("box:history");
        const map = committed.regionOf("box:history:map");
        const actions = committed.regionOf(ACTION_ROW);
        if (row === undefined || map === undefined || actions === undefined) {
          throw new Error(`${where} drew no History row to divide`);
        }
        for (const [key, label] of Object.entries(labels)) {
          const bounds = committed.boundsOf(key);
          if (bounds === undefined) {
            throw new Error(
              `${where} drew no ${key}; its controls are ${JSON.stringify(
                committed.keys.filter((one) => one.startsWith("footer:")),
              )}`,
            );
          }
          expect([
            where,
            key,
            Number.isInteger(bounds.x) && Number.isInteger(bounds.width),
          ]).toEqual([where, key, true]);
          // The whole label, inside the target that owns it: a control shown
          // short is a control a reader cannot read, and a label wider than its
          // own box is one drawn over its neighbour. Every control is measured
          // with the two cells its focus marker draws in, which is why its box
          // is its label and that room — a control measured without it comes
          // out two columns narrower than the one drawn in its place.
          expect([where, key, bounds.width]).toEqual([
            where,
            key,
            label.length + CONTROL_ROOM.length,
          ]);
          expect([where, key, (committed.cells.get(key) ?? "").includes(label)]).toEqual([
            where,
            key,
            true,
          ]);
          expect([where, key, bounds.x >= actions.x]).toEqual([where, key, true]);
          expect([where, key, bounds.x + bounds.width <= actions.x + actions.width]).toEqual([
            where,
            key,
            true,
          ]);
        }
        // The phase is stated beside them, as text rather than as part of a
        // control's name.
        expect([where, committed.keys.includes("footer:pause-state")]).toEqual([where, true]);

        // The split itself: whole, exhaustive, and the map is what yielded.
        expect([where, Number.isInteger(map.width) && Number.isInteger(actions.width)]).toEqual([
          where,
          true,
        ]);
        expect([where, map.width + actions.width]).toEqual([where, row.width]);
        expect([where, actions.width >= 0]).toEqual([where, true]);

        // And the control a keystroke reaches is one the frame actually drew.
        const holding = presenter.tree.focused();
        const held = holding === undefined ? undefined : presenter.tree.keyOf(holding);
        expect([where, held === undefined || committed.boundsOf(held) !== undefined]).toEqual([
          where,
          true,
        ]);
        // The first frame drew the same row whole, before focus was carried in.
        expect([where, Number.isInteger(first.regionOf(ACTION_ROW)?.width ?? 0.5)]).toEqual([
          where,
          true,
        ]);
      });
    }
  });

  it("A2: the wide History row divides an odd remainder into whole cells", function* () {
    const empty = projectRepl([]);
    if (!empty.ok) {
      throw empty.error;
    }
    const size = WIDE;
    const model = empty.value;
    const view = viewFor(
      initialState("ordinary-root"),
      model,
      {
        output: "",
        question: undefined,
        expansion: "playing" as const,
        pausable: false,
        running: false,
        agent: NO_AGENT,
        lifecycle: NO_LIFECYCLE,
      },
      size,
      undefined,
      navigationOf(model.checkpoints, "empty"),
    );
    if (!view.ok) {
      throw view.error;
    }
    const presenter = yield* usePresenter(size);
    const staged = withWorkspace(view.value, workspaceOf());
    const first = yield* presenter.commit(staged);
    const node = presenter.tree.focused();
    const focused = node === undefined ? undefined : presenter.tree.keyOf(node);
    const committed = yield* presenter.commit({ ...staged, focused });

    // The remainder this reading leaves really is odd, which is the whole
    // reason the row needed a rule. Measured, not assumed.
    const row = first.regionOf("box:history");
    const map = first.regionOf("box:history:map");
    if (row === undefined || map === undefined) {
      throw new Error("this frame drew no History row to divide");
    }
    expect({ odd: (row.width - map.width) % 2 === 1 }).toEqual({ odd: true });

    // Committing is the assertion the renderer makes: it refuses a control on
    // half a cell rather than rounding it, so a frame that drew at all drew on
    // whole cells. Said again here over every published rectangle.
    for (const key of ["footer:history", "footer:exit"]) {
      const bounds = committed.boundsOf(key);
      if (bounds === undefined) {
        throw new Error(`${key} was not drawn on the ordinary root's own screen`);
      }
      expect({
        key,
        whole: Number.isInteger(bounds.x) && Number.isInteger(bounds.width),
      }).toEqual({ key, whole: true });
      expect({ key, room: bounds.width > 0 }).toEqual({ key, room: true });
    }
    const gap = committed.regionOf("box:history:space");
    const actions = committed.regionOf(ACTION_ROW);
    if (gap === undefined || actions === undefined) {
      throw new Error("this row drew no gap and controls to divide");
    }
    // The odd cell goes to the controls, which are what somebody is aiming at.
    expect({
      whole: Number.isInteger(gap.width) && Number.isInteger(actions.width),
    }).toEqual({
      whole: true,
    });
    expect({ gap: gap.width, actions: actions.width }).toEqual({
      gap: Math.floor((row.width - map.width) / 2),
      actions: row.width - map.width - Math.floor((row.width - map.width) / 2),
    });

    // The controls say what they are, where the frame put them.
    const history = committed.boundsOf("footer:history");
    if (history === undefined) {
      throw new Error("the History control was not drawn");
    }
    expect(presenter.grid.textIn(history).join(" ")).toContain("[history]");
    // And focus is the mounted tree's own answer, read back rather than set.
    expect({ focused: focused !== undefined }).toEqual({ focused: true });
  });
});

const KERNEL_SIDEKICK: ReplSidekickReading = {
  chat: [],
  busy: false,
  agent: "scribe",
  refusal: undefined,
  question: undefined,
  requested: undefined,
  verified: undefined,
  conversation: "owned",
  reading: "owned",
  current: true,
  turns: [],
  availability: { chats: ["owned"], sessions: [], refusal: undefined },
};

describe("Owned renderer claims moved out of mounted journeys", () => {
  it("B3/J1: an ancestor is keyboard reachable and a refused navigation keeps owned focus and targets", function* () {
    const model = yield* referenceModel();
    const selected = reduceRepl(
      initialState("reference"),
      { kind: "select-scope", scopes: ["entry-1", "Checklist-1"] },
      model,
      IDLE,
    ).state;
    const presenter = yield* usePresenter(WIDE);
    yield* presenter.commit(viewOf(model, WIDE, { state: selected }));
    yield* focusKey(presenter, "work:crumb:0");
    expect(focusedKey(presenter)).toBe("work:crumb:0");
    const entered = yield* presenter.tree.dispatch({ kind: "key", key: "Enter" });
    if (!entered.ok) {
      throw entered.error;
    }
    expect(entered.value.outcome).toBe("action");
    if (entered.value.outcome !== "action") {
      throw new Error("the ancestor produced no action");
    }
    const ancestor = reduceRepl(selected, entered.value.action, model, IDLE).state;
    expect(ancestor.route.scopes).toEqual(["entry-1"]);
    const history = reduceRepl(
      selected,
      { kind: "open-drawer", drawer: { kind: "history" } },
      model,
      IDLE,
    ).state;
    yield* presenter.commit(
      viewOf(model, WIDE, { state: history, focused: focusedKey(presenter) }),
    );
    const marker = `drawer:marker:${model.checkpoints[0]?.marker ?? ""}`;
    yield* focusKey(presenter, marker);
    const before = yield* presenter.commit(
      viewOf(model, WIDE, { state: history, focused: focusedKey(presenter) }),
    );
    const closeAt = before.boundsOf("drawer:close");
    expect(closeAt).toBeDefined();
    const refused = reduceRepl(
      history,
      { kind: "select-scope", scopes: ["entry-1", "Nowhere-9"] },
      model,
      IDLE,
    ).state;
    expect(refused.route).toEqual(history.route);
    expect(refused.refusal).toBeDefined();
    const after = yield* presenter.commit(
      viewOf(model, WIDE, { state: refused, focused: focusedKey(presenter) }),
    );
    expect(focusedKey(presenter)).toBe(marker);
    expect(after.boundsOf("drawer:close")).toEqual(closeAt);
    expect(after.keys).toEqual(before.keys);
  });

  it("Q-P1: three Backtabs reach the default composer without activating a pane", function* () {
    const model = yield* entriesModel(0);
    const live: ReplLive = { ...IDLE, sidekick: KERNEL_SIDEKICK };
    const view = viewFor(initialState("owned"), model, live, WIDE);
    if (!view.ok) {
      throw view.error;
    }
    const presenter = yield* usePresenter(WIDE);
    yield* presenter.commit(withWorkspace(view.value, workspaceOf(model)));
    yield* focusKey(presenter, "footer:input");
    const walked = yield* ring(presenter, "Backtab");
    expect(walked.indexOf("sidekick:message")).toBe(3);
    expect(view.value.state.route.view).toBeUndefined();
  });

  it("MQ4/CFG6: each Sidekick drawer and its targets stay inside the independent pane envelope and above the footer", function* () {
    const model = yield* entriesModel(0);
    const question = {
      key: "pending",
      message: "Fill this in.",
      form: readQuestionForm({
        type: "object",
        properties: Object.fromEntries(
          [
            "one",
            "two",
            "three",
            "four",
            "five",
            "six",
            "seven",
            "eight",
            "nine",
            "ten",
            "eleven",
            "twelve",
            "last",
          ].map((name) => [name, { type: "string", description: `What ${name} is for.` }]),
        ),
        required: ["one"],
        additionalProperties: false,
      }),
    };
    const quiet: ReplSidekickReading = {
      chat: [],
      busy: false,
      agent: "scribe",
      refusal: undefined,
      question: undefined,
      requested: undefined,
      verified: undefined,
      conversation: "owned",
      reading: "owned",
      current: true,
      turns: [],
      availability: { chats: ["owned"], sessions: [], refusal: undefined },
    };
    for (const size of [WIDE, MEDIUM, NARROW]) {
      for (const kind of ["question", "configure"]) {
        yield* scoped(function* () {
          const live: ReplLive = {
            ...IDLE,
            sidekick: kind === "question" ? { ...quiet, busy: true, question } : quiet,
          };
          let state = reduceRepl(
            initialState("owned"),
            { kind: "select-pane", pane: "sidekick" },
            model,
            live,
          ).state;
          if (kind === "question") {
            state = reduceRepl(
              state,
              { kind: "open-sidekick-question", question: question.key },
              model,
              live,
            ).state;
          } else {
            state = reduceRepl(
              state,
              { kind: "open-configure", conversation: "owned" },
              model,
              live,
            ).state;
            state = offering(
              state,
              "owned",
              undefined,
              Ok({
                agent: "scribe",
                model: {
                  selected: "balanced",
                  options: [
                    { id: "balanced", name: "Balanced", description: null, group: null },
                    { id: "fast", name: "Fast", description: null, group: null },
                  ],
                },
                effort: null,
              }),
              "scribe",
            );
          }
          const view = viewFor(
            state,
            model,
            live,
            size,
            kind === "question" ? "sidekick:answer" : "sidekick:configure",
          );
          if (!view.ok) {
            throw view.error;
          }
          const presenter = yield* usePresenter(size);
          const observed = yield* presenter.commit(withWorkspace(view.value, workspaceOf(model)));
          const layer = observed.regionOf("box:drawer:layer");
          const pane = observed.regionOf(
            size.columns === NARROW.columns ? "box:content" : "box:inspection",
          );
          const exit = observed.boundsOf("footer:exit");
          if (layer === undefined || pane === undefined || exit === undefined) {
            throw new Error(`${kind} at ${size.columns}x${size.rows} has no layer, pane or footer`);
          }
          const envelope = size.columns >= 160 ? 102 : size.columns >= 120 ? 88 : 0;
          expect([kind, size.columns, layer.x >= envelope]).toEqual([kind, size.columns, true]);
          expect(layer.x + layer.width).toBeLessThanOrEqual(size.columns);
          expect(layer.y + layer.height).toBeLessThanOrEqual(exit.y);
          const keys =
            kind === "question"
              ? ["drawer:close", "drawer:scroll:up", "drawer:value:one"]
              : ["drawer:close", "drawer:configure:refresh"];
          for (const key of keys) {
            expect([kind, key, within(layer, observed.boundsOf(key))]).toEqual([kind, key, true]);
            expect([kind, key, within(pane, observed.boundsOf(key))]).toEqual([kind, key, true]);
          }
          expect(observed.keys.filter((key) => key === "drawer:close")).toHaveLength(1);
          if (kind === "question") {
            expect(observed.keys).not.toContain("drawer:value:last");
            expect(observed.keys).not.toContain("drawer:form:submit");
          }
        });
      }
    }
  });
});

describe("Owned renderer outcomes retained from the original journeys", () => {
  it("J1: Continue is refused while a pause is still being taken", function* () {
    const model = yield* entriesModel(0);
    const live: ReplLive = { ...IDLE, expansion: "pausing", pausable: true, running: true };
    const pending = reduceRepl(initialState("owned"), { kind: "continue" }, model, live);
    expect(pending.intent.kind).toBe("none");
    expect(pending.state.refusal).toContain("not paused");
    const held = reduceRepl(initialState("owned"), { kind: "continue" }, model, { ...live, expansion: "paused" });
    expect(held.intent.kind).toBe("continue");
    expect(held.state.refusal).toBeUndefined();
  });

  it("TL6/J1: a drawer is opaque from narrow startup through the wide round trip", function* () {
    const model = yield* entriesModel(4);
    const presenter = yield* usePresenter(NARROW);
    for (const size of [NARROW, WIDE, MEDIUM, NARROW]) {
      const closed = viewOf(model, size);
      yield* presenter.commit(closed);
      const before = presenter.grid.rows();
      const state = reduceRepl(closed.state, { kind: "open-drawer", drawer: { kind: "history" } }, model, IDLE).state;
      const open = yield* presenter.commit(viewOf(model, size, { state }));
      const layer = open.regionOf("box:drawer:layer");
      const exit = open.boundsOf("footer:exit");
      const draft = open.boundsOf("footer:input");
      if (layer === undefined || exit === undefined || draft === undefined) { throw new Error("the drawer lost its layer or footer"); }
      const covered = before.slice(layer.y, layer.y + layer.height).map((row) => row.slice(layer.x, layer.x + layer.width).trim());
      const inside = presenter.grid.textIn(layer).join("\n");
      expect(covered.some((row) => row.length > 4)).toBe(true);
      expect(inside).toContain("History");
      for (const row of covered) {
        if (row.length >= 4 && !["[↑ earlier]", "[↓ later]", "[close]"].some((label) => label.includes(row))) {
          expect([size.columns, row, inside.includes(row)]).toEqual([size.columns, row, false]);
        }
      }
      expect(exit.y).toBeGreaterThanOrEqual(layer.y + layer.height);
      expect(draft.y).toBeGreaterThanOrEqual(layer.y + layer.height);
    }
  });

  it("MC5/MC7: growing value rows take room from the chat, keep a row, and retain the narrow gutter", function* () {
    const model = yield* entriesModel(0);
    const live: ReplLive = { ...IDLE, sidekick: KERNEL_SIDEKICK };
    for (const size of [WIDE, MEDIUM, NARROW]) {
      const presenter = yield* usePresenter(size);
      let state = reduceRepl(initialState("owned"), { kind: "select-pane", pane: "sidekick" }, model, live).state;
      const view = (one: ReplState) => {
        const resolved = viewFor(one, model, live, size, "sidekick:message");
        if (!resolved.ok) { throw resolved.error; }
        return withWorkspace(resolved.value, workspaceOf(model));
      };
      const empty = yield* presenter.commit(view(state));
      const before = empty.regionOf("box:inspection:viewport") ?? empty.regionOf("box:content:viewport");
      state = reduceRepl(state, { kind: "type", field: "message", text: Array.from({ length: 8 }, (_, i) => `ROW-${i + 1}`).join("\n") }, model, live).state;
      const full = yield* presenter.commit(view(state));
      const after = full.regionOf("box:inspection:viewport") ?? full.regionOf("box:content:viewport");
      const field = full.boundsOf("sidekick:message");
      if (before === undefined || after === undefined || field === undefined) { throw new Error(`no chat or field at ${size.columns}`); }
      expect(after.height).toBeLessThan(before.height);
      expect(after.height).toBeGreaterThanOrEqual(1);
      if (size.columns === 72) {
        expect(field.x).toBe(1);
        expect(presenter.grid.at(0, field.y)).toBe(" ");
      }
    }
  });
});
