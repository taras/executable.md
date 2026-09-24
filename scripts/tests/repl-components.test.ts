/**
 * The component boundary: one tree, and data that cannot reach past itself.
 *
 * #840's claim is that the mounted Freedom tree is the single authority for
 * component ancestry, rendering order, focus, scoped input and branch lifetime.
 * These cases hold the foundation of that claim: a projection a component
 * cannot see past, a body attached to a node, and a render that walks the same
 * tree the focus chain comes off.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";

import { PROFILE_SIZES, useTerm } from "../repl-study/capture.ts";
import { CATALOG, catalogText, renderAll, renderCatalog } from "../repl-study/catalog.ts";
import { readTextFile } from "@effectionx/fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attach, walk } from "../repl-study/component.ts";
import type { Node } from "../repl-study/vendor/freedom/upstream/index.ts";
import { hydrate, initialView, layoutOf } from "../repl-study/store.ts";
import { composeInto, useForeignTree } from "../repl-study/capture.ts";
import { fixture } from "../repl-study/fixtures.ts";
import { journalThrough } from "../repl-study/journal.ts";
import { paint } from "../repl-study/paint.ts";
import { drive } from "../repl-study/drive.ts";
import { applyAnsi, createGrid, gridText } from "../repl-study/screen.ts";
import { overlayOf, useReplTree } from "../repl-study/tree.ts";
import { enterRoute } from "../repl-study/drive.ts";
import { sendInput } from "../repl-study/input.ts";
import type { ReplInput } from "../repl-study/input.ts";
import { indexOf, project } from "../repl-study/view.ts";
import type { ReplView } from "../repl-study/view.ts";
import type { HarnessEvent } from "../repl-study/store.ts";
import type { Mutation } from "../repl-study/mutations.ts";

const WIDE = PROFILE_SIZES.wide;

/** One key, already normalized, for a case that delivers it by hand. */
function press(code: string): ReplInput {
  return { kind: "key", key: { type: "keydown", code } };
}

function context(size: typeof WIDE, mutation?: Mutation) {
  return { size, mutation, scrollLimit: 40 };
}

function key(code: string): HarnessEvent {
  return { kind: "key", event: { type: "keydown", key: code, code } };
}

function* mounted(
  url: string,
  head: string | undefined,
): Operation<{
  view: ReplView;
  screen: string;
  chain: string[];
}> {
  const state = hydrate(url, journalThrough(head));
  const tree = yield* useReplTree(state, WIDE);
  const view = project(state);
  const term = yield* useTerm(WIDE);
  const result = term.render(paint({ tree, view, layout: layoutOf(state, WIDE) }).ops, {
    deltaTime: 0,
  });
  expect(result.errors).toEqual([]);
  const grid = applyAnsi(createGrid(WIDE.cols, WIDE.rows), Uint8Array.from(result.output));
  return { view, screen: gridText(grid), chain: tree.chain().map((node) => node.name) };
}

describe("the view a component is handed", () => {
  it("is JSON, so it can carry no handle and no callback", function* () {
    const state = hydrate("xmd://repl/e1/transcript/entry-1/document", journalThrough("cp-14"));
    const view = project(state);
    // The boundary is a capability one, not a naming one: a marker's `scope` is
    // a label and belongs here, while a journal, a store handle, a Freedom node
    // or a callback could not survive this round trip. `architecture.md` states
    // the same rule for an ordinary component's props.
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);

    const functions: string[] = [];
    const seek = (value: unknown, at: string): void => {
      if (typeof value === "function") {
        functions.push(at);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item, index) => seek(item, `${at}[${index}]`));
        return;
      }
      if (typeof value === "object" && value !== null) {
        for (const [key, nested] of Object.entries(value)) {
          seek(nested, `${at}.${key}`);
        }
      }
    };
    seek(view, "view");
    expect(functions).toEqual([]);
  });

  it("names what a route may address, so the router can refuse the rest", function* () {
    const state = hydrate("xmd://repl/e1/transcript/entry-1/document", journalThrough("cp-14"));
    const index = indexOf(project(state));
    expect(index.surfaces).toContain("transcript");
    expect(index.markers.length).toBeGreaterThan(0);
    // The view decides what exists; a URL only addresses it.
    expect(index.scopes).not.toContain("no-such-scope");
  });
});

