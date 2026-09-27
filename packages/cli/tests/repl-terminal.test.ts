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
import { type Operation, scoped, sleep, spawn, suspend, withResolvers } from "effection";

import { HISTORY_ROWS, layout, NARROW, profileFor } from "../src/repl/layout.ts";
import type { ReplBounds, ReplRegion, ReplSemanticFrame, ReplSurface } from "../src/repl/layout.ts";
import { resolvePointer, snapshotRender, useReplRenderer } from "../src/repl/renderer.ts";
import type { ReplRendered, ReplRenderSnapshot } from "../src/repl/renderer.ts";
import { nearestCommonAncestor, ReplClock, useReplFrames } from "../src/repl/frame.ts";
import type { ReplFrameSubscription } from "../src/repl/frame.ts";
import { replModes, useReplScreen } from "../src/repl/screen.ts";
import type { ReplScreenEvent } from "../src/repl/screen.ts";
import { installReplTerminal } from "../src/repl/terminal-host.ts";
import type { ReplTerminalCapabilities } from "../src/repl/terminal-host.ts";
import type { ReplTerminalSize } from "../src/repl/terminal.ts";
import { useReplTree } from "../src/repl/reconcile.ts";
import type { ReplDispatched, ReplTree } from "../src/repl/reconcile.ts";
import type { ReplInputEvent } from "../src/repl/description.ts";
import {
  EMPTY,
  fixtureDescriptions,
  fixtureSurface,
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
  draft: "",
};

/** Let every task that is ready take its turn. */
function* settled(): Operation<void> {
  yield* sleep(0);
  yield* sleep(0);
  yield* sleep(0);
}

function bounds(frame: ReplSemanticFrame, region: ReplRegion): ReplBounds | undefined {
  return frame.regions.find((placed) => placed.region === region)?.bounds;
}

function regions(frame: ReplSemanticFrame): ReplRegion[] {
  return frame.regions.map((placed) => placed.region);
}

