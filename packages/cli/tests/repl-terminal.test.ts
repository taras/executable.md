/**
 * The terminal platform (#848 F1, H1, H2).
 *
 * One real Freedom tree, one real layout engine, and a terminal the test owns
 * completely. What is under test is the platform Slice E sits on: that a
 * described screen lays out the same way every time at four sizes, that what
 * was rendered is what a pointer resolves against, that presentation time has
 * one owner, and that every way out of the terminal gives it back.
 *
 * The terminal is injected through the contextual Api, so nothing here reads
 * `Deno`, `process` or a platform name, and the same corpus runs under Deno,
 * Node and Bun. The runtime adapters are constructed but never installed — that
 * is Slice E's turn.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  ensure,
  Err,
  type Operation,
  resource,
  type Result,
  scoped,
  sleep,
  spawn,
  type Stream,
  type Subscription,
  suspend,
  until,
  withResolvers,
} from "effection";

import { HISTORY_ROWS, NARROW, profileFor } from "../src/repl/layout.ts";
import type { ReplBounds, ReplRegion } from "../src/repl/layout.ts";
import { ReplRenderError, resolvePointer, useReplRenderer } from "../src/repl/renderer.ts";
import type { ReplMeasured, ReplRendered, ReplRenderer } from "../src/repl/renderer.ts";
import { createGrid, useCommitter } from "./fixtures/repl/presentation.ts";
import type { Drawn, TerminalGrid } from "./fixtures/repl/presentation.ts";
import { close, fixed, open, percent, text } from "@bomb.sh/tty";
import type { Op } from "@bomb.sh/tty";
import { nearestCommonAncestor, ReplClock, useReplFrames } from "../src/repl/frame.ts";
import type { ReplFrameSubscription } from "../src/repl/frame.ts";
import { replModes, useReplScreen } from "../src/repl/screen.ts";
import type { ReplScreenEvent } from "../src/repl/screen.ts";
import { installReplTerminal, nodeInputStream } from "../src/repl/terminal-host.ts";
import { readerStream } from "../src/deno-terminal-surface.ts";
import type { NodeShapedInput, ReplTerminalCapabilities } from "../src/repl/terminal-host.ts";
import type { ReplTerminalSize } from "../src/repl/terminal.ts";
import { useReplTree } from "../src/repl/reconcile.ts";
import type { ReplDispatched, ReplTree } from "../src/repl/reconcile.ts";
import type { ReplInputEvent } from "../src/repl/description.ts";
import {
  EMPTY,
  fixturePairs,
  STANDING_ACTIONS,
  type ReplFixtureState,
  type Surfaced,
} from "./fixtures/repl/surface.ts";

/** A screen with something on it, so placement has something to place. */
const FILLED: ReplFixtureState = {
  route: "entries",
  sessions: ["kf39sla2"],
  entries: ["entry-1"],
  scopes: ["entry-1/component", "entry-1/generated"],
  transcript: ["About to evaluate: the plan", "Decision: approve"],
  bindings: [
    { name: "plan", value: "ship it" },
    { name: "response", value: "approve" },
  ],
  history: [
    { marker: "yield:__root__:1", label: "root 1" },
    { marker: "close:__root__", label: "root close" },
  ],
  drawer: undefined,
  drawerLines: ["Close"],
  actions: STANDING_ACTIONS,
  windowed: false,
  draft: "",
  offsets: {},
  capture: "capture",
};

/** Let every task that is ready take its turn. */
function* settled(): Operation<void> {
  yield* sleep(0);
  yield* sleep(0);
  yield* sleep(0);
}

function bounds(frame: Drawn<Surfaced>, region: ReplRegion): ReplBounds | undefined {
  return frame.boundsOfRegion(region);
}

function regions(frame: Drawn<Surfaced>): string[] {
  return [...frame.regions];
}

function textsIn(frame: Drawn<Surfaced>, region: ReplRegion): string[] {
  return frame.inRegion(region).map((key) => frame.cellOf(key) ?? "");
}

function committed(outcome: { ok: boolean; error?: Error }): void {
  if (!outcome.ok) {
    throw outcome.error;
  }
}

/** What one dispatch produced, or a failure naming what came back instead. */
function acted(outcome: { ok: boolean; value?: unknown; error?: Error }): ReplDispatched<Surfaced> {
  if (!outcome.ok) {
    throw outcome.error;
  }
  const value = outcome.value;
  if (typeof value !== "object" || value === null || !("outcome" in value)) {
    throw new Error("a dispatch answers with a closed outcome");
  }
  const outcomeValue = value.outcome;
  if (outcomeValue === "action" && "action" in value && "ancestry" in value) {
    const action = value.action;
    const ancestry = value.ancestry;
    if (isSurfaced(action) && Array.isArray(ancestry)) {
      return { outcome: "action", action, ancestry: ancestry.map(String) };
    }
  }
  if (outcomeValue === "focus" && "focused" in value) {
    const focused = value.focused;
    return { outcome: "focus", focused: typeof focused === "string" ? focused : undefined };
  }
  if (outcomeValue === "dropped" && "reason" in value && typeof value.reason === "string") {
    return { outcome: "dropped", reason: value.reason };
  }
  throw new Error(
    `a dispatch answered with something this test does not recognize: ${outcomeValue}`,
  );
}

/** Whether a value is one of the fixture's actions, decided by parsing it. */
function isSurfaced(value: unknown): value is Surfaced {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return false;
  }
  const kind = value.kind;
  return (
    kind === "select-session" ||
    kind === "select-entry" ||
    kind === "select-scope" ||
    kind === "select-marker" ||
    kind === "close-drawer" ||
    kind === "submit" ||
    kind === "insert" ||
    kind === "erase"
  );
}

/**
 * Commit one fixture state at one size, through the product's own pipeline.
 *
 * Measured, admitted, reconciled and drawn: the four steps in the order the
 * screen itself does them. What comes back is the frame that was drawn, so every
 * number asserted against it is a number the engine gave.
 */
function* mounted(
  state: ReplFixtureState,
  size: ReplTerminalSize = { columns: 160, rows: 36 },
): Operation<{
  readonly tree: ReplTree<Surfaced>;
  readonly frame: Drawn<Surfaced>;
  readonly grid: TerminalGrid;
  readonly renderer: ReplRenderer;
}> {
  const renderer = yield* useReplRenderer(size);
  const tree = yield* useReplTree<Surfaced>();
  const grid = createGrid();
  const committer = yield* useCommitter<Surfaced>({
    size,
    tree,
    renderer,
    source: fixturePairs(state, size),
    grid,
  });
  return { tree, frame: yield* committer.commit(), grid, renderer };
}

/**
 * A committer one test can drive across several states and sizes.
 *
 * The same engine pair and the same tree throughout, because what a later frame
 * writes is the difference from the frame before it — which is the whole subject
 * of the isolation and stale-text rows.
 */
function* driving(size: ReplTerminalSize): Operation<{
  readonly tree: ReplTree<Surfaced>;
  readonly renderer: ReplRenderer;
  readonly grid: TerminalGrid;
  commit(state: ReplFixtureState, at?: ReplTerminalSize): Operation<Drawn<Surfaced>>;
}> {
  const renderer = yield* useReplRenderer(size);
  const tree = yield* useReplTree<Surfaced>();
  const grid = createGrid();
  return {
    tree,
    renderer,
    grid,
    *commit(state, at = size) {
      const committer = yield* useCommitter<Surfaced>({
        size: at,
        tree,
        renderer,
        source: fixturePairs(state, at),
        grid,
      });
      return yield* committer.commit();
    },
  };
}

