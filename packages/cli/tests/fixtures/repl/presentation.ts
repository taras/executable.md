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
import type {
  ReplDrawnBox,
  ReplRendered,
  ReplRenderer,
  ReplTarget,
} from "../../../src/repl/renderer.ts";
import { committedOps, flatten, skeletonOps } from "../../../src/repl/layout.ts";
import type { ReplBounds, ReplLayoutManifest } from "../../../src/repl/layout.ts";
import {
  admitActions,
  admitRows,
  capacityOf,
  NOTHING_ADMITTED,
} from "../../../src/repl/layout-admission.ts";
import type { ReplAdmission, ReplWindow } from "../../../src/repl/layout-admission.ts";
import { useReplTree } from "../../../src/repl/reconcile.ts";
import type { ReplTree } from "../../../src/repl/reconcile.ts";
import type { ReplDescription } from "../../../src/repl/description.ts";
import type { ReplAction } from "../../../src/repl/components/actions.ts";
import type { ReplPresentationContext, ReplView } from "../../../src/repl/application.ts";
import type { ReplTerminalSize } from "../../../src/repl/terminal.ts";

const TEXT = new TextDecoder();

/**
 * What one cell was drawn with, as the terminal was told.
 *
 * `foreground` and `background` are 24-bit, the way the palette states them and
 * the way the renderer's own truecolor SGR reports them, so what came out of a
 * cell is comparable with what was asked for without either side re-deriving the
 * other. `attrs` holds the SGR attribute parameters that were in force — `1` for
 * bold — in ascending order. `undefined` is the terminal's own default, which is
 * what a cell nothing coloured keeps.
 */
export interface CellStyle {
  readonly foreground: number | undefined;
  readonly background: number | undefined;
  readonly attrs: readonly number[];
}

const DEFAULT_STYLE: CellStyle = Object.freeze({
  foreground: undefined,
  background: undefined,
  attrs: Object.freeze([]),
});

/**
 * A terminal's cells, as the bytes written to it leave them.
 *
 * A real buffer rather than the bytes with escapes stripped, because this
 * renderer writes *diffs*: it moves the cursor to what changed and writes only
 * that. Concatenating the diffs gives characters in the order they were written
 * rather than the order they appear, and a character the previous frame already
 * had is not written again at all — so stripped bytes read as words with letters
 * missing. Interpreting the cursor moves is what makes this a screen.
 *
 * It persists across frames on purpose. A cell a later frame leaves blank is the
 * evidence that the text which used to be there was actually erased, and that
 * evidence only exists if the frame before it is still in the buffer.
 *
 * Every cell keeps the colour, background and attributes it was written under as
 * well as its character, because an assertion that a row is a failure is an
 * assertion about those cells. The same escapes carry both: the renderer sets the
 * attributes and then moves the cursor, so a cell's style is whatever was in
 * force at the moment the character landed in it — which is why a grid that only
 * skipped the escapes could find a colour somewhere in the stream and prove
 * nothing about where it was used.
 */
