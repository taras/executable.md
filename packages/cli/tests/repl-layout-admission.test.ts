/**
 * Measured admission (#875 TL2–TL5).
 *
 * One real layout engine pair, one real Freedom tree, and a terminal cell grid
 * that accumulates what every frame actually wrote. What is under test is the invariant the whole boundary rests on: **the rows and controls a person can
 * see, focus and click are exactly the rows and controls the measured frame
 * admitted.**
 *
 * Every number asserted here comes from the frame — the geometry it published,
 * the window it measured, the cells it painted. Nothing in this file works out
 * where a row ought to be: a test that computed the answer would agree with
 * itself while the product drew something else, which is the defect the measured
 * pipeline exists to make impossible.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";

import { NARROW, profileFor, skeletonOps } from "../src/repl/layout.ts";
import { projectRepl } from "../src/repl/model.ts";
import { navigationOf } from "../src/repl/navigation.ts";
import { NO_LIFECYCLE } from "../src/repl/lifecycle.ts";
import type { ReplBounds } from "../src/repl/layout.ts";
import { useReplRenderer } from "../src/repl/renderer.ts";
import type { ReplRenderer } from "../src/repl/renderer.ts";
import { prepareFrame } from "../src/repl/program.ts";
import {
  ACTION_ROW,
  initialState,
  NO_AGENT,
  QUEUE_WINDOW,
  viewFor,
  withWorkspace,
  workspaceOf,
} from "../src/repl/application.ts";
import { useReplTree } from "../src/repl/reconcile.ts";
import type { ReplTerminalSize } from "../src/repl/terminal.ts";
import { createGrid, useCommitter, usePresenter, windowOf } from "./fixtures/repl/presentation.ts";
import { useTempFileCompiler } from "@executablemd/core";
import {
  CHECKPOINT_ASKING,
  CHECKPOINT_MEDIUM,
  CHECKPOINT_NARROW,
  CHECKPOINT_SIZE,
  checkpointModel,
  checkpointStateModel,
  checkpointViewOf,
  commitCheckpoint,
  OVERFLOW_WORKSPACE,
} from "./fixtures/repl/workspace-checkpoint.ts";
import type { Committer, Drawn, TerminalGrid } from "./fixtures/repl/presentation.ts";
import {
  EMPTY,
  ENTRIES,
  fixturePairs,
  SESSIONS,
  STANDING_ACTIONS,
} from "./fixtures/repl/surface.ts";
import type { ReplFixtureAction, ReplFixtureState, Surfaced } from "./fixtures/repl/surface.ts";

const WIDE: ReplTerminalSize = { columns: 160, rows: 36 };
const MEDIUM: ReplTerminalSize = { columns: 120, rows: 30 };

/** Forty conversations, which no supported profile can show at once. */
const MANY_SESSIONS = Object.freeze(
  Array.from({ length: 40 }, (_, at) => `conversation ${String(at).padStart(2, "0")}`),
);

/** Eighteen entries, which no sidebar share can show at once. */
const MANY_ENTRIES = Object.freeze(Array.from({ length: 18 }, (_, at) => `entry ${at + 1}`));

function stateWith(over: Partial<ReplFixtureState>): ReplFixtureState {
  return Object.freeze({ ...EMPTY, ...over });
}

/** One live screen: a real engine pair, a real tree and one accumulating grid. */
interface Screen {
  readonly committer: Committer<Surfaced>;
  readonly grid: TerminalGrid;
  /** Commit one state at one size, returning what the frame actually drew. */
  commit(state: ReplFixtureState, size: ReplTerminalSize): Operation<Drawn<Surfaced>>;
  /** Measure and admit one state without mounting or drawing anything. */
  measure(state: ReplFixtureState, size: ReplTerminalSize): Operation<Drawn<Surfaced>["admission"]>;
  resize(size: ReplTerminalSize): void;
}

