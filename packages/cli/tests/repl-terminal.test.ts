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
import { useTempFileCompiler } from "@executablemd/core";
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
  withResolvers,
} from "effection";

import { projectRepl } from "../src/repl/model.ts";
import type { ReplModel } from "../src/repl/model.ts";
import { navigationOf } from "../src/repl/navigation.ts";
import { NO_LIFECYCLE } from "../src/repl/lifecycle.ts";
import { commitReplFrame } from "../src/repl/program.ts";
import {
  initialState,
  NO_AGENT,
  reduceRepl,
  viewFor,
  withWorkspace,
  workspaceOf,
} from "../src/repl/application.ts";
import type { ReplLive, ReplState, ReplView } from "../src/repl/application.ts";
import type { ReplAction } from "../src/repl/components/actions.ts";
import type { ReplBounds } from "../src/repl/layout.ts";
import { ReplRenderError, resolvePointer, useReplRenderer } from "../src/repl/renderer.ts";
import type { ReplMeasured, ReplRenderer } from "../src/repl/renderer.ts";
import { useGrid, usePresenter } from "./fixtures/repl/presentation.ts";
import type { Observed, Presenter } from "./fixtures/repl/presentation.ts";
import { referenceEvents } from "./fixtures/repl/reference.ts";
import { useTerminalScreen } from "./support/terminal-screen.ts";
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
import type { ReplDispatched } from "../src/repl/reconcile.ts";
import type { ReplInputEvent } from "../src/repl/description.ts";
import { useReplPage } from "./support/mounted-page.ts";
import type { PageArea, PageFrame, ReplPage } from "./support/mounted-page.ts";
import {
  draft,
  entrySettles,
  focusCycle,
  frameAt,
  openCatalog,
  paste,
} from "./support/repl-page-adapters.ts";

const WIDE: ReplTerminalSize = { columns: 160, rows: 36 };
const MEDIUM: ReplTerminalSize = { columns: 120, rows: 30 };
const NARROW: ReplTerminalSize = { columns: 72, rows: 20 };
const TOO_SMALL: ReplTerminalSize = { columns: 40, rows: 10 };

/** The drawer layer's region, as the running command reports it. */
const LAYER = "box:drawer:layer";

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

/** Let every task that is ready take its turn. */
function* settled(): Operation<void> {
  yield* sleep(0);
  yield* sleep(0);
  yield* sleep(0);
}