export interface TerminalGrid {
  /** Replay one presentation's bytes into the grid. */
  apply(bytes: Uint8Array): void;
  /** Every row written so far, in order. */
  rows(): readonly string[];
  /** One cell, or a space where nothing has ever been written. */
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

export function createGrid(): TerminalGrid {
  const cells: string[][] = [];
  const styles: CellStyle[][] = [];
  let row = 0;
  let column = 0;
  let current: CellStyle = DEFAULT_STYLE;

  const put = (character: string): void => {
    while (cells.length <= row) {
      cells.push([]);
      styles.push([]);
    }
    const line = cells[row];
    const styled = styles[row];
    while (line.length < column) {
      line.push(" ");
      styled.push(DEFAULT_STYLE);
    }
    line[column] = character;
    styled[column] = current;
    column += 1;
  };

  const read = (x: number, y: number): string => cells[y]?.[x] ?? " ";
  const readStyle = (x: number, y: number): CellStyle => styles[y]?.[x] ?? DEFAULT_STYLE;

  /** The style one `m` sequence leaves in force, applied to what is already. */
  const select = (parameters: readonly number[]): void => {
    let foreground = current.foreground;
    let background = current.background;
    const attrs = new Set(current.attrs);
    for (let at = 0; at < parameters.length; at += 1) {
      const parameter = parameters[at];
      if (parameter === 0) {
        foreground = undefined;
        background = undefined;
        attrs.clear();
        continue;
      }
      // Truecolor, which is the only form this renderer emits: `38;2;r;g;b` for
      // the foreground and `48;2;r;g;b` for the background.
      if ((parameter === 38 || parameter === 48) && parameters[at + 1] === 2) {
        const packed =
          ((parameters[at + 2] ?? 0) << 16) |
          ((parameters[at + 3] ?? 0) << 8) |
          (parameters[at + 4] ?? 0);
        if (parameter === 38) {
          foreground = packed;
        } else {
          background = packed;
        }
        at += 4;
        continue;
      }
      if (parameter === 39) {
        foreground = undefined;
        continue;
      }
      if (parameter === 49) {
        background = undefined;
        continue;
      }
      if (parameter >= 1 && parameter <= 9) {
        attrs.add(parameter);
        continue;
      }
      // `2x` turns off the attribute `x` switched on, except 20 and 21.
      if (parameter >= 22 && parameter <= 29) {
        attrs.delete(parameter - 20);
      }
    }
    current = Object.freeze({
      foreground,
      background,
      attrs: Object.freeze([...attrs].sort((left, right) => left - right)),
    });
  };

  return {
    apply(bytes) {
      const written = TEXT.decode(bytes);
      for (let index = 0; index < written.length; index += 1) {
        const character = written[index];
        if (character !== "\u001B") {
          if (character === "\n") {
            row += 1;
            column = 0;
          } else if (character === "\r") {
            column = 0;
          } else {
            put(character);
          }
          continue;
        }
        // CSI: positioning, clearing and the attributes a cell is written under.
        const csi = /^\u001B\[([0-9;]*)([@-~])/.exec(written.slice(index));
        if (csi !== null) {
          const parameters = csi[1].split(";").map((one) => (one === "" ? 0 : Number(one)));
          if (csi[2] === "H") {
            row = Math.max(0, (parameters[0] ?? 1) - 1);
            column = Math.max(0, (parameters[1] ?? 1) - 1);
          } else if (csi[2] === "J") {
            cells.length = 0;
            styles.length = 0;
            row = 0;
            column = 0;
          } else if (csi[2] === "m") {
            select(parameters);
          }
          index += csi[0].length - 1;
          continue;
        }
        // OSC, and the two-byte escapes. Neither carries anything readable.
        const osc = /^\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/.exec(written.slice(index));
        if (osc !== null) {
          index += osc[0].length - 1;
          continue;
        }
        index += 1;
      }
    },
    rows() {
      return cells.map((line) => line.join(""));
    },
    at(x, y) {
      return read(x, y);
    },
    textIn(bounds) {
      const lines: string[] = [];
      for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
        let line = "";
        for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
          line += read(x, y);
        }
        lines.push(line);
      }
      return lines;
    },
    blank(bounds) {
      return this.nonblank(bounds).length === 0;
    },
    nonblank(bounds) {
      const found: string[] = [];
      for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
        for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
          const character = read(x, y);
          if (character !== " ") {
            found.push(`${x},${y}=${character}`);
          }
        }
      }
      return found;
    },
    styleAt(x, y) {
      return readStyle(x, y);
    },
    styledIn(bounds) {
      const lines: string[] = [];
      for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
        const line: string[] = [];
        for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
          line.push(`${read(x, y)}|${described(readStyle(x, y))}`);
        }
        lines.push(line.join(" "));
      }
      return lines;
    },
  };
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
    const grid = createGrid();
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
      },
    };
    yield* provide(presenter);
  });
}

