/**
 * Observing what the REPL actually drew.
 *
 * Two things, and deliberately not a third. A **cell grid** that replays the
 * bytes a frame presented, so an assertion about the screen is an assertion
 * about the screen rather than about a list of descriptions. And a **driver**
 * that runs the production pipeline — the real `commitReplFrame`, the real
 * renderer, one real Freedom tree — so what a test observes is what the product
 * does.
 *
 * It is not a layout calculator. Nothing here computes a cell coordinate, a
 * capacity or a rectangle: every number a test asserts against comes from the
 * committed frame's own published geometry or from the grid the frame painted.
 * A helper that worked out where a row *ought* to be would pass while the
 * product drew it somewhere else, which is the whole defect this boundary
 * exists to make impossible.
 */

import { type Operation, resource } from "effection";
import type { Result } from "effection";

import { commitReplFrame, prepareFrame } from "../../../src/repl/program.ts";
import type { ReplCommitted } from "../../../src/repl/program.ts";
import { useReplRenderer } from "../../../src/repl/renderer.ts";
import type { ReplRenderer, ReplTarget } from "../../../src/repl/renderer.ts";
import type { ReplBounds } from "../../../src/repl/layout.ts";
import { NOTHING_ADMITTED } from "../../../src/repl/layout-admission.ts";
import type { ReplAdmission, ReplWindow } from "../../../src/repl/layout-admission.ts";
import { useReplTree } from "../../../src/repl/reconcile.ts";
import type { ReplTree } from "../../../src/repl/reconcile.ts";
import type { ReplAction } from "../../../src/repl/components/actions.ts";
import type { ReplPresentationContext, ReplView } from "../../../src/repl/application.ts";
import type { ReplTerminalSize } from "../../../src/repl/terminal.ts";
import { usedRows, useTerminalScreen } from "../../support/terminal-screen.ts";
import type { CellStyle } from "../../support/terminal-screen.ts";

export type { CellStyle };

/**
 * A terminal's cells, as the bytes written to it leave them.
 *
 * One emulated screen at the frame's size, persisting across frames on purpose:
 * this renderer writes diffs, and a cell a later frame leaves blank is the
 * evidence that the text which used to be there was actually erased — which
 * only exists if the frame before it is still on the screen. Every cell keeps
 * the colour, background and attributes it was written under.
 */
export interface TerminalGrid {
  /** Apply one presentation's bytes to the screen. */
  apply(bytes: Uint8Array): void;
  /** The screen is now this size, as a terminal is when its window changes. */
  resize(size: ReplTerminalSize): void;
  readonly size: ReplTerminalSize;
  /** Every row down to the last one anything is written on. */
  rows(): readonly string[];
  /** One cell, or a space where nothing is drawn. */
  at(column: number, row: number): string;
  /** The rows of one rectangle, each exactly as wide as the rectangle. */
  textIn(bounds: ReplBounds): readonly string[];
  /** Whether every cell of one rectangle is blank. */
  blank(bounds: ReplBounds): boolean;
  /** Every cell of one rectangle that is not blank, as `column,row=character`. */
  nonblank(bounds: ReplBounds): readonly string[];
  /** What one cell was drawn with, or the terminal's default where nothing was. */
  styleAt(column: number, row: number): CellStyle;
  /**
   * Every cell of one rectangle as `character|foreground|background|attrs`, row
   * by row.
   *
   * Blank cells included: a background painted across a row the text no longer
   * fills, and a cell a shortened row left behind, are both only visible here.
   */
  styledIn(bounds: ReplBounds): readonly string[];
}

/** A grid of this size, released with the scope that asked for it. */
export function* useGrid(size: ReplTerminalSize): Operation<TerminalGrid> {
  const screen = yield* useTerminalScreen(size);
  const grid: TerminalGrid = {
    apply(bytes) {
      screen.feed(bytes);
    },
    resize(next) {
      if (next.columns !== screen.size.columns || next.rows !== screen.size.rows) {
        screen.resize(next);
      }
    },
    get size() {
      return screen.size;
    },
    rows() {
      return usedRows(screen.rows());
    },
    at(x, y) {
      return screen.at(x, y);
    },
    textIn(bounds) {
      const lines: string[] = [];
      for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
        let line = "";
        for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
          line += screen.at(x, y);
        }
        lines.push(line);
      }
      return lines;
    },
    blank(bounds) {
      return grid.nonblank(bounds).length === 0;
    },
    nonblank(bounds) {
      const found: string[] = [];
      for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
        for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
          const character = screen.at(x, y);
          if (character !== " ") {
            found.push(`${x},${y}=${character}`);
          }
        }
      }
      return found;
    },
    styleAt(x, y) {
      return screen.styleAt(x, y);
    },
    styledIn(bounds) {
      const lines: string[] = [];
      for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
        const line: string[] = [];
        for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
          line.push(`${screen.at(x, y)}|${described(screen.styleAt(x, y))}`);
        }
        lines.push(line.join(" "));
      }
      return lines;
    },
  };
  return grid;
}