/**
 * A screen that commits whatever state it is handed.
 *
 * The builder is rebuilt per commit because the state is: what a frame shows is
 * derived from one immutable reading, so a new reading is a new builder rather
 * than a mutation of the last one.
 */
function* useScreen(size: ReplTerminalSize): Operation<Screen> {
  const renderer = yield* useReplRenderer(size);
  const tree = yield* useReplTree<Surfaced>();
  const grid = createGrid();
  let current = size;
  const screen: Screen = {
    get committer(): Committer<Surfaced> {
      throw new Error("commit through `commit`, so the builder matches the state");
    },
    grid,
    *commit(state, at) {
      const committer = yield* useCommitter<Surfaced>({
        size: at,
        tree,
        renderer,
        source: fixturePairs(state, at),
        grid,
      });
      return yield* committer.commit();
    },
    *measure(state, at) {
      const committer = yield* useCommitter<Surfaced>({
        size: at,
        tree,
        renderer,
        source: fixturePairs(state, at),
        grid,
      });
      return yield* committer.measure();
    },
    resize(next) {
      current = next;
      renderer.resize(next);
    },
  };
  // `current` is read by nothing else; holding it documents that a resize tells
  // the engines before the next frame is built for the new size.
  void current;
  return screen;
}

/** Every description key one frame mounted, sorted for a stable comparison. */
function keysOf(drawn: Drawn<Surfaced>): string[] {
  return [...drawn.keys].sort();
}

/** The whole focus cycle, as Tab visits it from wherever focus is now. */
function* tabCycle(drawn: Drawn<Surfaced>, limit = 200): Operation<string[]> {
  const visited: string[] = [];
  for (let step = 0; step < limit; step += 1) {
    const moved = yield* drawn.tree.dispatch({ kind: "key", key: "Tab" });
    if (!moved.ok || moved.value.outcome !== "focus") {
      break;
    }
    const key =
      moved.value.focused === undefined ? undefined : drawn.tree.keyOf(moved.value.focused);
    if (key === undefined) {
      break;
    }
    if (visited.includes(key)) {
      break;
    }
    visited.push(key);
  }
  return visited;
}

/** The whole cycle in reverse, as Backtab visits it. */
function* backtabCycle(drawn: Drawn<Surfaced>, limit = 200): Operation<string[]> {
  const visited: string[] = [];
  for (let step = 0; step < limit; step += 1) {
    const moved = yield* drawn.tree.dispatch({ kind: "key", key: "Backtab" });
    if (!moved.ok || moved.value.outcome !== "focus") {
      break;
    }
    const key =
      moved.value.focused === undefined ? undefined : drawn.tree.keyOf(moved.value.focused);
    if (key === undefined || visited.includes(key)) {
      break;
    }
    visited.push(key);
  }
  return visited;
}

/** The viewport one window was measured in, read from the committed frame. */
function viewportOf(drawn: Drawn<Surfaced>, window: string): ReplBounds {
  const slot = drawn.manifest.viewports.find((one) => one.window === window);
  if (slot === undefined) {
    throw new Error(`this frame placed no ${window} viewport`);
  }
  const bounds = drawn.regionOf(slot.id);
  if (bounds === undefined) {
    throw new Error(`this frame published no geometry for the ${window} viewport`);
  }
  return bounds;
}

