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
import { attach, walk } from "../repl-study/component.ts";
import { hydrate, layoutOf } from "../repl-study/store.ts";
import { journalThrough } from "../repl-study/journal.ts";
import { paint } from "../repl-study/paint.ts";
import { applyAnsi, createGrid, gridText } from "../repl-study/screen.ts";
import { useReplTree } from "../repl-study/tree.ts";
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
    attach(child, ({ node }) => [{ kind: "text", value: node.name } as never], undefined, {
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