/** What one dispatch produced, or the failure it ended in. */
function acted(outcome: Result<ReplDispatched<ReplAction>>): ReplDispatched<ReplAction> {
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

/** The reference journal, read the way the application reads one. */
function* referenceModel(): Operation<ReplModel> {
  yield* useTempFileCompiler();
  const result = projectRepl(yield* referenceEvents());
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/** The screen the application draws for one model, as the program hands it to a frame. */
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

/**
 * The production pipeline over the application's own screen.
 *
 * One engine pair, one tree and one grid throughout, because what a later frame
 * writes is the difference from the frame before it — which is the whole subject
 * of the isolation and stale-text rows.
 */
interface Application {
  readonly presenter: Presenter;
  /** The state a person reaches by opening the Entries catalog from the first screen. */
  readonly opened: ReplState;
  /** The state after the catalog is put away again. */
  readonly closed: ReplState;
  /**
   * Commit one screen at one size, composed from the focus the tree answers with.
   *
   * The first frame carries no focus, so the Draft takes it exactly as it does
   * when a command opens; every frame after composes from the tree's own answer.
   */
  commit(options?: {
    readonly size?: ReplTerminalSize;
    readonly state?: ReplState;
  }): Operation<Observed>;
}

function* useApplication(model: ReplModel, size: ReplTerminalSize = WIDE): Operation<Application> {
  const presenter = yield* usePresenter(size);
  const first = initialState("reference");
  const opened = reduceRepl(first, { kind: "open-catalog" }, model, IDLE).state;
  let current = size;
  return {
    presenter,
    opened,
    closed: reduceRepl(opened, { kind: "close-catalog" }, model, IDLE).state,
    *commit(options = {}) {
      if (presenter.last() === undefined && options.state !== undefined) {
        // A command opens on its first screen, and a catalog is opened from it.
        yield* presenter.commit(viewOf(model, current));
      }
      const at = options.size ?? current;
      if (at.columns !== current.columns || at.rows !== current.rows) {
        presenter.resize(at);
        current = at;
      }
      const node = presenter.tree.focused();
      const focused = node === undefined ? undefined : presenter.tree.keyOf(node);
      return yield* presenter.commit(viewOf(model, at, { state: options.state, focused }));
    },
  };
}

/** Submit one entry through the Draft and wait for the History rail to mark it settled. */
function* submit(page: ReplPage, order: number, source: string): Operation<void> {
  yield* paste(page, draft(page), source);
  yield* page.key("Enter");
  yield* entrySettles(page, order, "ok");
}

/** A reading long enough that the drawer's rectangle lands on top of it. */
const COVERED_READING = Array.from({ length: 24 }, (_unused, at) => `COVERED-ROW-${at}`).join(
  "\n\n",
);

const readingArea = (frame: PageFrame): PageArea | undefined => frame.area("box:reading:viewport");

/** A page whose reading is the long entry, with nothing else in the way. */
function* coveredScreen(size: ReplTerminalSize): Operation<ReplPage> {
  const page = yield* useReplPage({ size });
  yield* submit(page, 1, COVERED_READING);
  yield* page.until(
    "the long entry being read",
    (frame) => readingArea(frame)?.shows("COVERED-ROW-3") ?? false,
  );
  return page;
}

describe("REPL terminal: responsive semantic frames", () => {
  it("F1: a wide frame carries the identity row, three columns and the fixed footer", function* () {
    const page = yield* useReplPage({ size: WIDE });
    const frame = page.frame();
    const bounds = (id: string): ReplBounds | undefined => frame.area(id)?.bounds;

    expect(frame.profile).toBe("wide");
    // The spec's first composition: the columns are 36, 66 and 58 cells,
    // dividers included, the body 33 rows and the Draft four of the centre's.
    expect(bounds("box:identity")).toEqual({ x: 0, y: 0, width: 160, height: 1 });
    expect(bounds("box:sidebar")).toEqual({ x: 0, y: 1, width: 36, height: 33 });
    expect(bounds("box:transcript")).toEqual({ x: 36, y: 1, width: 66, height: 33 });
    expect(bounds("box:inspection")).toEqual({ x: 102, y: 1, width: 58, height: 33 });
    expect(bounds("box:draft")?.height).toBe(4);
    // Full width and pinned to the bottom, at every size: one compact History
    // row and one row of guidance.
    expect(bounds("box:history")).toEqual({ x: 0, y: 34, width: 160, height: 1 });
    expect(bounds("box:guidance")).toEqual({ x: 0, y: 35, width: 160, height: 1 });

    // Each pane holds its own controls and no other pane's.
    expect(frame.area("box:sidebar")?.contains("transcript:selector")).toBe(true);
    for (const key of ["entries:heading", "footer:input", "draft:send"]) {
      expect([key, frame.area("box:transcript")?.contains(key)]).toEqual([key, true]);
    }
    for (const key of ["tab:bindings", "tab:sidekick", "sidekick:message"]) {
      expect([key, frame.area("box:inspection")?.contains(key)]).toEqual([key, true]);
    }
    for (const key of ["footer:history", "footer:exit"]) {
      expect([key, frame.area("box:history")?.contains(key)]).toEqual([key, true]);
    }
    expect(frame.has("tray:queue")).toBe(false);
    expect(frame.has("follow")).toBe(false);
  });

  it("F1: a medium frame keeps every region, narrower", function* () {
    const page = yield* useReplPage({ size: MEDIUM });
    const frame = page.frame();
    const bounds = (id: string): ReplBounds | undefined => frame.area(id)?.bounds;

    expect(frame.profile).toBe("medium");
    const [left, centre, right] = ["box:sidebar", "box:transcript", "box:inspection"].map(bounds);
    if (left === undefined || centre === undefined || right === undefined) {
      throw new Error(`a medium frame drew fewer than three columns. ${page.describe()}`);
    }
    // The same three columns, tiling the width, with the centre and the right
    // pane giving cells up from the 66 and 58 they hold at 160.
    expect(left.x).toBe(0);
    expect(centre.x).toBe(left.x + left.width);
    expect(right.x).toBe(centre.x + centre.width);
    expect(right.x + right.width).toBe(120);
    expect(centre.width).toBeLessThan(66);
    expect(right.width).toBeLessThan(58);
    for (const column of [left, centre, right]) {
      expect(column.y).toBe(1);
      expect(column.height).toBe(27);
    }
    expect(bounds("box:history")).toEqual({ x: 0, y: 28, width: 120, height: 1 });
    expect(bounds("box:guidance")).toEqual({ x: 0, y: 29, width: 120, height: 1 });
    expect(frame.has("tray:queue")).toBe(false);
    expect(frame.has("follow")).toBe(false);
  });

  it("F1: a narrow frame routes one content surface and keeps the drawer and footer", function* () {
    const page = yield* useReplPage({ size: NARROW });
    const frame = page.frame();

    expect(frame.profile).toBe("narrow");
    expect(frame.area("box:content")?.bounds).toEqual({ x: 0, y: 1, width: 72, height: 17 });
    for (const column of ["box:sidebar", "box:transcript", "box:inspection"]) {
      expect([column, frame.area(column)]).toEqual([column, undefined]);
    }
    // The same footer contract as the wide frame: full width, one History row
    // and one row of guidance.
    expect(frame.area("box:history")?.bounds).toEqual({ x: 0, y: 18, width: 72, height: 1 });
    expect(frame.area("box:guidance")?.bounds).toEqual({ x: 0, y: 19, width: 72, height: 1 });
    expect(frame.has("tray:queue")).toBe(false);
    expect(frame.has("follow")).toBe(false);

    yield* openCatalog(page);
    const opened = page.frame();
    const body = opened.area("box:body")?.bounds;
    const layer = opened.area(LAYER)?.bounds;
    if (body === undefined || layer === undefined) {
      throw new Error(`the narrow frame drew no drawer over its body. ${page.describe()}`);
    }
    expect(layer.x).toBeGreaterThanOrEqual(body.x);
    expect(layer.y).toBeGreaterThanOrEqual(body.y);
    expect(layer.x + layer.width).toBeLessThanOrEqual(body.x + body.width);
    expect(layer.y + layer.height).toBeLessThanOrEqual(body.y + body.height);
    // Its title, both window controls, its one row and the way out.
    expect(opened.area(LAYER)?.shows("Entries")).toBe(true);
    expect(opened.area(LAYER)?.controls()).toEqual([
      "drawer:scroll:up",
      "drawer:scroll:down",
      "drawer:close",
    ]);
    expect(opened.area("box:history")?.bounds).toEqual({ x: 0, y: 18, width: 72, height: 1 });
    expect(opened.has("footer:history")).toBe(true);
  });

  it("F1: narrow shows the routed surface, and no other surface is reachable", function* () {
    const page = yield* useReplPage({ size: NARROW });
    const surfaces = ["sessions:heading", "entries:heading"];

    // Entries is the route a command opens on.
    const entries = page.frame();
    for (const key of ["footer:input", "draft:send"]) {
      expect([key, entries.has(key)]).toEqual([key, true]);
    }
    expect(entries.area("box:reading:viewport")).toBeDefined();
    // The other surface is **absent**, not hidden. A narrow frame has one
    // region, so a row of the surface it is not showing would be focusable with
    // nowhere to be drawn — which is why it is in no control and no cell.
    for (const key of ["transcript:selector", "sessions:earlier", "sessions:later"]) {
      expect([key, entries.has(key)]).toEqual([key, false]);
    }
    expect(entries.area("box:sessions:viewport")).toBeUndefined();
    expect(entries.rows.join("\n")).not.toContain("none retained");

    yield* page.press("sessions:heading");
    const sessions = yield* page.until("the Sessions surface", (frame) =>
      frame.has("transcript:selector"),
    );
    expect(sessions.area("box:sessions:viewport")).toBeDefined();
    for (const key of ["footer:input", "draft:send", "reading:earlier", "reading:later"]) {
      expect([key, sessions.has(key)]).toEqual([key, false]);
    }
    expect(sessions.area("box:reading:viewport")).toBeUndefined();
    expect(sessions.area("box:draft")).toBeUndefined();
    expect(sessions.rows.join("\n")).not.toContain("DRAFT");

    // What stays is the way between them, on either route. A narrow frame has
    // no inspection column, so the Bindings and the Sidekick are not on it.
    for (const frame of [entries, sessions]) {
      for (const key of surfaces) {
        expect([key, frame.has(key)]).toEqual([key, true]);
      }
      for (const key of ["tab:bindings", "tab:sidekick", "sidekick:message"]) {
        expect([key, frame.has(key)]).toEqual([key, false]);
      }
    }
  });

  it("F1: below the minimum the frame is an explicit refusal with nothing targetable", function* () {
    const sizes = [{ columns: 71, rows: 20 }, { columns: 72, rows: 19 }, TOO_SMALL];
    const page = yield* useReplPage({ size: sizes[0] });
    for (const size of sizes) {
      const frame = yield* frameAt(page, size);
      expect(frame.profile).toBe("too-small");
      expect([...frame.regions.keys()]).toEqual(["box:root", "box:refusal"]);
      // A control that is not in the frame cannot be reached by a pointer either.
      expect(frame.controls).toEqual([]);
      // It says the minimum, that growing recovers, and that Escape leaves.
      const shown = frame.rows.join(" ");
      expect(shown).toContain("72x20");
      expect(shown).toContain("larger");
      expect(shown).toContain("Escape");
    }
    const recovered = yield* frameAt(page, NARROW);
    expect(recovered.profile).toBe("narrow");
    expect(recovered.controls.length).toBeGreaterThan(0);
  });

  it("F1: Sessions says so when there is nothing in it", function* () {
    const page = yield* useReplPage({ size: WIDE });
    const frame = page.frame();

    expect(frame.area("box:sidebar")?.shows("(none retained)")).toBe(true);
    expect(frame.area("box:transcript")?.shows("No entry yet")).toBe(true);
    // Nothing is read, and nothing pretends to be: the reading is blank cells.
    expect(frame.area("box:reading:viewport")?.rows().join("")).toBe("");
    expect(frame.profile).toBe("wide");
  });

  // Retired for #881 PR 3: "F1: compact geometry groups marker labels and
  // keeps every marker's identity".
  //
  // It asserted that a compact band shares *labels* and that each marker
  // names the others it shares one with. The band no longer has labels: it
  // places marks at engine-measured columns, and a group is the positions
  // that landed on the same one. Its surviving claim — a compact band never
  // costs a reader the ability to reach an exact position — is now
  // `repl-history.test.ts`'s "groups collisions deterministically, and keeps
  // every member", which makes it against the real engine at two widths and
  // checks the ordinals as well as the markers.

  it("F1: resizing through every profile keeps selection, focus and action identity", function* () {
    const page = yield* useReplPage({ size: WIDE });
    yield* draft(page).type("kept");
    const first = page.frame();
    // `keys()` already answers with a fresh array, so it is sorted in place:
    // the Node typecheck's `lib` is ES2022 and `toSorted` is ES2023.
    const keys = first.keys().sort();
    expect(keys.length).toBeGreaterThan(0);

    // Across the three drawable profiles, a smaller frame admits fewer rows —
    // that is what measured admission is for. What resizing must not do is
    // *rename* anything: every control that is still shown is the same key it
    // was, and the focus and what was typed survive the move.
    const profiles = [first.profile];
    for (const size of [MEDIUM, NARROW]) {
      const frame = yield* page.resize(size);
      profiles.push(frame.profile);
      const shared = frame.keys().filter((key) => keys.includes(key));
      expect(shared).toEqual(
        expect.arrayContaining(["footer:input", "footer:history", "footer:exit"]),
      );
      expect(frame.focused).toBe("footer:input");
      expect(draft(page).text()).toBe("kept");
    }

    // Below the minimum there is nothing to keep: that frame draws its refusal
    // and places no control.
    const refused = yield* page.resize(TOO_SMALL);
    profiles.push(refused.profile);
    expect(profiles).toEqual(["wide", "medium", "narrow", "too-small"]);
    expect(refused.controls).toEqual([]);

    // And it recovers: growing the window back shows exactly the controls it
    // showed before, with the focus and the text where they were.
    const back = yield* page.resize(WIDE);
    expect(back.keys().sort()).toEqual(keys);
    expect(back.focused).toBe("footer:input");
    expect(draft(page).text()).toBe("kept");
    // The same control still means the same thing: Enter on the Draft submits
    // what was typed before any of this.
    yield* page.key("Enter");
    yield* entrySettles(page, 1, "ok");
    expect(readingArea(page.frame())?.shows("kept")).toBe(true);
  });

  it("UI5: the History band is placed in the footer, not at the frame's origin", function* () {
    const page = yield* useReplPage({ size: WIDE });
    for (const size of [WIDE, NARROW]) {
      const frame = yield* frameAt(page, size);
      const history = frame.area("box:history");
      const guidance = frame.area("box:guidance");
      if (history === undefined || guidance === undefined) {
        throw new Error(`every drawable frame has a footer. ${page.describe()}`);
      }

      // One row, full width, between the body and the guidance: never at the
      // origin, which is the identity row's.
      expect(history.bounds).toEqual({ x: 0, y: size.rows - 2, width: size.columns, height: 1 });
      expect(history.bounds.y).toBeGreaterThan(frame.area("box:identity")?.bounds.y ?? 0);
      expect(history.bounds.y + 1).toBe(guidance.bounds.y);
      // And what the terminal actually holds on that row is the band's own
      // surface, for the full width of the footer: the controls it carries sit
      // inside it.
      expect(frame.rows[history.bounds.y]).toContain("HISTORY");
      expect(frame.rows[0]).not.toContain("HISTORY");
      for (const key of ["footer:history", "footer:exit"]) {
        expect([key, history.contains(key)]).toEqual([key, true]);
      }
    }
  });

  it("UI5: a refusal has no band to place and no cell to aim at", function* () {
    const page = yield* useReplPage({ size: TOO_SMALL });
    const frame = page.frame();

    expect(frame.profile).toBe("too-small");
    // No band row placed at all rather than an empty rectangle: a renderer given
    // a zero rectangle draws rows into it.
    expect(frame.area("box:history")).toBeUndefined();
    // The sentence and nothing else. It is the frame's own — below the minimum
    // there is no row to describe — and nothing on this screen is a target.
    expect(frame.controls).toEqual([]);
    const shown = frame.rows.join(" ");
    expect(shown).toContain("larger");
    expect(shown).toContain("Escape");
  });

  it("UI5: every visible action has its own geometry in the frame's target map", function* () {
    const app = yield* useApplication(yield* referenceModel());
    const frame = yield* app.commit();
    const history = frame.regionOf("box:history");
    if (history === undefined) {
      throw new Error("every drawable frame has a History row");
    }
    const { map } = frame.committed.rendered;

    // The action row's controls sit side by side on one row, each as wide as
    // its own label — so a pointer on one reaches that one and not its
    // neighbour.
    const placed = frame.targets.filter((target) => target.bounds.y === history.y);
    expect(placed.length).toBeGreaterThan(1);
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
    // selected in the History drawer. So no column of its map answers a pointer.
    const band = frame.regionOf("box:history:map");
    if (band === undefined) {
      throw new Error("the History row draws no map");
    }
    for (let x = band.x; x < band.x + band.width; x += 1) {
      expect([x, map.at(x, band.y)]).toEqual([x, undefined]);
    }
  });

  it("F1: a pointer against a control the refusal hides reaches nothing", function* () {
    const app = yield* useApplication(yield* referenceModel(), NARROW);
    const visible = yield* app.commit();
    const input = visible.targets.find(
      (target) => app.presenter.tree.keyOf(target.node) === "footer:input",
    );
    expect(input).toBeDefined();
    if (input === undefined) {
      throw new Error("the narrow frame draws the footer input");
    }
    // The same place, now under a refusal.
    const refused = yield* app.commit({ size: TOO_SMALL });
    expect(refused.targets).toEqual([]);
    expect(
      resolvePointer(refused.committed.rendered, { column: input.bounds.x, row: input.bounds.y }),
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
    const app = yield* useApplication(yield* referenceModel(), NARROW);
    const narrow = yield* app.commit();
    const held = narrow.committed.rendered.output;
    const witnessed = Array.from(held);
    expect(witnessed.length).toBeGreaterThan(0);

    // A second render writes over the engine's output region, and a resize
    // grows its memory, which detaches every view into the old buffer.
    yield* app.commit({ size: MEDIUM });
    yield* app.commit({ size: WIDE });

    expect(Array.from(held)).toEqual(witnessed);
  });

  it("H1: what a caller does to bytes it holds cannot change a later render", function* () {
    // The same three frames through two renderers. One caller scribbles over
    // every result it is handed; the other leaves them alone. A renderer whose
    // result aliased the engine's memory would have the scribbling corrupt the
    // state the next frame is diffed against, and the two sequences would part.
    const model = yield* referenceModel();
    const sequence: readonly ReplTerminalSize[] = [NARROW, MEDIUM, NARROW];

    const tampered: number[][] = [];
    yield* scoped(function* (): Operation<void> {
      const app = yield* useApplication(model, NARROW);
      for (const size of sequence) {
        const rendered = (yield* app.commit({ size })).committed.rendered;
        tampered.push(Array.from(rendered.output));
        rendered.output.fill(0);
      }
    });

    const clean: number[][] = [];
    yield* scoped(function* (): Operation<void> {
      const app = yield* useApplication(model, NARROW);
      for (const size of sequence) {
        clean.push(Array.from((yield* app.commit({ size })).committed.rendered.output));
      }
    });

    expect(tampered[0].length).toBeGreaterThan(0);
    expect(tampered).toEqual(clean);
  });

  it("H1: a frame drawn after a removal draws only what is still mounted", function* () {
    const app = yield* useApplication(yield* referenceModel());
    const { tree } = app.presenter;
    const before = yield* app.commit({ state: app.opened });
    const going = tree.mounted().find((id) => tree.keyOf(id) === "drawer:close");
    if (going === undefined) {
      throw new Error("the catalog's Close is mounted before the removal");
    }
    expect(before.keys).toContain("drawer:close");

    // The reading loses the catalog, and the next frame is committed from it.
    const after = yield* app.commit({ state: app.closed });
    expect(tree.mounted()).not.toContain(going);

    // The mounted tree is the only source of renderable nodes: a row that has
    // gone is not drawn, and is therefore not a target either.
    expect(after.committed.rendered.map.targets.map((target) => target.node)).not.toContain(going);
    expect(after.keys).not.toContain("drawer:close");
    expect(after.committed.rendered.map.targets.length).toBeGreaterThan(0);
  });

  it("H1: capacity replacement redraws the identical logical frame", function* () {
    // Deliberately more than any of the supported profiles produces: the
    // engine's measurement arenas are sized from the dimensions it was built
    // for, and what this proves is that a renderer built when the terminal was
    // tiny recovers rather than refusing the frame the terminal now needs.
    const rows = 1000;
    const huge: ReplTerminalSize = { columns: 160, rows: rows + 10 };
    const ops: Op[] = [
      open("root", {
        layout: { width: fixed(huge.columns), height: fixed(huge.rows), direction: "ttb" },
      }),
    ];
    const ids: string[] = [];
    for (let at = 0; at < rows; at += 1) {
      const id = `row-${at}`;
      ids.push(id);
      ops.push(
        open(id, { layout: { width: fixed(huge.columns), height: fixed(1) } }),
        text(`a fairly long recorded value for row number ${at}`),
        close(),
      );
    }
    ops.push(close());
    const request = {
      ops,
      boxes: ids.map((id) => ({ id, node: id, control: true })),
      regions: [] as string[],
      tree: 1,
      size: huge,
      deltaTime: 0,
      pointer: undefined,
    };

    yield* scoped(function* (): Operation<void> {
      // Built for a terminal far smaller than the frame it is about to be given.
      const renderer = yield* useReplRenderer({ columns: 20, rows: 5 });
      const measured = yield* renderer.measure(ops, huge);
      if (!measured.ok) {
        throw measured.error;
      }
      const drawn = yield* renderer.draw(request);
      if (!drawn.ok) {
        throw drawn.error;
      }

      expect(drawn.value.recovered).toBe(true);
      // The same logical frame: every row is a real target. Recovery is
      // invisible above this line.
      expect(drawn.value.map.targets.length).toBe(rows);
      expect(drawn.value.tree).toBe(1);

      // One replacement each, and no more: a frame this much larger than the
      // terminal these engines were built for overflows both arenas, so each
      // refuses once on its own pass and is rebuilt at the frame's own size.
      expect(renderer.engines()).toEqual({ measuring: 2, drawing: 2 });

      // Drawn again at the same size, it needs no recovery and places the same
      // controls under the same ids.
      const repeated = yield* renderer.draw(request);
      if (!repeated.ok) {
        throw repeated.error;
      }
      expect(repeated.value.recovered).toBe(false);
      expect(repeated.value.map.targets.map((target) => target.id)).toEqual(
        drawn.value.map.targets.map((target) => target.id),
      );
      // Reused, not rebuilt: drawing the same frame again creates nothing.
      expect(renderer.engines()).toEqual({ measuring: 2, drawing: 2 });
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
 * several, which is exactly what the assertion below must not depend on. This one
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
    // moved focus forward would satisfy the assertions above and still be the
    // defect. So the keystroke is sent to the running command, which answers
    // with the control that holds focus afterwards.
    const page = yield* useReplPage({ size: WIDE });
    expect(page.frame().focused).toBe("footer:input");

    yield* page.key("Tab");
    const forward = yield* page.until(
      "focus moving forward",
      (frame) => frame.focused !== "footer:input",
    );
    yield* page.key("Backtab");
    yield* page.until("focus coming back", (frame) => frame.focused === "footer:input");
    expect(forward.focused).not.toBe("footer:input");
  });

  it("I1: going back inside a drawer stays inside it", function* () {
    // Containment is the drawer's, not this key's. Backtab must traverse the
    // chain the drawer owns rather than escape to the reading behind it. The
    // History controls belong to that chain: they stay reachable from inside
    // an open drawer, where they belong to that drawer.
    const page = yield* useReplPage({ size: WIDE });
    yield* openCatalog(page);
    const opened = page.frame();
    const owned = new Set([
      ...(opened.area(LAYER)?.controls() ?? []),
      ...(opened.area("box:history")?.controls() ?? []),
    ]);
    expect(owned.size).toBeGreaterThan(2);
    expect(owned.has(opened.focused ?? "")).toBe(true);
    const behind = opened.keys().filter((key) => !owned.has(key));
    expect(behind.length).toBeGreaterThan(0);

    for (let step = 0; step < owned.size + 1; step += 1) {
      const previous = page.frame().focused;
      yield* page.key("Backtab");
      const moved = yield* page.until("focus moving back", (frame) => frame.focused !== previous);
      expect([step, owned.has(moved.focused ?? "")]).toEqual([step, true]);
      expect([step, behind.includes(moved.focused ?? "")]).toEqual([step, false]);
    }
  });

  it("I1: text and Backspace reach the draft through the same ancestry as a key", function* () {
    const page = yield* useReplPage({ size: WIDE });

    // Focus is on the draft line, which is where typing goes.
    expect(page.frame().focused).toBe("footer:input");
    yield* draft(page).type("é");
    expect(draft(page).text()).toBe("é");

    // A pasted newline arrives as text of its own, and starts a row.
    yield* paste(page, draft(page), "x\ny");
    expect(
      draft(page)
        .text()
        .split("\n")
        .map((line) => line.trim()),
    ).toEqual(["éx", "y"]);

    yield* page.key("Backspace");
    yield* page.key("Backspace");
    yield* page.until("both characters erased", () => draft(page).text() === "éx");

    // And the named keys still mean what they meant.
    yield* page.key("Enter");
    yield* entrySettles(page, 1, "ok");
    expect(draft(page).text()).toBe("");
    expect(readingArea(page.frame())?.shows("éx")).toBe(true);
    yield* page.key("Tab");
    yield* page.until("focus moving off the draft", (frame) => frame.focused !== "footer:input");
  });

  it("I1: text a row does not claim passes it on the way up", function* () {
    const app = yield* useApplication(yield* referenceModel());
    const { tree } = app.presenter;
    yield* app.commit({ state: app.opened });

    // Focus is inside the drawer, on a row that has no use for text.
    const closer = tree.mounted().find((id) => tree.keyOf(id) === "drawer:close");
    if (closer === undefined) {
      throw new Error("the catalog's Close is mounted");
    }
    yield* tree.dispatch({ kind: "key", key: "Backtab" });
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
    expect(escaped.outcome).toBe("action");
    if (escaped.outcome === "action") {
      expect(escaped.action.kind).toBe("close-drawer");
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
    const app = yield* useApplication(yield* referenceModel());
    const { tree } = app.presenter;
    const frame = yield* app.commit();
    const rendered = frame.committed.rendered;

    // Focus is walked to the control the way a person walks it: with Tab.
    for (let press = 0; press < 40; press += 1) {
      const held = tree.focused();
      if (held !== undefined && tree.keyOf(held) === "entries:heading") {
        break;
      }
      acted(yield* tree.dispatch({ kind: "key", key: "Tab" }));
    }
    const byKey = acted(yield* tree.dispatch({ kind: "key", key: "Enter" }));
    expect(byKey.outcome).toBe("action");

    const control = rendered.map.targets.find(
      (target) => tree.keyOf(target.node) === "entries:heading",
    );
    if (control === undefined) {
      throw new Error("the Entries heading is drawn and targetable");
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
    const app = yield* useApplication(yield* referenceModel());
    const { tree } = app.presenter;
    const frame = yield* app.commit({ state: app.opened });
    const rendered = frame.committed.rendered;

    const behind = rendered.map.targets.find(
      (target) => tree.keyOf(target.node) === "transcript:selector",
    );
    if (behind === undefined) {
      throw new Error("the Transcript's selector is drawn and targetable behind the drawer");
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
    const app = yield* useApplication(yield* referenceModel());
    const { tree } = app.presenter;
    const frame = yield* app.commit();
    const rendered = frame.committed.rendered;

    const control = rendered.map.targets.find(
      (target) => tree.keyOf(target.node) === "entries:heading",
    );
    if (control === undefined) {
      throw new Error("the Entries heading is drawn and targetable");
    }
    const pointer = resolvePointer(rendered, { column: control.bounds.x, row: control.bounds.y });
    if (pointer === undefined) {
      throw new Error("a pointer inside a drawn control resolves to it");
    }

    // The screen moved on.
    yield* app.commit({ state: { ...initialState("reference"), draft: "yes" } });
    expect(tree.frame().id).not.toBe(pointer.frame);

    const outcome = acted(yield* tree.dispatch(pointer));
    expect(outcome.outcome).toBe("dropped");
    if (outcome.outcome === "dropped") {
      expect(outcome.reason).toContain("no longer drawn");
    }
  });

  it("I1: a pointer naming a node the tree removed reaches nothing", function* () {
    const app = yield* useApplication(yield* referenceModel());
    const { tree } = app.presenter;
    const frame = yield* app.commit({ state: app.opened });
    const rendered = frame.committed.rendered;

    const removed = rendered.map.targets.find(
      (target) => tree.keyOf(target.node) === "scope:entry-1/generated-1",
    );
    if (removed === undefined) {
      throw new Error("the generated scope row is drawn and targetable");
    }

    const shorter = yield* app.commit({ state: app.closed });
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
    expect(shorter.committed.rendered.map.targets.map((target) => target.node)).not.toContain(
      removed.node,
    );
  });
});

describe("REPL terminal: what a drawer covers, and what it cannot reach", () => {
  it("TL6: a drawer obscures the whole of its rectangle, blank cells included", function* () {
    const page = yield* coveredScreen(WIDE);
    const before = page.frame();
    expect(before.area(LAYER)).toBeUndefined();

    // The drawer holds a few short rows, so most of what it covers is its own
    // blank space — which is exactly the part a drawer without a background
    // lets through.
    yield* openCatalog(page);
    const after = page.frame();
    const covered = after.area(LAYER);
    if (covered === undefined) {
      throw new Error(`no drawer is open. ${page.describe()}`);
    }

    // Pre-assert: the cells the drawer is about to cover really had text in
    // them. Without this the assertion below would pass on an empty screen.
    const hidden = before.within(covered.bounds).rows();
    expect(hidden.filter((line) => line.includes("COVERED-ROW-")).length).toBeGreaterThan(0);

    // And none of their text is anywhere inside the rectangle now, in the cells
    // Termless holds. The drawer's own text is there instead.
    const inside = covered.rows().join("\n");
    expect(inside).not.toContain("COVERED-ROW-");
    expect(inside).toContain("Entries");
    expect(inside).toContain("[close]");
  });

  it("TL6: the footer is never covered, and a narrow start behaves the same", function* () {
    for (const size of [WIDE, NARROW]) {
      yield* scoped(function* (): Operation<void> {
        const page = yield* useReplPage({ size });
        yield* openCatalog(page);
        const frame = page.frame();
        const rect = frame.area(LAYER)?.bounds;
        const history = frame.area("box:history")?.bounds;
        const draftBox = frame.area("box:draft")?.bounds;
        if (rect === undefined || history === undefined || draftBox === undefined) {
          throw new Error(
            `the drawer, the History row and the Draft were not all placed. ${page.describe()}`,
          );
        }
        // Above the footer rather than across it: the History controls are the
        // way out and the Draft is what the person is writing, and a modal that
        // covered either would hide them.
        expect(rect.y + rect.height).toBeLessThanOrEqual(history.y);
        expect(rect.y + rect.height).toBeLessThanOrEqual(draftBox.y);
        // And they are still drawn, with their own text.
        expect(frame.rows[history.y]).toContain("HISTORY");
        expect(frame.has("footer:history")).toBe(true);
        expect(frame.has("footer:exit")).toBe(true);
        expect(frame.control("footer:input")?.text).toContain("DRAFT");
      });
    }
  });

  it("TL6: a resize round trip keeps the drawer covering what it covers", function* () {
    const page = yield* coveredScreen(WIDE);
    yield* openCatalog(page);
    const wideRect = page.frame().area(LAYER)?.bounds;
    if (wideRect === undefined) {
      throw new Error(`no drawer is open. ${page.describe()}`);
    }

    const narrow = yield* page.resize(NARROW);
    const narrowRect = narrow.area(LAYER)?.bounds;
    if (narrowRect === undefined) {
      throw new Error(`the narrow frame lost the drawer. ${page.describe()}`);
    }
    expect(narrowRect.x + narrowRect.width).toBeLessThanOrEqual(NARROW.columns);
    expect(narrowRect.y + narrowRect.height).toBeLessThanOrEqual(
      narrow.area("box:history")?.bounds.y ?? 0,
    );
    expect(narrowRect).not.toEqual(wideRect);

    const wide = yield* page.resize(WIDE);
    expect(wide.area(LAYER)?.bounds).toEqual(wideRect);

    // Nothing of the body is left showing through the rectangle after the
    // round trip, which is where a diffing renderer leaves stale text.
    const inside = wide.within(wideRect).rows().join("\n");
    expect(inside).not.toContain("COVERED-ROW-");
    expect(inside).toContain("Entries");
  });

  it("TL7: a press behind the modal is dropped by the reconciler, not by the engine's hit test", function* () {
    const app = yield* useApplication(yield* referenceModel());
    const { tree } = app.presenter;
    const frame = yield* app.commit({ state: app.opened });

    // The press names the node directly, so the engine's own narrowing over the
    // drawer's rectangle takes no part: what refuses it has to be the
    // reconciler. Containment is not the engine's to own.
    const behind = frame.targets.find(
      (target) => tree.keyOf(target.node) === "transcript:selector",
    );
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

    // And the modal's own control still answers, so containment has not broken
    // the product — only what is behind it.
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
    const page = yield* useReplPage({ size: WIDE });
    yield* submit(page, 1, "Entry one.");
    yield* openCatalog(page);
    const opened = page.frame();
    // The drawer's own controls, and the History controls that stay reachable
    // from inside it.
    const owned = new Set([
      ...(opened.area(LAYER)?.controls() ?? []),
      ...(opened.area("box:history")?.controls() ?? []),
    ]);
    expect(opened.has("drawer:close")).toBe(true);

    const visited = yield* focusCycle(page, "Tab");
    expect(visited.length).toBeGreaterThan(0);
    // Every stop is the drawer's. Nothing behind it is reachable by keyboard
    // either, which is the same containment the pointer met above.
    for (const key of visited) {
      expect([key, owned.has(key)]).toEqual([key, true]);
    }
    expect(visited).toContain("entry:entry-1");
    expect(visited).toContain("drawer:close");
  });
});

describe("REPL terminal: committed geometry, and what it promises", () => {
  it("TL8: every target's bounds are whole cells at every profile", function* () {
    const model = yield* referenceModel();
    for (const size of [WIDE, MEDIUM, NARROW]) {
      yield* scoped(function* (): Operation<void> {
        const app = yield* useApplication(model, size);
        const frame = yield* app.commit();
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
    const app = yield* useApplication(yield* referenceModel());
    const frame = yield* app.commit();
    const { map } = frame.committed.rendered;
    expect(frame.targets.length).toBeGreaterThan(0);
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
    const app = yield* useApplication(yield* referenceModel());
    const first = yield* app.commit();
    // Copied out of the result, which is what a caller retains.
    const held = first.targets.map((target) => ({ ...target, bounds: { ...target.bounds } }));
    const bytes = Array.from(first.committed.rendered.output);
    expect(held.length).toBeGreaterThan(0);

    // Two more frames, one of them at a different size, which both reuse the
    // engine and invalidate whatever its last result pointed at.
    yield* app.commit({ size: NARROW });
    yield* app.commit({
      size: WIDE,
      state: { ...initialState("reference"), draft: "typed since" },
    });

    // The first frame answers exactly what it answered.
    for (const target of held) {
      expect([target.id, first.committed.rendered.map.boundsOf(target.id)]).toEqual([
        target.id,
        target.bounds,
      ]);
    }
    expect(Array.from(first.committed.rendered.output)).toEqual(bytes);
  });

  it("TL11: exactly two engines are acquired, and reused for every frame", function* () {
    const app = yield* useApplication(yield* referenceModel());
    // Two on acquisition: one that measures and one that draws.
    expect(app.presenter.renderer.engines()).toEqual({ measuring: 1, drawing: 1 });

    // Twelve frames across three profiles, with resizes between them. Each one
    // measures at least once and draws once, so a renderer that built an
    // engine per frame would be far past two by now.
    for (let round = 0; round < 4; round += 1) {
      for (const size of [WIDE, MEDIUM, NARROW]) {
        yield* app.commit({
          size,
          state: { ...initialState("reference"), draft: `round ${round}` },
        });
      }
    }
    expect(app.presenter.renderer.engines()).toEqual({ measuring: 1, drawing: 1 });
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
    const model = yield* referenceModel();
    const renderer = yield* useReplRenderer(WIDE);
    const tree = yield* useReplTree<ReplAction>();
    const grid = yield* useGrid(WIDE);
    const held = holding(renderer);

    // Nothing has happened yet, and this is what "nothing" looks like.
    const revision = tree.frame().id;
    const mounted = tree.mounted();
    const focused = tree.focused();
    expect(mounted).toEqual([]);

    const running = yield* spawn(() =>
      commitReplFrame(tree, held.renderer, viewOf(model, WIDE), 0, undefined),
    );
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
    if (!drawn.ok) {
      throw drawn.error;
    }
    grid.apply(drawn.value.rendered.output);
    expect(drawn.value.rendered.map.targets.length).toBeGreaterThan(0);
    expect(tree.frame().id).not.toBe(revision);
    expect(grid.rows().length).toBeGreaterThan(0);
    expect(renderer.last()).toBeDefined();
  });

  it("TL9: a measurement that fails mounts nothing and publishes no target", function* () {
    const model = yield* referenceModel();
    const renderer = yield* useReplRenderer(WIDE);
    const tree = yield* useReplTree<ReplAction>();
    const grid = yield* useGrid(WIDE);

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

    let raised: Error | undefined;
    try {
      const outcome = yield* commitReplFrame(tree, refusing, viewOf(model, WIDE), 0, undefined);
      if (!outcome.ok) {
        raised = outcome.error;
      }
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

  it("TL8: a fractional layout is refused, not rounded into a hit box", function* () {
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

describe("Termless screen adapter", () => {
  const SMALL = { columns: 12, rows: 3 };

  it("erases what an erase-line clears, rather than keeping the frame beneath it", function* () {
    const screen = yield* useTerminalScreen(SMALL);
    screen.feed("\u001B[1;1Hstale text\u001B[2;1Hkeep this");
    screen.feed("\u001B[1;1H\u001B[2K\u001B[2;5H\u001B[K");
    expect(screen.rows()).toEqual(["", "keep", ""]);
  });

  it("keeps the truecolor, the weight and a reset each cell was written under", function* () {
    const grid = yield* useGrid(SMALL);
    const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
    grid.apply(encode("\u001B[1m\u001B[38;2;127;211;232m\u001B[48;2;18;32;38m\u001B[1;1Hab"));
    grid.apply(encode("\u001B[0m\u001B[1;3Hc"));
    expect(grid.styleAt(0, 0)).toEqual({ foreground: 0x7fd3e8, background: 0x122026, attrs: [1] });
    expect(grid.styleAt(2, 0)).toEqual({ foreground: undefined, background: undefined, attrs: [] });
    expect(grid.styledIn({ x: 1, y: 0, width: 2, height: 1 })).toEqual([
      "b|7fd3e8|122026|1 c|-|-|",
    ]);
  });

  it("gives a wide glyph both of its cells, and names it once", function* () {
    const screen = yield* useTerminalScreen(SMALL);
    screen.feed("\u001B[1;1Habcd\u001B[1;1H界g");
    expect(screen.rows()[0]).toBe("界gd");
    expect([screen.at(0, 0), screen.at(1, 0), screen.at(2, 0), screen.at(4, 0)]).toEqual([
      "界",
      "",
      "g",
      " ",
    ]);
  });

  it("joins a character whose bytes arrive in two writes", function* () {
    const screen = yield* useTerminalScreen(SMALL);
    const bytes = new TextEncoder().encode("界✓");
    screen.feed(bytes.slice(0, 2));
    screen.feed(bytes.slice(2));
    expect(screen.rows()[0]).toBe("界✓");
  });

  it("is released with the scope that owns it and still reports what it last showed", function* () {
    const screen = yield* scoped(function* () {
      const owned = yield* useTerminalScreen(SMALL);
      owned.feed("\u001B[2;1Hlast");
      expect(owned.closed).toBe(false);
      return owned;
    });
    expect(screen.closed).toBe(true);
    expect(screen.rows()).toEqual(["", "last", ""]);
    expect(() => screen.feed("more")).toThrow("this screen has been closed");
  });
});