describe("REPL layout: what an empty measurement describes", () => {
  it("TL2: a measured viewport holds no node, no cell and no target", function* () {
    const screen = yield* useScreen(WIDE);
    const state = stateWith({ sessions: MANY_SESSIONS, entries: MANY_ENTRIES });
    // The measuring pass describes every scrolling viewport empty. It is the
    // same walk the commit uses, so if it mounted anything the commit would be
    // reconciling against a tree the measurement had already changed.
    const admission = yield* screen.measure(state, WIDE);
    expect(screen.grid.rows()).toEqual([]);
    expect(windowOf(admission, SESSIONS).capacity).toBeGreaterThan(0);
    expect(windowOf(admission, ENTRIES).capacity).toBeGreaterThan(0);
    // Nothing was mounted and nothing was painted by measuring.
    const drawn = yield* screen.commit(state, WIDE);
    expect(drawn.rendered.map.targets.length).toBeGreaterThan(0);
  });

  it("TL2: capacity describes the region, not whatever is overflowing it", function* () {
    const screen = yield* useScreen(WIDE);
    const few = yield* screen.measure(
      stateWith({ sessions: MANY_SESSIONS.slice(0, 3), entries: MANY_ENTRIES }),
      WIDE,
    );
    const many = yield* screen.measure(
      stateWith({ sessions: MANY_SESSIONS, entries: MANY_ENTRIES }),
      WIDE,
    );
    // The same region, so the same room. A capacity that moved with the length
    // of the list would be measuring the list.
    expect(windowOf(many, SESSIONS).capacity).toBe(windowOf(few, SESSIONS).capacity);
    expect(windowOf(few, SESSIONS).total).toBe(3);
    expect(windowOf(many, SESSIONS).total).toBe(40);
  });

  it("TL2: an action label is measured with the focus marker it draws with", function* () {
    const screen = yield* useScreen(WIDE);
    const drawn = yield* screen.commit(stateWith({ sessions: MANY_SESSIONS }), WIDE);
    // Each control is as wide as its own label, so a pointer aimed at one
    // reaches it and not its neighbour.
    for (const action of STANDING_ACTIONS) {
      const bounds = drawn.boundsOf(action.key);
      expect(bounds).toBeDefined();
      expect(bounds?.width).toBe(action.label.length);
    }
  });
});

