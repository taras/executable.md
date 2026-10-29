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
import { scoped } from "effection";
import type { Operation } from "effection";

import { skeletonOps } from "../src/repl/layout.ts";
import { entryInitialBindings, projectRepl } from "../src/repl/model.ts";
import type { ReplModel } from "../src/repl/model.ts";
import { EntrySegmentStream } from "../src/repl/entries.ts";
import { navigationOf } from "../src/repl/navigation.ts";
import { NO_LIFECYCLE } from "../src/repl/lifecycle.ts";
import type { ReplActionCandidate, ReplBounds } from "../src/repl/layout.ts";
import type { ReplWindow } from "../src/repl/layout-admission.ts";
import { admitActions } from "../src/repl/layout-admission.ts";
import type { ReplLive, ReplState, ReplView } from "../src/repl/application.ts";
import type { ReplRenderer } from "../src/repl/renderer.ts";
import { prepareFrame } from "../src/repl/program.ts";
import {
  ACTION_ROW,
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
import { usePresenter, windowOf } from "./fixtures/repl/presentation.ts";
import { referenceEvents } from "./fixtures/repl/reference.ts";
import { useReplPage } from "./support/mounted-page.ts";
import type { PageFrame, ReplPage } from "./support/mounted-page.ts";
import {
  draft,
  entrySettles,
  focusCycle,
  frameAt,
  openCatalog,
  paste,
  scrollUntil,
} from "./support/repl-page-adapters.ts";

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

function projected(events: readonly DurableEvent[]): ReplModel {
  const result = projectRepl(events);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

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
  yield* useTempFileCompiler();
  const physical = new InMemoryStream();
  for (let at = 1; at <= count; at += 1) {
    const settled = yield* physical.readAll();
    const execution = yield* executeInstalled(
      {
        ...inlineSource(`# Entry ${at}\n\nThe ${at} th reading of this history.\n`),
        stream: new EntrySegmentStream(physical),
      },
      [],
      { initialBindings: settled.length === 0 ? {} : entryInitialBindings(projected(settled)) },
    );
    yield* collect(execution);
  }
  return projected(yield* physical.readAll());
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

/** The window the frame measured under this name, or a failure naming the ones it did. */
function windowIn(frame: PageFrame, name: string): ReplWindow {
  const held = frame.windows.get(name);
  if (held === undefined) {
    throw new Error(
      `this frame measured no ${name} window; it measured ${[...frame.windows.keys()].join(", ")}`,
    );
  }
  return held;
}

/** Submit one entry through the Draft and wait for the History rail to mark it settled. */
function* submit(page: ReplPage, order: number, source: string): Operation<void> {
  yield* paste(page, draft(page), source);
  yield* page.key("Enter");
  yield* entrySettles(page, order, "ok");
}

const CATALOG_ENTRIES = 10;
const entryKey = (order: number): string => `entry:entry-${order}`;
const entryLabel = (order: number): string => `${order}. [ok] entry-${order}`;

/**
 * A page at the narrowest size with its Entries catalog open over ten entries.
 *
 * The entries are submitted where the History rail marks each of them, and the
 * terminal is made narrow afterwards: the catalog's window holds six rows at
 * the narrowest size, so ten of them overflow it.
 */
function* catalogOverEntries(): Operation<ReplPage> {
  const page = yield* useReplPage({ size: WIDE });
  for (let order = 1; order <= CATALOG_ENTRIES; order += 1) {
    yield* submit(page, order, `Entry ${order} text.`);
  }
  yield* page.resize(NARROW);
  yield* openCatalog(page);
  return page;
}

/** A reading long enough that no region holds it: forty paragraphs, one row each. */
const LONG_READING = Array.from({ length: 40 }, (_unused, at) => `VACATED-${at}`).join("\n\n");

/** The measured extent of one control on a one-row action row. */
const extentAt = (x: number, width: number): ReplBounds => ({ x, y: 0, width, height: 1 });

/** Controls offered to an action row, each measured under the id `box:` and its key. */
const offered = (...keys: string[]): readonly ReplActionCandidate[] =>
  keys.map((key) => ({ key, id: `box:${key}`, control: true }));

/** The row's answer to "where did this control land", from literal extents. */
const boundsIn =
  (extents: Readonly<Record<string, ReplBounds>>) =>
  (id: string): ReplBounds | undefined =>
    extents[id.replace(/^box:/, "")];

/** The rows the reading's viewport holds on this frame, trimmed. */
const reading = (frame: PageFrame): readonly string[] =>
  frame.area("box:reading:viewport")?.rows() ?? [];

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
    const page = yield* useReplPage({ size: WIDE });
    yield* submit(page, 1, "Entry one.");
    const few = windowIn(page.frame(), READING_WINDOW);
    expect(few.total).toBeLessThanOrEqual(few.capacity);

    yield* submit(page, 2, LONG_READING);
    const many = windowIn(
      yield* page.until(
        "the long entry being read",
        (frame) => windowIn(frame, READING_WINDOW).total > few.capacity,
      ),
      READING_WINDOW,
    );
    // The same region, so the same room. A capacity that moved with the length
    // of the reading would be measuring the reading.
    expect(many.capacity).toBe(few.capacity);
    expect(many.total).toBeGreaterThan(many.capacity);
    expect(many.count).toBeLessThanOrEqual(many.capacity);
  });

  it("TL2: an action label is measured with the focus marker it draws with", function* () {
    const page = yield* useReplPage({ size: WIDE });
    // Each control is as wide as its own label and the room its marker draws
    // in, so a pointer aimed at one reaches it and not its neighbour.
    for (const size of [WIDE, NARROW]) {
      const frame = yield* frameAt(page, size);
      for (const [key, label] of [
        ["footer:history", "[history]"],
        ["footer:exit", "[exit]"],
        ["draft:send", "[send]"],
      ]) {
        const control = frame.control(key);
        expect(control?.text).toBe(label);
        expect(control?.bounds.width).toBe(label.length + CONTROL_ROOM.length);
      }
    }
  });
});