describe("REPL terminal: responsive semantic frames", () => {
  it("F1: a wide frame carries the sidebar, transcript, inspection and fixed footer", function* () {
    const { tree, frame } = yield* mounted(FILLED, { columns: 160, rows: 36 });

    expect(frame.manifest.profile).toBe("wide");
    expect(regions(frame)).toEqual(["sidebar", "transcript", "inspection", "footer"]);
    expect(bounds(frame, "sidebar")).toEqual({ x: 0, y: 0, width: 32, height: 29 });
    expect(bounds(frame, "transcript")).toEqual({ x: 32, y: 0, width: 92, height: 29 });
    expect(bounds(frame, "inspection")).toEqual({ x: 124, y: 0, width: 36, height: 29 });
    // Full width and pinned to the bottom, at every size.
    expect(bounds(frame, "footer")).toEqual({ x: 0, y: 29, width: 160, height: 7 });
    expect(frame.manifest.history.rows).toHaveLength(HISTORY_ROWS);
    expect(frame.manifest.profile).not.toBe("too-small");

    expect(textsIn(frame, "sidebar")).toEqual([
      "Sessions",
      "kf39sla2",
      "Entries",
      "entry-1",
      "entry-1/component",
      "entry-1/generated",
    ]);
    expect(textsIn(frame, "transcript")).toEqual([
      "About to evaluate: the plan",
      "Decision: approve",
    ]);
    expect(textsIn(frame, "inspection")).toEqual(["plan = ship it", "response = approve"]);
    // The footer's own mounted rows: the action row's controls and the draft.
    // The History band is not among them — its labels come from the model rather
    // than from a node, so it is text the frame places and no row contributed.
    // Where those five rows land is asserted on its own, below.
    expect(textsIn(frame, "footer")).toEqual(["[history]", "[exit]", "> "]);
    expect(tree.mounted()).toHaveLength(frame.keys.length);
  });

  it("F1: a medium frame keeps every region, narrower", function* () {
    const { frame } = yield* mounted(FILLED, { columns: 120, rows: 30 });

    expect(frame.manifest.profile).toBe("medium");
    expect(regions(frame)).toEqual(["sidebar", "transcript", "inspection", "footer"]);
    expect(bounds(frame, "sidebar")).toEqual({ x: 0, y: 0, width: 28, height: 23 });
    expect(bounds(frame, "transcript")).toEqual({ x: 28, y: 0, width: 64, height: 23 });
    expect(bounds(frame, "inspection")).toEqual({ x: 92, y: 0, width: 28, height: 23 });
    expect(bounds(frame, "footer")).toEqual({ x: 0, y: 23, width: 120, height: 7 });
    expect(frame.manifest.history.rows).toHaveLength(HISTORY_ROWS);
  });

  it("F1: a narrow frame routes one content surface and keeps the drawer and footer", function* () {
    const { frame } = yield* mounted({ ...FILLED, drawer: "Binding: plan" }, NARROW);

    expect(frame.manifest.profile).toBe("narrow");
    expect(regions(frame)).toEqual(["content", "drawer", "footer"]);
    expect(bounds(frame, "content")).toEqual({ x: 0, y: 0, width: 72, height: 13 });
    // The same footer contract as the wide frame: full width, five History rows.
    expect(bounds(frame, "footer")).toEqual({ x: 0, y: 13, width: 72, height: 7 });
    expect(frame.manifest.history.rows).toHaveLength(HISTORY_ROWS);
    expect(bounds(frame, "drawer")).toEqual({ x: 9, y: 1, width: 54, height: 11 });
    // Its title, both window controls, its one content row and the way out.
    // The two window controls are new (#875 R1): every drawer scrolls, and they
    // sit outside the content they move.
    expect(textsIn(frame, "drawer")).toEqual([
      "Binding: plan",
      "[↑ earlier]",
      "Close",
      "[↓ later]",
      "[close]",
    ]);
    // One surface, the routed one, and nothing from the others.
    expect(textsIn(frame, "content")).toEqual([
      "Entries",
      "entry-1",
      "entry-1/component",
      "entry-1/generated",
    ]);
    expect(textsIn(frame, "content")).not.toContain("kf39sla2");
    expect(textsIn(frame, "content")).not.toContain("Decision: approve");
  });

  it("F1: narrow shows the routed surface, and no other surface is reachable", function* () {
    const routes = [
      { route: "sessions", shown: ["Sessions", "kf39sla2"], hidden: "entry-1" },
      {
        route: "entries",
        shown: ["Entries", "entry-1", "entry-1/component", "entry-1/generated"],
        hidden: "kf39sla2",
      },
    ] as const;

    for (const { route, shown, hidden } of routes) {
      yield* scoped(function* (): Operation<void> {
        const state: ReplFixtureState = { ...FILLED, route };
        const { tree, frame } = yield* mounted(state, NARROW);

        // Only the routed surface's rows.
        expect(textsIn(frame, "content")).toEqual(shown);

        // The other surface is **absent**, not hidden. A narrow frame has one
        // region, so a row of the surface it is not showing would be mounted and
        // focusable with nowhere to be drawn — which is why it is not described
        // at all rather than described and left out of the frame.
        const other = tree.mounted().filter((id) => {
          const key = tree.keyOf(id);
          return key !== undefined && key.endsWith(hidden);
        });
        expect(other).toEqual([]);
        expect(frame.keys.filter((key) => key.endsWith(hidden))).toEqual([]);

        // And nowhere a pointer can land reaches one of them.
        for (let row = 0; row < NARROW.rows; row += 1) {
          for (let column = 0; column < NARROW.columns; column += 8) {
            const pointer = resolvePointer(frame.rendered, { column, row });
            if (pointer !== undefined) {
              expect(tree.keyOf(pointer.target)?.endsWith(hidden) ?? false).toBe(false);
            }
          }
        }
      });
    }
  });

  it("F1: below the minimum the frame is an explicit refusal with nothing targetable", function* () {
    for (const size of [
      { columns: 71, rows: 20 },
      { columns: 72, rows: 19 },
      { columns: 40, rows: 10 },
    ]) {
      yield* scoped(function* (): Operation<void> {
        const { frame } = yield* mounted(FILLED, size);
        expect(profileFor(size)).toBe("too-small");
        expect(frame.manifest.profile).toBe("too-small");
        expect(regions(frame)).toEqual(["refusal"]);
        // A control that is not in the frame cannot be in its target map either.
        expect(frame.targets).toEqual([]);
        expect(frame.keys).toEqual([]);
        expect(frame.manifest.history.rows).toHaveLength(HISTORY_ROWS);
      });
    }
  });

  it("F1: Sessions says so when there is nothing in it", function* () {
    const { frame } = yield* mounted(EMPTY, { columns: 160, rows: 36 });

    expect(textsIn(frame, "sidebar")).toEqual(["Sessions: none yet", "Entries"]);
    expect(textsIn(frame, "transcript")).toEqual([]);
    expect(frame.manifest.profile).toBe("wide");
  });

  it("F1: compact geometry groups marker labels and keeps every marker's identity", function* () {
    const history = Array.from({ length: 40 }, (_unused, index) => ({
      marker: `yield:entry-1:${index}`,
      label: `entry-1 yield ${index}`,
    }));
    const wide = (yield* mounted({ ...FILLED, history }, { columns: 160, rows: 36 })).frame;
    const narrow = yield* scoped(function* () {
      return (yield* mounted({ ...FILLED, history }, NARROW)).frame;
    });

    // Every marker survives at both sizes, once each, under its own name.
    for (const frame of [wide, narrow]) {
      expect(frame.manifest.history.markers.map((marker) => marker.marker)).toEqual(
        history.map((one) => one.marker),
      );
      expect(frame.manifest.history.rows).toHaveLength(HISTORY_ROWS);
    }
    // Wide has room for its own labels; narrow shares them.
    expect(wide.manifest.history.markers.every((marker) => marker.grouped.length === 0)).toBe(true);
    expect(narrow.manifest.history.markers.some((marker) => marker.grouped.length > 0)).toBe(true);
    const shared = narrow.manifest.history.markers.filter(
      (marker) => marker.label === narrow.manifest.history.markers[0].label,
    );
    expect(shared.length).toBeGreaterThan(1);
    // A grouped marker names the others it shares a label with, so the identity
    // of a compact position is still recoverable.
    expect(narrow.manifest.history.markers[0].grouped).toEqual(
      shared.slice(1).map((marker) => marker.marker),
    );
    expect(narrow.manifest.history.markers[0].label).toContain("+");
  });

  it("F1: resizing through every profile keeps selection, nodes and action identity", function* () {
    const driver = yield* driving({ columns: 160, rows: 36 });
    const sizes = [
      { columns: 160, rows: 36 },
      { columns: 120, rows: 30 },
      NARROW,
      { columns: 40, rows: 10 },
    ];
    const first = yield* driver.commit(FILLED, sizes[0]);
    const focused = driver.tree.focused();
    /** Which node each key is mounted under, for one frame. */
    const identities = (frame: Drawn<Surfaced>): Map<string, string> =>
      new Map(frame.keys.map((key) => [key, frame.nodeOf(key) ?? ""]));
    const before = identities(first);
    expect(before.size).toBeGreaterThan(0);

    // Across the three drawable profiles, a smaller frame admits fewer rows —
    // that is what measured admission is for. What resizing must not do is
    // *rename* anything: every row that is still shown is the same node it
    // was, so the selection and the focus survive the move.
    const profiles = [first.manifest.profile];
    for (const size of sizes.slice(1, 3)) {
      driver.renderer.resize(size);
      const frame = yield* driver.commit(FILLED, size);
      profiles.push(frame.manifest.profile);

      const now = identities(frame);
      const shared = [...now.keys()].filter((key) => before.has(key));
      expect(shared.length).toBeGreaterThan(0);
      for (const key of shared) {
        expect([key, now.get(key)]).toEqual([key, before.get(key)]);
      }
      expect(driver.tree.focused()).toBe(focused);
      // And the same control still means the same thing.
      const outcome = acted(yield* driver.tree.dispatch({ kind: "key", key: "Enter" }));
      expect(outcome.outcome).toBe("action");
      if (outcome.outcome === "action") {
        expect(outcome.action).toEqual({ kind: "submit" });
      }
    }

    // Below the minimum there is nothing to keep: that frame draws its refusal
    // and places no control, so the tree it commits holds no control either.
    driver.renderer.resize(sizes[3]);
    const refused = yield* driver.commit(FILLED, sizes[3]);
    profiles.push(refused.manifest.profile);
    expect(profiles).toEqual(["wide", "medium", "narrow", "too-small"]);
    expect(refused.targets).toEqual([]);

    // And it recovers: growing the window back shows exactly the rows it
    // showed before. Their node ids are new, because the refusal unmounted
    // them — a screen that places nothing holds nothing — so what recovery
    // means here is the same screen, not the same nodes.
    driver.renderer.resize(sizes[0]);
    const back = yield* driver.commit(FILLED, sizes[0]);
    expect([...identities(back).keys()].sort()).toEqual([...before.keys()].sort());
    expect(back.targets.length).toBeGreaterThan(0);
  });

  it("UI5: the History band is placed in the footer, not at the frame's origin", function* () {
    for (const size of [{ columns: 160, rows: 36 }, NARROW]) {
      yield* scoped(function* (): Operation<void> {
        const { frame, grid } = yield* mounted(FILLED, size);
        const footer = bounds(frame, "footer");
        expect(footer).toBeDefined();
        if (footer === undefined) {
          throw new Error("every drawable frame has a footer");
        }

        // Five rows, in the footer, between the one action row above them and
        // the draft below them. Read from where the band's own rows were
        // actually drawn: a band with five rows and nowhere to put them is what
        // drew over the sidebar.
        expect(frame.manifest.history.rows).toHaveLength(HISTORY_ROWS);
        const placed = Array.from({ length: HISTORY_ROWS }, (_unused, row) =>
          frame.regionOf(`box:band:${row}`),
        );
        for (const [row, at] of placed.entries()) {
          expect(at).toEqual({
            x: footer.x,
            y: footer.y + 1 + row,
            width: footer.width,
            height: 1,
          });
          // Inside the footer, and never at the origin, which is the sidebar's.
          expect(at?.y).toBeGreaterThan(footer.y);
          expect(at?.y).toBeLessThan(footer.y + footer.height - 1);
        }

        // Each row is the full width, so a band that gets shorter cannot leave
        // the tail of the position that used to be there.
        for (const row of frame.manifest.history.rows) {
          expect(row).toHaveLength(size.columns);
        }
        // And what the terminal actually holds on those rows is the band.
        const band = grid.textIn({
          x: footer.x,
          y: footer.y + 1,
          width: footer.width,
          height: HISTORY_ROWS,
        });
        expect(band[0]).toContain("root 1");
      });
    }
  });

  it("UI5: a refusal has no band to place and no cell to aim at", function* () {
    const { frame, grid } = yield* mounted(FILLED, { columns: 40, rows: 10 });

    expect(frame.manifest.profile).toBe("too-small");
    // No band row placed at all rather than an empty rectangle: a renderer given
    // a zero rectangle draws five rows into it.
    expect(frame.regionOf("box:band:0")).toBeUndefined();
    // The sentence and nothing else. It is the frame's own — below the minimum
    // there is no row to describe — so it is read off the terminal rather than
    // off a mounted node, and nothing on this screen is a target.
    expect(frame.keys).toEqual([]);
    expect(frame.targets).toEqual([]);
    const shown = grid.rows().join(" ");
    expect(shown).toContain("larger");
    expect(shown).toContain("Escape");
  });

  it("UI5: every visible action has its own geometry in the frame's target map", function* () {
    const { frame } = yield* mounted(FILLED, { columns: 160, rows: 36 });
    const footer = bounds(frame, "footer");
    if (footer === undefined) {
      throw new Error("every drawable frame has a footer");
    }
    const { map } = frame.rendered;

    // The action row's controls sit side by side on one row, each as wide as
    // its own label — so a pointer on one reaches that one and not its
    // neighbour. Stacked rows would have cost the band and the draft theirs.
    const reachable = frame.targets.filter((target) => {
      const at = target.bounds;
      return at.y >= footer.y && at.y < footer.y + footer.height;
    });
    // The draft owns the last footer row and shares it with nothing, so it is
    // not one of the action row's controls even though a pointer reaches it.
    const draft = reachable.filter((one) => one.bounds.y === footer.y + footer.height - 1);
    expect(draft).toHaveLength(1);
    expect(map.boundsOf(draft[0].id)).toEqual(draft[0].bounds);

    const placed = reachable.filter((one) => one.bounds.y === footer.y);
    expect(placed.length).toBeGreaterThan(1);
    expect(placed.length + draft.length).toBe(reachable.length);
    for (const one of placed) {
      expect(one.bounds.height).toBe(1);
      // And every column of it answers with this node and no other.
      for (let x = one.bounds.x; x < one.bounds.x + one.bounds.width; x += 1) {
        expect([x, map.at(x, one.bounds.y)]).toEqual([x, one.node]);
      }
    }

    // No two of them overlap, which is what makes the column a pointer lands
    // on an unambiguous answer.
    const sorted = [...placed].sort((one, other) => one.bounds.x - other.bounds.x);
    for (let at = 1; at < sorted.length; at += 1) {
      const left = sorted[at - 1].bounds;
      expect(sorted[at].bounds.x).toBeGreaterThanOrEqual(left.x + left.width);
    }

    // The band is not a control: it is read, and the positions it labels are
    // selected in the History drawer. So no column of it answers a pointer.
    for (let row = 0; row < HISTORY_ROWS; row += 1) {
      const at = frame.regionOf(`box:band:${row}`);
      expect(at).toBeDefined();
      expect([row, map.at(0, at?.y ?? -1)]).toEqual([row, undefined]);
    }
  });

  it("F1: a pointer against a control the refusal hides reaches nothing", function* () {
    const driver = yield* driving(NARROW);
    const visible = yield* driver.commit(FILLED, NARROW);
    const footer = visible.targets.find(
      (target) => driver.tree.keyOf(target.node) === "footer:input",
    );
    expect(footer).toBeDefined();
    if (footer === undefined) {
      throw new Error("the narrow frame draws the footer input");
    }
    // The same place, now under a refusal.
    driver.renderer.resize({ columns: 40, rows: 10 });
    const refused = yield* driver.commit(FILLED, { columns: 40, rows: 10 });
    expect(refused.targets).toEqual([]);
    expect(
      resolvePointer(refused.rendered, { column: footer.bounds.x, row: footer.bounds.y }),
    ).toBeUndefined();
  });
});

/** A clock the test moves, so "no timer" is something it can observe. */
interface TestClock {
  /** How many waits were ever scheduled. */
  waits: number;
  now: number;
  install(): Operation<void>;
  /** Advance and release every wait outstanding right now. */
  tick(seconds: number): Operation<void>;
}

