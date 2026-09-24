/**
 * The route, and the tree that owns focus.
 *
 * #839's first attempt kept a flat `FocusTarget[]` beside the interface and
 * rebuilt traversal, ownership and restoration by hand. Every case it wrote
 * passed, because a list compared against itself always agrees. What it could
 * not do was answer a question about where a control actually *is* — so the
 * cases here are chosen to be ones a flat registry cannot satisfy: a key's
 * path through its ancestors' middleware, a branch that stops existing, and an
 * overlay that is the tree rather than a copy of it.
 *
 * Two claims are still driven as **bytes**, because synthetic events are what
 * hid the decoder defects this slice repairs.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createInput } from "@bomb.sh/tty";
import type { Input, InputEvent } from "@bomb.sh/tty";
import { readTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { sleep, spawn, suspend, until } from "effection";
import type { Operation } from "effection";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  captureFocus,
  captureText,
  composeInto,
  PROFILE_SIZES,
  renderInto,
  useComposition,
  useTerm,
} from "../repl-study/capture.ts";
import { fixture } from "../repl-study/fixtures.ts";
import { CATALOG } from "../repl-study/catalog.ts";
import { playbackBetween, transitionOf } from "../repl-study/playback.ts";
import { FRAMES, frame, stateFor, useFrame } from "../repl-study/frames.ts";
import { openingState, scanKeys } from "../repl-study/host.ts";
import { fold, JOURNAL, journalThrough, markers, siblingsOf } from "../repl-study/journal.ts";
import {
  formatRoute,
  navigationFor,
  parseRoute,
  ROUTE_SURFACES,
  surfaceFor,
} from "../repl-study/route.ts";
import {
  fixtureFor,
  hydrate,
  initialView,
  layoutOf,
  openDrawer,
  projection,
  viewOf,
} from "../repl-study/store.ts";
import type { HarnessEvent, ReplState, Size } from "../repl-study/store.ts";
import { drive, enterRoute } from "../repl-study/drive.ts";
import { focus as focusNode } from "../repl-study/tree.ts";
import { find, overlayOf, surfaceOwning, useReplTree, walk } from "../repl-study/tree.ts";
import type { OverlayEntry, ReplTree } from "../repl-study/tree.ts";
import { ReplInputApi, sendInput } from "../repl-study/input.ts";
import { ReplActionApi, UnownedActionError } from "../repl-study/actions.ts";
import type { ReplAction } from "../repl-study/actions.ts";
import { boxOf } from "../repl-study/component.ts";
import {
  createFrames,
  FrameContext,
  TRANSITION_SECONDS,
  useFrames,
} from "../repl-study/animation.ts";
import type { Frames } from "../repl-study/animation.ts";
import { UNAVAILABLE } from "../repl-study/store.ts";
import type { Node } from "../repl-study/vendor/freedom/upstream/index.ts";
import type { ReplInput } from "../repl-study/input.ts";
import type { Mutation } from "../repl-study/mutations.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GOLDENS = fileURLToPath(new URL("./fixtures/repl-focus/", import.meta.url));
const MAIN = "scripts/repl-study/main.ts";

const DRAWER = "xmd://repl/e1/transcript/entry-1/document/+project";

/** The same drawer, opened over a reconstruction, which makes it read-only. */
const RECORDED = "xmd://repl/e1/transcript/entry-1/document/+project?at=cp-04&inspect";

const WIDE: Size = PROFILE_SIZES.wide;
const NARROW: Size = PROFILE_SIZES.narrow;

function context(size: Size, mutation?: Mutation) {
  return { size, mutation, scrollLimit: 40 };
}

function key(code: string, extra: Record<string, unknown> = {}): HarnessEvent {
  return { kind: "key", event: { type: "keydown", key: code, code, ...extra } };
}

/** One key, already normalized, for a case that delivers it by hand. */
function press(code: string): ReplInput {
  return { kind: "key", key: { type: "keydown", code } };
}

/** One state and the tree that renders it, built from a URL and a journal. */
function* opened(
  url: string,
  head: string | undefined,
  composed: Size = WIDE,
): Operation<{
  state: ReplState;
  tree: ReplTree;
}> {
  const state = hydrate(url, journalThrough(head));
  const tree = yield* useReplTree(state, composed);
  return { state, tree };
}

/**
 * One frame, drawn by the tree that owns it.
 *
 * `extra` is what a caller might still try to tell the renderer. It is spread
 * over a complete request, so anything it carries is carried all the way to
 * `paint`.
 */
function* shot(tree: ReplTree, state: ReplState, options: Shot = {}): Operation<string> {
  const term = yield* useTerm(WIDE);
  const fixture = fixtureFor(state);
  const view = viewOf(state);
  const request = {
    fixture,
    view,
    size: WIDE,
    overlay: options.overlay ?? true,
    composition: composeInto(tree, fixture, view),
    // The field #839 threaded a focus identity and a numbered map through.
    // It is written into the request deliberately; nothing reads it any more.
    focus: options.claim,
  };
  return renderInto(term, request).text;
}

interface Shot {
  /** Whether F1 is down. Left out, the map is drawn. */
  readonly overlay?: boolean;
  /** A caller still trying to tell the renderer where focus is. */
  readonly claim?: {
    readonly here: string;
    readonly map: readonly OverlayEntry[];
    readonly overlay: boolean;
  };
}

/** The overlay's own row for one entry, as the map draws it. */
function overlayRow(entry: { readonly number: number; readonly label: string }): string {
  return `\u25b8 ${String(entry.number).padEnd(3)}${entry.label}`;
}

/** The identities Tab walks, in tree order. */
function chain(tree: ReplTree): string[] {
  return tree.chain().map((node) => node.name);
}

function bytes(...codes: number[]): Uint8Array {
  return Uint8Array.from(codes);
}

function* decoded(input: Input, chunk: Uint8Array, mutation?: Mutation): Operation<InputEvent[]> {
  const events: InputEvent[] = [];
  yield* scanKeys(input, chunk, (event) => events.push(event), mutation);
  return events;
}

const ESC = 0x1b;

describe("the URL that says where you are", () => {
  it("round-trips every frame's location", function* () {
    for (const subject of FRAMES) {
      const parsed = parseRoute(subject.url);
      expect({ id: subject.id, ok: parsed.ok }).toEqual({ id: subject.id, ok: true });
      if (parsed.ok) {
        expect(formatRoute(parsed.value)).toBe(subject.url);
      }
    }
  });

  it("parses every part of the schema, and refuses what is not in it", function* () {
    const parsed = parseRoute(
      "xmd://repl/e1/transcript/entry-1/plan/+project?at=cp-07&inspect&draft=%3CPlan%3E",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value).toEqual({
      execution: "e1",
      surface: "transcript",
      scopes: ["entry-1", "plan"],
      drawers: ["project"],
      at: "cp-07",
      inspect: true,
      draft: "<Plan>",
    });

    for (const url of [
      "https://repl/e1/transcript",
      "xmd://repl/e1/nowhere",
      "xmd://repl//transcript",
      "xmd://repl/e1/transcript/+project/plan",
      "xmd://repl/e1/transcript?zoom=2",
      "xmd://repl/e1/transcript?at=",
      "xmd://repl/e1/transcript?inspect",
      "xmd://repl/e1/transcript?at=cp-04&inspect=yes",
    ]) {
      expect({ url, ok: parseRoute(url).ok }).toEqual({ url, ok: false });
    }
  });

  it("says selecting a marker and reconstructing it separately", function* () {
    const selected = hydrate("xmd://repl/e1/history?at=cp-04", journalThrough("cp-18"));
    expect(selected.selection).toBeGreaterThanOrEqual(0);
    expect(selected.moment.transport).toBe("paused");
    const reconstructed = hydrate(
      "xmd://repl/e1/history?at=cp-04&inspect",
      journalThrough("cp-18"),
    );
    expect(reconstructed.selection).toBe(selected.selection);
    expect(reconstructed.moment.transport).toBe("inspecting");
  });

  it("names a surface for every region focus can be in", function* () {
    expect([...ROUTE_SURFACES]).toEqual(["sessions", "transcript", "bindings", "input", "history"]);
  });
});

describe("every frame of the approved focus study", () => {
  it("builds each frame's targets and numbering out of the live tree", function* () {
    for (const subject of FRAMES) {
      const { tree } = yield* useFrame(subject, WIDE);
      const entries = overlayOf(tree);
      // With the overlay off the study draws only the focused target.
      const shown = subject.overlay
        ? entries
        : entries.filter((entry) => entry.id === subject.focus);
      expect({
        frame: subject.id,
        targets: shown.map((entry) => ({ n: entry.number, id: entry.id })),
      }).toEqual({
        frame: subject.id,
        targets: subject.targets.map((target) => ({ n: target.n, id: target.id })),
      });
      expect({ frame: subject.id, focus: tree.focused().name }).toEqual({
        frame: subject.id,
        focus: subject.focus,
      });
    }
  });

  it("moves where the study says Tab and Shift+Tab move", function* () {
    for (const subject of FRAMES) {
      const forward = yield* useFrame(subject, WIDE);
      forward.tree.advance();
      expect({ frame: subject.id, tab: forward.tree.focused().name }).toEqual({
        frame: subject.id,
        tab: subject.tab,
      });
      const reverse = yield* useFrame(subject, WIDE);
      reverse.tree.retreat();
      expect({ frame: subject.id, shift: reverse.tree.focused().name }).toEqual({
        frame: subject.id,
        shift: subject.shift,
      });
    }
  });

  it("drives the real keys through the real tree", function* () {
    // The transition, not two destinations built independently.
    for (const subject of FRAMES) {
      const { state, tree } = yield* useFrame(subject, WIDE);
      yield* drive(tree, state, key("Tab"), context(WIDE));
      expect({ frame: subject.id, tab: tree.focused().name }).toEqual({
        frame: subject.id,
        tab: subject.tab,
      });
    }
  });

  it("takes the URL with it whenever focus changes region", function* () {
    for (const subject of FRAMES) {
      const { state, tree } = yield* useFrame(subject, WIDE);
      const driven = yield* drive(tree, state, key("Tab"), context(WIDE));
      const landed = surfaceOwning(tree.focused());
      expect({ frame: subject.id, surface: driven.state.route.surface }).toEqual({
        frame: subject.id,
        surface: landed ?? driven.state.route.surface,
      });
    }
  });

  it("leaves the URL behind when focus is allowed to move without it", function* () {
    const { state, tree } = yield* useFrame(frame("02")!, WIDE);
    const driven = yield* drive(tree, state, key("Tab"), context(WIDE, "keep-route-on-focus"));
    expect(tree.focused().name).toBe("region:history");
    expect(driven.state.route.surface).toBe("input");
  });

  it("walks the whole ring in both directions and comes back to the start", function* () {
    for (const subject of FRAMES) {
      const { tree } = yield* useFrame(subject, WIDE);
      const size = tree.chain().length;
      for (let at = 0; at < size; at += 1) {
        tree.advance();
      }
      expect({ frame: subject.id, at: tree.focused().name }).toEqual({
        frame: subject.id,
        at: subject.focus,
      });
    }
  });
});