function textsIn(frame: ReplSemanticFrame, region: ReplRegion): string[] {
  return frame.cells.filter((cell) => cell.region === region).map((cell) => cell.text);
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

/** Mount one fixture state and hand back the tree and its surface. */
function* mounted(
  state: ReplFixtureState,
): Operation<{ tree: ReplTree<Surfaced>; surface: ReplSurface }> {
  const tree = yield* useReplTree<Surfaced>();
  committed(yield* tree.apply(fixtureDescriptions(state)));
  return { tree, surface: fixtureSurface(tree, state) };
}

/** A render input for one laid-out frame and one mounted tree. */
function input(frame: ReplSemanticFrame, tree: ReplTree<Surfaced>): ReplRenderSnapshot {
  return snapshotRender({
    frame,
    tree: tree.frame().id,
    mounted: tree.mounted(),
    deltaTime: 0,
    pointer: undefined,
  });
}

/** Render one frame, failing the test if the renderer refused it. */
function* drawn(
  renderer: {
    render(
      snapshot: ReplRenderSnapshot,
    ): Operation<{ ok: boolean; value?: ReplRendered; error?: Error }>;
  },
  snapshot: ReplRenderSnapshot,
): Operation<ReplRendered> {
  const outcome = yield* renderer.render(snapshot);
  if (!outcome.ok || outcome.value === undefined) {
    throw outcome.error ?? new Error("the renderer refused a frame this test expects it to draw");
  }
  return outcome.value;
}

describe("REPL terminal: responsive semantic frames", () => {
  it("F1: a wide frame carries the sidebar, transcript, inspection and fixed footer", function* () {
    const { tree, surface } = yield* mounted(FILLED);
    const frame = layout({ columns: 160, rows: 36 }, surface);

    expect(frame.profile).toBe("wide");
    expect(regions(frame)).toEqual(["sidebar", "transcript", "inspection", "footer"]);
    expect(bounds(frame, "sidebar")).toEqual({ x: 0, y: 0, width: 32, height: 29 });
    expect(bounds(frame, "transcript")).toEqual({ x: 32, y: 0, width: 92, height: 29 });
    expect(bounds(frame, "inspection")).toEqual({ x: 124, y: 0, width: 36, height: 29 });
    // Full width and pinned to the bottom, at every size.
    expect(bounds(frame, "footer")).toEqual({ x: 0, y: 29, width: 160, height: 7 });
    expect(frame.historyRows).toHaveLength(HISTORY_ROWS);
    expect(frame.refusal).toBeUndefined();

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
    expect(textsIn(frame, "footer")).toEqual(["root 1", "root close", "> "]);
    expect(tree.mounted()).toHaveLength(frame.cells.length);
  });

  it("F1: a medium frame keeps every region, narrower", function* () {
    const { surface } = yield* mounted(FILLED);
    const frame = layout({ columns: 120, rows: 30 }, surface);

    expect(frame.profile).toBe("medium");
    expect(regions(frame)).toEqual(["sidebar", "transcript", "inspection", "footer"]);
    expect(bounds(frame, "sidebar")).toEqual({ x: 0, y: 0, width: 28, height: 23 });
    expect(bounds(frame, "transcript")).toEqual({ x: 28, y: 0, width: 64, height: 23 });
    expect(bounds(frame, "inspection")).toEqual({ x: 92, y: 0, width: 28, height: 23 });
    expect(bounds(frame, "footer")).toEqual({ x: 0, y: 23, width: 120, height: 7 });
    expect(frame.historyRows).toHaveLength(HISTORY_ROWS);
  });

  it("F1: a narrow frame routes one content surface and keeps the drawer and footer", function* () {
    const { surface } = yield* mounted({ ...FILLED, drawer: "Binding: plan" });
    const frame = layout(NARROW, surface);

    expect(frame.profile).toBe("narrow");
    expect(regions(frame)).toEqual(["content", "drawer", "footer"]);
    expect(bounds(frame, "content")).toEqual({ x: 0, y: 0, width: 72, height: 13 });
    // The same footer contract as the wide frame: full width, five History rows.
    expect(bounds(frame, "footer")).toEqual({ x: 0, y: 13, width: 72, height: 7 });
    expect(frame.historyRows).toHaveLength(HISTORY_ROWS);
    expect(bounds(frame, "drawer")).toEqual({ x: 9, y: 1, width: 54, height: 11 });
    expect(textsIn(frame, "drawer")).toEqual(["Binding: plan", "Close"]);
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
        route: "transcript",
        shown: ["About to evaluate: the plan", "Decision: approve"],
        hidden: "kf39sla2",
      },
    ] as const;

    for (const { route, shown, hidden } of routes) {
      const state: ReplFixtureState = { ...FILLED, route };
      const { tree, surface } = yield* mounted(state);
      const frame = layout(NARROW, surface);
      const renderer = yield* useReplRenderer(NARROW);
      const rendered = yield* drawn(renderer, input(frame, tree));

      expect(textsIn(frame, "content")).toEqual(shown);

      // The other surfaces are still mounted — routing is presentation — and
      // that is exactly why the proof has to be that they are not in the frame
      // and not in its map.
      const inactive = tree.mounted().filter((id) => {
        const key = tree.keyOf(id);
        return key !== undefined && key.endsWith(hidden);
      });
      expect(inactive.length).toBeGreaterThan(0);
      for (const node of inactive) {
        expect(frame.cells.map((cell) => cell.node)).not.toContain(node);
        expect(rendered.map.targets.map((target) => target.node)).not.toContain(node);
        expect(rendered.map.nodeOf(`content:${node}`)).toBeUndefined();
      }

      // And nowhere a pointer can land reaches one of them.
      for (let row = 0; row < NARROW.rows; row += 1) {
        for (let column = 0; column < NARROW.columns; column += 8) {
          const pointer = resolvePointer(rendered, { column, row });
          if (pointer !== undefined) {
            expect(inactive).not.toContain(pointer.target);
          }
        }
      }
    }
  });

  it("F1: below the minimum the frame is an explicit refusal with nothing targetable", function* () {
    const { surface } = yield* mounted(FILLED);

    for (const size of [
      { columns: 71, rows: 20 },
      { columns: 72, rows: 19 },
      { columns: 40, rows: 10 },
    ]) {
      const frame = layout(size, surface);
      expect(profileFor(size)).toBe("too-small");
      expect(frame.profile).toBe("too-small");
      expect(frame.refusal).toContain("at least 72x20");
      expect(frame.refusal).toContain(`${size.columns}x${size.rows}`);
      expect(regions(frame)).toEqual(["refusal"]);
      // A control that is not in the frame cannot be in its target map either.
      expect(frame.cells).toEqual([]);
      expect(frame.historyRows).toHaveLength(HISTORY_ROWS);
    }
  });

  it("F1: Sessions says so when there is nothing in it", function* () {
    const { surface } = yield* mounted(EMPTY);
    const frame = layout({ columns: 160, rows: 36 }, surface);

    expect(textsIn(frame, "sidebar")).toEqual(["Sessions: none yet", "Entries"]);
    expect(textsIn(frame, "transcript")).toEqual([]);
    expect(frame.refusal).toBeUndefined();
  });

  it("F1: compact geometry groups marker labels and keeps every marker's identity", function* () {
    const history = Array.from({ length: 40 }, (_unused, index) => ({
      marker: `yield:entry-1:${index}`,
      label: `entry-1 yield ${index}`,
    }));
    const { surface } = yield* mounted({ ...FILLED, history });

    const wide = layout({ columns: 160, rows: 36 }, surface);
    const narrow = layout(NARROW, surface);

    // Every marker survives at both sizes, once each, under its own name.
    for (const frame of [wide, narrow]) {
      expect(frame.markers.map((marker) => marker.marker)).toEqual(
        history.map((one) => one.marker),
      );
      expect(frame.historyRows).toHaveLength(HISTORY_ROWS);
    }
    // Wide has room for its own labels; narrow shares them.
    expect(wide.markers.every((marker) => marker.grouped.length === 0)).toBe(true);
    expect(narrow.markers.some((marker) => marker.grouped.length > 0)).toBe(true);
    const shared = narrow.markers.filter((marker) => marker.label === narrow.markers[0].label);
    expect(shared.length).toBeGreaterThan(1);
    // A grouped marker names the others it shares a label with, so the identity
    // of a compact position is still recoverable.
    expect(narrow.markers[0].grouped).toEqual(shared.slice(1).map((marker) => marker.marker));
    expect(narrow.markers[0].label).toContain("+");
  });

  it("F1: resizing through every profile keeps selection, nodes and action identity", function* () {
    const { tree, surface } = yield* mounted(FILLED);
    const before = tree.mounted();
    const focused = tree.focused();
    const frameId = tree.frame().id;

    const sizes = [
      { columns: 160, rows: 36 },
      { columns: 120, rows: 30 },
      NARROW,
      { columns: 40, rows: 10 },
    ];
    const laid = sizes.map((size) => layout(size, surface));

    expect(laid.map((frame) => frame.profile)).toEqual(["wide", "medium", "narrow", "too-small"]);
    // Laying out is presentation: it reads the tree and tells it nothing.
    expect(tree.mounted()).toEqual(before);
    expect(tree.focused()).toBe(focused);
    expect(tree.frame().id).toBe(frameId);

    // And the same control still means the same thing.
    for (const _frame of laid) {
      const outcome = acted(yield* tree.dispatch({ kind: "key", key: "Enter" }));
      expect(outcome.outcome).toBe("action");
      if (outcome.outcome === "action") {
        expect(outcome.action).toEqual({ kind: "submit" });
      }
    }
  });

  it("F1: a pointer against a control the refusal hides reaches nothing", function* () {
    const { tree, surface } = yield* mounted(FILLED);
    const renderer = yield* useReplRenderer(NARROW);

    const visible = yield* drawn(renderer, input(layout(NARROW, surface), tree));
    const footer = visible.map.targets.find((target) => tree.keyOf(target.node) === "footer:input");
    expect(footer).toBeDefined();
    if (footer === undefined) {
      throw new Error("the narrow frame draws the footer input");
    }
    // The same place, now under a refusal.
    const refused = yield* drawn(renderer, input(layout({ columns: 40, rows: 10 }, surface), tree));
    expect(refused.map.targets).toEqual([]);
    expect(
      resolvePointer(refused, { column: footer.bounds.x, row: footer.bounds.y }),
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
    const { tree, surface } = yield* mounted(FILLED);
    const renderer = yield* useReplRenderer(NARROW);

    const narrow = yield* drawn(renderer, input(layout(NARROW, surface), tree));
    const held = narrow.output;
    const witnessed = Array.from(held);
    expect(witnessed.length).toBeGreaterThan(0);

    // A second render writes over the engine's output region, and a resize grows
    // its memory, which detaches every view into the old buffer.
    yield* drawn(renderer, input(layout({ columns: 120, rows: 30 }, surface), tree));
    renderer.resize({ columns: 160, rows: 36 });
    yield* drawn(renderer, input(layout({ columns: 160, rows: 36 }, surface), tree));

    expect(Array.from(held)).toEqual(witnessed);
  });

  it("H1: what a caller does to bytes it holds cannot change a later render", function* () {
    const { tree, surface } = yield* mounted(FILLED);
    // The same three frames through two renderers. One caller scribbles over
    // every result it is handed; the other leaves them alone. A renderer whose
    // result aliased the engine's memory would have the scribbling corrupt the
    // state the next frame is diffed against, and the two sequences would part.
    const sequence = [
      layout(NARROW, surface),
      layout({ columns: 120, rows: 30 }, surface),
      layout(NARROW, surface),
    ];

    const tampered: number[][] = [];
    const scribbling = yield* useReplRenderer(NARROW);
    for (const frame of sequence) {
      const rendered = yield* drawn(scribbling, input(frame, tree));
      tampered.push(Array.from(rendered.output));
      rendered.output.fill(0);
    }

    const clean: number[][] = [];
    const untouched = yield* useReplRenderer(NARROW);
    for (const frame of sequence) {
      const rendered = yield* drawn(untouched, input(frame, tree));
      clean.push(Array.from(rendered.output));
    }

    expect(tampered[0].length).toBeGreaterThan(0);
    expect(tampered).toEqual(clean);
  });

  it("H1: a frame laid out before a removal draws only what is still mounted", function* () {
    const { tree, surface } = yield* mounted(FILLED);
    const renderer = yield* useReplRenderer({ columns: 160, rows: 36 });
    // Laid out while the row was there.
    const frame = layout({ columns: 160, rows: 36 }, surface);
    const going = tree.mounted().find((id) => tree.keyOf(id) === "scope:entry-1/generated");
    if (going === undefined) {
      throw new Error("the generated scope row is mounted before the removal");
    }
    expect(frame.cells.map((cell) => cell.node)).toContain(going);

    // And the tree moved on before anything was drawn.
    committed(yield* tree.apply(fixtureDescriptions({ ...FILLED, scopes: ["entry-1/component"] })));
    expect(tree.mounted()).not.toContain(going);

    const rendered = yield* drawn(renderer, input(frame, tree));

    // The mounted tree is the only source of renderable nodes: a cell naming a
    // node that has gone is not drawn, and is therefore not a target either.
    expect(rendered.map.targets.map((target) => target.node)).not.toContain(going);
    expect(rendered.map.nodeOf(`sidebar:${going}`)).toBeUndefined();
    expect(rendered.map.targets.length).toBeGreaterThan(0);
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
    const { tree, surface } = yield* mounted({ ...FILLED, bindings });
    const frame = layout({ columns: 160, rows: 1010 }, surface);
    expect(frame.cells.length).toBeGreaterThan(900);

    const renderer = yield* useReplRenderer({ columns: 20, rows: 5 });
    const snapshot = input(frame, tree);
    const rendered = yield* drawn(renderer, snapshot);

    expect(rendered.recovered).toBe(true);
    // The same logical frame: the same tree, the same targets, the same
    // geometry. Recovery is invisible above this line.
    expect(rendered.tree).toBe(tree.frame().id);
    expect(rendered.map.targets.length).toBeGreaterThan(0);
    expect(renderer.last()).toEqual(snapshot);

    const repeated = yield* drawn(renderer, snapshot);
    expect(repeated.recovered).toBe(false);
    expect(repeated.map.targets.map((target) => target.id)).toEqual(
      rendered.map.targets.map((target) => target.id),
    );
    expect(tree.focused()).toBe(tree.focused());
    expect(tree.mounted()).toHaveLength(frame.cells.length);
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
  let waiting: ((result: IteratorResult<Uint8Array, undefined>) => void) | undefined;
  let ended = false;

  const log: TerminalLog = {
    raw: [],
    writes: 0,
    resets: 0,
    listeners: 0,
    readers: 0,
    opened: 0,
    reading: false,
    size,
    hold: false,
    feed(bytes: Uint8Array): void {
      const resolve = waiting;
      if (resolve === undefined) {
        queue.push(bytes);
        return;
      }
      waiting = undefined;
      log.reading = false;
      resolve({ done: false, value: bytes });
    },
    end(): void {
      ended = true;
      const resolve = waiting;
      if (resolve !== undefined) {
        waiting = undefined;
        log.reading = false;
        resolve({ done: true, value: undefined });
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
    write(_bytes: Uint8Array): Promise<void> {
      if (log.hold) {
        // Never completes: what a terminal that has stopped accepting bytes
        // looks like from here, and where a cancellation can land.
        return new Promise<void>(() => {});
      }
      log.writes += 1;
      return Promise.resolve();
    },
    writeNow(_bytes: Uint8Array): void {
      log.resets += 1;
    },
    setRaw(raw: boolean): void {
      log.raw.push(raw);
    },
    bytes(): AsyncIterable<Uint8Array> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array, undefined> {
          log.readers += 1;
          log.opened += 1;
          return {
            next(): Promise<IteratorResult<Uint8Array, undefined>> {
              const head = queue.shift();
              if (head !== undefined) {
                return Promise.resolve({ done: false, value: head });
              }
              if (ended) {
                return Promise.resolve({ done: true, value: undefined });
              }
              log.reading = true;
              return new Promise<IteratorResult<Uint8Array, undefined>>((resolve) => {
                waiting = resolve;
              });
            },
            return(): Promise<IteratorResult<Uint8Array, undefined>> {
              log.readers -= 1;
              log.reading = false;
              // Closing a source settles the read that was outstanding on it,
              // the way a real reader does. A fake that abandoned the promise
              // would leave the runtime holding one forever.
              const resolve = waiting;
              waiting = undefined;
              resolve?.({ done: true, value: undefined });
              return Promise.resolve({ done: true, value: undefined });
            },
          };
        },
      };
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
}

const BYTES = new TextEncoder();

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
      // a key with no meaning here at all.
      terminal.log.feed(new Uint8Array([0x03]));
      terminal.log.feed(BYTES.encode("\x1ba"));
      terminal.log.feed(new Uint8Array([0x08]));
      terminal.log.feed(BYTES.encode("\x1b[15~"));
      // A sentinel behind them, so the assertion is the whole sequence and not
      // just the absence of something.
      terminal.log.feed(BYTES.encode("z"));

      expect(normalizedFrom(yield* drained(events))).toEqual([{ kind: "text", text: "z" }]);
    });
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
    const { tree, surface } = yield* mounted(FILLED);
    const renderer = yield* useReplRenderer({ columns: 160, rows: 36 });
    const rendered = yield* drawn(
      renderer,
      input(layout({ columns: 160, rows: 36 }, surface), tree),
    );

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
    const { tree, surface } = yield* mounted(state);
    const renderer = yield* useReplRenderer({ columns: 160, rows: 36 });
    const rendered = yield* drawn(
      renderer,
      input(layout({ columns: 160, rows: 36 }, surface), tree),
    );

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
    const { tree, surface } = yield* mounted(FILLED);
    const renderer = yield* useReplRenderer({ columns: 160, rows: 36 });
    const rendered = yield* drawn(
      renderer,
      input(layout({ columns: 160, rows: 36 }, surface), tree),
    );

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
    committed(yield* tree.apply(fixtureDescriptions({ ...FILLED, draft: "yes" })));
    expect(tree.frame().id).not.toBe(pointer.frame);

    const outcome = acted(yield* tree.dispatch(pointer));
    expect(outcome.outcome).toBe("dropped");
    if (outcome.outcome === "dropped") {
      expect(outcome.reason).toContain("no longer drawn");
    }
  });

  it("I1: a pointer naming a node the tree removed reaches nothing", function* () {
    const { tree, surface } = yield* mounted(FILLED);
    const renderer = yield* useReplRenderer({ columns: 160, rows: 36 });
    const rendered = yield* drawn(
      renderer,
      input(layout({ columns: 160, rows: 36 }, surface), tree),
    );

    const removed = rendered.map.targets.find(
      (target) => tree.keyOf(target.node) === "scope:entry-1/generated",
    );
    if (removed === undefined) {
      throw new Error("the generated scope row is drawn and targetable");
    }

    committed(yield* tree.apply(fixtureDescriptions({ ...FILLED, scopes: ["entry-1/component"] })));
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

    // And redrawing does not offer it either.
    const after = yield* drawn(
      renderer,
      input(layout({ columns: 160, rows: 36 }, fixtureSurface(tree, FILLED)), tree),
    );
    expect(after.map.targets.map((target) => target.node)).not.toContain(removed.node);
  });
});