function controllableClock(): TestClock {
  let pending: (() => void)[] = [];
  const clock: TestClock = {
    waits: 0,
    now: 0,
    install(): Operation<void> {
      return ReplClock.around(
        {
          // deno-lint-ignore require-yield
          *now(): Operation<number> {
            return clock.now;
          },
          *wait(): Operation<void> {
            clock.waits += 1;
            const waiter = withResolvers<void>();
            pending.push(() => waiter.resolve());
            yield* waiter.operation;
          },
        },
        { at: "min" },
      );
    },
    *tick(seconds: number): Operation<void> {
      clock.now += seconds;
      const releasing = pending;
      pending = [];
      for (const release of releasing) {
        release();
      }
      yield* settled();
    },
  };
  return clock;
}

describe("REPL terminal: frame and renderer ownership", () => {
  it("H1: a frame advances only once every subscriber has applied the last one", function* () {
    const clock = controllableClock();
    yield* clock.install();
    const frames = yield* useReplFrames();

    // One ancestor, two participants beneath it: one animation, one clock.
    const first = yield* frames.subscribe({
      owner: "page",
      participants: [
        ["left", "page", "root"],
        ["right", "page", "root"],
      ],
    });
    const second = yield* frames.subscribe({ owner: "footer", participants: [["footer"]] });
    if (!first.ok) {
      throw first.error;
    }
    if (!second.ok) {
      throw second.error;
    }
    yield* settled();

    expect(frames.demanded()).toBe(true);
    expect(frames.published()).toBe(0);
    expect(clock.waits).toBe(1);

    yield* clock.tick(1 / 60);
    expect(frames.published()).toBe(1);
    expect(frames.outstanding()).toBe(2);
    // Nothing further is scheduled while anybody still owes this frame.
    expect(clock.waits).toBe(1);

    const received = yield* first.value.next();
    expect(received.id).toBe(1);
    expect(received.delta).toBe(0);
    yield* settled();
    // Received, not applied: drawing with a timestamp suspends, and the stream
    // has to wait for the drawing rather than for the handover.
    expect(first.value.received()).toBe(1);
    expect(first.value.applied()).toBe(0);
    expect(frames.outstanding()).toBe(2);
    expect(clock.waits).toBe(1);

    first.value.acknowledge();
    yield* settled();
    expect(first.value.applied()).toBe(1);
    expect(frames.outstanding()).toBe(1);
    expect(clock.waits).toBe(1);

    yield* second.value.next();
    second.value.acknowledge();
    yield* settled();
    expect(frames.outstanding()).toBe(0);
    // Now, and only now.
    expect(clock.waits).toBe(2);

    yield* clock.tick(1 / 30);
    expect(frames.published()).toBe(2);
    const later = yield* first.value.next();
    expect(later.id).toBe(2);
    // Seconds, because that is what the layout engine's transitions take.
    expect(later.delta).toBeCloseTo(1 / 30, 6);
  });

  it("H1: a subscriber holding a frame holds the whole stream until it applies it", function* () {
    const clock = controllableClock();
    yield* clock.install();
    const frames = yield* useReplFrames();

    const holding = yield* frames.subscribe({ owner: "page", participants: [["page"]] });
    const prompt = yield* frames.subscribe({ owner: "footer", participants: [["footer"]] });
    if (!holding.ok) {
      throw holding.error;
    }
    if (!prompt.ok) {
      throw prompt.error;
    }
    yield* settled();
    yield* clock.tick(1 / 60);

    // One receives its frame and holds it, as a subscriber does while it is
    // laying out and drawing.
    const held = yield* holding.value.next();
    expect(held.id).toBe(1);
    // The other applies and says so.
    yield* prompt.value.next();
    prompt.value.acknowledge();
    yield* settled();

    // Still one frame, still one timer: the holder's work has not finished.
    expect(frames.published()).toBe(1);
    expect(frames.outstanding()).toBe(1);
    expect(clock.waits).toBe(1);
    // Releasing the clock changes nothing while the frame is unapplied.
    yield* clock.tick(1 / 60);
    expect(frames.published()).toBe(1);
    expect(clock.waits).toBe(1);

    holding.value.acknowledge();
    yield* settled();
    expect(frames.outstanding()).toBe(0);
    expect(clock.waits).toBe(2);
  });

  it("H1: cancelling a holder drops its demand without claiming it applied anything", function* () {
    const clock = controllableClock();
    yield* clock.install();
    const frames = yield* useReplFrames();

    const prompt = yield* frames.subscribe({ owner: "footer", participants: [["footer"]] });
    if (!prompt.ok) {
      throw prompt.error;
    }

    // The handle is read *after* the cancellation has fully unwound, not from
    // inside a destructor: destructors run in reverse, so a reading registered
    // by the holder would run before the subscription's own teardown and would
    // miss anything that teardown did.
    let handle: ReplFrameSubscription | undefined;
    const holder = yield* spawn(function* (): Operation<void> {
      const held = yield* frames.subscribe({ owner: "page", participants: [["page"]] });
      if (!held.ok) {
        throw held.error;
      }
      handle = held.value;
      // Received, and then cancelled part-way through applying it.
      yield* held.value.next();
      yield* suspend();
    });
    yield* settled();
    yield* clock.tick(1 / 60);
    yield* settled();

    yield* prompt.value.next();
    prompt.value.acknowledge();
    yield* settled();
    expect(frames.outstanding()).toBe(1);
    expect(clock.waits).toBe(1);

    yield* holder.halt();
    yield* settled();

    // Its demand is gone, so the stream moves; its acknowledgement never
    // arrived, because it never finished the frame.
    expect(handle?.received()).toBe(1);
    expect(handle?.applied()).toBe(0);
    expect(frames.outstanding()).toBe(0);
    expect(clock.waits).toBe(2);
    // The frame it was holding is not counted as drawn anywhere.
    expect(frames.published()).toBe(1);
  });

  it("H1: no demand outlives a subscription, at any turn of its life", function* () {
    // The same walk, for the other resource this slice publishes: whichever turn
    // puts the subscriber in the demand set, the removal for it already exists.
    for (let turns = 0; turns <= 6; turns += 1) {
      const clock = controllableClock();
      yield* scoped(function* (): Operation<void> {
        yield* clock.install();
        const frames = yield* useReplFrames();

        const task = yield* spawn(function* (): Operation<void> {
          const held = yield* frames.subscribe({ owner: "page", participants: [["page"]] });
          if (!held.ok) {
            throw held.error;
          }
          yield* suspend();
        });
        for (let turn = 0; turn < turns; turn += 1) {
          yield* sleep(0);
        }
        yield* task.halt();
        yield* settled();

        expect(frames.demanded()).toBe(false);
        expect(frames.outstanding()).toBe(0);
      });
    }
  });

  it("H1: a settled tree schedules no timer at all", function* () {
    const clock = controllableClock();
    yield* clock.install();
    const frames = yield* useReplFrames();

    yield* settled();
    expect(frames.demanded()).toBe(false);
    expect(clock.waits).toBe(0);

    const holder = yield* spawn(function* (): Operation<void> {
      const held = yield* frames.subscribe({ owner: "page", participants: [["page"]] });
      if (!held.ok) {
        throw held.error;
      }
      yield* suspend();
    });
    yield* settled();
    expect(clock.waits).toBe(1);

    yield* holder.halt();
    yield* settled();
    expect(frames.demanded()).toBe(false);
    yield* clock.tick(1);
    yield* settled();
    // The released wait published nothing and scheduled nothing after it.
    expect(frames.published()).toBe(0);
    expect(clock.waits).toBe(1);
  });

  it("H1: a cross-component animation belongs to exactly its nearest common ancestor", function* () {
    const clock = controllableClock();
    yield* clock.install();
    const frames = yield* useReplFrames();
    const participants = [
      ["left", "page", "root"],
      ["right", "page", "root"],
    ];

    expect(nearestCommonAncestor(participants)).toBe("page");

    const owned = yield* frames.subscribe({ owner: "page", participants });
    expect(owned.ok).toBe(true);

    // A participant cannot own it: its own lifetime is shorter than the
    // animation's.
    const byParticipant = yield* frames.subscribe({ owner: "left", participants });
    expect(byParticipant.ok).toBe(false);
    // Nor can a grandparent: it would hold the clock for a subtree that stopped.
    const byAncestor = yield* frames.subscribe({ owner: "root", participants });
    expect(byAncestor.ok).toBe(false);
    if (byAncestor.ok) {
      throw new Error("a distant ancestor must not own this animation");
    }
    expect(byAncestor.error.name).toBe("ReplFrameOwnerError");
    expect(byAncestor.error.message).toContain("page");

    yield* settled();
    // The two refusals registered no demand, so there is exactly one clock.
    expect(clock.waits).toBe(1);
    yield* clock.tick(1 / 60);
    expect(frames.outstanding()).toBe(1);
  });

  it("H1: rendered bytes are copied out before the engine reuses its view", function* () {
    const driver = yield* driving(NARROW);
    const narrow = yield* driver.commit(FILLED, NARROW);
    const held = narrow.rendered.output;
    const witnessed = Array.from(held);
    expect(witnessed.length).toBeGreaterThan(0);

    // A second render writes over the engine's output region, and a resize
    // grows its memory, which detaches every view into the old buffer.
    driver.renderer.resize({ columns: 120, rows: 30 });
    yield* driver.commit(FILLED, { columns: 120, rows: 30 });
    driver.renderer.resize({ columns: 160, rows: 36 });
    yield* driver.commit(FILLED, { columns: 160, rows: 36 });

    expect(Array.from(held)).toEqual(witnessed);
  });

  it("H1: what a caller does to bytes it holds cannot change a later render", function* () {
    // The same three frames through two renderers. One caller scribbles over
    // every result it is handed; the other leaves them alone. A renderer whose
    // result aliased the engine's memory would have the scribbling corrupt the
    // state the next frame is diffed against, and the two sequences would part.
    const sequence: readonly ReplTerminalSize[] = [NARROW, { columns: 120, rows: 30 }, NARROW];

    const tampered: number[][] = [];
    yield* scoped(function* (): Operation<void> {
      const driver = yield* driving(NARROW);
      for (const size of sequence) {
        driver.renderer.resize(size);
        const rendered = (yield* driver.commit(FILLED, size)).rendered;
        tampered.push(Array.from(rendered.output));
        rendered.output.fill(0);
      }
    });

    const clean: number[][] = [];
    yield* scoped(function* (): Operation<void> {
      const driver = yield* driving(NARROW);
      for (const size of sequence) {
        driver.renderer.resize(size);
        clean.push(Array.from((yield* driver.commit(FILLED, size)).rendered.output));
      }
    });

    expect(tampered[0].length).toBeGreaterThan(0);
    expect(tampered).toEqual(clean);
  });

  it("H1: a frame drawn after a removal draws only what is still mounted", function* () {
    const driver = yield* driving({ columns: 160, rows: 36 });
    const before = yield* driver.commit(FILLED, { columns: 160, rows: 36 });
    const going = driver.tree
      .mounted()
      .find((id) => driver.tree.keyOf(id) === "scope:entry-1/generated");
    if (going === undefined) {
      throw new Error("the generated scope row is mounted before the removal");
    }
    expect(before.keys).toContain("scope:entry-1/generated");

    // The reading loses that row, and the next frame is committed from it.
    const after = yield* driver.commit(
      { ...FILLED, scopes: ["entry-1/component"] },
      { columns: 160, rows: 36 },
    );
    expect(driver.tree.mounted()).not.toContain(going);

    // The mounted tree is the only source of renderable nodes: a row that has
    // gone is not drawn, and is therefore not a target either.
    expect(after.rendered.map.targets.map((target) => target.node)).not.toContain(going);
    expect(after.keys).not.toContain("scope:entry-1/generated");
    expect(after.rendered.map.targets.length).toBeGreaterThan(0);
  });

  it("H1: capacity replacement redraws the identical logical frame", function* () {
    // Deliberately more than any of the four profiles produces: the engine's
    // measurement arenas are sized from the dimensions it was built for, and
    // what this proves is that a renderer built when the terminal was tiny
    // recovers rather than refusing the frame the terminal now needs.
    const bindings = Array.from({ length: 1000 }, (_unused, index) => ({
      name: `binding-${index}`,
      value: `a fairly long recorded value for binding number ${index}`,
    }));
    const huge: ReplTerminalSize = { columns: 160, rows: 1010 };
    yield* scoped(function* (): Operation<void> {
      // Built for a terminal far smaller than the frame it is about to be given.
      const driver = yield* driving({ columns: 20, rows: 5 });
      const rendered = yield* driver.commit({ ...FILLED, bindings }, huge);

      expect(rendered.keys.length).toBeGreaterThan(900);
      expect(rendered.rendered.recovered).toBe(true);
      // The same logical frame: the same tree and real targets. Recovery is
      // invisible above this line.
      expect(rendered.rendered.tree).toBe(driver.tree.frame().id);
      expect(rendered.rendered.map.targets.length).toBeGreaterThan(0);

      // One replacement each, and no more: a frame this much larger than the
      // terminal these engines were built for overflows both arenas, so each
      // refuses once on its own pass and is rebuilt at the frame's own size.
      expect(driver.renderer.engines()).toEqual({ measuring: 2, drawing: 2 });

      // Drawn again at the same size, it needs no recovery and places the same
      // controls under the same ids.
      const repeated = yield* driver.commit({ ...FILLED, bindings }, huge);
      expect(repeated.rendered.recovered).toBe(false);
      expect(repeated.rendered.map.targets.map((target) => target.id)).toEqual(
        rendered.rendered.map.targets.map((target) => target.id),
      );
      // Reused, not rebuilt: drawing the same frame again creates nothing.
      expect(driver.renderer.engines()).toEqual({ measuring: 2, drawing: 2 });
    });
  });
});