describe("input reaches the focused node through its ancestors", () => {
  it("passes through the panel and the drawer that contain it", function* () {
    // A flat registry has no way to produce this: the path is the tree's.
    const { tree } = yield* opened("xmd://repl/e1/transcript/entry-1/document/+project", "cp-14");
    const delivery = sendInput(tree.root.node, tree.focused(), press("x"));
    expect(delivery.target).toBe("field:drawer.project.name");
    expect(delivery.path).toEqual(["drawer:project", "panel:project.body"]);
  });

  it("passes through the region that owns a transport control", function* () {
    const { state, tree } = yield* useFrame(frame("10")!, WIDE);
    void state;
    const delivery = sendInput(tree.root.node, tree.focused(), press("x"));
    expect(delivery.target).toBe("control:transport.continue");
    expect(delivery.path).toEqual(["region:history"]);
  });

  it("stops reaching a control whose branch was removed", function* () {
    const { state, tree } = yield* opened(
      "xmd://repl/e1/transcript/entry-1/document/+project",
      "cp-14",
    );
    const field = tree.chain().find((node) => node.name === "field:drawer.project.name")!;
    const closed = hydrate("xmd://repl/e1/transcript/entry-1/document", state.journal);
    yield* tree.sync(closed);
    // The node object still exists in this test's hand; the tree does not hold
    // it, nothing can focus it, and no middleware path reaches it any more.
    expect(chain(tree)).not.toContain("field:drawer.project.name");
    expect(walk(tree.root.node).map((node) => node.name)).not.toContain("drawer:project");
    const delivery = sendInput(tree.root.node, tree.focused(), press("x"));
    expect(delivery.path).not.toContain("drawer:project");
    expect(delivery.target).not.toBe(field.name);
  });
});

describe("a branch may consume a key, and then nothing else runs it", () => {
  const suspended = () => opened("xmd://repl/e1/transcript/entry-1/document/+project", "cp-14");

  it("stops at the branch that claimed it, and the fallback never fires", function* () {
    const { state, tree } = yield* suspended();
    const drawer = find(tree.root.node, "drawer:project")!;
    drawer.scope.around(ReplInputApi, {
      handle([received], _next): boolean {
        void received;
        return true;
      },
    });
    const driven = yield* drive(tree, state, key("Escape"), context(WIDE));
    expect(driven.delivery?.handled).toBe(true);
    // The path stops at the branch that consumed it — the body panel below it
    // never ran.
    expect(driven.delivery?.path).toEqual(["drawer:project"]);
    // And the drawer is still open: Escape's global meaning did not happen.
    expect(driven.state.route.drawers).toEqual(["project"]);
  });

  it("reaches the fallback and closes the drawer when nothing claims it", function* () {
    const { state, tree } = yield* suspended();
    const driven = yield* drive(tree, state, key("Escape"), context(WIDE));
    expect(driven.delivery?.handled).toBe(false);
    expect(driven.delivery?.path).toEqual(["drawer:project", "panel:project.body"]);
    expect(driven.state.route.drawers).toEqual([]);
  });

  it("asks the tree which region owns a control, not the control's name", function* () {
    // Back from a control returns to the region that owns it. Which region that
    // is comes from walking the live tree, so a node that moved would move with
    // it.
    const { state, tree } = yield* useFrame(frame("10")!, WIDE);
    expect(tree.focused().name).toBe("control:transport.continue");
    const owner = surfaceOwning(tree.focused());
    expect(owner).toBe("history");
    const driven = yield* drive(tree, state, key("Escape"), context(WIDE));
    expect(tree.focused().name).toBe("region:history");
    expect(driven.state.route.surface).toBe("history");
  });
});

describe("a live tree and a rebuilt one are the same tree", () => {
  /** Frame 11, driven into historical inspection through the real path. */
  function* inspected(mutation?: Mutation): Operation<{
    state: ReplState;
    order: readonly string[];
  }> {
    const { state, tree } = yield* useFrame(frame("11")!, WIDE);
    const driven = yield* drive(tree, state, key("Enter"), context(WIDE, mutation));
    return {
      state: driven.state,
      order: overlayOf(tree).map((entry) => entry.id),
    };
  }

  /** The same URL and journal, with the store and the tree thrown away. */
  function* rebuilt(state: ReplState): Operation<readonly string[]> {
    const fresh = hydrate(formatRoute(state.route), state.journal);
    const tree = yield* useReplTree(fresh, WIDE);
    const region = tree.chain().find((node) => node.name === "region:history");
    if (region) {
      focusNode(region);
    }
    yield* tree.sync(fresh);
    return overlayOf(tree).map((entry) => entry.id);
  }

  it("rebuilds the same ordered topology from the URL and the journal", function* () {
    const live = yield* inspected();
    expect(live.state.route.inspect).toBe(true);
    expect(yield* rebuilt(live.state)).toEqual(live.order);
  });

  it("keeps the transport in its canonical order either way", function* () {
    const live = yield* inspected();
    const transport = (order: readonly string[]) =>
      order.filter((id) => id.startsWith("control:transport."));
    expect(transport(live.order)).toEqual([
      "control:transport.continue",
      "control:transport.return-head",
      "control:transport.fork",
    ]);
    expect(transport(yield* rebuilt(live.state))).toEqual(transport(live.order));
  });

  it("diverges when a replaced control is left where it was appended", function* () {
    const live = yield* inspected("append-replacements");
    expect(yield* rebuilt(live.state)).not.toEqual(live.order);
  });

  it("leaves focus on a surviving node after every replacement", function* () {
    const { state, tree } = yield* useFrame(frame("11")!, WIDE);
    const driven = yield* drive(tree, state, key("Enter"), context(WIDE));
    void driven;
    expect(chain(tree)).toContain(tree.focused().name);
    // …and after a branch is torn down as well.
    const { state: open, tree: withDrawer } = yield* opened(
      "xmd://repl/e1/transcript/entry-1/document/+project",
      "cp-14",
    );
    yield* withDrawer.sync(hydrate("xmd://repl/e1/transcript/entry-1/document", open.journal));
    expect(chain(withDrawer)).toContain(withDrawer.focused().name);
  });
});

describe("branches, and what closing one destroys", () => {
  it("adds a nested panel's focusables in tree order", function* () {
    const { state, tree } = yield* opened("xmd://repl/e1/transcript/entry-1", "cp-14");
    const before = chain(tree);
    const deeper = hydrate("xmd://repl/e1/transcript/entry-1/document/+project", state.journal);
    yield* tree.sync(deeper);
    expect(chain(tree)).toEqual([
      "field:drawer.project.name",
      "field:drawer.project.description",
      "control:drawer.project.schema",
      "control:drawer.project.submit",
      "region:history",
    ]);
    expect(before).not.toEqual(chain(tree));
  });

  it("destroys the whole branch when it closes", function* () {
    const { state, tree } = yield* opened(
      "xmd://repl/e1/transcript/entry-1/document/+project",
      "cp-14",
    );
    const names = () => walk(tree.root.node).map((node) => node.name);
    expect(names()).toContain("panel:project.body");
    yield* tree.sync(hydrate("xmd://repl/e1/transcript/entry-1/document", state.journal));
    for (const gone of [
      "drawer:project",
      "panel:project.body",
      "field:drawer.project.name",
      "control:drawer.project.submit",
    ]) {
      expect({ gone, present: names().includes(gone) }).toEqual({ gone, present: false });
    }
  });

  it("keeps a closed drawer's controls alive when the branch is not removed", function* () {
    const { state, tree } = yield* opened(
      "xmd://repl/e1/transcript/entry-1/document/+project",
      "cp-14",
    );
    yield* tree.sync(hydrate("xmd://repl/e1/transcript/entry-1/document", state.journal), {
      mutation: "keep-closed-branch",
    });
    expect(walk(tree.root.node).map((node) => node.name)).toContain("field:drawer.project.name");
  });

  it("keeps focus across a sync, because the tree is reconciled and not rebuilt", function* () {
    const { state, tree } = yield* useFrame(frame("10")!, WIDE);
    expect(tree.focused().name).toBe("control:transport.continue");
    yield* tree.sync(state);
    expect(tree.focused().name).toBe("control:transport.continue");
  });

  it("loses focus when every node is rebuilt on each sync", function* () {
    const { state, tree } = yield* useFrame(frame("10")!, WIDE);
    yield* tree.sync(state, { mutation: "rebuild-tree-each-sync" });
    expect(tree.focused().name).not.toBe("control:transport.continue");
  });
});