describe("REPL layout: what a window admits", () => {
  it("TL3: a row outside the window is in no node, cell, target or Tab stop", function* () {
    const screen = yield* useScreen(WIDE);
    const state = stateWith({ sessions: MANY_SESSIONS, entries: MANY_ENTRIES });
    const drawn = yield* screen.commit(state, WIDE);
    const held = windowOf(drawn.admission, SESSIONS);
    expect(held.total).toBe(40);
    expect(held.capacity).toBeLessThan(held.total);
    expect(held.more).toBe(true);

    const shown = MANY_SESSIONS.slice(held.from, held.from + held.count);
    const hidden = MANY_SESSIONS.filter((one) => !shown.includes(one));
    expect(hidden.length).toBeGreaterThan(0);

    const keys = keysOf(drawn);
    for (const session of hidden) {
      const key = `session:${session}`;
      // Not mounted, so there is nothing to draw, nothing to aim at and
      // nothing for traversal to stop on.
      expect(keys).not.toContain(key);
      expect(drawn.nodeOf(key)).toBeUndefined();
      expect(drawn.cellOf(key)).toBeUndefined();
      expect(drawn.boundsOf(key)).toBeUndefined();
    }
    const cycle = yield* tabCycle(drawn);
    for (const session of hidden) {
      expect(cycle).not.toContain(`session:${session}`);
    }
    // And the same in reverse: a hidden row is not reachable from either side.
    const reverse = yield* backtabCycle(drawn);
    for (const session of hidden) {
      expect(reverse).not.toContain(`session:${session}`);
    }
    for (const session of shown) {
      expect(cycle).toContain(`session:${session}`);
    }
  });

  it("TL3: no row is drawn outside the viewport it was admitted to", function* () {
    const screen = yield* useScreen(WIDE);
    const drawn = yield* screen.commit(
      stateWith({ sessions: MANY_SESSIONS, entries: MANY_ENTRIES }),
      WIDE,
    );
    const viewport = viewportOf(drawn, SESSIONS);
    const held = windowOf(drawn.admission, SESSIONS);
    for (const session of MANY_SESSIONS.slice(held.from, held.from + held.count)) {
      const bounds = drawn.boundsOf(`session:${session}`);
      expect(bounds).toBeDefined();
      if (bounds === undefined) {
        continue;
      }
      expect(bounds.y).toBeGreaterThanOrEqual(viewport.y);
      expect(bounds.y).toBeLessThan(viewport.y + viewport.height);
    }
  });

  it("TL3: earlier and later reach every row, including the last", function* () {
    const screen = yield* useScreen(WIDE);
    const last = MANY_SESSIONS[MANY_SESSIONS.length - 1];
    let offsets: Record<string, number> = {};
    let reached = false;
    let seen = 0;
    // Walk the window to the end the way a person does, one press at a time,
    // and stop when the final row is genuinely mounted.
    for (let press = 0; press < 60; press += 1) {
      const state = stateWith({ sessions: MANY_SESSIONS, entries: MANY_ENTRIES, offsets });
      const drawn = yield* screen.commit(state, WIDE);
      const held = windowOf(drawn.admission, SESSIONS);
      seen = held.from;
      if (drawn.nodeOf(`session:${last}`) !== undefined) {
        reached = true;
        // Visible, so it is a real target with real geometry.
        expect(drawn.boundsOf(`session:${last}`)).toBeDefined();
        expect(yield* tabCycle(drawn)).toContain(`session:${last}`);
        break;
      }
      if (!held.more) {
        break;
      }
      offsets = { ...offsets, [SESSIONS]: held.from + 1 };
    }
    expect(reached).toBe(true);
    expect(seen).toBeGreaterThan(0);
  });

  it("TL3: the first scroll after a resize moves from the clamp that is drawn", function* () {
    const screen = yield* useScreen(MEDIUM);
    const state = stateWith({ sessions: MANY_SESSIONS, entries: MANY_ENTRIES });

    // Scrolled to the very end of the smaller region, which is as far as this
    // reading goes while the terminal is this size.
    const medium = yield* screen.commit(state, MEDIUM);
    const narrowRoom = windowOf(medium.admission, SESSIONS);
    const far = narrowRoom.total - narrowRoom.capacity;
    const atEnd = stateWith({ ...state, offsets: { [SESSIONS]: far } });
    const settled = yield* screen.commit(atEnd, MEDIUM);
    expect(windowOf(settled.admission, SESSIONS).from).toBe(far);
    expect(windowOf(settled.admission, SESSIONS).more).toBe(false);

    // The terminal grows. A taller region holds more rows, so the last window
    // starts further back — the stored offset is now past it, and what the
    // frame draws is the clamp.
    screen.resize(WIDE);
    const wide = yield* screen.commit(atEnd, WIDE);
    const clamped = windowOf(wide.admission, SESSIONS);
    expect(clamped.capacity).toBeGreaterThan(narrowRoom.capacity);
    expect(clamped.from).toBeLessThan(far);
    expect(clamped.from).toBe(clamped.total - clamped.capacity);
    // And the clamp is what is on screen: the last row really is the last one.
    expect(clamped.more).toBe(false);

    // So the next press moves from there. Asking to go one row earlier than
    // the *drawn* clamp lands one row earlier; a frame that had moved from the
    // stored number instead would still be showing the clamp.
    const back = stateWith({ ...state, offsets: { [SESSIONS]: clamped.from - 1 } });
    const moved = yield* screen.commit(back, WIDE);
    expect(windowOf(moved.admission, SESSIONS).from).toBe(clamped.from - 1);
    expect(windowOf(moved.admission, SESSIONS).more).toBe(true);
  });
});