/** Everything the fake terminal was asked to do, and what it still holds. */
interface TerminalLog {
  /** Every raw-mode change, in order. */
  readonly raw: boolean[];
  /** Suspending writes that completed. */
  writes: number;
  /** Unsuspending writes, which is how the final reset is written. */
  resets: number;
  /** Resize listeners still attached. */
  listeners: number;
  /** Byte sources still open. */
  readers: number;
  /** Byte sources ever opened. */
  opened: number;
  /** Whether a read is outstanding right now. */
  reading: boolean;
  /** How many times the input stream's cleanup has run. */
  cleanups: number;
  /** When set, the input stream's cleanup suspends on this until it is released. */
  holdCleanup: Operation<void> | undefined;
  /** Make the next cleanup suspend, so a test can prove the owner joins it. */
  holdNextCleanup(): void;
  /** Release a held cleanup. */
  releaseCleanup(): void;
  /** Fail the outstanding read, the way a terminal that broke mid-read does. */
  fail(cause: Error): void;
  size: ReplTerminalSize;
  /** When set, a suspending write never completes. */
  hold: boolean;
  feed(bytes: Uint8Array): void;
  end(): void;
  resized(size: ReplTerminalSize): void;
}

/** A terminal the test owns completely, and a host that installs it. */
function recordingTerminal(size: ReplTerminalSize = { columns: 160, rows: 36 }): {
  log: TerminalLog;
  install(): Operation<void>;
} {
  const queue: Uint8Array[] = [];
  const watchers = new Set<() => void>();
  /** The outstanding read, which only the fake or its cleanup may settle. */
  let waiting:
    | {
        resolve(result: IteratorResult<Uint8Array, void>): void;
        reject(cause: Error): void;
      }
    | undefined;
  let ended = false;
  let release: (() => void) | undefined;

  const log: TerminalLog = {
    raw: [],
    writes: 0,
    resets: 0,
    listeners: 0,
    readers: 0,
    opened: 0,
    reading: false,
    cleanups: 0,
    holdCleanup: undefined,
    size,
    hold: false,
    holdNextCleanup(): void {
      const held = withResolvers<void>();
      release = held.resolve;
      log.holdCleanup = held.operation;
    },
    releaseCleanup(): void {
      const open = release;
      release = undefined;
      log.holdCleanup = undefined;
      open?.();
    },
    fail(cause: Error): void {
      const pending = waiting;
      waiting = undefined;
      log.reading = false;
      pending?.reject(cause);
    },
    feed(bytes: Uint8Array): void {
      const pending = waiting;
      if (pending === undefined) {
        queue.push(bytes);
        return;
      }
      waiting = undefined;
      log.reading = false;
      pending.resolve({ done: false, value: bytes });
    },
    end(): void {
      ended = true;
      const pending = waiting;
      if (pending !== undefined) {
        waiting = undefined;
        log.reading = false;
        pending.resolve({ done: true, value: undefined });
      }
    },
    resized(next: ReplTerminalSize): void {
      log.size = next;
      for (const watcher of watchers) {
        watcher();
      }
    },
  };

  const host: ReplTerminalCapabilities = {
    interactive: () => true,
    size(): ReplTerminalSize {
      return log.size;
    },
    *write(_bytes: Uint8Array): Operation<void> {
      if (log.hold) {
        // Never completes: what a terminal that has stopped accepting bytes
        // looks like from here, and where a cancellation can land.
        yield* suspend();
      }
      log.writes += 1;
      // A write that completed, which still costs the caller a turn.
      yield* sleep(0);
    },
    writeNow(_bytes: Uint8Array): void {
      log.resets += 1;
    },
    setRaw(raw: boolean): void {
      log.raw.push(raw);
    },
    input(): Stream<Uint8Array, void> {
      return resource<Subscription<Uint8Array, void>>(function* (provide) {
        let open = false;
        // Registered before the reader is acquired: a scope cancelled between
        // the two must leave nothing holding the terminal's input.
        yield* ensure(function* (): Operation<void> {
          log.cleanups += 1;
          if (open) {
            open = false;
            log.readers -= 1;
            // Actively cancelled. A cleanup that waited for this read to end on
            // its own would need another keystroke to get one — which is the
            // defect this stream exists to remove.
            const pending = waiting;
            waiting = undefined;
            log.reading = false;
            pending?.resolve({ done: true, value: undefined });
          }
          const held = log.holdCleanup;
          if (held !== undefined) {
            yield* held;
          }
        });
        log.readers += 1;
        log.opened += 1;
        open = true;
        yield* provide({
          *next(): Operation<IteratorResult<Uint8Array, void>> {
            // Always one suspension per chunk, buffered or not: the reader turns
            // one chunk into many decoded events, and draining a buffer without
            // yielding hands them over faster than the scanner takes them.
            const pending = withResolvers<IteratorResult<Uint8Array, void>>();
            const head = queue.shift();
            if (head !== undefined) {
              pending.resolve({ done: false, value: head });
            } else if (ended) {
              pending.resolve({ done: true, value: undefined });
            } else {
              log.reading = true;
              waiting = { resolve: pending.resolve, reject: pending.reject };
            }
            return yield* pending.operation;
          },
        });
      });
    },
    onResize(listener: () => void): () => void {
      watchers.add(listener);
      log.listeners += 1;
      return () => {
        watchers.delete(listener);
        log.listeners -= 1;
      };
    },
  };

  return { log, install: () => installReplTerminal(host) };
}

/** What every exit owes the terminal. */
function givenBack(log: TerminalLog): void {
  // Exactly once, however the owner ended.
  expect(log.resets).toBe(1);
  expect(log.raw[log.raw.length - 1]).toBe(false);
  expect(log.listeners).toBe(0);
  expect(log.readers).toBe(0);
  expect(log.reading).toBe(false);
  // One cleanup for each time the source was opened, and no more: a cleanup that
  // ran twice would release something twice, and one that never ran would have
  // left a reader on the terminal. A scope cancelled before the stream was ever
  // subscribed opened nothing and so owes nothing — 0 and 0 is the same claim.
  expect(log.cleanups).toBe(log.opened);
}

const BYTES = new TextEncoder();

/** Wait for one screen event of this kind, over a bounded number of turns. */
function* until_(
  events: { next(): Operation<IteratorResult<ReplScreenEvent, void>> },
  kind: ReplScreenEvent["kind"],
): Operation<void> {
  for (let turn = 0; turn < 40; turn += 1) {
    const next = yield* events.next();
    if (next.done === true) {
      throw new Error(`the screen ended before it said ${kind}`);
    }
    if (next.value.kind === kind) {
      return;
    }
  }
  throw new Error(`the screen never said ${kind}`);
}

/**
 * A readable whose reader fails the way a host's can.
 *
 * Structural, so a row can put a rejecting `cancel()` or a throwing
 * `releaseLock()` behind the production stream — which `Deno.stdin` will never do
 * on request, and which is exactly the case that decides whether a command
 * reports an orderly exit over a read it never joined.
 */
function failingReadable(options: {
  readonly cancel?: "reject" | "resolve";
  readonly release?: "throw" | "return";
}): {
  readonly source: object;
  readonly steps: () => string[];
} {
  const steps: string[] = [];
  const source = {
    getReader(): object {
      return {
        read(): Promise<IteratorResult<Uint8Array>> {
          steps.push("read");
          // Never settles on its own: what a terminal with nobody typing at it
          // looks like, and the only state in which releasing it is interesting.
          return new Promise<IteratorResult<Uint8Array>>(() => {});
        },
        cancel(): Promise<void> {
          steps.push("cancel");
          return options.cancel === "reject"
            ? Promise.reject(new Error("the host would not cancel the read"))
            : Promise.resolve();
        },
        releaseLock(): void {
          steps.push("releaseLock");
          if (options.release === "throw") {
            throw new Error("the host would not release the lock");
          }
        },
      };
    },
  };
  return { source, steps: () => [...steps] };
}

describe("REPL terminal: releasing this host's standard input", () => {
  it("UI2: a cancellation that fails is a terminal failure, not a quiet exit", function* () {
    const readable = failingReadable({ cancel: "reject" });
    let raised: Error | undefined;

    try {
      yield* scoped(function* (): Operation<void> {
        const reading = yield* readerStream(readable.source);
        yield* spawn(function* (): Operation<void> {
          // One read outstanding, which nothing will ever satisfy.
          yield* reading.next();
        });
        yield* sleep(0);
      });
    } catch (error) {
      raised = error instanceof Error ? error : new Error(String(error));
    }

    // The failure is reported rather than swallowed: a command that returned an
    // orderly outcome here would be claiming it joined a read it did not.
    expect(raised).toBeDefined();
    expect(raised?.message).toContain("would not cancel");
    // And both steps were still attempted: the lock is what the next thing to run
    // needs released, so it is not skipped because cancelling failed.
    expect(readable.steps()).toEqual(["read", "cancel", "releaseLock"]);
  });

  it("UI2: a lock that will not release is a terminal failure too", function* () {
    const readable = failingReadable({ release: "throw" });
    let raised: Error | undefined;

    try {
      yield* scoped(function* (): Operation<void> {
        const reading = yield* readerStream(readable.source);
        yield* spawn(function* (): Operation<void> {
          yield* reading.next();
        });
        yield* sleep(0);
      });
    } catch (error) {
      raised = error instanceof Error ? error : new Error(String(error));
    }

    expect(raised?.message).toContain("would not release");
    expect(readable.steps()).toEqual(["read", "cancel", "releaseLock"]);
  });

  it("UI2: a release that fails fabricates no end of input, and restores once", function* () {
    const readable = failingReadable({ cancel: "reject" });
    const terminal = recordingTerminal();
    const clock = controllableClock();
    const seen: string[] = [];
    let raised: Error | undefined;

    try {
      yield* scoped(function* (): Operation<void> {
        // The production stream, behind the production terminal host and screen,
        // over a reader that cannot be released.
        yield* installReplTerminal({
          interactive: () => true,
          size: () => terminal.log.size,
          write: () => sleep(0),
          writeNow: () => {
            terminal.log.resets += 1;
          },
          setRaw: (raw: boolean) => {
            terminal.log.raw.push(raw);
          },
          input: () => readerStream(readable.source),
          onResize: () => () => {},
        });
        yield* clock.install();
        const screen = yield* useReplScreen();
        const events = yield* screen.events();
        yield* spawn(function* (): Operation<void> {
          while (true) {
            const next = yield* events.next();
            if (next.done === true) {
              seen.push("closed");
              return;
            }
            seen.push(next.value.kind);
          }
        });
        yield* settled();
      });
    } catch (error) {
      raised = error instanceof Error ? error : new Error(String(error));
    }

    expect(raised?.message).toContain("would not cancel");
    // No end of input was invented on the way out. An `eof` here would tell the
    // command the person had closed their terminal, which nobody did.
    expect(seen).not.toContain("eof");
    expect(seen).not.toContain("closed");
    // And the modes still went back, exactly once, before the failure propagated.
    expect(terminal.log.resets).toBe(1);
    expect(terminal.log.raw[terminal.log.raw.length - 1]).toBe(false);
  });

  it("UI2: releasing is attempted once, however many times teardown runs", function* () {
    const readable = failingReadable({});
    yield* scoped(function* (): Operation<void> {
      const reading = yield* readerStream(readable.source);
      yield* spawn(function* (): Operation<void> {
        yield* reading.next();
      });
      yield* sleep(0);
    });
    // One acquisition, one release of each kind: idempotent by construction,
    // because the reader is cleared before either step is attempted.
    expect(readable.steps()).toEqual(["read", "cancel", "releaseLock"]);
  });
});