describe("a component is a body on a node", () => {
  it("hands a body its identity and no way to reach the tree", function* () {
    const state = hydrate("xmd://repl/e1/transcript/entry-1/document", journalThrough("cp-14"));
    const tree = yield* useReplTree(state, WIDE);
    const node = tree.root.node.createChild("probe:self");
    let seen: Record<string, unknown> = {};
    attach(
      node,
      (context) => {
        seen = { ...context };
        return [];
      },
      undefined,
      { rect: { x: 0, y: 0, width: 1, height: 1 }, dense: false, profile: "wide" },
    );
    walk(node);
    // A body that held the node could create children, remove itself, set props
    // or reach its scope; the tree's authority would be advisory.
    expect(Object.keys(seen).toSorted()).toEqual([
      "children",
      "data",
      "focus",
      "placement",
      "self",
    ]);
    expect(Object.keys(seen.self as object).toSorted()).toEqual(["id", "name"]);
    // Focus arrives as a relation to this node and nothing else: a word, never
    // a node, an identity or a map of where everything else is.
    expect(seen.focus).toBe("outside");
  });

  it("renders the REPL by walking the mounted tree", function* () {
    const { screen } = yield* mounted("xmd://repl/e1/transcript/entry-1/document", "cp-14");
    expect(screen).toContain("SESSION");
    expect(screen).toContain("BINDINGS");
    expect(screen).toContain("Entry 1");
  });

  it("gives rendering and focus the same tree to come off", function* () {
    const { screen, chain } = yield* mounted("xmd://repl/e1/transcript/entry-1/document", "cp-14");
    // The five regions are focusable *and* drawn, from one structure.
    expect(chain).toEqual([
      "region:sessions",
      "region:transcript",
      "region:bindings",
      "region:input",
      "region:history",
    ]);
    expect(screen.length).toBeGreaterThan(0);
  });

  it("lets a parent wrap what its children already rendered", function* () {
    const state = hydrate("xmd://repl/e1/transcript/entry-1/document", journalThrough("cp-14"));
    const tree = yield* useReplTree(state, WIDE);
    const parent = tree.root.node.createChild("probe:parent");
    const child = parent.createChild("probe:child");
    attach(child, ({ self }) => [{ kind: "text", value: self.name } as never], undefined, {
      rect: { x: 0, y: 0, width: 1, height: 1 },
      dense: false,
      profile: "wide",
    });
    attach(
      parent,
      ({ children }) => ["before" as never, ...children, "after" as never],
      undefined,
      {
        rect: { x: 0, y: 0, width: 1, height: 1 },
        dense: false,
        profile: "wide",
      },
    );
    const ops = walk(parent);
    expect(ops.length).toBe(3);
    expect(ops[0]).toBe("before");
    expect(ops[2]).toBe("after");
  });

  it("keeps the node when its data changes, rather than rebuilding", function* () {
    const state = hydrate("xmd://repl/e1/transcript/entry-1/document", journalThrough("cp-14"));
    const tree = yield* useReplTree(state, WIDE);
    const node = tree.chain().find((candidate) => candidate.name === "region:transcript")!;
    const before = node.id;
    const view = project(state);
    const layout = layoutOf(state, WIDE);
    paint({ tree, view, layout, anchor: 0 });
    paint({ tree, view, layout, anchor: 12 });
    const after = tree.chain().find((candidate) => candidate.name === "region:transcript")!;
    expect(after.id).toBe(before);
    expect(after).toBe(node);
  });
});

const CATALOG_GOLDENS = fileURLToPath(new URL("./fixtures/repl-catalog/", import.meta.url));

describe("the component catalog", () => {
  it("renders every committed catalog capture exactly", function* () {
    const frames = yield* renderAll();
    expect(frames.length).toBe(CATALOG.length * 2);
    for (const frame of frames) {
      const golden = yield* readTextFile(join(CATALOG_GOLDENS, `${frame.name}.txt`));
      expect(catalogText(frame)).toBe(golden);
    }
  });

  it("covers every state the contract names", function* () {
    // Each of these is a state #840's Story asks the catalog to render.
    for (const required of [
      "empty",
      "nested",
      "sessions",
      "drawer-project",
      "drawer-review",
      "drawer-confirm",
      "bindings-plan",
      "bindings-document",
      "inspecting",
      "drawer-historical",
      "settled",
    ]) {
      expect({ required, present: CATALOG.some((one) => one.id === required) }).toEqual({
        required,
        present: true,
      });
    }
  });

  it("renders a recorded drawer with nothing to act on", function* () {
    const frame = yield* renderCatalog(
      CATALOG.find((one) => one.id === "drawer-historical")!,
      "wide",
    );
    expect(frame.text).toContain("recorded · read-only");
    // Shown as the state it recorded, never as an affordance that would do
    // nothing when pressed.
    expect(frame.text).not.toContain("[ Submit ]");
  });

  it("says the same thing at both profiles", function* () {
    for (const subject of CATALOG) {
      const wide = yield* renderCatalog(subject, "wide");
      const narrow = yield* renderCatalog(subject, "narrow");
      expect({ id: subject.id, drew: wide.text.trim().length > 0 }).toEqual({
        id: subject.id,
        drew: true,
      });
      expect({ id: subject.id, drew: narrow.text.trim().length > 0 }).toEqual({
        id: subject.id,
        drew: true,
      });
    }
  });
});