describe("drawers trap traversal and restore outward", () => {
  it("traps the ring in the top drawer, with the footer inside it", function* () {
    for (const subject of FRAMES.filter((one) => one.meta.trap)) {
      const { tree } = yield* useFrame(subject, WIDE);
      const ids = chain(tree);
      expect({ frame: subject.id, last: ids[ids.length - 1] }).toEqual({
        frame: subject.id,
        last: "region:history",
      });
      expect({ frame: subject.id, panes: ids.filter((id) => id.startsWith("region:")) }).toEqual({
        frame: subject.id,
        panes: ["region:history"],
      });
    }
  });

  it("restores first to the outer drawer, then to the invoking control", function* () {
    const { state, tree } = yield* opened("xmd://repl/e1/transcript/entry-1/document", "cp-14");
    // Focus somewhere recognisable before anything is pushed.
    yield* drive(tree, state, key("2"), context(WIDE));
    const invoker = tree.focused().name;
    expect(invoker).toBe("region:transcript");

    const outer = openDrawer(state, "project", invoker);
    yield* tree.sync(outer);
    expect(tree.focused().name).toBe("field:drawer.project.name");

    const inner = openDrawer(outer, "confirm", tree.focused().name);
    yield* tree.sync(inner);
    expect(chain(tree)).toEqual([
      "control:drawer.confirm.preview",
      "control:drawer.confirm.approve",
      "control:drawer.confirm.decline",
      "region:history",
    ]);

    yield* tree.sync(outer);
    expect(tree.focused().name).toBe("field:drawer.project.name");
    yield* tree.sync(state);
    expect(tree.focused().name).toBe(invoker);
  });

  it("offers no way out of a narrow drawer, because there is no band to go to", function* () {
    // A narrow drawer owns the whole screen, so the Execution History band it
    // would escape to is not composed. A target Tab reaches and nothing draws
    // is one a person has to guess at, so it is not mounted at all.
    const { tree } = yield* opened(DRAWER, "cp-14", NARROW);
    expect(chain(tree)).not.toContain("region:history");
    expect(overlayOf(tree).map((entry) => entry.id)).not.toContain("region:history");
    const drawer = find(tree.root.node, "drawer:project")!;
    // No branch at all, so there is no node to enter the ring, carry
    // middleware or receive a key.
    expect(walk(drawer).map((node) => node.name)).not.toContain("region:history");
  });

  it("keeps the way out of a wide drawer, where the band is on screen", function* () {
    const { tree } = yield* opened(DRAWER, "cp-14", WIDE);
    expect(chain(tree)).toContain("region:history");
    expect(overlayOf(tree).map((entry) => entry.id)).toContain("region:history");
  });

  it("takes the way out away on a resize, and leaves focus on a live target", function* () {
    const { state, tree } = yield* opened(DRAWER, "cp-14", WIDE);
    const escape = tree.chain().find((node) => node.name === "region:history")!;
    focusNode(escape);
    expect(tree.focused().name).toBe("region:history");

    yield* drive(
      tree,
      state,
      { kind: "resize", cols: NARROW.cols, rows: NARROW.rows },
      {
        size: NARROW,
        scrollLimit: 0,
      },
    );
    expect(chain(tree)).not.toContain("region:history");
    // Focus did not go outside the drawer, and it did not stay on a node that
    // is no longer there.
    expect(chain(tree)).toContain(tree.focused().name);
    expect(
      tree.focused().name.startsWith("field:drawer.") ||
        tree.focused().name.startsWith("control:drawer."),
    ).toBe(true);
  });

  it("brings the way out back in its canonical place when the room returns", function* () {
    const { state, tree } = yield* opened(DRAWER, "cp-14", WIDE);
    const order = () =>
      [...tree.root.node.children]
        .filter((node) => node.name === "drawer:project")
        .flatMap((drawer) => [...drawer.children].map((child) => child.name));
    const wide = order();

    yield* drive(
      tree,
      state,
      { kind: "resize", cols: NARROW.cols, rows: NARROW.rows },
      {
        size: NARROW,
        scrollLimit: 0,
      },
    );
    expect(order()).toEqual(["panel:project.body"]);

    yield* drive(
      tree,
      state,
      { kind: "resize", cols: WIDE.cols, rows: WIDE.rows },
      {
        size: WIDE,
        scrollLimit: 0,
      },
    );
    expect(order()).toEqual(wide);
  });

  it("gives a narrow drawer's ring nothing that leads off the screen", function* () {
    // Walking the whole ring is the question a person asks with Tab. Nothing it
    // stops on is a region, because the only region a drawer carries is the one
    // the narrow composition does not draw.
    const { state, tree } = yield* opened(DRAWER, "cp-14", NARROW);
    const reached: string[] = [];
    for (let at = 0; at < tree.chain().length + 1; at += 1) {
      reached.push(tree.focused().name);
      yield* drive(tree, state, key("Tab"), context(NARROW));
    }
    expect(reached).not.toContain("region:history");
    expect(new Set(reached).size).toBe(tree.chain().length);
  });

  it("closes a recorded narrow drawer back to the surface the URL names", function* () {
    // A recorded drawer at the narrow profile is a read-only modal: nothing in
    // it is actionable, and the band it would escape to is not on screen. So
    // the drawer itself holds focus, Tab does nothing, and Escape is the way
    // out — which makes where Escape *lands* the whole of this state's
    // navigation, and it used to land on Sessions.
    const { state, tree } = yield* opened(RECORDED, "cp-18", NARROW);
    const drawer = find(tree.root.node, "drawer:project")!;
    expect([...drawer.children].flatMap((child) => [...child.children]).length).toBeGreaterThan(0);
    expect(chain(tree)).toEqual([]);
    expect(tree.focused().name).toBe("drawer:project");

    const closed = yield* drive(tree, state, key("Escape"), context(NARROW));
    // Escape closes the drawer and nothing else: the reconstruction it was
    // opened over is still open, at the same recorded marker.
    expect(closed.state.route.drawers).toEqual([]);
    expect(closed.state.route.inspect).toBe(true);
    expect(closed.state.route.at).toBe("cp-04");
    // Back to the surface the URL names, and to a node the ring actually has.
    expect(tree.focused().name).toBe("region:transcript");
    expect(chain(tree)).toContain(tree.focused().name);

    // Leaving the reconstruction is a second, separate Escape.
    const live = yield* drive(tree, closed.state, key("Escape"), context(NARROW));
    expect(live.state.route.inspect).toBe(false);
  });

  it("lets Tab escape the trap when the branch is not pushed as a focus root", function* () {
    const { state, tree } = yield* opened("xmd://repl/e1/transcript/entry-1/document", "cp-14");
    yield* tree.sync(hydrate("xmd://repl/e1/transcript/entry-1/document/+project", state.journal), {
      mutation: "leak-drawer-trap",
    });
    expect(chain(tree)).toContain("region:transcript");
  });

  it("leaves focus behind when the drawer's push is never popped", function* () {
    const { state, tree } = yield* opened(
      "xmd://repl/e1/transcript/entry-1/document/+project",
      "cp-14",
    );
    yield* tree.sync(hydrate("xmd://repl/e1/transcript/entry-1/document", state.journal), {
      mutation: "forget-drawer-invoker",
    });
    expect(tree.focused().name).not.toBe("region:transcript");
  });
});

describe("removing the focused node", () => {
  it("selects a surviving node before teardown", function* () {
    const { state, tree } = yield* useFrame(frame("10")!, WIDE);
    expect(tree.focused().name).toBe("control:transport.continue");
    // Resuming removes the paused transport and mounts the live one.
    const live = hydrate(formatRoute(state.route), journalThrough("cp-19"));
    yield* tree.sync(live);
    expect(chain(tree)).toContain(tree.focused().name);
    expect(tree.focused().name).not.toBe("control:transport.continue");
  });

  it("selects a survivor when the branch above the focused node goes", function* () {
    // Freedom's own middleware asked whether the *removed node* was focused;
    // a drawer is closed by removing the branch above the focused control.
    const { state, tree } = yield* opened(
      "xmd://repl/e1/transcript/entry-1/document/+project",
      "cp-14",
    );
    expect(tree.focused().name).toBe("field:drawer.project.name");
    yield* tree.sync(hydrate("xmd://repl/e1/transcript/entry-1/document", state.journal));
    expect(tree.focused().name).not.toBe("");
    expect(chain(tree)).toContain(tree.focused().name);
  });
});

describe("background updates", () => {
  const streaming = (): HarnessEvent => ({
    kind: "background",
    record: {
      marker: "cp-live",
      at: 50,
      kind: "session.started",
      scope: "document",
      detail: "review-b72e1d",
      shows: "drawer",
    },
  });

  it("changes nothing about where the person is", function* () {
    const { state, tree } = yield* useFrame(frame("06")!, WIDE);
    const before = tree.focused().name;
    const driven = yield* drive(tree, state, streaming(), context(WIDE));
    expect(tree.focused().name).toBe(before);
    expect(driven.state.route).toBe(state.route);
    expect(driven.state.journal.length).toBe(state.journal.length + 1);
  });

  it("is rejected when the update moves focus", function* () {
    const { state, tree } = yield* useFrame(frame("06")!, WIDE);
    const before = tree.focused().name;
    yield* drive(tree, state, streaming(), context(WIDE, "steal-focus-on-background"));
    expect(tree.focused().name).not.toBe(before);
  });
});

describe("a disabled control is drawn and never focusable", () => {
  it("numbers Continue in the overlay and keeps it out of the chain", function* () {
    const { tree } = yield* useFrame(frame("12")!, WIDE);
    const entries = overlayOf(tree);
    const continues = entries.find((entry) => entry.id === "control:transport.continue");
    expect(continues?.enabled).toBe(false);
    expect(chain(tree)).not.toContain("control:transport.continue");
    expect(entries.map((entry) => entry.id)).toContain("control:transport.continue");
  });

  it("admits it to the chain when a disabled control is made focusable", function* () {
    const { state, tree } = yield* useFrame(frame("12")!, WIDE);
    yield* tree.sync(state, { mutation: "focus-hidden-target" });
    expect(chain(tree)).toContain("control:transport.continue");
  });
});