describe("REPL terminal: an owned input stream, and what releasing it costs", () => {
  it("UI2: cleanup cancels the read it was holding, with no further byte", function* () {
    const terminal = recordingTerminal();
    const clock = controllableClock();

    yield* scoped(function* (): Operation<void> {
      yield* terminal.install();
      yield* clock.install();
      yield* useReplScreen();
      // A read is outstanding and nothing will satisfy it: no byte is fed, and
      // none is fed for the rest of this row.
      yield* settled();
      expect(terminal.log.reading).toBe(true);
      expect(terminal.log.readers).toBe(1);
    });

    // The scope that owned the stream has gone, and it did not wait for a byte
    // to do it. Cleanup cancelled the read instead, which is the whole change.
    yield* settled();
    expect(terminal.log.reading).toBe(false);
    expect(terminal.log.readers).toBe(0);
    expect(terminal.log.cleanups).toBe(1);
  });

  it("UI2: the owner does not return until the stream's cleanup has finished", function* () {
    const terminal = recordingTerminal();
    const clock = controllableClock();
    let returned = false;

    const owner = yield* spawn(function* (): Operation<void> {
      yield* scoped(function* (): Operation<void> {
        yield* terminal.install();
        yield* clock.install();
        yield* useReplScreen();
        yield* settled();
        expect(terminal.log.reading).toBe(true);
        // Held from here on: the cleanup this scope is about to run suspends.
        terminal.log.holdNextCleanup();
      });
      returned = true;
    });

    // Several turns with the cleanup held. The owner is unwinding and has not
    // finished: a cleanup that were started and not awaited would let it.
    yield* settled();
    yield* settled();
    expect(terminal.log.cleanups).toBe(1);
    expect(returned).toBe(false);

    terminal.log.releaseCleanup();
    yield* owner;
    expect(returned).toBe(true);
    expect(terminal.log.readers).toBe(0);
    expect(terminal.log.reading).toBe(false);
  });

  it("UI2: end of input closes the stream and leaves nothing holding the terminal", function* () {
    const terminal = recordingTerminal();
    const clock = controllableClock();

    yield* scoped(function* (): Operation<void> {
      yield* terminal.install();
      yield* clock.install();
      const screen = yield* useReplScreen();
      const events = yield* screen.events();
      // The first frame is the size this screen opened at.
      expect((yield* events.next()).done).toBe(false);
      yield* settled();
      terminal.log.end();
      // End of input is an ending, not a failure: the screen says so and the
      // stream closes under it.
      yield* until_(events, "eof");
    });

    yield* settled();
    givenBack(terminal.log);
  });

  it("UI2: a read that fails is a terminal failure, and still releases everything", function* () {
    const terminal = recordingTerminal();
    const clock = controllableClock();
    let raised: Error | undefined;

    try {
      yield* scoped(function* (): Operation<void> {
        yield* terminal.install();
        yield* clock.install();
        const screen = yield* useReplScreen();
        const events = yield* screen.events();
        expect((yield* events.next()).done).toBe(false);
        yield* settled();
        // A live terminal that broke mid-read. Not an ending: a command that
        // treated this as end of input would report an orderly finish for a
        // terminal it can no longer read.
        terminal.log.fail(new Error("the terminal stopped answering"));
        yield* suspend();
      });
    } catch (error) {
      raised = error instanceof Error ? error : new Error(String(error));
    }

    expect(raised?.message).toContain("stopped answering");
    yield* settled();
    // The same release a success owes, performed before the failure propagated.
    expect(terminal.log.resets).toBe(1);
    expect(terminal.log.raw[terminal.log.raw.length - 1]).toBe(false);
    expect(terminal.log.listeners).toBe(0);
    expect(terminal.log.readers).toBe(0);
    expect(terminal.log.cleanups).toBe(1);
  });
});

/**
 * A Node-shaped standard input this row pushes into by hand.
 *
 * The real `process.stdin` decides for itself when a paste becomes one chunk or
 * several, which is exactly what the claim below must not depend on. This one
 * delivers precisely the chunks it is told to, so "two chunks were already
 * waiting" is a fact of the row rather than a hope about the host.
 */
function pushableInput(): NodeShapedInput & { push(text: string): void } {
  // oxlint-disable-next-line typescript/no-explicit-any
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  return {
    // oxlint-disable-next-line typescript/no-explicit-any
    on(event: string, listener: (...args: any[]) => void): unknown {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return undefined;
    },
    // oxlint-disable-next-line typescript/no-explicit-any
    off(event: string, listener: (...args: any[]) => void): unknown {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((one) => one !== listener),
      );
      return undefined;
    },
    resume(): unknown {
      return undefined;
    },
    pause(): unknown {
      return undefined;
    },
    push(text: string): void {
      for (const listener of listeners.get("data") ?? []) {
        listener(BYTES.encode(text));
      }
    },
  };
}

describe("REPL terminal: one suspension per chunk, buffered or not", () => {
  it("UI2: a ready continuation runs between two chunks that were already waiting", function* () {
    const stdin = pushableInput();
    const order: string[] = [];

    yield* scoped(function* (): Operation<void> {
      const subscription = yield* nodeInputStream(stdin);

      // Two distinct chunks, both delivered before anything consumes either.
      // This is the paste case: one chunk is not one keystroke, and the reader
      // downstream turns each of these into several decoded events.
      stdin.push("first");
      stdin.push("second");

      // A continuation that is ready the entire time. It is the measuring
      // instrument: if handing over an already-buffered chunk completes without
      // suspending, this never gets a turn between the two deliveries, and the
      // reader has drained its buffer faster than anyone could take from it.
      yield* spawn(function* (): Operation<void> {
        while (true) {
          order.push("other");
          yield* sleep(0);
        }
      });

      for (const expected of ["first", "second"]) {
        const next = yield* subscription.next();
        if (next.done) {
          throw new Error(`the stream ended before delivering ${expected}`);
        }
        order.push(`chunk:${new TextDecoder().decode(next.value)}`);
      }
    });

    const first = order.indexOf("chunk:first");
    const second = order.indexOf("chunk:second");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
    // The whole claim, and the one a settled resolver cannot satisfy: something
    // else ran in between.
    expect(order.slice(first + 1, second)).toContain("other");
  });
});

describe("REPL terminal: giving the terminal back", () => {
  it("H2: a run that finishes stops the reader, drops every listener and resets once", function* () {
    const terminal = recordingTerminal();
    yield* terminal.install();
    const clock = controllableClock();
    yield* clock.install();

    const finished = yield* spawn(function* (): Operation<void> {
      const screen = yield* useReplScreen();
      const events = yield* screen.events();
      const first = yield* events.next();
      expect(first.done).toBe(false);
      if (first.done !== true) {
        expect(first.value.kind).toBe("resize");
      }
      // The reader is a task, and a task starts a turn after it is spawned.
      yield* settled();
      expect(terminal.log.raw).toEqual([true]);
      expect(terminal.log.opened).toBe(1);
      expect(terminal.log.resets).toBe(0);
    });

    yield* finished;
    yield* settled();
    givenBack(terminal.log);
    expect(terminal.log.opened).toBe(1);
  });

  it("H2: a refusal restores everything a success would have", function* () {
    const terminal = recordingTerminal();
    yield* terminal.install();
    const clock = controllableClock();
    yield* clock.install();

    const refusing = yield* spawn(function* (): Operation<Error> {
      yield* useReplScreen();
      yield* settled();
      // The owner decided it cannot go on. That is an outcome, not an exception,
      // and it owes the terminal exactly what any other outcome does.
      return new Error("this REPL needs a terminal at least 72x20");
    });

    const refusal = yield* refusing;
    expect(refusal.message).toContain("72x20");
    yield* settled();
    givenBack(terminal.log);
  });

  it("H2: a failure restores everything before it propagates", function* () {
    const terminal = recordingTerminal();
    yield* terminal.install();
    const clock = controllableClock();
    yield* clock.install();

    let raised: Error | undefined;
    try {
      // Its own scope, not a spawned task: a task's failure raises into its
      // owner, and what this test needs is the failure delivered to the caller
      // with the screen's own scope already unwound.
      yield* scoped(function* (): Operation<void> {
        yield* useReplScreen();
        yield* settled();
        throw new Error("the renderer could not draw this frame");
      });
    } catch (error) {
      raised = error instanceof Error ? error : new Error(String(error));
    }
    expect(raised?.message).toContain("could not draw");
    yield* settled();
    givenBack(terminal.log);
  });

  it("H2: a cancellation restores everything, including a reader mid-read", function* () {
    const terminal = recordingTerminal();
    yield* terminal.install();
    const clock = controllableClock();
    yield* clock.install();

    const task = yield* spawn(function* (): Operation<void> {
      yield* useReplScreen();
      yield* suspend();
    });
    yield* settled();
    // The reader is blocked on bytes that will never come, which is the state a
    // person pressing nothing leaves it in.
    expect(terminal.log.reading).toBe(true);
    expect(terminal.log.readers).toBe(1);

    yield* task.halt();
    yield* settled();
    givenBack(terminal.log);
  });

  it("H2: end of input is a lifecycle outcome, and shuts down like the others", function* () {
    const terminal = recordingTerminal();
    yield* terminal.install();
    const clock = controllableClock();
    yield* clock.install();

    const seen: ReplScreenEvent["kind"][] = [];
    const reading = yield* spawn(function* (): Operation<void> {
      const screen = yield* useReplScreen();
      const events = yield* screen.events();
      terminal.log.feed(BYTES.encode("\r"));
      terminal.log.end();
      while (true) {
        const next = yield* events.next();
        if (next.done === true) {
          return;
        }
        seen.push(next.value.kind);
        if (next.value.kind === "eof") {
          // The owner shuts down on end of input; it is not a key anybody claims.
          return;
        }
      }
    });

    yield* reading;
    expect(seen).toEqual(["resize", "input", "eof"]);
    yield* settled();
    givenBack(terminal.log);
  });

  it("H2: a cancellation during registration leaves no half-taken terminal", function* () {
    const terminal = recordingTerminal();
    terminal.log.hold = true;
    yield* terminal.install();
    const clock = controllableClock();
    yield* clock.install();

    const task = yield* spawn(function* (): Operation<void> {
      yield* useReplScreen();
      yield* suspend();
    });
    yield* settled();
    // Raw mode was taken; the mode sequence never landed.
    expect(terminal.log.raw).toEqual([true]);
    expect(terminal.log.writes).toBe(0);
    expect(terminal.log.opened).toBe(0);

    yield* task.halt();
    yield* settled();
    // Restored anyway, because the undo was registered before the do.
    givenBack(terminal.log);
  });

  it("H2: no reader and no resize listener outlives a cancellation, at any turn", function* () {
    // The mode write is the one window the other cancellation case can hold, and
    // it stops short of the reader and the listener. So this walks the owner's
    // whole life a turn at a time and cancels at each of them: whichever turn
    // opens the byte source or attaches the resize listener, the release for it
    // was already registered, so nothing is left behind.
    for (let turns = 0; turns <= 8; turns += 1) {
      const terminal = recordingTerminal();
      yield* scoped(function* (): Operation<void> {
        yield* terminal.install();
        const clock = controllableClock();
        yield* clock.install();

        const task = yield* spawn(function* (): Operation<void> {
          yield* useReplScreen();
          yield* suspend();
        });
        for (let turn = 0; turn < turns; turn += 1) {
          yield* sleep(0);
        }
        yield* task.halt();
        yield* settled();

        expect(terminal.log.readers).toBe(0);
        expect(terminal.log.listeners).toBe(0);
        // At most one reset, and exactly one once anything at all was taken.
        expect(terminal.log.resets).toBeLessThanOrEqual(1);
        if (terminal.log.raw.includes(true)) {
          expect(terminal.log.resets).toBe(1);
          expect(terminal.log.raw[terminal.log.raw.length - 1]).toBe(false);
        }
      });
    }
  });

  it("H2: nothing survives its owner, even the modes it never finished applying", function* () {
    const terminal = recordingTerminal();
    yield* terminal.install();
    const clock = controllableClock();
    yield* clock.install();

    const modes = replModes();
    expect(modes.apply.length).toBeGreaterThan(0);
    expect(modes.revert.length).toBeGreaterThan(0);

    const task = yield* spawn(function* (): Operation<void> {
      yield* useReplScreen();
      yield* suspend();
    });
    yield* settled();
    yield* task.halt();
    yield* settled();

    // Halting twice must not reset twice: the reset is the terminal's, and it
    // happens once.
    yield* task.halt();
    yield* settled();
    givenBack(terminal.log);
  });
});

