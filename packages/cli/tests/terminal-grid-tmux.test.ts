/**
 * Tier TX — the tmux terminal-grid provider
 * (architecture.md §Interactive terminal grids, issue #732).
 *
 * The provider is the one production presentation for a grid, and these rows
 * hold it to the two things a document can observe about it: that the panes end
 * up where the author put them, and that nothing tmux-shaped leaks out of the
 * closure. Core lifecycle semantics are the controlled provider's to prove —
 * this tier does not restate them.
 *
 * Geometry first. `select-layout tiled` picks its own column count from the
 * window's dimensions, so the same four panes would be 2×2 in one terminal and
 * 4×1 in another; an authored `columns` has to be told to tmux rather than
 * asked of it. These rows check the string that tells it, at sizes a reader
 * would actually have.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  layoutString,
  placementProblems,
  rowMajorCells,
  swapsInto,
} from "../src/terminal/layout.ts";
import type { LayoutCell } from "../src/terminal/layout.ts";

/** The cells a layout string describes, read back out of it. */
function readCells(layout: string): LayoutCell[] {
  const cells: LayoutCell[] = [];
  // `WxH,left,top,paneId` — the leaves, in the order the string lists them,
  // which is the order tmux fills them in.
  const leaf = /(\d+)x(\d+),(\d+),(\d+),(\d+)(?![\dx])/g;
  let match = leaf.exec(layout);
  let ordinal = 0;
  while (match !== null) {
    const [, width, height, left, top] = match;
    cells.push({
      ordinal: ordinal++,
      left: Number(left),
      top: Number(top),
      width: Number(width),
      height: Number(height),
    });
    match = leaf.exec(layout);
  }
  return cells;
}

describe("Tier TX — the tmux grid's geometry", () => {
  it("TX1: an authored column count survives every terminal size", function* () {
    // Four panes in two columns is 2×2 whatever the terminal is. `tiled` would
    // have made the wide one 4×1 and the tall one 1×4.
    for (const [width, height] of [
      [80, 24],
      [200, 24],
      [80, 60],
      [211, 51],
    ] as const) {
      const cells = rowMajorCells(width, height, 2, 4);
      const rows = new Set(cells.map((cell) => cell.top));
      const columns = new Set(cells.map((cell) => cell.left));
      const size = `${width}x${height}`;
      expect(`${size}: ${rows.size} rows`).toBe(`${size}: 2 rows`);
      expect(`${size}: ${columns.size} columns`).toBe(`${size}: 2 columns`);
      expect(`${size}: ${placementProblems(cells, 2).join("; ")}`).toBe(`${size}: `);
    }
  });

  it("TX2: the cells tile the terminal exactly, with one separator between", function* () {
    const cells = rowMajorCells(80, 24, 2, 4);
    // Two panes and one separator span the width; two rows and one separator
    // span the height. A gap or an overlap would be a grid the reader can see
    // is wrong.
    const top = cells.filter((cell) => cell.top === 0);
    expect(top.reduce((total, cell) => total + cell.width, 0) + (top.length - 1)).toBe(80);
    const left = cells.filter((cell) => cell.left === 0);
    expect(left.reduce((total, cell) => total + cell.height, 0) + (left.length - 1)).toBe(24);
  });

  it("TX3: a short final row spans it, because tmux has no empty cells", function* () {
    // Three panes in two columns: two above, one below across the whole width.
    const cells = rowMajorCells(80, 24, 2, 3);
    expect(cells.length).toBe(3);
    const last = cells[2];
    expect(last?.left).toBe(0);
    expect(last?.width).toBe(80);
    expect(placementProblems(cells, 2)).toEqual([]);
  });

  it("TX4: one pane and one row need no tree at all", function* () {
    expect(rowMajorCells(80, 24, 1, 1)).toEqual([
      { ordinal: 0, left: 0, top: 0, width: 80, height: 24 },
    ]);
    // A single row is written flat: nesting one row inside a column tree is a
    // layout tmux accepts and a reader would never see the point of.
    const single = layoutString(80, 24, 2, [1, 2]);
    expect(single).not.toContain("[");
    expect(single).toContain("{");
  });

  it("TX5: the string is one tmux accepts — checksum, then the tree", function* () {
    const layout = layoutString(80, 24, 2, [1, 2, 3, 4]);
    const [sum, ...rest] = layout.split(",");
    expect(sum).toMatch(/^[0-9a-f]{4}$/);
    // Rows top to bottom, columns left to right, and every authored pane named.
    const body = rest.join(",");
    expect(body.startsWith("80x24,0,0[")).toBe(true);
    for (const pane of [1, 2, 3, 4]) {
      expect(body).toContain(`,${pane}`);
    }
    // And the geometry it describes is the geometry that was asked for.
    expect(placementProblems(readCells(layout), 2)).toEqual([]);
  });

  it("TX6: the checksum changes with the tree, so a stale string is rejected", function* () {
    const four = layoutString(80, 24, 2, [1, 2, 3, 4]);
    const swapped = layoutString(80, 24, 2, [1, 2, 4, 3]);
    expect(four.split(",")[0]).not.toBe(swapped.split(",")[0]);
  });

  it("TX7: authored order is imposed by swaps, because tmux ignores leaf ids", function* () {
    // tmux fills the leaves in window-list order, so a window holding panes in
    // the wrong order needs them moved rather than re-described.
    const swaps = swapsInto([3, 1, 4, 2], [1, 2, 3, 4]);
    const order = [3, 1, 4, 2];
    for (const swap of swaps) {
      const from = order[swap.from];
      const to = order[swap.to];
      if (from === undefined || to === undefined) {
        continue;
      }
      order[swap.to] = from;
      order[swap.from] = to;
    }
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("TX8: an order that is already authored is left alone", function* () {
    expect(swapsInto([1, 2, 3, 4], [1, 2, 3, 4])).toEqual([]);
  });

  it("TX9: a window missing an authored pane refuses rather than placing another", function* () {
    let message = "";
    try {
      swapsInto([1, 2, 9], [1, 2, 3]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("pane 3 is not in this window");
  });
});