describe("the overlay is the tree", () => {
  it("matches the live tree exactly, node for node", function* () {
    for (const subject of FRAMES) {
      const { tree } = yield* useFrame(subject, WIDE);
      const fromTree = tree
        .map()
        .map((node) => node.name)
        .sort();
      const fromOverlay = overlayOf(tree)
        .map((entry) => entry.id)
        .sort();
      expect({ frame: subject.id, fromOverlay }).toEqual({
        frame: subject.id,
        fromOverlay: fromTree,
      });
    }
  });

  it("follows the tree into a drawer rather than numbering the panes behind it", function* () {
    const { tree } = yield* opened("xmd://repl/e1/transcript/entry-1/document/+project", "cp-14");
    expect(overlayOf(tree).map((entry) => entry.id)).toEqual([
      "field:drawer.project.name",
      "field:drawer.project.description",
      "control:drawer.project.schema",
      "control:drawer.project.submit",
      "region:history",
    ]);
  });

  it("goes on numbering the panes when the overlay is kept beside the tree", function* () {
    const { tree } = yield* opened("xmd://repl/e1/transcript/entry-1/document/+project", "cp-14");
    expect(overlayOf(tree, "flat-overlay").map((entry) => entry.id)).toContain("region:transcript");
  });
});

describe("inspecting a recorded moment", () => {
  const paused = () => opened("xmd://repl/e1/history/entry-1/document", "cp-18");
  const inspecting = () =>
    opened("xmd://repl/e1/history/entry-1/document/plan?at=cp-04&inspect", "cp-18");

  it("refuses a mutation while a reconstruction is open", function* () {
    const { state, tree } = yield* inspecting();
    yield* drive(tree, state, key("4"), context(WIDE));
    const typed = yield* drive(tree, state, key("x"), context(WIDE));
    expect(typed.state.route.draft).toBe("");
  });

  it("permits that mutation when the read-only rule is removed", function* () {
    const { state, tree } = yield* inspecting();
    const focused = yield* drive(tree, state, key("4"), context(WIDE));
    const typed = yield* drive(
      tree,
      focused.state,
      key("x"),
      context(WIDE, "mutate-while-inspecting"),
    );
    expect(typed.state.route.draft).toBe("x");
  });

  it("keeps every recorded marker visible, including the ones after it", function* () {
    const { state } = yield* inspecting();
    const later = fixtureFor(state).history.checkpoints.filter(
      (point) => point.at > state.moment.at,
    );
    expect(later.length).toBeGreaterThan(0);
  });

  it("withholds Continue until the paused head is regained", function* () {
    const { state, tree } = yield* inspecting();
    // Enter the footer, so its controls exist to be walked.
    const entered = yield* drive(tree, state, key("5"), context(WIDE));
    expect(chain(tree)).not.toContain("control:transport.continue");
    tree.advance();
    expect(tree.focused().name).toBe("control:transport.return-head");
    const returned = yield* drive(tree, entered.state, key("Enter"), context(WIDE));
    expect(returned.state.route.inspect).toBe(false);
    // Closing the reconstruction is not deselecting the marker.
    expect(returned.state.route.at).toBe("cp-04");
  });

  it("holds the transport slot across freezing and resuming", function* () {
    const { state, tree } = yield* paused();
    const entered = yield* drive(tree, state, key("5"), context(WIDE));
    tree.advance();
    expect(tree.focused().name).toBe("control:transport.continue");
    const resumed = yield* drive(tree, entered.state, key("Enter"), context(WIDE));
    expect(resumed.state.moment.transport).toBe("live");
    // `Continue` is gone; the live counterpart is what the footer now offers,
    // and focus is on a node that exists.
    expect(chain(tree)).toContain("control:transport.pause");
    expect(chain(tree)).toContain(tree.focused().name);
  });
});

describe("the selected marker is location", () => {
  it("writes the scrubber's selection into the URL, by replacing", function* () {
    const { state, tree } = yield* opened("xmd://repl/e1/history/entry-1/document", "cp-18");
    const focused = yield* drive(tree, state, key("5"), context(WIDE));
    const scrubbed = yield* drive(tree, focused.state, key("ArrowLeft"), context(WIDE));
    expect(scrubbed.state.route.at).toBeDefined();
    expect(scrubbed.state.route.inspect).toBe(false);
    expect(scrubbed.state.history.length).toBe(focused.state.history.length);
    expect(navigationFor("scrub")).toBe("replace");
  });

  it("comes back to the same marker, scope and bindings from the URL alone", function* () {
    const selected = stateFor(frame("11")!);
    expect(selected.selection).toBeGreaterThanOrEqual(0);
    const rebuilt = hydrate(formatRoute(selected.route), selected.journal);
    expect(projection(rebuilt)).toEqual(projection(selected));
    expect(projection(rebuilt).selected).toBe("cp-16");
  });

  it("loses the selection when it is kept outside the URL", function* () {
    const selected = stateFor(frame("11")!);
    const rebuilt = hydrate(
      formatRoute(selected.route),
      selected.journal,
      "drop-selection-on-hydrate",
    );
    expect(rebuilt.selection).toBe(-1);
  });
});

describe("structural navigation across siblings", () => {
  const settled = () => opened("xmd://repl/e1/transcript/entry-1/document/plan", "cp-22");

  it("reads the sibling list out of the journal, in source order", function* () {
    expect(siblingsOf(JOURNAL, ["document"])).toEqual(["plan", "preview", "write"]);
    expect(siblingsOf(JOURNAL, [])).toEqual(["document"]);
  });

  it("moves to the next and previous sibling, and takes the URL with it", function* () {
    const { state, tree } = yield* settled();
    const next = yield* drive(tree, state, key("ArrowRight", { ctrl: true }), context(WIDE));
    expect(next.state.route.scopes).toEqual(["entry-1", "document", "preview"]);
    const after = yield* drive(tree, next.state, key("ArrowRight", { ctrl: true }), context(WIDE));
    expect(after.state.route.scopes).toEqual(["entry-1", "document", "write"]);
    const back = yield* drive(tree, after.state, key("ArrowLeft", { ctrl: true }), context(WIDE));
    expect(back.state.route.scopes).toEqual(["entry-1", "document", "preview"]);
  });

  it("moves out to the parent and in to the first child", function* () {
    const { state, tree } = yield* settled();
    const out = yield* drive(tree, state, key("ArrowUp", { ctrl: true }), context(WIDE));
    expect(out.state.route.scopes).toEqual(["entry-1", "document"]);
    const back = yield* drive(tree, out.state, key("ArrowDown", { ctrl: true }), context(WIDE));
    expect(back.state.route.scopes).toEqual(["entry-1", "document", "plan"]);
  });

  it("never intercepts a modified arrow out of a draft somebody is typing", function* () {
    const { state, tree } = yield* settled();
    const typing = yield* drive(tree, state, key("4"), context(WIDE));
    const moved = yield* drive(
      tree,
      typing.state,
      key("ArrowRight", { ctrl: true }),
      context(WIDE),
    );
    expect(moved.state.route.scopes).toEqual(typing.state.route.scopes);
  });

  it("leaves the arrows inert when the sibling list is ignored", function* () {
    const { state, tree } = yield* settled();
    const moved = yield* drive(
      tree,
      state,
      key("ArrowRight", { ctrl: true }),
      context(WIDE, "inert-sibling-arrows"),
    );
    expect(moved.state.route.scopes).toEqual(state.route.scopes);
  });
});

describe("push versus replace", () => {
  const start = () => opened("xmd://repl/e1/transcript/entry-1/document", "cp-14");

  it("replaces the URL while a draft is typed", function* () {
    const { state, tree } = yield* start();
    let driven = yield* drive(tree, state, key("4"), context(WIDE));
    const before = driven.state.history.length;
    for (const glyph of ["a", "b", "c"]) {
      driven = yield* drive(tree, driven.state, key(glyph), context(WIDE));
    }
    expect(driven.state.route.draft).toBe("abc");
    expect(driven.state.history.length).toBe(before);
    expect(navigationFor("draft")).toBe("replace");
  });

  it("fills the navigation stack when every keystroke pushes", function* () {
    const { state, tree } = yield* start();
    let driven = yield* drive(tree, state, key("4"), context(WIDE, "push-draft-edits"));
    const before = driven.state.history.length;
    for (const glyph of ["a", "b", "c"]) {
      driven = yield* drive(tree, driven.state, key(glyph), context(WIDE, "push-draft-edits"));
    }
    expect(driven.state.history.length).toBe(before + 3);
  });
});

describe("Ctrl+C, three ways", () => {
  it("interrupts a running entry, and a paused or reconstructed one", function* () {
    for (const [url, head] of [
      ["xmd://repl/e1/transcript/entry-1/document", "cp-06"],
      ["xmd://repl/e1/history/entry-1/document", "cp-18"],
      ["xmd://repl/e1/history/entry-1/document/plan?at=cp-04&inspect", "cp-18"],
    ] as const) {
      const { state, tree } = yield* opened(url, head);
      const driven = yield* drive(tree, state, key("c", { ctrl: true }), context(WIDE));
      expect({ url, quit: driven.state.quit, interrupts: driven.state.interrupts }).toEqual({
        url,
        quit: false,
        interrupts: 1,
      });
    }
  });

  it("exits from a paused entry when only a live one counts as active", function* () {
    const { state, tree } = yield* opened("xmd://repl/e1/history/entry-1/document", "cp-18");
    const driven = yield* drive(
      tree,
      state,
      key("c", { ctrl: true }),
      context(WIDE, "exit-on-paused-interrupt"),
    );
    expect(driven.state.quit).toBe(true);
  });

  it("clears a draft, then leaves, when nothing is running", function* () {
    const withDraft = yield* opened("xmd://repl/e1/input?draft=%3CPlan%3E", "cp-22");
    const cleared = yield* drive(
      withDraft.tree,
      withDraft.state,
      key("c", { ctrl: true }),
      context(WIDE),
    );
    expect(cleared.state.route.draft).toBe("");
    expect(cleared.state.quit).toBe(false);

    const empty = yield* opened("xmd://repl/e1/input", "cp-22");
    const left = yield* drive(empty.tree, empty.state, key("c", { ctrl: true }), context(WIDE));
    expect(left.state.quit).toBe(true);
  });
});