/** Read the next event the screen reports, failing if the stream ended. */
function* reported(events: {
  next(): Operation<IteratorResult<ReplScreenEvent, void>>;
}): Operation<ReplScreenEvent> {
  const next = yield* events.next();
  if (next.done === true) {
    throw new Error("the screen ended while this test was waiting for an event");
  }
  return next.value;
}

/**
 * Everything the screen reports within a bounded number of turns.
 *
 * Bounded on purpose: a test that blocked on the next event could only fail by
 * hanging, and a hang names nothing. Draining lets the assertion be the exact
 * sequence, so a missing event is a diff rather than a timeout.
 */
function* drained(events: {
  next(): Operation<IteratorResult<ReplScreenEvent, void>>;
}): Operation<ReplScreenEvent[]> {
  const seen: ReplScreenEvent[] = [];
  const collector = yield* spawn(function* (): Operation<void> {
    while (true) {
      const next = yield* events.next();
      if (next.done === true) {
        return;
      }
      seen.push(next.value);
    }
  });
  for (let turn = 0; turn < 12; turn += 1) {
    yield* sleep(0);
  }
  yield* collector.halt();
  return seen;
}

/** The normalized events out of a drained sequence, resizes and all else aside. */
function normalizedFrom(reported: readonly ReplScreenEvent[]): ReplInputEvent[] {
  const events: ReplInputEvent[] = [];
  for (const one of reported) {
    if (one.kind === "input") {
      events.push(one.event);
    }
  }
  return events;
}

describe("REPL terminal: what the host normalizes, and what it refuses to guess", () => {
  it("I1: a key becomes a normalized event and a mouse press becomes a position", function* () {
    const terminal = recordingTerminal();
    yield* terminal.install();
    const clock = controllableClock();
    yield* clock.install();

    yield* scoped(function* (): Operation<void> {
      const screen = yield* useReplScreen();
      const events = yield* screen.events();
      expect((yield* reported(events)).kind).toBe("resize");

      terminal.log.feed(BYTES.encode("\r"));
      expect(yield* reported(events)).toEqual({
        kind: "input",
        event: { kind: "key", key: "Enter" },
      });

      terminal.log.feed(BYTES.encode("\t"));
      expect(yield* reported(events)).toEqual({
        kind: "input",
        event: { kind: "key", key: "Tab" },
      });

      // Shift-Tab, which travels the same path rather than through a shortcut of
      // the host's own.
      terminal.log.feed(BYTES.encode("\x1b[Z"));
      expect(yield* reported(events)).toEqual({
        kind: "input",
        event: { kind: "key", key: "Backtab" },
      });

      // A press is a column and a row. Which node is there is the frame's answer.
      // The protocol counts from one and the frame counts from zero.
      terminal.log.feed(BYTES.encode("\x1b[<0;5;3M"));
      const pointer = yield* reported(events);
      expect(pointer.kind).toBe("pointer");
      if (pointer.kind === "pointer") {
        expect(pointer.at).toEqual({ column: 4, row: 2 });
      }

      // A key nothing has a meaning for is dropped rather than invented into one.
      terminal.log.feed(BYTES.encode("\x1b[A"));
      terminal.log.feed(BYTES.encode("\r"));
      expect(yield* reported(events)).toEqual({
        kind: "input",
        event: { kind: "key", key: "Enter" },
      });
    });
  });

  it("I1: typed and pasted text arrives as text, in the order the terminal sent it", function* () {
    const terminal = recordingTerminal();
    yield* terminal.install();
    const clock = controllableClock();
    yield* clock.install();

    yield* scoped(function* (): Operation<void> {
      const screen = yield* useReplScreen();
      const events = yield* screen.events();

      // Real bytes, through the real decoder: ASCII, a shifted capital, a space,
      // an accented character and two multi-byte ones; then a pasted newline,
      // which the terminal sends as LF and the decoder reports as Control-J with
      // no text of its own; then editing and submission.
      terminal.log.feed(BYTES.encode("aA é漢字"));
      terminal.log.feed(new Uint8Array([0x0a]));
      terminal.log.feed(BYTES.encode("b"));
      terminal.log.feed(new Uint8Array([0x7f]));
      terminal.log.feed(BYTES.encode("\r"));

      expect(normalizedFrom(yield* drained(events))).toEqual([
        { kind: "text", text: "a" },
        { kind: "text", text: "A" },
        { kind: "text", text: " " },
        { kind: "text", text: "é" },
        { kind: "text", text: "漢" },
        { kind: "text", text: "字" },
        { kind: "text", text: "\n" },
        { kind: "text", text: "b" },
        { kind: "key", key: "Backspace" },
        { kind: "key", key: "Enter" },
      ]);
    });
  });

  it("I1: a chord types nothing, whatever letter it was pressed with", function* () {
    const terminal = recordingTerminal();
    yield* terminal.install();
    const clock = controllableClock();
    yield* clock.install();

    yield* scoped(function* (): Operation<void> {
      const screen = yield* useReplScreen();
      const events = yield* screen.events();

      // Every one of these decodes to a letter the person did not ask to type:
      // Control-C is `c`, Alt-a carries the text `a`, Control-H is `h`, and F5 is
      // a key with no meaning here at all. Control-C is named rather than
      // dropped — it is an interrupt — but it is still not the letter it was
      // pressed with, which is what this row is about.
      terminal.log.feed(new Uint8Array([0x03]));
      terminal.log.feed(BYTES.encode("\x1ba"));
      terminal.log.feed(new Uint8Array([0x08]));
      terminal.log.feed(BYTES.encode("\x1b[15~"));
      // A sentinel behind them, so the assertion is the whole sequence and not
      // just the absence of something.
      terminal.log.feed(BYTES.encode("z"));

      expect(normalizedFrom(yield* drained(events))).toEqual([
        { kind: "key", key: "Interrupt" },
        { kind: "text", text: "z" },
      ]);
    });
  });

  it("I1: a shifted Tab goes backward, whichever way the terminal spells it", function* () {
    const terminal = recordingTerminal();
    yield* terminal.install();
    const clock = controllableClock();
    yield* clock.install();

    yield* scoped(function* (): Operation<void> {
      const screen = yield* useReplScreen();
      const events = yield* screen.events();

      // This screen asks the terminal for progressive keyboard input, so a
      // shifted Tab arrives as `Tab` carrying a shift rather than as the legacy
      // `Backtab` sequence. Both spellings are the same keystroke, and a reader
      // pressing it is asking to go back either way.
      terminal.log.feed(BYTES.encode("\x1b[Z"));
      terminal.log.feed(BYTES.encode("\x1b[9;2u"));
      // Held down, it repeats — and a repeat of going back is going back.
      terminal.log.feed(BYTES.encode("\x1b[9;2:2u"));
      // Unshifted, both spellings still go forward.
      terminal.log.feed(BYTES.encode("\t"));
      terminal.log.feed(BYTES.encode("\x1b[9;1u"));
      // With Control held it is a chord nothing here claims, shift or no shift.
      terminal.log.feed(BYTES.encode("\x1b[9;5u"));
      terminal.log.feed(BYTES.encode("\x1b[9;6u"));
      // A release is not a press.
      terminal.log.feed(BYTES.encode("\x1b[9;2:3u"));
      // A sentinel, so this is the whole sequence rather than the absence of
      // something at the end of it.
      terminal.log.feed(BYTES.encode("z"));

      expect(normalizedFrom(yield* drained(events))).toEqual([
        { kind: "key", key: "Backtab" },
        { kind: "key", key: "Backtab" },
        { kind: "key", key: "Backtab" },
        { kind: "key", key: "Tab" },
        { kind: "key", key: "Tab" },
        { kind: "text", text: "z" },
      ]);
    });
  });

  it("I1: what a shifted Tab normalizes to actually moves focus back", function* () {
    // The name is only half of it: a key that normalized correctly and then
    // moved focus forward would satisfy the assertion above and still be the
    // defect. So the normalized event is dispatched into a real mounted tree.
    const { tree } = yield* mounted(FILLED);

    const draft = tree.mounted().find((id) => tree.keyOf(id) === "footer:input");
    expect(tree.focused()).toBe(draft);

    const forward = acted(yield* tree.dispatch({ kind: "key", key: "Tab" }));
    expect(forward.outcome).toBe("focus");
    const moved = tree.focused();
    expect(moved).not.toBe(draft);

    const back = acted(yield* tree.dispatch({ kind: "key", key: "Backtab" }));
    expect(back.outcome).toBe("focus");
    expect(tree.focused()).toBe(draft);
  });

  it("I1: going back inside a drawer stays inside it", function* () {
    // Containment is the drawer's, not this key's. Backtab must traverse the
    // chain the drawer owns rather than escape to the reading behind it.
    const { tree } = yield* mounted({ ...FILLED, drawer: "Binding: plan" });

    const inside = new Set(
      tree.mounted().filter((id) => (tree.keyOf(id) ?? "").startsWith("drawer:")),
    );
    expect(inside.size).toBeGreaterThan(1);
    const within = () => {
      const here = tree.focused();
      return here !== undefined && inside.has(here);
    };
    expect(within()).toBe(true);

    for (let step = 0; step < inside.size + 1; step += 1) {
      const outcome = acted(yield* tree.dispatch({ kind: "key", key: "Backtab" }));
      expect(outcome.outcome).toBe("focus");
      expect([step, within()]).toEqual([step, true]);
    }
  });

  it("I1: text and Backspace reach the draft through the same ancestry as a key", function* () {
    const { tree } = yield* mounted(FILLED);

    // Focus is on the draft line, which is where typing goes.
    const draft = tree.mounted().find((id) => tree.keyOf(id) === "footer:input");
    expect(tree.focused()).toBe(draft);

    const typed = acted(yield* tree.dispatch({ kind: "text", text: "é" }));
    expect(typed.outcome).toBe("action");
    if (typed.outcome === "action") {
      expect(typed.action).toEqual({ kind: "insert", text: "é" });
      expect(typed.ancestry[0]).toBe(draft);
    }

    const pasted = acted(yield* tree.dispatch({ kind: "text", text: "\n" }));
    if (pasted.outcome === "action") {
      expect(pasted.action).toEqual({ kind: "insert", text: "\n" });
    }

    const erased = acted(yield* tree.dispatch({ kind: "key", key: "Backspace" }));
    if (erased.outcome === "action") {
      expect(erased.action).toEqual({ kind: "erase" });
    }

    // And the named keys still mean what they meant.
    const submitted = acted(yield* tree.dispatch({ kind: "key", key: "Enter" }));
    if (submitted.outcome === "action") {
      expect(submitted.action).toEqual({ kind: "submit" });
    }
    const moved = acted(yield* tree.dispatch({ kind: "key", key: "Tab" }));
    expect(moved.outcome).toBe("focus");
  });

  it("I1: text a row does not claim passes it on the way up", function* () {
    const { tree } = yield* mounted({ ...FILLED, drawer: "Binding: plan" });

    // Focus is inside the drawer, on a row that has no use for text.
    const closer = tree.mounted().find((id) => tree.keyOf(id) === "drawer:close");
    expect(tree.focused()).toBe(closer);

    // Nothing above it claims text either, so this is an explicit failure rather
    // than a keystroke silently swallowed.
    const outcome = yield* tree.dispatch({ kind: "text", text: "a" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.name).toBe("ReplUnownedEventError");
    }

    // Escape still closes it.
    const escaped = acted(yield* tree.dispatch({ kind: "key", key: "Escape" }));
    if (escaped.outcome === "action") {
      expect(escaped.action).toEqual({ kind: "close-drawer" });
    }
  });

  it("I1: a lone Escape waits for the decoder's latency and then arrives", function* () {
    const terminal = recordingTerminal();
    yield* terminal.install();
    const clock = controllableClock();
    yield* clock.install();

    yield* scoped(function* (): Operation<void> {
      const screen = yield* useReplScreen();
      const events = yield* screen.events();
      expect((yield* reported(events)).kind).toBe("resize");

      terminal.log.feed(BYTES.encode("\x1b"));
      yield* settled();
      // Undecided: it could still be the start of a sequence.
      expect(clock.waits).toBe(1);

      yield* clock.tick(0.025);
      expect(yield* reported(events)).toEqual({
        kind: "input",
        event: { kind: "key", key: "Escape" },
      });
    });
  });

  it("I1: bytes that follow a pending Escape are rescanned with it, not split", function* () {
    const terminal = recordingTerminal();
    yield* terminal.install();
    const clock = controllableClock();
    yield* clock.install();

    yield* scoped(function* (): Operation<void> {
      const screen = yield* useReplScreen();
      const events = yield* screen.events();
      expect((yield* reported(events)).kind).toBe("resize");

      // An escape sequence arriving in two pieces, which is what a slow link does.
      terminal.log.feed(BYTES.encode("\x1b"));
      yield* settled();
      expect(clock.waits).toBe(1);
      terminal.log.feed(BYTES.encode("[Z"));

      // Backtab, and no Escape before it: the held prefix was rescanned with what
      // followed rather than flushed as a keypress nobody made.
      expect(yield* reported(events)).toEqual({
        kind: "input",
        event: { kind: "key", key: "Backtab" },
      });
    });
  });

  it("I1: a resize is a size the host reports, not a key anybody claims", function* () {
    const terminal = recordingTerminal();
    yield* terminal.install();
    const clock = controllableClock();
    yield* clock.install();

    yield* scoped(function* (): Operation<void> {
      const screen = yield* useReplScreen();
      const events = yield* screen.events();
      expect(yield* reported(events)).toEqual({ kind: "resize", size: { columns: 160, rows: 36 } });

      terminal.log.resized({ columns: 72, rows: 20 });
      expect(yield* reported(events)).toEqual({ kind: "resize", size: { columns: 72, rows: 20 } });
      expect(yield* screen.size()).toEqual({ columns: 72, rows: 20 });

      // The same size again is the same frame again, and says nothing new.
      terminal.log.resized({ columns: 72, rows: 20 });
      terminal.log.feed(BYTES.encode("\r"));
      expect(yield* reported(events)).toEqual({
        kind: "input",
        event: { kind: "key", key: "Enter" },
      });
    });
  });

  it("I1: a key and a click on one control produce one action", function* () {
    const { tree, frame } = yield* mounted(FILLED, { columns: 160, rows: 36 });
    const rendered = frame.rendered;

    const byKey = acted(yield* tree.dispatch({ kind: "key", key: "Enter" }));
    expect(byKey.outcome).toBe("action");

    const control = rendered.map.targets.find(
      (target) => tree.keyOf(target.node) === "footer:input",
    );
    if (control === undefined) {
      throw new Error("the footer input is drawn and targetable");
    }
    const pointer = resolvePointer(rendered, { column: control.bounds.x, row: control.bounds.y });
    expect(pointer).toEqual({ kind: "pointer", target: control.node, frame: rendered.tree });
    if (pointer === undefined) {
      throw new Error("a pointer inside a drawn control resolves to it");
    }
    const byPointer = acted(yield* tree.dispatch(pointer));

    expect(byPointer).toEqual(byKey);
  });

  it("I1: a pointer outside the open drawer reaches nothing", function* () {
    const state = { ...FILLED, drawer: "Binding: plan" };
    const { tree, frame } = yield* mounted(state, { columns: 160, rows: 36 });
    const rendered = frame.rendered;

    const behind = rendered.map.targets.find(
      (target) => tree.keyOf(target.node) === "session:kf39sla2",
    );
    if (behind === undefined) {
      throw new Error("the sidebar's session row is drawn and targetable");
    }
    const pointer = resolvePointer(rendered, { column: behind.bounds.x, row: behind.bounds.y });
    if (pointer === undefined) {
      throw new Error("a pointer inside a drawn control resolves to it");
    }

    const outcome = acted(yield* tree.dispatch(pointer));
    expect(outcome.outcome).toBe("dropped");
    if (outcome.outcome === "dropped") {
      expect(outcome.reason).toContain("behind the open drawer");
    }
  });

  it("I1: a pointer resolved against a frame the tree has moved past reaches nothing", function* () {
    const { tree, frame } = yield* mounted(FILLED, { columns: 160, rows: 36 });
    const rendered = frame.rendered;

    const control = rendered.map.targets.find(
      (target) => tree.keyOf(target.node) === "entry:entry-1",
    );
    if (control === undefined) {
      throw new Error("the entry row is drawn and targetable");
    }
    const pointer = resolvePointer(rendered, { column: control.bounds.x, row: control.bounds.y });
    if (pointer === undefined) {
      throw new Error("a pointer inside a drawn control resolves to it");
    }

    // The screen moved on.
    committed(
      yield* tree.apply(
        fixturePairs({ ...FILLED, draft: "yes" }, { columns: 160, rows: 36 }).build({
          measuring: false,
          admission: frame.admission,
        }).descriptions,
      ),
    );
    expect(tree.frame().id).not.toBe(pointer.frame);

    const outcome = acted(yield* tree.dispatch(pointer));
    expect(outcome.outcome).toBe("dropped");
    if (outcome.outcome === "dropped") {
      expect(outcome.reason).toContain("no longer drawn");
    }
  });

  it("I1: a pointer naming a node the tree removed reaches nothing", function* () {
    const driver = yield* driving({ columns: 160, rows: 36 });
    const frame = yield* driver.commit(FILLED, { columns: 160, rows: 36 });
    const tree = driver.tree;
    const rendered = frame.rendered;

    const removed = rendered.map.targets.find(
      (target) => tree.keyOf(target.node) === "scope:entry-1/generated",
    );
    if (removed === undefined) {
      throw new Error("the generated scope row is drawn and targetable");
    }

    const shorter = yield* driver.commit(
      { ...FILLED, scopes: ["entry-1/component"] },
      { columns: 160, rows: 36 },
    );
    expect(tree.mounted()).not.toContain(removed.node);

    // Carrying the current frame's number, so what is under test is the node and
    // not the frame: a pointer cannot reach something that is not there.
    const outcome = acted(
      yield* tree.dispatch({ kind: "pointer", target: removed.node, frame: tree.frame().id }),
    );
    expect(outcome.outcome).toBe("dropped");
    if (outcome.outcome === "dropped") {
      expect(outcome.reason).toContain("no longer holds");
    }

    // And the frame that replaced it does not offer the node either.
    expect(shorter.rendered.map.targets.map((target) => target.node)).not.toContain(removed.node);
  });
});