/**
 * What a pair builder is told about one pass.
 *
 * The same shape the production boundary receives: whether this is the pass that
 * measures, and what the pass before it admitted. A builder that ignored
 * `measuring` and described its rows anyway would be measuring the rows instead
 * of the region, which is the defect the whole pipeline exists to remove.
 */
export interface Pass {
  readonly measuring: boolean;
  readonly admission: ReplAdmission;
}

/** A screen that can describe itself and say where its parts go. */
export interface PairBuilder<T> {
  build(pass: Pass): {
    readonly descriptions: readonly ReplDescription<T>[];
    readonly manifest: ReplLayoutManifest;
  };
  /** How many rows one window's whole reading holds. */
  total(window: string): number;
  /** How far one window is scrolled, as the screen is holding it. */
  offset(window: string): number;
}

/** One frame a pair builder committed. */
export interface Drawn<T> {
  readonly rendered: ReplRendered;
  readonly manifest: ReplLayoutManifest;
  readonly admission: ReplAdmission;
  readonly mounted: readonly string[];
  /**
   * The keys this frame **placed**, in placement order.
   *
   * Placed, not merely mounted: a description whose box the manifest left out
   * contributes no cell and no target, and the whole point of asking is to tell
   * those two states apart.
   */
  readonly keys: readonly string[];
  readonly targets: readonly ReplTarget[];
  nodeOf(key: string): string | undefined;
  keyOf(node: string): string | undefined;
  cellOf(key: string): string | undefined;
  boundsOf(key: string): ReplBounds | undefined;
  regionOf(id: string): ReplBounds | undefined;
  /** The keys this frame placed in one region, in placement order. */
  inRegion(region: string): readonly string[];
  /** Where one named region landed, read from the committed frame. */
  boundsOfRegion(region: string): ReplBounds | undefined;
  /** Every region this frame placed, in placement order. */
  readonly regions: readonly string[];
  tree: ReplTree<T>;
}

/** Drives any paired screen through measure, admit, reconcile and draw. */
export interface Committer<T> {
  commit(pointer?: {
    readonly x: number;
    readonly y: number;
    readonly down: boolean;
  }): Operation<Drawn<T>>;
  /** Measure and admit only. Mounts nothing, draws nothing, paints nothing. */
  measure(): Operation<ReplAdmission>;
  readonly grid: TerminalGrid;
  last(): Drawn<T> | undefined;
}

/**
 * Drive one paired screen the way the product drives its own.
 *
 * Measure the skeleton on the measuring engine, admit rows and whole controls
 * from what it measured, reconcile exactly that, then draw it. The steps and
 * their order are the product's; what differs is only which screen is being
 * described, which is what makes this usable for a fixture screen and for the
 * application alike.
 */