describe("a recorded drawer keeps its presentation and loses its actionability", () => {
  const LIVE = "xmd://repl/e1/transcript/entry-1/document/+project";
  const RECORDED = "xmd://repl/e1/transcript/entry-1/document/+project?at=cp-04&inspect";

  function* open(url: string, head: string) {
    const state = hydrate(url, journalThrough(head));
    const tree = yield* useReplTree(state, WIDE);
    yield* enterRoute(tree, state);
    return { state, tree };
  }

  it("exposes a live drawer's controls in tree order", function* () {
    const { tree } = yield* open(LIVE, "cp-14");
    expect(tree.chain().map((node) => node.name)).toEqual([
      "field:drawer.project.name",
      "field:drawer.project.description",
      "control:drawer.project.schema",
      "control:drawer.project.submit",
      "region:history",
    ]);
    const delivery = sendInput(tree.root.node, tree.focused(), press("x"));
    expect(delivery.target).toBe("field:drawer.project.name");
  });

  it("renders the recorded controls while none of them is focusable", function* () {
    // Cold: the URL and the journal alone, with nothing carried over.
    const { tree } = yield* open(RECORDED, "cp-18");
    const frame = yield* renderCatalog(
      CATALOG.find((one) => one.id === "drawer-historical")!,
      "wide",
    );
    // The complete recorded presentation is still drawn — the study's own form,
    // with its labelled fields, its validation line and its schema.
    for (const shown of ["Project name", "Northstar", "Description", "schema", "Submit"]) {
      expect(frame.text).toContain(shown);
    }
    expect(frame.text).toContain("recorded · read-only");
    // …and none of it is in the ring, so none of it can be focused.
    const chain = tree.chain().map((node) => node.name);
    expect(chain).toEqual(["region:history"]);
    for (const control of [
      "field:drawer.project.name",
      "field:drawer.project.description",
      "control:drawer.project.schema",
      "control:drawer.project.submit",
    ]) {
      expect({ control, focusable: chain.includes(control) }).toEqual({
        control,
        focusable: false,
      });
    }
  });

  it("keeps only the navigation that stays valid while inspecting", function* () {
    const { tree } = yield* open(RECORDED, "cp-18");
    expect(tree.focused().name).toBe("region:history");
    const delivery = sendInput(tree.root.node, tree.focused(), press("x"));
    // A key reaches the history path and nothing recorded.
    expect(delivery.target).toBe("region:history");
    expect(delivery.path).not.toContain("panel:project.body");
  });

  it("removes actionability when a mounted drawer becomes recorded", function* () {
    // `focusable()` is one-way, so reconciliation has to rebuild the branch
    // rather than quietly leave a focusable node describing a recorded one.
    const { tree } = yield* open(LIVE, "cp-14");
    expect(tree.chain().length).toBe(5);
    yield* tree.sync(hydrate(RECORDED, journalThrough("cp-18")));
    expect(tree.chain().map((node) => node.name)).toEqual(["region:history"]);
    expect(tree.chain()).toContain(tree.focused());
  });
});