describe("rebuilding from the URL and the journal alone", () => {
  function* journey(): Operation<ReplState> {
    const { state, tree } = yield* opened("xmd://repl/e1/transcript/entry-1/document", "cp-14");
    let driven = yield* drive(tree, state, key("4"), context(WIDE));
    for (const glyph of ["<", "P", "l", "a", "n", ">"]) {
      driven = yield* drive(tree, driven.state, key(glyph), context(WIDE));
    }
    driven = yield* drive(tree, driven.state, key("Tab"), context(WIDE));
    driven = yield* drive(tree, driven.state, key("5"), context(WIDE));
    driven = yield* drive(tree, driven.state, key("ArrowLeft"), context(WIDE));
    driven = yield* drive(tree, driven.state, key("Enter"), context(WIDE));
    return driven.state;
  }

  it("comes back to the same semantic state with nothing else", function* () {
    const original = yield* journey();
    expect(original.route.draft).toBe("<Plan>");
    const rebuilt = hydrate(formatRoute(original.route), original.journal);
    expect(projection(rebuilt)).toEqual(projection(original));
  });

  it("throws away the disposable half rather than pretending to restore it", function* () {
    const original = yield* journey();
    const rebuilt = hydrate(formatRoute(original.route), original.journal);
    expect(rebuilt.anchor).toBe(0);
    expect(rebuilt.history).toEqual([]);
    expect(rebuilt.selection).toBe(original.selection);
  });

  it("folds the journal rather than reading the fixtures", function* () {
    const moment = fold(journalThrough("cp-08"));
    expect(moment.scope).toBe("plan");
    expect(moment.published).toEqual(["inputs", "draft"]);
    expect(moment.suspension).toBe("review");
    expect(markers(JOURNAL).length).toBe(JOURNAL.length);
  });
});

describe("the same route at two profiles", () => {
  it("says the same thing wide and narrow", function* () {
    for (const subject of FRAMES) {
      const { state, tree } = yield* useFrame(subject, WIDE);
      const before = projection(state);
      expect(layoutOf(state, WIDE).profile).toBe("wide");
      expect(layoutOf(state, NARROW).profile).toBe("narrow");
      let moved = yield* drive(tree, state, { kind: "resize", ...NARROW }, context(NARROW));
      moved = yield* drive(tree, moved.state, { kind: "resize", ...WIDE }, context(WIDE));
      expect({ frame: subject.id, after: projection(moved.state) }).toEqual({
        frame: subject.id,
        after: before,
      });
    }
  });

  it("loses the route when a resize rebuilds it from the profile", function* () {
    const { state, tree } = yield* useFrame(frame("07")!, WIDE);
    const moved = yield* drive(
      tree,
      state,
      { kind: "resize", ...NARROW },
      context(NARROW, "drop-route-on-resize"),
    );
    expect(formatRoute(moved.state.route)).not.toBe(frame("07")!.url);
  });
});

describe("through a real decoder", () => {
  it("delivers a lone Escape only after the pending flush", function* () {
    const immediate: Input = yield* until(createInput({}));
    const scanned = immediate.scan(bytes(ESC));
    expect(scanned.events).toEqual([]);
    expect(scanned.pending?.delay).toBeGreaterThan(0);

    const flushed = yield* decoded(yield* until(createInput({})), bytes(ESC));
    expect(flushed.map((event) => ("code" in event ? event.code : ""))).toEqual(["Escape"]);
  });

  it("acts on the Escape those bytes produced", function* () {
    const input: Input = yield* until(createInput({}));
    const events = yield* decoded(input, bytes(ESC));
    const { state, tree } = yield* opened(
      "xmd://repl/e1/transcript/entry-1/document/+project",
      "cp-14",
    );
    let driven = { state };
    for (const event of events) {
      driven = yield* drive(tree, driven.state, { kind: "key", event }, context(WIDE));
    }
    expect(driven.state.route.drawers).toEqual([]);
  });

  it("swallows every Escape when the pending flush is dropped", function* () {
    const input: Input = yield* until(createInput({}));
    expect(yield* decoded(input, bytes(ESC), "swallow-pending-escape")).toEqual([]);
  });

  it("reads a real Shift+Tab, which arrives as Backtab with no shift flag", function* () {
    const input: Input = yield* until(createInput({}));
    const events = yield* decoded(input, bytes(ESC, 0x5b, 0x5a));
    expect(events.length).toBe(1);
    const [event] = events;
    expect("code" in event ? event.code : "").toBe("Backtab");
    expect("shift" in event ? event.shift : undefined).toBeUndefined();

    const subject = frame("03")!;
    const { state, tree } = yield* useFrame(subject, WIDE);
    for (const decodedEvent of events) {
      yield* drive(tree, state, { kind: "key", event: decodedEvent }, context(WIDE));
    }
    expect(tree.focused().name).toBe(subject.shift);
  });

  it("traverses forward when only a synthetic Tab+shift counts as reverse", function* () {
    const input: Input = yield* until(createInput({}));
    const events = yield* decoded(input, bytes(ESC, 0x5b, 0x5a));
    const subject = frame("03")!;
    const { state, tree } = yield* useFrame(subject, WIDE);
    for (const event of events) {
      yield* drive(tree, state, { kind: "key", event }, context(WIDE, "ignore-backtab"));
    }
    expect(tree.focused().name).toBe(subject.tab);
  });

  it("decodes the modified arrows structural navigation is specified on", function* () {
    const input: Input = yield* until(createInput({}));
    const events = yield* decoded(input, bytes(ESC, 0x5b, 0x31, 0x3b, 0x35, 0x41));
    const [event] = events;
    expect("code" in event ? event.code : "").toBe("ArrowUp");
    expect("ctrl" in event ? event.ctrl : undefined).toBe(true);
  });
});