describe("REPL layout: what an action row admits", () => {
  /** Controls wide enough that the narrowest supported row cannot hold them all. */
  const CROWDED: readonly ReplFixtureAction[] = Object.freeze([
    Object.freeze({ key: "footer:history", label: "[history]" }),
    Object.freeze({ key: "footer:exit", label: "[exit]" }),
    Object.freeze({ key: "footer:pause", label: "[pause expansion now]" }),
    Object.freeze({ key: "footer:continue", label: "[continue expansion now]" }),
    Object.freeze({ key: "footer:live", label: "[return to the live head]" }),
    Object.freeze({ key: "footer:answer", label: "[answer the open question]" }),
  ]);

  it("TL4: a row too narrow for everything admits a whole prefix only", function* () {
    const screen = yield* useScreen(NARROW);
    const drawn = yield* screen.commit(stateWith({ actions: CROWDED }), NARROW);
    const admitted = CROWDED.filter((one) => drawn.admission.actions.has(one.key));
    const omitted = CROWDED.filter((one) => !drawn.admission.actions.has(one.key));
    expect(omitted.length).toBeGreaterThan(0);

    // A contiguous prefix of the offered order, and nothing after the break.
    expect(admitted.map((one) => one.key)).toEqual(
      CROWDED.slice(0, admitted.length).map((one) => one.key),
    );
    // The way out stays, because it comes first.
    expect(drawn.admission.actions.has("footer:history")).toBe(true);
    expect(drawn.admission.actions.has("footer:exit")).toBe(true);

    const row = drawn.manifest.actions;
    expect(row).toBeDefined();
    const keys = keysOf(drawn);
    for (const one of omitted) {
      expect(keys).not.toContain(one.key);
      expect(drawn.boundsOf(one.key)).toBeUndefined();
    }
    const cycle = yield* tabCycle(drawn);
    for (const one of omitted) {
      expect(cycle).not.toContain(one.key);
    }
  });

  it("TL4: every admitted control is drawn whole, inside the row", function* () {
    const screen = yield* useScreen(NARROW);
    const drawn = yield* screen.commit(stateWith({ actions: CROWDED }), NARROW);
    const footer = drawn.regionOf("box:footer:actions");
    expect(footer).toBeDefined();
    if (footer === undefined) {
      return;
    }
    for (const one of CROWDED) {
      if (!drawn.admission.actions.has(one.key)) {
        continue;
      }
      const bounds = drawn.boundsOf(one.key);
      expect(bounds).toBeDefined();
      if (bounds === undefined) {
        continue;
      }
      // Whole: its own trailing edge is inside the row's, so no part of it is
      // drawn off the end where a person could see it and not hit it.
      expect(bounds.width).toBe(one.label.length);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(footer.x + footer.width);
    }
  });

  it("TL4: a control the row cannot hold does not let a narrower one past it", function* () {
    const screen = yield* useScreen(NARROW);
    // The third control is far too wide for the narrowest row; the fourth
    // would fit in what is left. Order is priority, so neither is admitted.
    const ordered: readonly ReplFixtureAction[] = Object.freeze([
      Object.freeze({ key: "footer:history", label: "[history]" }),
      Object.freeze({ key: "footer:exit", label: "[exit]" }),
      Object.freeze({ key: "footer:wide", label: `[${"w".repeat(90)}]` }),
      Object.freeze({ key: "footer:narrow", label: "[x]" }),
    ]);
    const drawn = yield* screen.commit(stateWith({ actions: ordered }), NARROW);
    expect(drawn.admission.actions.has("footer:history")).toBe(true);
    expect(drawn.admission.actions.has("footer:exit")).toBe(true);
    expect(drawn.admission.actions.has("footer:wide")).toBe(false);
    // The whole point: it fits, and it is still not admitted, because the row
    // stopped at the first control it could not hold whole.
    expect(drawn.admission.actions.has("footer:narrow")).toBe(false);
    expect(keysOf(drawn)).not.toContain("footer:narrow");
    expect(yield* tabCycle(drawn)).not.toContain("footer:narrow");
  });
});