describe("REPL terminal: what a drawer covers, and what it cannot reach", () => {
  /** A reading long enough that the drawer's rectangle lands on top of it. */
  const BUSY: ReplFixtureState = {
    ...FILLED,
    transcript: Array.from({ length: 24 }, (_unused, at) => `TRANSCRIPT-ROW-${at}`),
    bindings: Array.from({ length: 24 }, (_unused, at) => ({
      name: `binding-${at}`,
      value: `INSPECTION-VALUE-${at}`,
    })),
  };

  it("TL6: a drawer obscures the whole of its rectangle, blank cells included", function* () {
    const size = { columns: 160, rows: 36 };
    const driver = yield* driving(size);
    const before = yield* driver.commit(BUSY, size);
    const rect = bounds(before, "drawer");
    expect(rect).toBeUndefined();

    // Pre-assert: the cells the drawer is about to cover really have text in
    // them. Without this the assertion below would pass on an empty screen.
    const open = { ...BUSY, drawer: "Binding: plan", drawerLines: ["one line, and no more"] };
    const after = yield* driver.commit(open, size);
    const covered = bounds(after, "drawer");
    expect(covered).toEqual({ x: 20, y: 3, width: 120, height: 23 });
    if (covered === undefined) {
      return;
    }

    // Every transcript row the rectangle covers was on the screen first.
    const under = before.keys.filter((key) => key.startsWith("line:"));
    const hidden = under.filter((key) => {
      const at = before.boundsOf(key);
      return at !== undefined && at.y >= covered.y && at.y < covered.y + covered.height;
    });
    expect(hidden.length).toBeGreaterThan(0);

    // And none of their text is anywhere inside the rectangle now. The drawer
    // holds one short line, so most of what it covers is its own blank space —
    // which is exactly the part a drawer without a background lets through.
    const inside = driver.grid.textIn(covered).join("\n");
    for (const key of hidden) {
      const text = (before.cellOf(key) ?? "").trim();
      expect([key, inside.includes(text)]).toEqual([key, false]);
    }
    // The drawer's own text is there instead.
    expect(inside).toContain("one line, and no more");
  });

  it("TL6: the footer is never covered, and a narrow start behaves the same", function* () {
    for (const size of [{ columns: 160, rows: 36 }, NARROW]) {
      yield* scoped(function* (): Operation<void> {
        const driver = yield* driving(size);
        const open = { ...BUSY, drawer: "Binding: plan", drawerLines: ["short"] };
        const frame = yield* driver.commit(open, size);
        const rect = bounds(frame, "drawer");
        const footer = bounds(frame, "footer");
        expect(rect).toBeDefined();
        expect(footer).toBeDefined();
        if (rect === undefined || footer === undefined) {
          return;
        }
        // Above the footer rather than across it: the draft is the thing the
        // question is about, and a modal that covered it would hide it.
        expect(rect.y + rect.height).toBeLessThanOrEqual(footer.y);
        // And the draft is still drawn, on the footer's last row.
        expect(frame.boundsOf("footer:input")?.y).toBe(size.rows - 1);
      });
    }
  });

  it("TL6: a resize round trip keeps the drawer covering what it covers", function* () {
    const driver = yield* driving({ columns: 160, rows: 36 });
    const open = { ...BUSY, drawer: "Binding: plan", drawerLines: ["short"] };
    yield* driver.commit(open, { columns: 160, rows: 36 });
    driver.renderer.resize(NARROW);
    const narrow = yield* driver.commit(open, NARROW);
    expect(bounds(narrow, "drawer")).toEqual({ x: 9, y: 1, width: 54, height: 11 });
    driver.renderer.resize({ columns: 160, rows: 36 });
    const wide = yield* driver.commit(open, { columns: 160, rows: 36 });
    expect(bounds(wide, "drawer")).toEqual({ x: 20, y: 3, width: 120, height: 23 });

    // Nothing of the body is left showing through the rectangle after the
    // round trip, which is where a diffing renderer leaves stale text.
    const rect = bounds(wide, "drawer");
    if (rect === undefined) {
      return;
    }
    const inside = driver.grid.textIn(rect).join("\n");
    expect(inside).not.toContain("TRANSCRIPT-ROW-");
    expect(inside).not.toContain("INSPECTION-VALUE-");
  });

  it("TL7: with engine capture off, dispatch behind the modal is still dropped", function* () {
    const size = { columns: 160, rows: 36 };
    // Capture deliberately off: the engine's own hit test no longer narrows
    // over the drawer's rectangle, so what refuses a press behind the modal
    // has to be the reconciler. Containment is not the engine's to own.
    const open: ReplFixtureState = {
      ...FILLED,
      drawer: "Binding: plan",
      drawerLines: ["one"],
      capture: "passthrough",
    };
    const { tree, frame } = yield* mounted(open, size);

    const behind = frame.targets.find((target) => tree.keyOf(target.node) === "session:kf39sla2");
    expect(behind).toBeDefined();
    if (behind === undefined) {
      return;
    }
    const outcome = acted(
      yield* tree.dispatch({ kind: "pointer", target: behind.node, frame: tree.frame().id }),
    );
    expect(outcome.outcome).toBe("dropped");
    if (outcome.outcome === "dropped") {
      expect(outcome.reason).toContain("behind the open drawer");
    }

    // And the modal's own control still answers, so capture-off has not
    // broken the product — only the engine's narrowing.
    const close = frame.targets.find((target) => tree.keyOf(target.node) === "drawer:close");
    expect(close).toBeDefined();
    if (close === undefined) {
      return;
    }
    const inside = acted(
      yield* tree.dispatch({ kind: "pointer", target: close.node, frame: tree.frame().id }),
    );
    expect(inside.outcome).toBe("action");
  });

  it("TL7: traversal inside an open drawer visits only its own descendants", function* () {
    const open: ReplFixtureState = {
      ...FILLED,
      drawer: "Binding: plan",
      drawerLines: ["one"],
    };
    const { tree, frame } = yield* mounted(open, { columns: 160, rows: 36 });
    expect(frame.keys).toContain("drawer:close");

    const visited: string[] = [];
    for (let press = 0; press < 40; press += 1) {
      const moved = yield* tree.dispatch({ kind: "key", key: "Tab" });
      if (!moved.ok || moved.value.outcome !== "focus") {
        break;
      }
      const node = moved.value.focused;
      const key = node === undefined ? undefined : tree.keyOf(node);
      if (key === undefined || visited.includes(key)) {
        break;
      }
      visited.push(key);
    }
    expect(visited.length).toBeGreaterThan(0);
    // Every stop is the drawer's. Nothing behind it is reachable by keyboard
    // either, which is the same containment the pointer met above.
    for (const key of visited) {
      expect([key, key.startsWith("drawer:")]).toEqual([key, true]);
    }
  });
});