describe("REPL layout: what a window admits", () => {
  it("TL3: a row outside the window is in no node, cell, target or Tab stop", function* () {
    const page = yield* catalogOverEntries();
    const frame = page.frame();
    const held = windowIn(frame, DRAWER_WINDOW);
    expect(held.total).toBe(CATALOG_ENTRIES);
    expect(held.capacity).toBeLessThan(held.total);
    expect(held.more).toBe(true);

    const orders = Array.from({ length: CATALOG_ENTRIES }, (_unused, at) => at + 1);
    const shown = orders.slice(held.from, held.from + held.count);
    const hidden = orders.filter((order) => !shown.includes(order));
    expect(hidden.length).toBeGreaterThan(0);

    for (const order of hidden) {
      // Not placed, so there is nothing to draw, nothing to aim at and nothing
      // for traversal to stop on.
      expect(frame.has(entryKey(order))).toBe(false);
      expect(frame.rows.some((line) => line.includes(entryLabel(order)))).toBe(false);
    }
    const forward = yield* focusCycle(page, "Tab");
    const backward = yield* focusCycle(page, "Backtab");
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
    const page = yield* catalogOverEntries();
    const frame = page.frame();
    const viewport = frame.area(`box:${DRAWER_WINDOW}:viewport`);
    if (viewport === undefined) {
      throw new Error(`this frame placed no drawer viewport. ${page.describe()}`);
    }
    const held = windowIn(frame, DRAWER_WINDOW);
    expect(held.count).toBeGreaterThan(0);
    for (let order = held.from + 1; order <= held.from + held.count; order += 1) {
      expect(viewport.contains(entryKey(order))).toBe(true);
      expect(viewport.shows(entryLabel(order))).toBe(true);
    }
  });

  it("TL3: earlier and later reach every row, including the last", function* () {
    const page = yield* catalogOverEntries();
    const last = entryKey(CATALOG_ENTRIES);
    expect(page.frame().has(last)).toBe(false);

    // Walk the window to the end the way a person does, one press at a time,
    // and stop when the final row is genuinely placed.
    const reached = yield* scrollUntil(
      page,
      { window: DRAWER_WINDOW, control: "drawer:scroll:down", toward: "more" },
      (frame) => frame.has(last),
    );
    expect(windowIn(reached, DRAWER_WINDOW).from).toBeGreaterThan(0);
    // Visible, so it is a real control with real geometry and a Tab stop.
    expect(reached.control(last)?.text).toBe(entryLabel(CATALOG_ENTRIES));
    yield* page.focus(last);
    expect(page.frame().focused).toBe(last);

    // And back: the first row is reachable again from the far end.
    const first = entryKey(1);
    expect(page.frame().has(first)).toBe(false);
    const back = yield* scrollUntil(
      page,
      { window: DRAWER_WINDOW, control: "drawer:scroll:up", toward: "less" },
      (frame) => frame.has(first),
    );
    expect(windowIn(back, DRAWER_WINDOW).from).toBe(0);
  });

  it("TL3: the first scroll after a resize moves from the clamp that is drawn", function* () {
    const page = yield* catalogOverEntries();

    // Scrolled to the very end of the smaller region, which is as far as this
    // reading goes while the terminal is this size.
    yield* scrollUntil(
      page,
      { window: DRAWER_WINDOW, control: "drawer:scroll:down", toward: "more" },
      (frame) => !windowIn(frame, DRAWER_WINDOW).more,
    );
    const atEnd = windowIn(page.frame(), DRAWER_WINDOW);
    expect(atEnd.from).toBe(atEnd.total - atEnd.capacity);
    expect(atEnd.from).toBeGreaterThan(1);

    // The terminal grows. A taller region holds more rows, so the last window
    // starts further back — the position scrolled to is now past it, and what
    // the frame draws is the clamp.
    const clamped = windowIn(
      yield* page.resize({ columns: NARROW.columns, rows: NARROW.rows + 2 }),
      DRAWER_WINDOW,
    );
    expect(clamped.capacity).toBeGreaterThan(atEnd.capacity);
    expect(clamped.from).toBeLessThan(atEnd.from);
    expect(clamped.from).toBe(clamped.total - clamped.capacity);
    // And the clamp is what is on screen: the last row really is the last one.
    expect(clamped.more).toBe(false);
    expect(page.frame().has(entryKey(CATALOG_ENTRIES))).toBe(true);

    // So the next press moves from there. Going one row earlier than the drawn
    // clamp lands one row earlier; a frame that had moved from the position
    // scrolled to instead would land two rows further on.
    yield* page.press("drawer:scroll:up");
    const moved = windowIn(
      yield* page.until(
        "the window moving earlier",
        (frame) => windowIn(frame, DRAWER_WINDOW).from !== clamped.from,
      ),
      DRAWER_WINDOW,
    );
    expect(moved.from).toBe(clamped.from - 1);
    expect(moved.more).toBe(true);
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
    const page = yield* useReplPage({ size: WIDE });
    for (const size of [WIDE, MEDIUM, NARROW]) {
      const frame = yield* frameAt(page, size);
      const actions = frame.area(ACTION_ROW);
      expect(actions?.contains("footer:history")).toBe(true);
      expect(actions?.contains("footer:exit")).toBe(true);
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
  /** Submit the long entry, then a short one that is read in its place. */
  function* shrunk(page: ReplPage): Operation<readonly string[]> {
    yield* submit(page, 1, LONG_READING);
    yield* page.until("the long entry being read", (frame) =>
      reading(frame).some((line) => line.includes("VACATED-3")),
    );
    const before = reading(page.frame());
    yield* submit(page, 2, "Short.");
    yield* page.until("the short entry being read", (frame) =>
      reading(frame).some((line) => line.includes("Short.")),
    );
    return before;
  }

  it("TL5: cells a filtered reading vacates are blank, not merely undescribed", function* () {
    const page = yield* useReplPage({ size: WIDE });
    const before = yield* shrunk(page);
    const after = reading(page.frame());

    // Pre-assert: the area about to be vacated really had text in it. Without
    // this the assertion below would pass on an empty screen.
    const kept = after.findLastIndex((line) => line.trim().length > 0) + 1;
    expect(kept).toBeGreaterThan(0);
    expect(before.slice(kept).some((line) => line.trim().length > 0)).toBe(true);

    // The reading becomes a short one. This is the one shape where a shared
    // measure-and-draw engine leaves the old text: the measurement skeleton
    // leaves these cells blank too, so a shared instance's diff has nothing to
    // say about them. Asserted against the screen Termless holds, so this is
    // what the terminal shows rather than what the last frame described.
    expect(after.join("\n")).not.toContain("VACATED-");
    expect(after.slice(kept).every((line) => line.length === 0)).toBe(true);
    expect(page.frame().rows.join("\n")).not.toContain("VACATED-");
  });

  it("TL5: the rows that remain are still drawn where the frame says", function* () {
    const page = yield* useReplPage({ size: WIDE });
    yield* shrunk(page);
    const frame = page.frame();
    expect(frame.controls.length).toBeGreaterThan(0);
    for (const placed of frame.controls) {
      expect(frame.control(placed.key)?.text).not.toBe("");
    }
    expect(frame.control("entries:heading")?.text).toBe("Entries");
    expect(frame.control("footer:history")?.text).toBe("[history]");
    expect(frame.area("box:reading:viewport")?.shows("Short.")).toBe(true);
  });
});

describe("REPL layout: the profiles this product supports", () => {
  it("TL1: every supported size keeps its columns and its two footer rows", function* () {
    const page = yield* useReplPage({ size: WIDE });
    for (const { size, profile } of [
      { size: WIDE, profile: "wide" },
      { size: MEDIUM, profile: "medium" },
      { size: NARROW, profile: "narrow" },
    ]) {
      const frame = yield* frameAt(page, size);
      expect(frame.profile).toBe(profile);
      const bounds = (id: string): ReplBounds | undefined => frame.area(id)?.bounds;
      // One identity row, the body between, then one compact History row and
      // one row of guidance, at every size.
      expect(bounds("box:identity")).toEqual({ x: 0, y: 0, width: size.columns, height: 1 });
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
      expect(frame.rows[size.rows - 2]).toContain("HISTORY");
      expect(frame.area("box:history")?.contains("footer:history")).toBe(true);
      expect(frame.area("box:draft")?.contains("footer:input")).toBe(true);
    }

    const wide = yield* frameAt(page, WIDE);
    // The first composition gives the columns 36, 66 and 58 cells, dividers
    // included, the body 33 rows and the Draft four of the centre's.
    expect(wide.area("box:sidebar")?.bounds).toMatchObject({ x: 0, width: 36, height: 33 });
    expect(wide.area("box:transcript")?.bounds).toMatchObject({ x: 36, width: 66, height: 33 });
    expect(wide.area("box:inspection")?.bounds).toMatchObject({ x: 102, width: 58, height: 33 });
    expect(wide.area("box:draft")?.bounds.height).toBe(4);
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
      expect({ where, windows: admission.windows.size > 0 }).toEqual({ where, windows: true });
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
        expect({ where, key: candidate.key, admitted, drawn: drawn.has(candidate.key) }).toEqual({
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
    expect({ beyond: window.total > window.capacity }).toEqual({ beyond: true });

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
    expect({ hidden: shown(first).length < window.total, reached: reached.length > 0 }).toEqual({
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
    expect({ whole: Number.isInteger(gap.width) && Number.isInteger(actions.width) }).toEqual({
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