describe("REPL layout: what a shrinking reading leaves behind", () => {
  it("TL5: cells a filtered reading vacates are blank, not merely undescribed", function* () {
    const screen = yield* useScreen(WIDE);
    const many = stateWith({ sessions: MANY_SESSIONS, entries: MANY_ENTRIES });
    const first = yield* screen.commit(many, WIDE);
    const viewport = viewportOf(first, SESSIONS);
    const held = windowOf(first.admission, SESSIONS);
    expect(held.count).toBeGreaterThan(3);

    // Pre-assert: the area about to be vacated really has text in it now.
    const vacating: ReplBounds = {
      x: viewport.x,
      y: viewport.y + 2,
      width: viewport.width,
      height: held.count - 2,
    };
    expect(screen.grid.nonblank(vacating).length).toBeGreaterThan(0);

    // The filter: a long conversation reading becomes a short one. This is the
    // one shape where a shared measure-and-draw engine leaves the old text —
    // the measurement skeleton leaves these cells blank too, so a shared
    // instance's diff has nothing to say about them.
    const few = stateWith({ sessions: MANY_SESSIONS.slice(0, 2), entries: MANY_ENTRIES });
    yield* screen.commit(few, WIDE);

    // Asserted against the accumulated grid, so this is what the terminal
    // shows rather than what the last frame happened to describe.
    expect(screen.grid.nonblank(vacating)).toEqual([]);
  });

  it("TL5: the rows that remain are still drawn where the frame says", function* () {
    const screen = yield* useScreen(WIDE);
    yield* screen.commit(stateWith({ sessions: MANY_SESSIONS, entries: MANY_ENTRIES }), WIDE);
    const after = yield* screen.commit(
      stateWith({ sessions: MANY_SESSIONS.slice(0, 2), entries: MANY_ENTRIES }),
      WIDE,
    );
    for (const session of MANY_SESSIONS.slice(0, 2)) {
      const bounds = after.boundsOf(`session:${session}`);
      expect(bounds).toBeDefined();
      if (bounds === undefined) {
        continue;
      }
      expect(screen.grid.textIn(bounds)[0]).toContain(session);
    }
  });
});

describe("REPL layout: the profiles this product supports", () => {
  it("TL1: every supported size keeps its columns and its seven footer rows", function* () {
    for (const size of [WIDE, MEDIUM, NARROW]) {
      yield* scoped(function* (): Operation<void> {
        const screen = yield* useScreen(size);
        const drawn = yield* screen.commit(
          stateWith({ sessions: MANY_SESSIONS, entries: MANY_ENTRIES }),
          size,
        );
        expect(drawn.manifest.profile).toBe(profileFor(size));
        const footer = drawn.regionOf("box:footer");
        expect(footer).toEqual({
          x: 0,
          y: size.rows - 7,
          width: size.columns,
          height: 7,
        });
        // Five band rows, and the draft on the last one.
        expect(drawn.manifest.history.rows.length).toBe(5);
        const draft = drawn.boundsOf("footer:input");
        expect(draft?.y).toBe(size.rows - 1);
      });
    }
  });
});

/**
 * #971 A2: what the staged composition admits at each supported size.
 *
 * The same invariant the rest of this file is about, asked of the screen the
 * workspace draws: every window the frame measured holds a whole number of rows
 * it has room for, every control it published was drawn, and nothing it left
 * out is reachable. The geometry those numbers come from is a proposal under
 * image review; that each of them is measured rather than computed here is not.
 */