describe("input is one gesture, and what it means is an action", () => {
  const PAUSED = "xmd://repl/e1/history/entry-1/document";
  const DELIVERY = { size: WIDE, scrollLimit: 0 };

  /** A footer with its transport controls mounted, and a frame drawn once. */
  function* transport(
    url: string,
    head: string,
  ): Operation<{ state: ReplState; tree: ReplTree; control: Node }> {
    const { state, tree } = yield* opened(url, head);
    // The footer is an explicit region: its controls exist once focus is in it.
    const entered = yield* drive(tree, state, key("5"), context(WIDE));
    tree.advance();
    // Drawing once is what gives every node the box a pointer is resolved
    // against. Nothing is asserted about the picture here.
    yield* shot(tree, entered.state);
    return { state: entered.state, tree, control: tree.focused() };
  }

  /**
   * Every action that passed this node, in order.
   *
   * Recording is installed for as long as it is wanted and then switched off,
   * because a case that walks many controls on one tree would otherwise keep
   * collecting through every middleware it ever added.
   */
  function record(node: Node, seen: ReplAction[]): () => void {
    let on = true;
    node.scope.around(ReplActionApi, {
      dispatch([action], next): void {
        if (on) {
          seen.push(action);
        }
        return next(action);
      },
    });
    return () => {
      on = false;
    };
  }

  /**
   * Every state that mounts action-bearing controls, and the controls in it.
   *
   * Driven from what the tree actually mounts rather than from a list written
   * beside it: the roster below is checked against the walk, so a control that
   * stopped being mounted, or one that was added, fails here rather than going
   * unexercised.
   */
  const MOUNTED: readonly { readonly url: string; readonly head?: string }[] = [
    // `Run` is offered when there is something to run and nothing running.
    { url: "xmd://repl/e1/input?draft=hello" },
    { url: "xmd://repl/e1/history/entry-1/document", head: "cp-14" },
    { url: "xmd://repl/e1/history/entry-1/document", head: "cp-18" },
    { url: "xmd://repl/e1/history/entry-1/document/plan?at=cp-04&inspect", head: "cp-18" },
    { url: "xmd://repl/e1/transcript/entry-1/document/+project", head: "cp-14" },
    { url: "xmd://repl/e1/transcript/entry-1/document/+review", head: "cp-14" },
    { url: "xmd://repl/e1/transcript/entry-1/document/+confirm", head: "cp-14" },
  ];

  /** The actions a real execution owns, which this study answers by refusing. */
  const UNSUPPORTED = [
    "run",
    "fork",
    "submit",
    "approve",
    "request-changes",
    "stop",
    "decline",
    "disclose-schema",
  ];

  /** What each enabled control emits. An empty string is one that emits nothing. */
  const ROSTER: Readonly<Record<string, string>> = {
    "control:input.run": "run",
    "control:transport.pause": "pause",
    "control:transport.continue": "continue",
    "control:transport.return-head": "return-to-head",
    "control:transport.fork": "fork",
    "field:drawer.project.name": "",
    "field:drawer.project.description": "",
    "control:drawer.project.schema": "disclose-schema",
    "control:drawer.project.submit": "submit",
    "control:drawer.review.scroll": "",
    "control:drawer.review.approve": "approve",
    "control:drawer.review.request": "request-changes",
    "control:drawer.review.stop": "stop",
    "control:drawer.review.submit": "submit",
    "control:drawer.confirm.preview": "",
    "control:drawer.confirm.approve": "approve",
    "control:drawer.confirm.decline": "decline",
  };

  it("gives every enabled control one action for Enter, Space and a pointer", function* () {
    const reached = new Set<string>();
    for (const where of MOUNTED) {
      const { state, tree } = yield* opened(where.url, where.head);
      // The footer's controls exist only once focus is inside it.
      const entered = yield* drive(tree, state, key("5"), context(WIDE));
      for (const node of tree.chain()) {
        if (!node.name.startsWith("control:") && !node.name.startsWith("field:")) {
          continue;
        }
        focusNode(node);
        yield* shot(tree, entered.state);
        const box = boxOf(node);
        const seen: ReplAction[] = [];
        const stop = record(tree.root.node, seen);
        const inputs: ReplInput[] = [press("Enter"), press("Space")];
        if (box !== undefined && box.width > 0) {
          // Pointed at the cell its own parent reserved for it, which the tree
          // resolves back to this very node.
          expect({ id: node.name, hit: tree.hit(box.x, box.y)?.name }).toEqual({
            id: node.name,
            hit: node.name,
          });
          inputs.push({
            kind: "pointer",
            pointer: { button: "primary", x: box.x, y: box.y },
          });
        }
        const delivered = inputs.map((input) =>
          tree.deliver({ state: entered.state, input, context: DELIVERY }),
        );
        stop();

        // Nothing fell through: every enabled control answers its own
        // activation, whether or not it has anything to say about it.
        expect({ id: node.name, handled: delivered.map((one) => one.delivery.handled) }).toEqual({
          id: node.name,
          handled: delivered.map(() => true),
        });
        // One action, byte for byte, however it was asked for.
        const shapes = seen.map((action) => JSON.stringify(action));
        expect({ id: node.name, shapes }).toEqual({
          id: node.name,
          shapes: shapes.map(() => shapes[0] ?? ""),
        });
        const expected = ROSTER[node.name];
        expect({ id: node.name, kind: seen[0]?.kind ?? "" }).toEqual({
          id: node.name,
          kind: expected,
        });
        expect({ id: node.name, count: seen.length }).toEqual({
          id: node.name,
          count: expected === "" ? 0 : inputs.length,
        });
        // The same input, the same outcome.
        const states = delivered.map((one) => JSON.stringify(one.reduction?.state ?? null));
        expect({ id: node.name, states }).toEqual({
          id: node.name,
          states: states.map(() => states[0]),
        });
        reached.add(node.name);
      }
    }
    // The roster is the tree's, not a list kept beside it.
    expect([...reached].sort()).toEqual(Object.keys(ROSTER).sort());
  });

  it("emits one action for Enter, for Space and for a pointer on the same control", function* () {
    const { state, tree, control } = yield* transport(PAUSED, "cp-18");
    expect(control.name).toBe("control:transport.continue");
    const box = boxOf(control)!;
    // The pointer is aimed at the cell the band itself says the control owns,
    // and the tree resolves that cell back to the same node.
    expect(tree.hit(box.x, box.y)).toBe(control);

    const seen: ReplAction[] = [];
    record(tree.root.node, seen);

    const byEnter = tree.deliver({ state, input: press("Enter"), context: DELIVERY });
    const bySpace = tree.deliver({ state, input: press("Space"), context: DELIVERY });
    const byPointer = tree.deliver({
      state,
      input: { kind: "pointer", pointer: { button: "primary", x: box.x, y: box.y } },
      context: DELIVERY,
    });

    // Byte for byte: there is nothing in an action for a keyboard and a pointer
    // to differ about, because neither is in it.
    const [enter, space, pointer] = seen.map((action) => JSON.stringify(action));
    expect({ space, pointer }).toEqual({ space: enter, pointer: enter });
    expect(enter).toBe(JSON.stringify({ kind: "continue" }));

    // And the same state, from the same state.
    const shapes = [byEnter, bySpace, byPointer].map((one) => JSON.stringify(one.reduction?.state));
    expect(shapes[1]).toBe(shapes[0]);
    expect(shapes[2]).toBe(shapes[0]);
    expect(byEnter.reduction?.state.moment.transport).toBe("live");
  });

  it("refuses what a real execution owns, visibly, and changes nothing else", function* () {
    for (const where of MOUNTED) {
      const { state, tree } = yield* opened(where.url, where.head);
      const entered = yield* drive(tree, state, key("5"), context(WIDE));
      for (const node of tree.chain()) {
        const action = ROSTER[node.name];
        if (action === undefined || !UNSUPPORTED.includes(action)) {
          continue;
        }
        focusNode(node);
        const refused = yield* drive(tree, entered.state, key("Enter"), context(WIDE));
        // Said in words, where the interface can draw it.
        expect({ id: node.name, notice: refused.state.notice.includes(UNAVAILABLE) }).toEqual({
          id: node.name,
          notice: true,
        });
        // And nothing else moved: not the journal, not the URL.
        expect({
          id: node.name,
          journal: refused.state.journal,
          route: refused.state.route,
        }).toEqual({
          id: node.name,
          journal: entered.state.journal,
          route: entered.state.route,
        });

        // Drawn, not merely recorded.
        const drawn = yield* shot(tree, refused.state);
        expect({ id: node.name, shown: drawn.includes(UNAVAILABLE) }).toEqual({
          id: node.name,
          shown: true,
        });
      }
    }
  });

  it("wires nothing a person cannot reach", function* () {
    // A disabled control and a recorded drawer's contents are both drawn and
    // numbered and neither is actionable. Not wiring them is the same act as
    // not making them focusable: there is one node, and it either takes part or
    // it does not.
    const { state, tree } = yield* opened(
      "xmd://repl/e1/history/entry-1/document/plan?at=cp-04&inspect",
      "cp-18",
    );
    const entered = yield* drive(tree, state, key("5"), context(WIDE));
    const numbered = overlayOf(tree).map((one) => one.id);
    expect(numbered).toContain("control:transport.continue");
    expect(chain(tree)).not.toContain("control:transport.continue");

    const disabled = find(tree.root.node, "control:transport.continue")!;
    const seen: ReplAction[] = [];
    record(tree.root.node, seen);
    const delivery = sendInput(tree.root.node, disabled, press("Enter"));
    expect(delivery.handled).toBe(false);
    expect(seen).toEqual([]);

    // Drawn, so a pointer reaches it — and it neither acts nor takes focus.
    yield* shot(tree, entered.state);
    const box = boxOf(disabled)!;
    expect(tree.hit(box.x, box.y)).toBe(disabled);
    const here = tree.focused();
    const pointed = tree.deliver({
      state: entered.state,
      input: { kind: "pointer", pointer: { button: "primary", x: box.x, y: box.y } },
      context: DELIVERY,
    });
    expect(pointed.delivery.handled).toBe(false);
    expect(seen).toEqual([]);
    expect(tree.focused()).toBe(here);

    const recorded = yield* opened(RECORDED, "cp-18");
    const inside = find(recorded.tree.root.node, "control:drawer.project.submit")!;
    const heard: ReplAction[] = [];
    record(recorded.tree.root.node, heard);
    expect(sendInput(recorded.tree.root.node, inside, press("Enter")).handled).toBe(false);
    expect(heard).toEqual([]);
    // A recorded drawer reserves no gutter, so its controls offer no cell to
    // point at either.
    yield* shot(recorded.tree, recorded.state);
    expect(boxOf(inside)?.width ?? 0).toBe(0);
  });

  it("aims a pointer at what it landed on, not at what had focus", function* () {
    const { state, tree } = yield* opened(PAUSED, "cp-18");
    const entered = yield* drive(tree, state, key("5"), context(WIDE));
    yield* shot(tree, entered.state);

    const chain = tree.chain();
    const first = chain.find((node) => node.name === "control:transport.continue")!;
    const other = chain.find((node) => node.name === "control:transport.return-head")!;
    focusNode(first);
    expect(tree.focused()).toBe(first);

    const box = boxOf(other)!;
    const seen: ReplAction[] = [];
    record(tree.root.node, seen);
    const pointed = tree.deliver({
      state: entered.state,
      input: { kind: "pointer", pointer: { button: "primary", x: box.x, y: box.y } },
      context: DELIVERY,
    });
    // The control that was pointed at is the one that spoke, and it is not the
    // one that had focus — pointing at something you can reach is reaching it.
    expect(pointed.delivery.target).toBe("control:transport.return-head");
    expect(seen.map((action) => action.kind)).toEqual(["return-to-head"]);
    expect(tree.focused()).toBe(other);
  });

  it("follows a pointer onto another surface, and the URL follows with it", function* () {
    // `Run` belongs to the input band. Reaching it from the footer is a move,
    // and the surface segment is what says which region owns focus — so the URL
    // has to arrive there too, in the same act.
    const { state, tree } = yield* opened("xmd://repl/e1/history?draft=hello", undefined);
    expect(tree.focused().name).toBe("region:history");
    yield* shot(tree, state);
    const run = tree.chain().find((node) => node.name === "control:input.run")!;
    const box = boxOf(run)!;

    const driven = yield* drive(
      tree,
      state,
      {
        kind: "pointer",
        pointer: { button: "primary", x: box.x, y: box.y },
      },
      context(WIDE),
    );

    expect(tree.focused().name).toBe("control:input.run");
    expect(driven.state.route.surface).toBe("input");
    // And what it asked for is a thing this study cannot do, said out loud.
    expect(driven.state.notice).toContain(UNAVAILABLE);
    expect(driven.state.journal).toEqual(state.journal);
  });

  it("leaves focus on a survivor when a pointer's own action removes it", function* () {
    const { state, tree } = yield* opened(PAUSED, "cp-18");
    const entered = yield* drive(tree, state, key("5"), context(WIDE));
    yield* shot(tree, entered.state);
    const resume = tree.chain().find((node) => node.name === "control:transport.continue")!;
    const box = boxOf(resume)!;

    const driven = yield* drive(
      tree,
      entered.state,
      {
        kind: "pointer",
        pointer: { button: "primary", x: box.x, y: box.y },
      },
      context(WIDE),
    );

    // Resuming replaces the paused transport with the live one, so the control
    // the pointer landed on is not there any more.
    expect(driven.state.moment.transport).toBe("live");
    expect(chain(tree)).not.toContain("control:transport.continue");
    expect(chain(tree)).toContain("control:transport.pause");
    expect(chain(tree)).toContain(tree.focused().name);
  });

  it("runs no fallback and emits no action for an input a branch consumed", function* () {
    const { state, tree } = yield* transport(PAUSED, "cp-18");
    // `F1` is not an action: the store owns it, and it is the one that shows
    // whether the fallback ran at all. Enter is, and shows whether the branch
    // below the consumer ever got to say so.
    const loose = yield* drive(tree, state, key("F1"), context(WIDE));
    expect(loose.state.overlay).toBe(!state.overlay);

    const seen: ReplAction[] = [];
    record(tree.root.node, seen);
    find(tree.root.node, "region:history")!.scope.around(ReplInputApi, {
      handle([received], _next): boolean {
        void received;
        return true;
      },
    });
    const overlay = yield* drive(tree, state, key("F1"), context(WIDE));
    // The store never saw it: a consumed input has no global meaning left.
    expect(overlay.state.overlay).toBe(state.overlay);
    expect(overlay.state).toBe(state);
    expect(overlay.delivery?.handled).toBe(true);

    const activated = yield* drive(tree, state, key("Enter"), context(WIDE));
    expect(seen).toEqual([]);
    expect(activated.state).toBe(state);
  });

  it("lets a drawer say what Back means inside it", function* () {
    const { state, tree } = yield* opened(DRAWER, "cp-14");
    const seen: ReplAction[] = [];
    // Recorded at the root, which is where every action passes: the drawer
    // consumes `back` rather than forwarding it, so its own scope never sees
    // both halves of what it did.
    record(tree.root.node, seen);
    const inside = tree.deliver({ state, input: press("Escape"), context: DELIVERY });
    // The drawer owned `back` and dispatched what it really meant there.
    expect(seen.map((action) => action.kind)).toEqual(["back", "close-drawer"]);
    expect(inside.reduction?.state.route.drawers).toEqual([]);

    // Back anywhere else is a different thing entirely: it returns focus to the
    // region that owns the control, and the route keeps its shape.
    const { state: plain, tree: bare } = yield* transport(PAUSED, "cp-18");
    const outside = bare.deliver({ state: plain, input: press("Escape"), context: DELIVERY });
    expect(outside.reduction?.focus).toEqual({ kind: "owner" });
    expect(outside.reduction?.state.route.drawers).toEqual([]);
  });

  it("throws on an action nothing owns", function* () {
    const { state, tree } = yield* transport(PAUSED, "cp-18");
    // Dispatched where no root is adapting: there is nothing to answer it.
    expect(() =>
      ReplActionApi.invoke(tree.focused().scope, "dispatch", [{ kind: "pause" }]),
    ).toThrow(UnownedActionError);

    // And inside a delivery, against a root that implements nothing.
    expect(() =>
      tree.deliver({
        state,
        input: press("Enter"),
        context: { ...DELIVERY, mutation: "disown-actions" },
      }),
    ).toThrow(UnownedActionError);
  });

  it("takes a closed branch's input and action middleware away with it", function* () {
    const { state, tree } = yield* opened(DRAWER, "cp-14");
    const seen: ReplAction[] = [];
    record(tree.root.node, seen);

    const open = tree.deliver({ state, input: press("Escape"), context: DELIVERY });
    expect(open.delivery.path).toContain("drawer:project");
    expect(seen.map((action) => action.kind)).toEqual(["back", "close-drawer"]);

    yield* tree.sync(open.reduction!.state);
    expect(find(tree.root.node, "drawer:project")).toBeUndefined();
    seen.length = 0;
    const closed = tree.deliver({
      state: open.reduction!.state,
      input: press("Escape"),
      context: DELIVERY,
    });
    // Nothing left to record the path, and nothing left to translate the
    // action: Back is plain Back again.
    expect(closed.delivery.path).not.toContain("drawer:project");
    expect(seen.map((action) => action.kind)).toEqual(["back"]);
  });

  it("leaves the state it was handed alone, whatever an action does to it", function* () {
    const { state, tree } = yield* transport(PAUSED, "cp-18");
    const before = JSON.stringify(state.route);
    const driven = tree.deliver({ state, input: press("Enter"), context: DELIVERY });
    expect(JSON.stringify(state.route)).toBe(before);
    expect(driven.reduction?.state).not.toBe(state);
  });

  it("keeps route building where the only action handler is", function* () {
    // The root adapts; nothing else may. A branch that built a route would be a
    // second place state comes from, and the way to see that is to look.
    for (const name of ["components.ts", "render.ts", "tree.ts", "input.ts", "actions.ts"]) {
      const source = yield* readTextFile(join(ROOT, "scripts/repl-study", name));
      expect({
        name,
        builds: source.includes("hydrate(") || source.includes("formatRoute("),
      }).toEqual({ name, builds: false });
    }
  });
});

