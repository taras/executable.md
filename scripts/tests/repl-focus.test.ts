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
import { until } from "effection";
import type { Operation } from "effection";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { captureFocus, captureText, PROFILE_SIZES, renderFrame } from "../repl-study/capture.ts";
import { FRAMES, frame, stateFor, useFrame } from "../repl-study/frames.ts";
import { scanKeys } from "../repl-study/host.ts";
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
  layoutOf,
  openDrawer,
  projection,
  viewOf,
} from "../repl-study/store.ts";
import type { HarnessEvent, ReplState, Size } from "../repl-study/store.ts";
import { drive } from "../repl-study/drive.ts";
import { overlayOf, surfaceOwning, useReplTree, walk } from "../repl-study/tree.ts";
import type { ReplTree } from "../repl-study/tree.ts";
import { sendKey } from "../repl-study/keys.ts";
import type { Mutation } from "../repl-study/mutations.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GOLDENS = fileURLToPath(new URL("./fixtures/repl-focus/", import.meta.url));
const MAIN = "scripts/repl-study/main.ts";

const WIDE: Size = PROFILE_SIZES.wide;
const NARROW: Size = PROFILE_SIZES.narrow;

function context(size: Size, mutation?: Mutation) {
  return { size, mutation, scrollLimit: 40 };
}

function key(code: string, extra: Record<string, unknown> = {}): HarnessEvent {
  return { kind: "key", event: { type: "keydown", key: code, code, ...extra } };
}

/** One state and the tree that renders it, built from a URL and a journal. */
function* opened(
  url: string,
  head: string | undefined,
): Operation<{
  state: ReplState;
  tree: ReplTree;
}> {
  const state = hydrate(url, journalThrough(head));
  const tree = yield* useReplTree(state);
  return { state, tree };
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
      const { tree } = yield* useFrame(subject);
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
      const forward = yield* useFrame(subject);
      forward.tree.advance();
      expect({ frame: subject.id, tab: forward.tree.focused().name }).toEqual({
        frame: subject.id,
        tab: subject.tab,
      });
      const reverse = yield* useFrame(subject);
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
      const { state, tree } = yield* useFrame(subject);
      yield* drive(tree, state, key("Tab"), context(WIDE));
      expect({ frame: subject.id, tab: tree.focused().name }).toEqual({
        frame: subject.id,
        tab: subject.tab,
      });
    }
  });

  it("takes the URL with it whenever focus changes region", function* () {
    for (const subject of FRAMES) {
      const { state, tree } = yield* useFrame(subject);
      const driven = yield* drive(tree, state, key("Tab"), context(WIDE));
      const landed = surfaceOwning(tree.focused());
      expect({ frame: subject.id, surface: driven.state.route.surface }).toEqual({
        frame: subject.id,
        surface: landed ?? driven.state.route.surface,
      });
    }
  });

  it("leaves the URL behind when focus is allowed to move without it", function* () {
    const { state, tree } = yield* useFrame(frame("02")!);
    const driven = yield* drive(tree, state, key("Tab"), context(WIDE, "keep-route-on-focus"));
    expect(tree.focused().name).toBe("region:history");
    expect(driven.state.route.surface).toBe("input");
  });

  it("walks the whole ring in both directions and comes back to the start", function* () {
    for (const subject of FRAMES) {
      const { tree } = yield* useFrame(subject);
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
    const delivery = sendKey(tree.root.node, tree.focused(), { type: "keydown", code: "x" });
    expect(delivery.target).toBe("field:drawer.project.name");
    expect(delivery.path).toEqual(["drawer:project", "panel:project.body"]);
  });

  it("passes through the region that owns a transport control", function* () {
    const { state, tree } = yield* useFrame(frame("10")!);
    void state;
    const delivery = sendKey(tree.root.node, tree.focused(), { type: "keydown", code: "x" });
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
    const delivery = sendKey(tree.root.node, tree.focused(), { type: "keydown", code: "x" });
    expect(delivery.path).not.toContain("drawer:project");
    expect(delivery.target).not.toBe(field.name);
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
    yield* tree.sync(
      hydrate("xmd://repl/e1/transcript/entry-1/document", state.journal),
      "keep-closed-branch",
    );
    expect(walk(tree.root.node).map((node) => node.name)).toContain("field:drawer.project.name");
  });

  it("keeps focus across a sync, because the tree is reconciled and not rebuilt", function* () {
    const { state, tree } = yield* useFrame(frame("10")!);
    expect(tree.focused().name).toBe("control:transport.continue");
    yield* tree.sync(state);
    expect(tree.focused().name).toBe("control:transport.continue");
  });

  it("loses focus when every node is rebuilt on each sync", function* () {
    const { state, tree } = yield* useFrame(frame("10")!);
    yield* tree.sync(state, "rebuild-tree-each-sync");
    expect(tree.focused().name).not.toBe("control:transport.continue");
  });
});