describe("REPL layout: what the staged workspace admits at each size", () => {
  it("A2: every measured window is whole, bounded and reachable", function* () {
    yield* useTempFileCompiler();
    const model = yield* checkpointModel();
    for (const size of [CHECKPOINT_SIZE, CHECKPOINT_MEDIUM, CHECKPOINT_NARROW]) {
      const where = `${size.columns}x${size.rows}`;
      const presenter = yield* usePresenter(size);
      const committed = yield* commitCheckpoint(presenter, {
        model,
        size,
        workspace: OVERFLOW_WORKSPACE,
      });
      const { admission, manifest } = committed.observed.committed;

      // A window holds whole rows, never more than its capacity, and never a
      // capacity it did not measure.
      expect({ where, windows: admission.windows.size > 0 }).toEqual({ where, windows: true });
      for (const slot of manifest.viewports) {
        const window = windowOf(admission, slot.window);
        const bounds = committed.observed.regionOf(slot.id);
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
        committed.observed.targets.flatMap((one) => {
          const key = presenter.tree.keyOf(one.node);
          return key === undefined ? [] : [key];
        }),
      );
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

  // The capacity a window is admitted against has to be the capacity of the
  // region the frame will draw. A scrolling viewport stretched by its own rows
  // reports the room its contents wanted, and one measured before the controls
  // that sit around it reports a rectangle that is about to move — so what the
  // preparation measured last and what it finally describes would be two
  // different regions that happen to agree.
  //
  // Read by watching the preparation's own measurements go past. Nothing here
  // changes an operation or a returned rectangle; the same production
  // `prepareFrame` runs against the same real engine.
  it("A2: the measurement the queue is admitted from is empty, with its controls around it", function* () {
    yield* useTempFileCompiler();
    const model = yield* checkpointStateModel();
    const size = CHECKPOINT_MEDIUM;
    const presenter = yield* usePresenter(size);
    const view = checkpointViewOf(model, undefined, {
      size,
      live: CHECKPOINT_ASKING,
      workspace: OVERFLOW_WORKSPACE,
    });
    const viewport = `box:${QUEUE_WINDOW}:viewport`;
    const row = /^box:inspection:queue:.*:row:\d+:row$/;
    const seen: {
      bounds: ReplBounds | undefined;
      rows: number;
      earlier: boolean;
      later: boolean;
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
            earlier: ids.includes("box:inspection:queue:earlier"),
            later: ids.includes("box:inspection:queue:later"),
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
    // This tray holds more rows than its column allocated it, which is the
    // case the viewport exists for at all.
    const window = windowOf(prepared.value.admission, QUEUE_WINDOW);
    expect({ beyond: window.total > window.capacity }).toEqual({ beyond: true });

    // The last measurement that held the viewport is the one the admission
    // above came from.
    const last = seen[seen.length - 1];
    if (last === undefined) {
      throw new Error("this preparation measured no queue viewport");
    }
    expect({ rows: last.rows, earlier: last.earlier, later: last.later }).toEqual({
      rows: 0,
      earlier: true,
      later: true,
    });

    // And it is the region the frame describes: the same rectangle the final
    // manifest places that viewport at, measured by the same engine.
    const final = yield* delegate.measure(
      skeletonOps(prepared.value.presentation.manifest.root),
      size,
    );
    if (!final.ok) {
      throw final.error;
    }
    expect(last.bounds).toEqual(final.value.boundsOf(viewport));
    // Both controls are outside it, which is why it starts where it does.
    const above = final.value.boundsOf("box:inspection:queue:earlier");
    const below = final.value.boundsOf("box:inspection:queue:later");
    if (above === undefined || below === undefined || last.bounds === undefined) {
      throw new Error("this frame drew the queue without its own controls");
    }
    expect({
      above: above.y + above.height <= last.bounds.y,
      below: below.y >= last.bounds.y + last.bounds.height,
    }).toEqual({ above: true, below: true });
  });

  // The accepted wide row is a fitted map, a gap and the controls. The gap and
  // the controls both grew, so the engine divided what the map left between
  // them — in halves, and half of an odd number of cells is not a cell. The
  // accepted fixture's map happens to leave an even remainder, so nothing said
  // the arrangement only worked for even ones. An ordinary empty root leaves an
  // odd one, and every control after the gap landed on half a cell.
  it("A2: the wide History row divides an odd remainder into whole cells", function* () {
    const empty = projectRepl([]);
    if (!empty.ok) {
      throw empty.error;
    }
    const size = CHECKPOINT_SIZE;
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