describe("one clock, and the components that animate against it", () => {
  /** A branch, and a record of every frame it took. */
  function* subscriber(
    tree: ReplTree,
    name: string,
    seen: number[],
    clock: Frames,
  ): Operation<Node> {
    const node = find(tree.root.node, name)!;
    yield* clock.animate(node, ({ at }) => seen.push(at));
    return node;
  }

  it("takes no frame when the branch goes before its consumer ever ran", function* () {
    // A task attaches a turn before it runs. This closes the branch inside that
    // turn, while the consumer is still being attached — so the scope that
    // would have owned the subscription ends before there is one.
    const clock = yield* useFrames();
    const { state, tree } = yield* opened(DRAWER, "cp-14");
    const seen: number[] = [];
    const node = find(tree.root.node, "drawer:project")!;
    const mounting = yield* spawn(function* () {
      yield* clock.animate(node, ({ at }) => seen.push(at));
    });

    // No turn was given to the consumer: the branch closes first.
    yield* tree.sync(hydrate("xmd://repl/e1/transcript/entry-1/document", state.journal));
    expect(find(tree.root.node, "drawer:project")).toBeUndefined();

    yield* clock.advance(1);
    expect(seen).toEqual([]);
    // And the teardown finishes: nothing is left waiting on a branch that has
    // gone.
    yield* mounting.halt();
    yield* clock.advance(2);
    expect(seen).toEqual([]);
  });

  it("closes it when the branch goes after consumption has begun", function* () {
    const clock = yield* useFrames();
    const { state, tree } = yield* opened(DRAWER, "cp-14");
    const seen: number[] = [];
    yield* subscriber(tree, "drawer:project", seen, clock);

    yield* clock.advance(1);
    expect(seen).toEqual([1]);

    yield* tree.sync(hydrate("xmd://repl/e1/transcript/entry-1/document", state.journal));
    yield* clock.advance(2);
    expect(seen).toEqual([1]);
  });

  it("gives two owners the same timestamps, and keeps only the survivor", function* () {
    const clock = yield* useFrames();
    const { state, tree } = yield* opened(DRAWER, "cp-14");
    const closing: number[] = [];
    const staying: number[] = [];
    yield* subscriber(tree, "drawer:project", closing, clock);
    yield* subscriber(tree, "region:transcript", staying, clock);

    yield* clock.advance(0.5);
    yield* clock.advance(1);
    // One producer, two owners, the same moments.
    expect(closing).toEqual([0.5, 1]);
    expect(staying).toEqual(closing);

    yield* tree.sync(hydrate("xmd://repl/e1/transcript/entry-1/document", state.journal));
    yield* clock.advance(1.5);
    expect(closing).toEqual([0.5, 1]);
    expect(staying).toEqual([0.5, 1, 1.5]);
  });

  it("draws the frame it was just given, with nothing left to arrive", function* () {
    // The picture is of the moment that was delivered, not of the one before
    // it: every subscriber has taken the frame by the time `advance` returns.
    const clock = yield* useFrames();
    const subject = fixture("drawer");
    const view = initialView(subject);
    const composition = yield* useComposition(subject, view, WIDE);
    const transition = transitionOf(playbackBetween("generated", "drawer")!, true);
    const shot = function* (): Operation<string> {
      const term = yield* useTerm(WIDE);
      return renderInto(term, {
        fixture: subject,
        view,
        composition,
        size: WIDE,
        transition,
        deltaSeconds: 0,
      }).text;
    };

    yield* clock.advance(0);
    const opening = yield* shot();
    yield* clock.advance(0.32);
    const half = yield* shot();
    yield* clock.advance(0.64);
    const whole = yield* shot();

    expect(half).not.toBe(opening);
    expect(whole).not.toBe(half);
    // Rendering again without another frame draws the same moment: nothing
    // arrived between the two, because nothing was sent.
    expect(yield* shot()).toBe(whole);
    expect(clock.wanted()).toBe(false);
  });

  it("asks for the clock only while something is moving", function* () {
    const clock = yield* useFrames();
    const { state, tree } = yield* opened("xmd://repl/e1/transcript/entry-1/document", "cp-14");
    expect(clock.wanted()).toBe(false);
    yield* shot(tree, state);
    expect(clock.wanted()).toBe(false);
  });

  it("releases a running transition's demand when its owner is torn down", function* () {
    // A demand cannot outlive what asked for it. This tears the composition
    // down in the middle of a transition — before the timestamp that would have
    // settled it — and nothing is left asking to be woken.
    const clock = createFrames();
    const subject = fixture("drawer");
    const view = initialView(subject);
    const transition = transitionOf(playbackBetween("generated", "drawer")!, true);
    let text = "";

    const applied: number[] = [];

    const mounted = yield* spawn(function* () {
      yield* FrameContext.set(clock);
      const composition = yield* useComposition(subject, view, WIDE);
      // A witness on the same root, so what the removed tree does with a frame
      // is observable rather than inferred.
      yield* clock.animate(composition.tree.root.node, ({ at }) => applied.push(at));
      const term = yield* useTerm(WIDE);
      // Presenting a real transition is what takes the demand: the transcript
      // starts arriving and the playhead starts travelling.
      yield* clock.advance(0);
      text = renderInto(term, {
        fixture: subject,
        view,
        composition,
        size: WIDE,
        transition,
        deltaSeconds: 0,
      }).text;
      yield* suspend();
    });
    // A spawned task attaches a turn late, so the composition exists after this.
    yield* sleep(0);
    expect(text).not.toBe("");
    expect(applied).toEqual([0]);
    expect(clock.wanted()).toBe(true);

    // Torn down before the timestamp that would have settled it. This returns,
    // which is the other half: a producer left waiting on a consumer that has
    // gone would never let the teardown finish.
    yield* mounted.halt();
    expect(clock.wanted()).toBe(false);

    // And the moment that would have finished the transition reaches nothing.
    yield* clock.advance(TRANSITION_SECONDS);
    expect(applied).toEqual([0]);
  });
});