function described(style: CellStyle): string {
  const colour = (value: number | undefined): string =>
    value === undefined ? "-" : value.toString(16).padStart(6, "0");
  return `${colour(style.foreground)}|${colour(style.background)}|${style.attrs.join(",")}`;
}

/** One frame this driver committed, with everything a test may read back. */
export interface Observed {
  readonly committed: ReplCommitted;
  /** The live nodes this frame mounted. */
  readonly mounted: readonly string[];
  /** The description keys this frame mounted. */
  readonly keys: readonly string[];
  /** Every published pointer target. */
  readonly targets: readonly ReplTarget[];
  /** The cell each mounted node contributed, by description key. */
  readonly cells: ReadonlyMap<string, string>;
  /** The live node one description key mounted, or none. */
  nodeOf(key: string): string | undefined;
  /** Where one mounted key's cell was actually drawn, or none. */
  boundsOf(key: string): ReplBounds | undefined;
  /** Where one region or viewport landed, by its structural id. */
  regionOf(id: string): ReplBounds | undefined;
}

/** The production pipeline, driven one frame at a time. */
export interface Presenter {
  /** Measure, admit, reconcile, draw and paint one view into the grid. */
  commit(
    view: ReplView,
    pointer?: { readonly x: number; readonly y: number; readonly down: boolean },
  ): Operation<Observed>;
  /** Measure and admit only: nothing is mounted, drawn, published or painted. */
  prepare(view: ReplView): Operation<ReplAdmission>;
  /** The grid every committed frame has painted into. */
  readonly grid: TerminalGrid;
  readonly renderer: ReplRenderer;
  readonly tree: ReplTree<ReplAction>;
  /** The last frame committed, or none. */
  last(): Observed | undefined;
  resize(size: ReplTerminalSize): void;
}

/**
 * Drive the production pipeline against one real tree and one real engine pair.
 *
 * The bytes a committed frame produces are applied to the grid here, which is
 * what the screen's own `present` does with them — so the grid holds exactly
 * what a person would be looking at.
 */
export function usePresenter(size: ReplTerminalSize): Operation<Presenter> {
  return resource(function* (provide) {
    const renderer = yield* useReplRenderer(size);
    const tree = yield* useReplTree<ReplAction>();
    const grid = yield* useGrid(size);
    let observed: Observed | undefined;

    const presenter: Presenter = {
      *commit(view, pointer) {
        const committed = yield* commitReplFrame(tree, renderer, view, 0, pointer);
        if (!committed.ok) {
          throw committed.error;
        }
        grid.apply(committed.value.rendered.output);
        const mounted = tree.mounted();
        const cells = new Map<string, string>();
        for (const cell of tree.frame().cells) {
          const key = tree.keyOf(cell.node);
          if (key !== undefined) {
            cells.set(key, cell.cell);
          }
        }
        const byKey = new Map<string, string>();
        for (const node of mounted) {
          const key = tree.keyOf(node);
          if (key !== undefined) {
            byKey.set(key, node);
          }
        }
        const { map } = committed.value.rendered;
        observed = {
          committed: committed.value,
          mounted: Object.freeze([...mounted]),
          keys: Object.freeze([...byKey.keys()]),
          targets: map.targets,
          cells,
          nodeOf(key) {
            return byKey.get(key);
          },
          boundsOf(key) {
            const node = byKey.get(key);
            if (node === undefined) {
              return undefined;
            }
            // A control's geometry is in the target map; every other drawn row's
            // is published beside it, because where a line landed and whether it
            // can be activated are two different questions.
            return map.boundsOf(node) ?? map.regionOf(node);
          },
          regionOf(id) {
            return map.regionOf(id);
          },
        };
        return observed;
      },
      *prepare(view) {
        const prepared: Result<{ readonly admission: ReplAdmission }> = yield* prepareFrame(
          renderer,
          view,
        );
        if (!prepared.ok) {
          throw prepared.error;
        }
        return prepared.value.admission;
      },
      grid,
      renderer,
      tree,
      last() {
        return observed;
      },
      resize(next) {
        renderer.resize(next);
        grid.resize(next);
      },
    };
    yield* provide(presenter);
  });
}

/** The window one reading was given, or a failure naming which is missing. */
export function windowOf(admission: ReplAdmission, name: string): ReplWindow {
  const held = admission.windows.get(name);
  if (held === undefined) {
    throw new Error(
      `this frame measured no ${name} window; it measured ${
        [...admission.windows.keys()].join(", ") || "none"
      }`,
    );
  }
  return held;
}