describe("REPL terminal: committed geometry, and what it promises", () => {
  it("TL8: every target's bounds are whole cells at every profile", function* () {
    for (const size of [{ columns: 160, rows: 36 }, { columns: 120, rows: 30 }, NARROW]) {
      yield* scoped(function* (): Operation<void> {
        const { frame } = yield* mounted(FILLED, size);
        expect(frame.targets.length).toBeGreaterThan(0);
        for (const target of frame.targets) {
          const { x, y, width, height } = target.bounds;
          for (const [name, value] of [
            ["x", x],
            ["y", y],
            ["width", width],
            ["height", height],
          ]) {
            expect([size.columns, target.id, name, Number.isInteger(value)]).toEqual([
              size.columns,
              target.id,
              name,
              true,
            ]);
          }
          // Inside the terminal, so no target names a column or row that is not
          // on the screen.
          expect(x).toBeGreaterThanOrEqual(0);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(x + width).toBeLessThanOrEqual(size.columns);
          expect(y + height).toBeLessThanOrEqual(size.rows);
        }
      });
    }
  });

  it("TL8: the trailing edge of a target belongs to whatever is after it", function* () {
    const size = { columns: 160, rows: 36 };
    const { frame } = yield* mounted(FILLED, size);
    const { map } = frame.rendered;
    for (const target of frame.targets) {
      const { x, y, width, height } = target.bounds;
      // Every interior cell answers with this node.
      expect([target.id, map.at(x, y)]).toEqual([target.id, target.node]);
      expect([target.id, map.at(x + width - 1, y + height - 1)]).toEqual([target.id, target.node]);
      // And the cell just past each trailing edge does not. The engine's own
      // hit test includes it, which is why resolution is half-open: without
      // that, every row of a stacked list is claimed by two neighbours.
      expect([target.id, map.at(x + width, y)]).not.toEqual([target.id, target.node]);
      expect([target.id, map.at(x, y + height)]).not.toEqual([target.id, target.node]);
    }
  });

  it("TL8: an older frame's geometry does not move when a later frame is drawn", function* () {
    const driver = yield* driving({ columns: 160, rows: 36 });
    const first = yield* driver.commit(FILLED, { columns: 160, rows: 36 });
    // Copied out of the result, which is what a caller retains.
    const held = first.targets.map((target) => ({ ...target, bounds: { ...target.bounds } }));
    const bytes = Array.from(first.rendered.output);
    expect(held.length).toBeGreaterThan(0);

    // Two more frames, one of them at a different size, which both reuse the
    // engine and invalidate whatever its last result pointed at.
    driver.renderer.resize(NARROW);
    yield* driver.commit(FILLED, NARROW);
    driver.renderer.resize({ columns: 160, rows: 36 });
    yield* driver.commit({ ...FILLED, draft: "typed since" }, { columns: 160, rows: 36 });

    // The first frame answers exactly what it answered.
    for (const target of held) {
      expect([target.id, first.rendered.map.boundsOf(target.id)]).toEqual([
        target.id,
        target.bounds,
      ]);
    }
    expect(Array.from(first.rendered.output)).toEqual(bytes);
  });

  it("TL11: exactly two engines are acquired, and reused for every frame", function* () {
    const driver = yield* driving({ columns: 160, rows: 36 });
    // Two on acquisition: one that measures and one that draws.
    expect(driver.renderer.engines()).toEqual({ measuring: 1, drawing: 1 });

    // Twelve frames across three profiles, with resizes between them. Each one
    // measures at least once and draws once, so a renderer that built an
    // engine per frame would be far past two by now.
    for (let round = 0; round < 4; round += 1) {
      for (const size of [{ columns: 160, rows: 36 }, { columns: 120, rows: 30 }, NARROW]) {
        driver.renderer.resize(size);
        yield* driver.commit({ ...FILLED, draft: `round ${round}` }, size);
      }
    }
    expect(driver.renderer.engines()).toEqual({ measuring: 1, drawing: 1 });
  });
});

describe("REPL terminal: a measurement that does not commit", () => {
  /**
   * A renderer whose measurement can be held open.
   *
   * The seam TL9 needs, and nothing production has: `measure` suspends on a
   * latch, so a test can look at the tree, the focus and the display *while* a
   * frame is owed and nothing has been admitted yet.
   */
  function holding(renderer: ReplRenderer): {
    readonly renderer: ReplRenderer;
    /** Release every measurement waiting right now. */
    release(): void;
    /** How many measurements have been asked for. */
    asked(): number;
  } {
    let waiters: (() => void)[] = [];
    let asked = 0;
    let holdingNow = true;
    return {
      renderer: {
        *measure(ops, size) {
          asked += 1;
          if (holdingNow) {
            const waiter = withResolvers<void>();
            waiters.push(() => waiter.resolve());
            yield* waiter.operation;
          }
          return yield* renderer.measure(ops, size);
        },
        draw: (request) => renderer.draw(request),
        resize: (size) => renderer.resize(size),
        last: () => renderer.last(),
        engines: () => renderer.engines(),
      },
      release() {
        holdingNow = false;
        const releasing = waiters;
        waiters = [];
        for (const one of releasing) {
          one();
        }
      },
      asked: () => asked,
    };
  }

  it("TL9: a held measurement mounts nothing, draws nothing and acknowledges nothing", function* () {
    const size = { columns: 160, rows: 36 };
    const renderer = yield* useReplRenderer(size);
    const tree = yield* useReplTree<Surfaced>();
    const grid = createGrid();
    const held = holding(renderer);

    const committer = yield* useCommitter<Surfaced>({
      size,
      tree,
      renderer: held.renderer,
      source: fixturePairs(FILLED, size),
      grid,
    });

    // Nothing has happened yet, and this is what "nothing" looks like.
    const revision = tree.frame().id;
    const mounted = tree.mounted();
    const focused = tree.focused();
    expect(mounted).toEqual([]);

    const running = yield* spawn(() => committer.commit());
    yield* settled();

    // The measurement is outstanding. The tree has not moved, nothing is
    // focused that was not, nothing has been painted, and the renderer has
    // committed no frame — so there is nothing to acknowledge either.
    expect(held.asked()).toBeGreaterThan(0);
    expect(tree.frame().id).toBe(revision);
    expect(tree.mounted()).toEqual(mounted);
    expect(tree.focused()).toBe(focused);
    expect(grid.rows()).toEqual([]);
    expect(renderer.last()).toBeUndefined();

    // Released, the same commit goes through and only then is any of that true.
    held.release();
    const drawn = yield* running;
    expect(drawn.targets.length).toBeGreaterThan(0);
    expect(tree.frame().id).not.toBe(revision);
    expect(grid.rows().length).toBeGreaterThan(0);
    expect(renderer.last()).toBeDefined();
  });

  it("TL9: a measurement that fails mounts nothing and publishes no target", function* () {
    const size = { columns: 160, rows: 36 };
    const renderer = yield* useReplRenderer(size);
    const tree = yield* useReplTree<Surfaced>();
    const grid = createGrid();

    /** A renderer whose measurement refuses for a reason no retry fixes. */
    const refusing: ReplRenderer = {
      // deno-lint-ignore require-yield
      *measure(): Operation<Result<ReplMeasured>> {
        return Err(new ReplRenderError("this measurement cannot be taken"));
      },
      draw: (request) => renderer.draw(request),
      resize: (next) => renderer.resize(next),
      last: () => renderer.last(),
      engines: () => renderer.engines(),
    };

    const committer = yield* useCommitter<Surfaced>({
      size,
      tree,
      renderer: refusing,
      source: fixturePairs(FILLED, size),
      grid,
    });

    let raised: Error | undefined;
    try {
      yield* committer.commit();
    } catch (error) {
      raised = error instanceof Error ? error : new Error(String(error));
    }
    expect(raised?.message).toContain("cannot be taken");

    // Nothing was mounted, nothing was painted, and no frame was committed:
    // a failure before admission leaves no half-interactive screen behind.
    expect(tree.mounted()).toEqual([]);
    expect(grid.rows()).toEqual([]);
    expect(renderer.last()).toBeUndefined();
  });
});

describe("REPL terminal: a frame that cannot be placed on cell boundaries", () => {
  /**
   * The shapes this engine answers with half a cell.
   *
   * Measured: centring a twelve-row element in a twenty-nine-row parent puts it
   * at `y=8.5`; a four-column element centred in nine columns lands at `x=2.5`;
   * and a third of ten columns is `3.3333334922790527` wide. Each of them is a
   * bound naming a row or column that does not exist.
   */
  const SHAPES: readonly { readonly name: string; readonly ops: readonly Op[] }[] = Object.freeze([
    {
      name: "a centred odd span",
      ops: [
        open("root", { layout: { width: fixed(60), height: fixed(40), direction: "ttb" } }),
        open("parent", {
          layout: { width: fixed(29), height: fixed(29), direction: "ttb", alignY: "center" },
        }),
        open("target", { layout: { width: fixed(12), height: fixed(12) } }),
        text("x"),
        close(),
        close(),
        close(),
      ],
    },
    {
      name: "a width stated as a share",
      ops: [
        open("root", { layout: { width: fixed(60), height: fixed(40), direction: "ttb" } }),
        open("parent", { layout: { width: fixed(10), height: fixed(10), direction: "ttb" } }),
        open("target", { layout: { width: percent(1 / 3), height: percent(1 / 3) } }),
        text("x"),
        close(),
        close(),
        close(),
      ],
    },
  ]);

  it("TL8: a fractional placement is refused, not rounded into a hit box", function* () {
    for (const shape of SHAPES) {
      yield* scoped(function* (): Operation<void> {
        const size = { columns: 60, rows: 40 };
        const renderer = yield* useReplRenderer(size);

        // The engine really does answer with half a cell here, which is what
        // makes this a test rather than an assertion about nothing.
        const measured = yield* renderer.measure(shape.ops, size);
        if (!measured.ok) {
          throw measured.error;
        }
        const raw = measured.value.boundsOf("target");
        expect(raw).toBeDefined();
        const whole =
          raw === undefined
            ? true
            : Number.isInteger(raw.x) &&
              Number.isInteger(raw.y) &&
              Number.isInteger(raw.width) &&
              Number.isInteger(raw.height);
        expect([shape.name, whole]).toEqual([shape.name, false]);

        // Drawing it is refused. A rounded hit box would disagree with the text
        // underneath it, and a person aiming at the half that is not there would
        // reach whatever is behind — so this frame is not drawn at all.
        const drawn = yield* renderer.draw({
          ops: shape.ops,
          boxes: [{ id: "target", node: "target", control: true }],
          regions: ["parent"],
          tree: 1,
          size,
          deltaTime: 0,
          pointer: undefined,
        });
        expect([shape.name, drawn.ok]).toEqual([shape.name, false]);
        if (!drawn.ok) {
          expect(drawn.error.message).toContain("fractional position");
          expect(drawn.error.name).toBe("ReplRenderError");
        }
      });
    }
  });
});