describe("a URL addresses the execution, and cannot invent one", () => {
  const HEAD = "cp-14";

  /** Every URL a committed capture or study frame opens at. */
  const OPENED: readonly { readonly url: string; readonly head?: string }[] = [
    ...CATALOG.map((one) => ({ url: one.url, head: one.head })),
    ...FRAMES.map((one) => ({ url: one.url, head: one.head })),
  ];

  const refusalFor = (url: string, head: string | undefined = HEAD) =>
    hydrate(url, journalThrough(head)).refusal;

  it("resolves every location the study actually opens", function* () {
    for (const one of OPENED) {
      expect({ url: one.url, refusal: refusalFor(one.url, one.head) }).toEqual({
        url: one.url,
        refusal: undefined,
      });
    }
  });

  it("names the segment it could not resolve, for each kind of segment", function* () {
    const cases = [
      { url: "xmd://repl/e1/transcript/entry-2/document", segment: "entry", named: "entry-2" },
      { url: "xmd://repl/e1/transcript/entry-1/nowhere", segment: "scope", named: "nowhere" },
      {
        url: "xmd://repl/e1/transcript/entry-1/document/missing",
        segment: "scope",
        named: "missing",
      },
      {
        url: "xmd://repl/e1/transcript/entry-1/document?at=cp-99",
        segment: "checkpoint",
        named: "cp-99",
      },
      {
        url: "xmd://repl/e1/transcript/entry-1/document/+nope",
        segment: "drawer",
        named: "nope",
      },
    ];
    for (const one of cases) {
      const refusal = refusalFor(one.url);
      expect({ url: one.url, segment: refusal?.segment, named: refusal?.named }).toEqual({
        url: one.url,
        segment: one.segment,
        named: one.named,
      });
      // It says what the execution did, not merely that something is wrong.
      expect(refusal?.reason.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("refuses a drawer when nothing is waiting for an answer", function* () {
    // The same drawer, against a moment before anything suspended.
    expect(refusalFor("xmd://repl/e1/transcript/entry-1/document/+project", "cp-03")).toEqual({
      segment: "drawer",
      named: "project",
      reason: "nothing is waiting for an answer",
    });
    expect(refusalFor("xmd://repl/e1/transcript/entry-1/document/+project", HEAD)).toBeUndefined();
  });

  it("mounts nothing but the refusal, and draws it instead of a screen", function* () {
    const state = hydrate("xmd://repl/e1/transcript/entry-1/nowhere", journalThrough(HEAD));
    const tree = yield* useReplTree(state, WIDE);
    // Hidden content has no branch: there are no panes to focus, reach or type
    // into, because there is nowhere to be.
    expect(walk(tree.root.node).map((node) => node.name)).toEqual(["", "chrome:refused"]);
    expect(chain(tree)).toEqual([]);
    expect(overlayOf(tree)).toEqual([]);

    const drawn = yield* shot(tree, state, { overlay: false });
    expect(drawn).toContain("This location does not exist");
    expect(drawn).toContain("nowhere");
    expect(drawn).not.toContain("BINDINGS");
  });

  it("renders the plausible screen instead when the refusal is removed", function* () {
    // The control. A router that resolves what it can and quietly drops the
    // rest draws an execution that never ran, with nothing saying which part
    // was invented.
    const state = hydrate("xmd://repl/e1/transcript/entry-1/nowhere", journalThrough(HEAD));
    const tree = yield* useReplTree(state, WIDE, "render-partial-route");
    const drawn = yield* shot(tree, state, { overlay: false });
    expect(drawn).not.toContain("This location does not exist");
    expect(drawn).toContain("BINDINGS");
  });
});

describe("the frames, as pictures", () => {
  it("renders every committed focus capture exactly", function* () {
    const captures = yield* captureFocus();
    expect(captures.length).toBeGreaterThan(0);
    for (const capture of captures) {
      const golden = yield* readTextFile(join(GOLDENS, `${capture.name}.txt`));
      expect(captureText(capture)).toBe(golden);
    }
  });

  it("cannot be told where focus is, from outside or from a moment ago", function* () {
    // #839 handed the renderer a `FocusView`: an identity and a numbered map,
    // worked out somewhere else and threaded down through every frame request.
    // The control is to try that again. There is nowhere left for it to land,
    // and the proof is bytes: a frame drawn with a stale claim attached is the
    // frame drawn without one.
    const { state, tree } = yield* useFrame(frame("01")!, WIDE);
    const stale = overlayOf(tree).find((entry) => entry.focused)!;
    const before = yield* shot(tree, state);
    expect(before).toContain(overlayRow(stale));

    tree.advance();
    const after = yield* shot(tree, state);
    // Focus moved, and the picture moved with it, because the picture asked.
    expect(after).not.toContain(overlayRow(stale));

    const claimed = yield* shot(tree, state, {
      claim: { here: stale.id, map: [stale], overlay: true },
    });
    expect(claimed).toBe(after);
  });

  it("shows the focused Run affordance with the map closed", function* () {
    // Nothing else on screen says where focus is when F1 is up, so a control
    // with no marker cell of its own is a control a person has to guess at.
    const state = hydrate("xmd://repl/e1/input?draft=hello", journalThrough(undefined));
    const tree = yield* useReplTree(state, WIDE);
    const run = tree.chain().find((node) => node.name === "control:input.run")!;
    focusNode(run);
    const rendered = yield* shot(tree, state, { overlay: false });
    expect(rendered).not.toContain("FOCUS MAP");
    expect(rendered).toContain("[\u25b8Run");
  });

  it("shows the way out of a drawer with the map closed", function* () {
    // A drawer traps focus and carries its own Execution History target. It is
    // a different node from the band outside, so it has to draw its own marker
    // — over the band it is the way back to.
    const { state, tree } = yield* opened(
      "xmd://repl/e1/transcript/entry-1/document/+project",
      "cp-14",
    );
    const inside = tree.chain().find((node) => node.name === "region:history")!;
    expect(inside.parent?.name).toBe("drawer:project");
    focusNode(inside);
    const rendered = yield* shot(tree, state, { overlay: false });
    expect(rendered).not.toContain("FOCUS MAP");
    expect(rendered).toContain("\u258cEXECUTION HISTORY");
  });

  it("draws the focused region and the numbered map", function* () {
    const { state, tree } = yield* useFrame(frame("12")!, WIDE);
    const rendered = yield* shot(tree, state);
    expect(rendered).toContain("FOCUS MAP");
    expect(rendered).toContain("Fork from here");
  });

  // The overlay is ordinary UI state, so a frame that did not ask for it does
  // not get it. A frame cannot be silent about focus itself any more: focus is
  // the tree's, the tree always has one, and drawing from the tree draws it.
  it("draws no focus map in a frame that did not ask for one", function* () {
    const { state, tree } = yield* useFrame(frame("07")!, WIDE);
    const rendered = yield* shot(tree, state, { overlay: false });
    expect(rendered).not.toContain("FOCUS MAP");
  });
});

describe("the command opens at the frame it names", () => {
  it("reproduces every frame through the harness's own opening path", function* () {
    // `--frame <id>` builds its state the way `runInteractive` does, not the
    // way the rest of this suite does. They were once different: the harness
    // opened at a frame's location but not its focus, so the footer — whose
    // controls exist only once focus is inside it — drew none of them, and no
    // case noticed because every case entered another way.
    for (const subject of FRAMES) {
      // Exactly what `runInteractive` does: build the opening state from the
      // flags, then enter the route with the frame's focus.
      const state = openingState({
        fixture: subject.fixture,
        route: subject.url,
        head: subject.head,
      });
      const tree = yield* useReplTree(state, WIDE);
      yield* enterRoute(tree, state, subject.focus);
      expect({ frame: subject.id, focus: tree.focused().name }).toEqual({
        frame: subject.id,
        focus: subject.focus,
      });
      const entries = overlayOf(tree);
      const shown = subject.overlay
        ? entries
        : entries.filter((entry) => entry.id === subject.focus);
      expect({
        frame: subject.id,
        targets: shown.map((entry) => ({ n: entry.number, id: entry.id })),
      }).toEqual({
        frame: subject.id,
        targets: subject.targets.map((target) => ({ n: target.n, id: target.id })),
      });
    }
  });
});

describe("the documented command", () => {
  it("opens at a route, a frame and with the map on", function* () {
    for (const argument of [
      "--route xmd://repl/e1/transcript/entry-1/plan/+project",
      "--frame 07",
      "--frame 07 --focus-map",
    ]) {
      const result = yield* exec(`deno run --allow-all ${MAIN} ${argument}`, { cwd: ROOT }).join();
      expect({ argument, code: result.code }).toEqual({ argument, code: 2 });
      expect(`${result.stdout}${result.stderr}`).toContain("--capture");
    }
  });

  it("refuses a route it cannot parse, and a frame that does not exist", function* () {
    const bad = yield* exec(`deno run --allow-all ${MAIN} --route xmd://repl/e1/nowhere`, {
      cwd: ROOT,
    }).join();
    expect(bad.code).toBe(2);
    expect(bad.stdout).toContain("is not a surface");
  });
});

describe("the vendored Freedom snapshot", () => {
  const VENDOR = fileURLToPath(new URL("../repl-study/vendor/freedom/", import.meta.url));

  it("matches the bytes its manifest records", function* () {
    const manifest = JSON.parse(yield* readTextFile(join(VENDOR, "MANIFEST.json")));
    const digest = function* (path: string): Operation<string> {
      const text = yield* readTextFile(join(VENDOR, path));
      const bytes = new TextEncoder().encode(text);
      const hash = yield* until(crypto.subtle.digest("SHA-256", bytes));
      return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
    };
    for (const [path, recorded] of Object.entries(manifest.files)) {
      expect({ path, sha256: yield* digest(path) }).toEqual({ path, sha256: recorded });
    }
  });

  it("names the upstream commit and every file it patched", function* () {
    const manifest = JSON.parse(yield* readTextFile(join(VENDOR, "MANIFEST.json")));
    expect(manifest.upstream.commit).toBe("8be97e7201cd6effddb2f8b240b4b5166641e7f0");
    expect(manifest.upstream.repository).toBe("https://github.com/bombshell-dev/playground");
    const patched = new Set(manifest.patches.map((patch: { file: string }) => patch.file));
    expect([...patched].sort()).toEqual([
      "upstream/lib/focus.ts",
      "upstream/lib/mod.ts",
      "upstream/lib/node.ts",
      "upstream/lib/root.ts",
    ]);
    for (const patch of manifest.patches) {
      expect(typeof patch.reason).toBe("string");
      expect(patch.reason.length).toBeGreaterThan(30);
    }
  });
});