/**
 * The context one view's frame settles on, measured with a real engine.
 *
 * The production preparation, run for its answer: the widths it measured, the
 * windows it admitted and the controls the row held whole. A test that wants the
 * descriptions a state really produces asks with this, because the rows inside a
 * window are exactly the rows the measurement left room for.
 */
export function* committedContext(
  renderer: ReplRenderer,
  view: ReplView,
): Operation<ReplPresentationContext> {
  const prepared = yield* prepareFrame(renderer, view);
  if (!prepared.ok) {
    throw prepared.error;
  }
  return prepared.value.context;
}

/**
 * One renderer a suite can measure with, without committing anything.
 *
 * For the tests that ask what a view describes rather than what a terminal
 * shows. It owns the engine pair, so the measurement is the product's own.
 */
export function useMeasuringRenderer(size: ReplTerminalSize): Operation<ReplRenderer> {
  return useReplRenderer(size);
}

/** A renderer that answers exactly as the real one does, and says what it was asked. */
export interface ReplCountingRenderer extends ReplRenderer {
  /** How many measurement renders have been asked for since the last reset. */
  measures(): number;
  /** How many texts those renders carried, which is the work inside them. */
  texts(): number;
  /** How many frames have been committed since the last reset. */
  draws(): number;
  /** Start counting again from here, after whatever warmup a case needs. */
  reset(): void;
}

/**
 * Count what a frame actually asks the engine for.
 *
 * The oracle for work, rather than a flag saying work was skipped: a cache
 * that reports a hit while measuring anyway is a cache that proves nothing,
 * and a count cannot be satisfied by an intention. Every member delegates, so
 * what is measured, drawn and reported is the product's own answer.
 */
export function* useCountingRenderer(size: ReplTerminalSize): Operation<ReplCountingRenderer> {
  const renderer = yield* useReplRenderer(size);
  let measures = 0;
  let texts = 0;
  let draws = 0;
  return {
    *measure(ops, measured) {
      measures += 1;
      // Each `text` op is one string the engine has to lay out. It is the unit
      // the expensive paths differ in: a binary search over one long line and a
      // batch over fifty short ones are both one render.
      texts += ops.filter((op) => "content" in op && typeof op.content === "string").length;
      return yield* renderer.measure(ops, measured);
    },
    *draw(input) {
      draws += 1;
      return yield* renderer.draw(input);
    },
    resize: (next) => renderer.resize(next),
    last: () => renderer.last(),
    engines: () => renderer.engines(),
    measures: () => measures,
    texts: () => texts,
    draws: () => draws,
    reset() {
      measures = 0;
      texts = 0;
      draws = 0;
    },
  };
}

/**
 * A measuring context, for a test asking what a view *offers* rather than what
 * one frame admitted.
 *
 * The measuring pass is the one that describes every candidate: every scrolling
 * viewport empty and every action control present, because what each one costs
 * is the question that pass exists to ask. A test that wants the set of rows a
 * view would offer at a size — rather than the subset one measured frame kept —
 * asks with this.
 */
export function measuringContext(size: ReplTerminalSize): ReplPresentationContext {
  return {
    widths: {
      surface: size.columns,
      list: size.columns,
      inspection: size.columns,
      // The inset bodies, which this pass has measured no gutter for: a
      // measuring context states the terminal's own width everywhere, and what
      // each column's body actually came out at is what the frame answers.
      surfaceBody: size.columns,
      listBody: size.columns,
      body: size.columns,
      drawer: size.columns,
    },
    admission: NOTHING_ADMITTED,
    measuring: true,
    entriesWindowed: false,
    entriesRows: undefined,
    capture: "capture",
    // The measuring pass has no fitted reading, preview or chat, which is what
    // makes it the pass that asks how wide the panes holding them are.
    reading: undefined,
    preview: undefined,
    chat: undefined,
    // One blank value row: the composer's minimum, which is what a pass that
    // has measured nothing describes.
    message: Object.freeze([""]),
    // One blank guidance row, which is the geometry this pass asks about.
    guidance: Object.freeze([""]),
    refusal: undefined,
    rail: undefined,
    // No settled drawer envelope: this pass has fitted no guidance for one to
    // be clear of, so a route drawer takes the rectangle its size states.
    drawer: undefined,
  };
}

/** Where one named region landed, read from the committed frame. */
export function regionBounds(observed: Observed, region: string): ReplBounds | undefined {
  const placed = observed.committed.manifest.regions.find((one) => one.region === region);
  return placed === undefined ? undefined : observed.regionOf(placed.id);
}

/** Where one window's viewport landed, read from the committed frame. */
export function viewportBounds(observed: Observed, window: string): ReplBounds | undefined {
  const slot = observed.committed.manifest.viewports.find((one) => one.window === window);
  return slot === undefined ? undefined : observed.regionOf(slot.id);
}