describe("one mounted tree answers everything", () => {
  function* harness() {
    const state = hydrate("xmd://repl/e1/transcript/entry-1/document", journalThrough("cp-14"));
    const tree = yield* useReplTree(state, WIDE);
    yield* enterRoute(tree, state);
    const subject = fixture("nested");
    const composition = composeInto(tree, subject, initialView(subject));
    return { tree, composition };
  }

  it("renders, focuses, targets input and numbers the overlay from one root", function* () {
    const { tree, composition } = yield* harness();
    // Object identity, not equality: two trees would each be internally
    // consistent and both would look right on their own.
    expect(composition.tree).toBe(tree);
    expect(composition.root).toBe(tree.root.node);

    const rootOf = (node: { parent?: unknown }) => {
      let at = node;
      while (at.parent) {
        at = at.parent as { parent?: unknown };
      }
      return at;
    };
    expect(rootOf(tree.focused())).toBe(tree.root.node);
    for (const target of tree.chain()) {
      expect(rootOf(target)).toBe(tree.root.node);
    }
    const delivery = sendInput(tree.root.node, tree.focused(), press("x"));
    expect(delivery.target).toBe(tree.focused().name);
    // The overlay is the same tree walked, so every entry names a node in it.
    const names = new Set(walkNames(tree.root.node));
    for (const entry of overlayOf(tree)) {
      expect({ id: entry.id, inTree: names.has(entry.id) }).toEqual({ id: entry.id, inTree: true });
    }
  });

  it("is rejected when rendering uses a tree of its own", function* () {
    const state = hydrate("xmd://repl/e1/transcript/entry-1/document", journalThrough("cp-14"));
    const tree = yield* useReplTree(state, WIDE);
    yield* enterRoute(tree, state);
    const subject = fixture("nested");
    yield* useForeignTree(subject, initialView(subject));

    // Move focus, so the two trees have something to disagree about. Node ids
    // cannot tell them apart — each tree counts from one — so the oracle is the
    // observable question: does what rendered agree with where focus is?
    yield* drive(tree, state, key("Tab"), context(WIDE));
    const focused = tree.focused().name;
    expect(focused).toBe("region:bindings");

    const honest = composeInto(tree, subject, initialView(subject));
    const marked = (composed: typeof honest) =>
      overlayOf(composed.tree).find((entry) => entry.id === composed.tree.focused().name)?.id;
    expect(marked(honest)).toBe(focused);

    const split = composeInto(tree, subject, initialView(subject), undefined, "second-tree");
    expect(marked(split)).not.toBe(focused);
    expect(split.root).not.toBe(tree.root.node);
  });

  it("does not move focus or topology when it repaints", function* () {
    // A repaint used to hydrate a synthetic state from a fabricated URL, sync
    // the tree to it and enter its route — every frame. Someone who tabbed to
    // the bindings pane had focus dragged back to the transcript by the next
    // frame, because drawing was re-deciding where they were.
    const state = hydrate("xmd://repl/e1/transcript/entry-1/document", journalThrough("cp-14"));
    const tree = yield* useReplTree(state, WIDE);
    yield* enterRoute(tree, state);
    const moved = yield* drive(tree, state, key("Tab"), context(WIDE));
    const focused = tree.focused().name;
    expect(focused).toBe("region:bindings");
    const topology = walkNames(tree.root.node).join(",");

    const subject = fixture("nested");
    for (let repaint = 0; repaint < 5; repaint += 1) {
      composeInto(tree, subject, initialView(subject));
    }
    expect(tree.focused().name).toBe(focused);
    expect(walkNames(tree.root.node).join(",")).toBe(topology);
    expect(moved.state.route.surface).toBe("bindings");
  });

  it("keeps unchanged children when a parent reconciles", function* () {
    const { tree } = yield* harness();
    const before = new Map(tree.chain().map((node) => [node.name, node] as const));
    const next = hydrate("xmd://repl/e1/bindings/entry-1/document", journalThrough("cp-14"));
    yield* tree.sync(next);
    for (const [name, node] of before) {
      const after = tree.chain().find((candidate) => candidate.name === name);
      if (after !== undefined) {
        expect({ name, same: after === node }).toEqual({ name, same: true });
      }
    }
  });

  it("hands a render body no node and no root view", function* () {
    const { tree } = yield* harness();
    const node = tree.root.node.createChild("probe:body");
    let seen: Record<string, unknown> = {};
    attach(
      node,
      (context) => {
        seen = { ...context };
        return [];
      },
      { only: "mine" },
      {
        rect: { x: 0, y: 0, width: 1, height: 1 },
        dense: false,
        profile: "wide",
      },
    );
    walk(node);
    expect(Object.keys(seen).toSorted()).toEqual([
      "children",
      "data",
      "focus",
      "placement",
      "self",
    ]);
    expect(seen.focus).toBe("outside");
    // Its own data, not the projection every other component was built from.
    expect(seen.data).toEqual({ only: "mine" });
    expect(Object.keys(seen.self as object).toSorted()).toEqual(["id", "name"]);
  });
});

/** Every node's name, for checking the overlay against the tree it came from. */
function walkNames(node: Node): string[] {
  return [node.name, ...[...node.children].flatMap(walkNames)];
}
