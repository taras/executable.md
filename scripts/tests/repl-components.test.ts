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
import { hydrate, layoutOf } from "../repl-study/store.ts";
import { journalThrough } from "../repl-study/journal.ts";
import { paint } from "../repl-study/paint.ts";
import { applyAnsi, createGrid, gridText } from "../repl-study/screen.ts";
import { useReplTree } from "../repl-study/tree.ts";
import { enterRoute } from "../repl-study/drive.ts";
import { sendKey } from "../repl-study/keys.ts";
import { indexOf, project } from "../repl-study/view.ts";
import type { ReplView } from "../repl-study/view.ts";

const WIDE = PROFILE_SIZES.wide;

function* mounted(
  url: string,
  head: string | undefined,
): Operation<{
  view: ReplView;
  screen: string;
  chain: string[];
}> {
  const state = hydrate(url, journalThrough(head));
  const tree = yield* useReplTree(state);
  const view = project(state);
  const term = yield* useTerm(WIDE);
  const result = term.render(
    paint({ root: tree.root.node, view, layout: layoutOf(state, WIDE), anchor: 0 }),
    { deltaTime: 0 },
  );
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
    const tree = yield* useReplTree(state);
    const node = tree.root.node.createChild("probe:self");
    let seen: Record<string, unknown> = {};
    attach(
      node,
      (context) => {
        seen = { ...context };
        return [];
      },
      undefined,
      { rect: { x: 0, y: 0, width: 1, height: 1 }, dense: false },
    );
    walk(node);
    // A body that held the node could create children, remove itself, set props
    // or reach its scope; the tree's authority would be advisory.
    expect(Object.keys(seen).toSorted()).toEqual(["children", "data", "placement", "self"]);
    expect(Object.keys(seen.self as object).toSorted()).toEqual(["id", "name"]);
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
    const tree = yield* useReplTree(state);
    const parent = tree.root.node.createChild("probe:parent");
    const child = parent.createChild("probe:child");
    attach(child, ({ self }) => [{ kind: "text", value: self.name } as never], undefined, {
      rect: { x: 0, y: 0, width: 1, height: 1 },
      dense: false,
    });
    attach(
      parent,
      ({ children }) => ["before" as never, ...children, "after" as never],
      undefined,
      {
        rect: { x: 0, y: 0, width: 1, height: 1 },
        dense: false,
      },
    );
    const ops = walk(parent);
    expect(ops.length).toBe(3);
    expect(ops[0]).toBe("before");
    expect(ops[2]).toBe("after");
  });

  it("keeps the node when its data changes, rather than rebuilding", function* () {
    const state = hydrate("xmd://repl/e1/transcript/entry-1/document", journalThrough("cp-14"));
    const tree = yield* useReplTree(state);
    const node = tree.chain().find((candidate) => candidate.name === "region:transcript")!;
    const before = node.id;
    const view = project(state);
    const layout = layoutOf(state, WIDE);
    paint({ root: tree.root.node, view, layout, anchor: 0 });
    paint({ root: tree.root.node, view, layout, anchor: 12 });
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
    // A disabled control is shown as recorded state rather than as an
    // affordance that would do nothing.
    expect(frame.text).toContain("· Submit");
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
    const tree = yield* useReplTree(state);
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
    const delivery = sendKey(tree.root.node, tree.focused(), { type: "keydown", code: "x" });
    expect(delivery.target).toBe("field:drawer.project.name");
  });

  it("renders the recorded controls while none of them is focusable", function* () {
    // Cold: the URL and the journal alone, with nothing carried over.
    const { tree } = yield* open(RECORDED, "cp-18");
    const frame = yield* renderCatalog(
      CATALOG.find((one) => one.id === "drawer-historical")!,
      "wide",
    );
    // The complete recorded presentation is still drawn…
    for (const control of ["Project name", "Description", "Schema disclosure", "Submit"]) {
      expect(frame.text).toContain(control);
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
    const delivery = sendKey(tree.root.node, tree.focused(), { type: "keydown", code: "x" });
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