describe("drawers trap traversal and restore outward", () => {
  it("traps the ring in the top drawer, with the footer inside it", function* () {
    for (const subject of FRAMES.filter((one) => one.meta.trap)) {
      const { tree } = yield* useFrame(subject);
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

  it("lets Tab escape the trap when the branch is not pushed as a focus root", function* () {
    const { state, tree } = yield* opened("xmd://repl/e1/transcript/entry-1/document", "cp-14");
    yield* tree.sync(
      hydrate("xmd://repl/e1/transcript/entry-1/document/+project", state.journal),
      "leak-drawer-trap",
    );
    expect(chain(tree)).toContain("region:transcript");
  });

  it("leaves focus behind when the drawer's push is never popped", function* () {
    const { state, tree } = yield* opened(
      "xmd://repl/e1/transcript/entry-1/document/+project",
      "cp-14",
    );
    yield* tree.sync(
      hydrate("xmd://repl/e1/transcript/entry-1/document", state.journal),
      "forget-drawer-invoker",
    );
    expect(tree.focused().name).not.toBe("region:transcript");
  });
});

describe("removing the focused node", () => {
  it("selects a surviving node before teardown", function* () {
    const { state, tree } = yield* useFrame(frame("10")!);
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
    const { state, tree } = yield* useFrame(frame("06")!);
    const before = tree.focused().name;
    const driven = yield* drive(tree, state, streaming(), context(WIDE));
    expect(tree.focused().name).toBe(before);
    expect(driven.state.route).toBe(state.route);
    expect(driven.state.journal.length).toBe(state.journal.length + 1);
  });

  it("is rejected when the update moves focus", function* () {
    const { state, tree } = yield* useFrame(frame("06")!);
    const before = tree.focused().name;
    yield* drive(tree, state, streaming(), context(WIDE, "steal-focus-on-background"));
    expect(tree.focused().name).not.toBe(before);
  });
});

describe("a disabled control is drawn and never focusable", () => {
  it("numbers Continue in the overlay and keeps it out of the chain", function* () {
    const { tree } = yield* useFrame(frame("12")!);
    const entries = overlayOf(tree);
    const continues = entries.find((entry) => entry.id === "control:transport.continue");
    expect(continues?.enabled).toBe(false);
    expect(chain(tree)).not.toContain("control:transport.continue");
    expect(entries.map((entry) => entry.id)).toContain("control:transport.continue");
  });

  it("admits it to the chain when a disabled control is made focusable", function* () {
    const { state, tree } = yield* useFrame(frame("12")!);
    yield* tree.sync(state, "focus-hidden-target");
    expect(chain(tree)).toContain("control:transport.continue");
  });
});

describe("the overlay is the tree", () => {
  it("matches the live tree exactly, node for node", function* () {
    for (const subject of FRAMES) {
      const { tree } = yield* useFrame(subject);
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
      const { state, tree } = yield* useFrame(subject);
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
    const { state, tree } = yield* useFrame(frame("07")!);
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
    const { state, tree } = yield* useFrame(subject);
    for (const decodedEvent of events) {
      yield* drive(tree, state, { kind: "key", event: decodedEvent }, context(WIDE));
    }
    expect(tree.focused().name).toBe(subject.shift);
  });

  it("traverses forward when only a synthetic Tab+shift counts as reverse", function* () {
    const input: Input = yield* until(createInput({}));
    const events = yield* decoded(input, bytes(ESC, 0x5b, 0x5a));
    const subject = frame("03")!;
    const { state, tree } = yield* useFrame(subject);
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

describe("the frames, as pictures", () => {
  it("renders every committed focus capture exactly", function* () {
    const captures = yield* captureFocus();
    expect(captures.length).toBeGreaterThan(0);
    for (const capture of captures) {
      const golden = yield* readTextFile(join(GOLDENS, `${capture.name}.txt`));
      expect(captureText(capture)).toBe(golden);
    }
  });

  it("draws the focused region and the numbered map", function* () {
    const subject = frame("12")!;
    const { state, tree } = yield* useFrame(subject);
    const rendered = yield* renderFrame({
      fixture: fixtureFor(state),
      view: viewOf(state),
      size: WIDE,
      focus: { here: tree.focused().name, map: overlayOf(tree), overlay: true },
    });
    expect(rendered.text).toContain("FOCUS MAP");
    expect(rendered.text).toContain("Fork from here");
  });

  it("says nothing about focus in a frame that was not asked about it", function* () {
    const state = stateFor(frame("07")!);
    const rendered = yield* renderFrame({
      fixture: fixtureFor(state),
      view: viewOf(state),
      size: WIDE,
    });
    expect(rendered.text).not.toContain("FOCUS MAP");
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