export function useCommitter<T>(options: {
  readonly size: ReplTerminalSize;
  readonly tree: ReplTree<T>;
  readonly renderer: ReplRenderer;
  readonly source: PairBuilder<T>;
  readonly grid?: TerminalGrid;
}): Operation<Committer<T>> {
  return resource(function* (provide) {
    const { tree, renderer, source } = options;
    const grid = options.grid ?? createGrid();
    let drawn: Drawn<T> | undefined;

    function* admit(): Operation<{ admission: ReplAdmission; manifest: ReplLayoutManifest }> {
      const skeleton = source.build({ measuring: true, admission: NOTHING_ADMITTED });
      const measured = yield* renderer.measure(
        skeletonOps(skeleton.manifest.root),
        skeleton.manifest.size,
      );
      if (!measured.ok) {
        throw measured.error;
      }
      const windows = new Map<string, ReplWindow>();
      for (const slot of skeleton.manifest.viewports) {
        windows.set(
          slot.window,
          admitRows({
            offset: source.offset(slot.window),
            total: source.total(slot.window),
            capacity: capacityOf(measured.value.boundsOf(slot.id)),
          }),
        );
      }
      const actions = skeleton.manifest.actions;
      const row =
        actions === undefined
          ? { admitted: new Set<string>(), shortened: undefined }
          : admitActions({
              row: measured.value.boundsOf(actions.id),
              controls: actions.controls,
              boundsOf: (id: string) => measured.value.boundsOf(id),
            });
      const admission: ReplAdmission = Object.freeze({
        windows,
        actions: row.admitted,
        shortened: row.shortened,
      });
      return { admission, manifest: skeleton.manifest };
    }

    yield* provide({
      *measure() {
        return (yield* admit()).admission;
      },
      *commit(pointer) {
        const { admission } = yield* admit();
        const wanted = source.build({ measuring: false, admission });
        const applied = yield* tree.apply(wanted.descriptions);
        if (!applied.ok) {
          throw applied.error;
        }
        const mounted = new Set(tree.mounted());
        const nodeByKey = new Map<string, string>();
        const keyByNode = new Map<string, string>();
        for (const node of mounted) {
          const key = tree.keyOf(node);
          if (key !== undefined) {
            nodeByKey.set(key, node);
            keyByNode.set(node, key);
          }
        }
        const cells = new Map<string, string>();
        const cellByKey = new Map<string, string>();
        for (const cell of tree.frame().cells) {
          cells.set(cell.node, cell.cell);
          const key = keyByNode.get(cell.node);
          if (key !== undefined) {
            cellByKey.set(key, cell.cell);
          }
        }
        const root = wanted.manifest.root;
        const boxes: ReplDrawnBox[] = [];
        const placed: Array<{ key: string; region: string | undefined }> = [];
        for (const box of flatten(root)) {
          if (box.key === undefined) {
            continue;
          }
          const node = nodeByKey.get(box.key);
          if (node === undefined || !mounted.has(node)) {
            continue;
          }
          boxes.push({ id: node, node, control: box.control });
          placed.push({ key: box.key, region: box.region });
        }
        const result = yield* renderer.draw({
          ops: committedOps(root, nodeByKey, mounted, cells, tree.focused()),
          boxes,
          // Every structural box the manifest placed, so where each region, each
          // viewport and each band row landed travels with the frame.
          regions: flatten(root)
            .filter((one) => one.key === undefined)
            .map((one) => one.id),
          tree: tree.frame().id,
          size: wanted.manifest.size,
          deltaTime: 0,
          pointer,
        });
        if (!result.ok) {
          throw result.error;
        }
        grid.apply(result.value.output);
        const { map } = result.value;
        drawn = {
          rendered: result.value,
          manifest: wanted.manifest,
          admission,
          mounted: Object.freeze([...mounted]),
          keys: Object.freeze(placed.map((one) => one.key)),
          targets: map.targets,
          nodeOf: (key: string) => nodeByKey.get(key),
          keyOf: (node: string) => keyByNode.get(node),
          cellOf: (key: string) => cellByKey.get(key),
          boundsOf(key: string) {
            const node = nodeByKey.get(key);
            if (node === undefined) {
              return undefined;
            }
            // A control's geometry is in the target map; every other drawn row's
            // is published beside it.
            return map.boundsOf(node) ?? map.regionOf(node);
          },
          regionOf: (id: string) => map.regionOf(id),
          inRegion: (region: string) =>
            placed.filter((one) => one.region === region).map((one) => one.key),
          boundsOfRegion(region: string) {
            const found = wanted.manifest.regions.find((one) => one.region === region);
            return found === undefined ? undefined : map.regionOf(found.id);
          },
          regions: Object.freeze(wanted.manifest.regions.map((one) => one.region)),
          tree,
        };
        return drawn;
      },
      grid,
      last() {
        return drawn;
      },
    });
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
      drawer: size.columns,
    },
    admission: NOTHING_ADMITTED,
    measuring: true,
    entriesWindowed: false,
    entriesRows: undefined,
    capture: "capture",
    // The measuring pass has no fitted reading or preview, which is what makes
    // it the pass that asks how wide the panes holding them are.
    reading: undefined,
    preview: undefined,
    rail: undefined,
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
