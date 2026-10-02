/**
 * Drawing one decided frame, and answering where things ended up.
 *
 * The renderer is the only thing that talks to `@bomb.sh/tty`'s layout engine,
 * and it does two jobs: it turns a laid-out frame into terminal bytes, and it
 * reports the geometry that came back so a pointer landing at a column and row
 * can be answered with **the exact live node** that occupies it. It never
 * invents a node: every target it publishes came from a cell that named one,
 * and a cell whose node is not currently mounted is not drawn at all.
 *
 * ## Why a snapshot
 *
 * Every render input is retained as a frozen snapshot, because the layout
 * engine has fixed arenas and can refuse a frame that is too large for them.
 * Recovering from that means throwing the engine away and building a new one at
 * the dimensions the frame was laid out for — those arenas are sized from the
 * terminal's width and height, so a frame that overflows an engine built for a
 * smaller terminal fits one built for this frame's own size. Then the same
 * logical frame is drawn again. Without the snapshot, "the same frame" would
 * have to be reassembled from live state that may already have moved on, and a
 * recovery would quietly change what the user is looking at. With it, recovery
 * is invisible: the same selection, the same focus, the same actions, the same
 * frame map.
 *
 * Output bytes are copied out of the engine's memory the moment they arrive.
 * `render()` hands back a view into WASM memory that the next render
 * invalidates, so anything held past that call has to own its bytes.
 */

import { Err, Ok, type Operation, resource, type Result, until } from "effection";
import { close, createTerm, fixed, type Op, open, type PointerEvent, text } from "@bomb.sh/tty";
import type { Term } from "@bomb.sh/tty";
import type { ReplInputEvent } from "./description.ts";
import type { ReplBounds, ReplPlacedCell, ReplSemanticFrame } from "./layout.ts";

/** The layout-engine failures that a bigger arena would fix. */
const CAPACITY = new Set([
  "ARENA_CAPACITY_EXCEEDED",
  "ELEMENTS_CAPACITY_EXCEEDED",
  "TEXT_MEASUREMENT_CAPACITY_EXCEEDED",
]);

/** A render that could not be completed. */
export class ReplRenderError extends Error {
  override name = "ReplRenderError";
}

/** Everything one render needs, frozen so a recovery can repeat it exactly. */
export interface ReplRenderSnapshot {
  /** Where everything goes. */
  readonly frame: ReplSemanticFrame;
  /** The Slice C frame id this was laid out from, carried for identity. */
  readonly tree: number;
  /** Every currently mounted node id. A cell naming anything else is dropped. */
  readonly mounted: readonly string[];
  /** Seconds since the last frame, for the engine's transitions. */
  readonly deltaTime: number;
  /** The pointer position and button state, when there is one. */
  readonly pointer: { readonly x: number; readonly y: number; readonly down: boolean } | undefined;
}

/** One drawn element and the live node behind it. */
export interface ReplTarget {
  /** The element id the engine measured. */
  readonly id: string;
  /** The live node. Never fabricated. */
  readonly node: string;
  readonly bounds: ReplBounds;
}

/** Where everything landed. Immutable, and retained with its frame. */
export interface ReplFrameMap {
  /** In draw order, so a later entry is drawn over an earlier one. */
  readonly targets: readonly ReplTarget[];
  /** The live node at one position, topmost first, or none. */
  at(x: number, y: number): string | undefined;
  /** The geometry one element id was given, or none if it was not drawn. */
  boundsOf(id: string): ReplBounds | undefined;
  /** The live node one element id belongs to. */
  nodeOf(id: string): string | undefined;
}

/** What one render produced. */
export interface ReplRendered {
  /** The Slice C frame id that was drawn. */
  readonly tree: number;
  /** Bytes this result owns. Safe to hold. */
  readonly output: Uint8Array;
  readonly map: ReplFrameMap;
  readonly pointers: readonly PointerEvent[];
  readonly animating: boolean;
  /** Whether the engine had to be rebuilt to fit this frame. */
  readonly recovered: boolean;
}

/** The renderer, for as long as its scope lives. */
export interface ReplRenderer {
  /** Draw one snapshot. */
  render(snapshot: ReplRenderSnapshot): Operation<Result<ReplRendered>>;
  /** Tell the engine the terminal changed size. */
  resize(size: { readonly columns: number; readonly rows: number }): void;
  /** The last snapshot drawn, for a caller that wants to redraw it verbatim. */
  last(): ReplRenderSnapshot | undefined;
}

/** Freeze one render input so repeating it cannot depend on anything mutable. */
export function snapshotRender(input: ReplRenderSnapshot): ReplRenderSnapshot {
  return Object.freeze({
    frame: input.frame,
    tree: input.tree,
    mounted: Object.freeze([...input.mounted]),
    deltaTime: input.deltaTime,
    pointer: input.pointer === undefined ? undefined : Object.freeze({ ...input.pointer }),
  });
}

/**
 * Build a renderer owned by the calling scope.
 *
 * The engine is a WASM instance, so it is a resource: one per renderer, torn
 * down with the scope that asked for it, and replaced in place when a frame
 * overflows its arenas.
 */
export function useReplRenderer(size: {
  readonly columns: number;
  readonly rows: number;
}): Operation<ReplRenderer> {
  return resource(function* (provide) {
    let term = yield* until(createTerm({ width: size.columns, height: size.rows }));
    let retained: ReplRenderSnapshot | undefined;

    function* rebuild(frame: ReplSemanticFrame): Operation<void> {
      // Sized for the frame in hand, which is the terminal's current size: the
      // engine's measurement arenas scale with width and height, so an engine
      // built when the terminal was smaller is exactly the one that overflows.
      term = yield* until(createTerm({ width: frame.size.columns, height: frame.size.rows }));
    }

    yield* provide({
      *render(snapshot) {
        let frozen = snapshotRender(snapshot);
        retained = frozen;
        let ops = opsFor(frozen);

        let first = attempt(term, ops, frozen);
        if (first.kind === "drawn") {
          return Ok({ ...first.rendered, recovered: false });
        }
        if (!first.capacity) {
          return Err(new ReplRenderError(first.reason));
        }

        yield* rebuild(frozen.frame);
        let second = attempt(term, ops, frozen);
        if (second.kind === "drawn") {
          return Ok({ ...second.rendered, recovered: true });
        }
        return Err(
          new ReplRenderError(
            `the frame does not fit the layout engine even after rebuilding it: ${second.reason}`,
          ),
        );
      },
      resize(next) {
        term.update({ width: next.columns, height: next.rows });
      },
      last() {
        return retained;
      },
    });
  });
}

/**
 * What one pass at the engine did.
 *
 * Not a `Result`: the caller has to tell a refusal a bigger engine would fix
 * from one it would not, and that is a second question about the same failure
 * rather than a different outcome.
 */
type Attempted =
  | { readonly kind: "drawn"; readonly rendered: Omit<ReplRendered, "recovered"> }
  | { readonly kind: "refused"; readonly capacity: boolean; readonly reason: string };

/** One pass at the engine, classifying whatever came back. */
function attempt(term: Term, ops: Op[], snapshot: ReplRenderSnapshot): Attempted {
  let result;
  try {
    result = term.render(ops, {
      row: 1,
      deltaTime: snapshot.deltaTime,
      ...(snapshot.pointer === undefined ? {} : { pointer: { ...snapshot.pointer } }),
    });
  } catch (error) {
    // `pack` throws rather than reporting when the ops themselves outgrow the
    // transfer buffer, which is the same problem a bigger engine solves.
    let reason = error instanceof Error ? error.message : String(error);
    return { kind: "refused", capacity: error instanceof RangeError, reason };
  }

  let capacity = result.errors.filter((error) => CAPACITY.has(error.type));
  if (capacity.length > 0) {
    return {
      kind: "refused",
      capacity: true,
      reason: capacity.map((error) => `${error.type}: ${error.message}`).join("; "),
    };
  }
  if (result.errors.length > 0) {
    return {
      kind: "refused",
      capacity: false,
      reason: result.errors.map((error) => `${error.type}: ${error.message}`).join("; "),
    };
  }

  return {
    kind: "drawn",
    rendered: {
      tree: snapshot.tree,
      // Copied now: this view points into the engine's memory and the next
      // render invalidates it.
      output: new Uint8Array(result.output),
      map: mapOf(snapshot, result.info),
      pointers: Object.freeze([...result.events]),
      animating: result.animating,
    },
  };
}

/** The cells of one frame that name a node the tree still has mounted. */
function drawn(snapshot: ReplRenderSnapshot): readonly ReplPlacedCell[] {
  let mounted = new Set(snapshot.mounted);
  return snapshot.frame.cells.filter((cell) => mounted.has(cell.node));
}

/** Turn one laid-out frame into engine ops. */
function opsFor(snapshot: ReplRenderSnapshot): Op[] {
  let { frame } = snapshot;
  let ops: Op[] = [
    open("repl", {
      layout: {
        width: fixed(frame.size.columns),
        height: fixed(frame.size.rows),
        direction: "ttb",
      },
    }),
  ];

  if (frame.refusal !== undefined) {
    ops.push(open("repl:refusal", { layout: { width: fixed(frame.size.columns) } }));
    ops.push(text(frame.refusal));
    ops.push(close());
    ops.push(close());
    return ops;
  }

  for (let cell of drawn(snapshot)) {
    ops.push(
      open(cell.id, {
        layout: { width: fixed(cell.bounds.width), height: fixed(cell.bounds.height) },
        floating: { x: cell.bounds.x, y: cell.bounds.y, attachTo: "root" },
      }),
    );
    ops.push(text(cell.text));
    ops.push(close());
  }

  // One floating element per band row, at the geometry layout decided. Five
  // `text` ops inside one element put all five on one line and, as the only
  // element in the tree without a position, that line landed at the terminal's
  // top-left corner — over the sidebar, where the band's text showed through from
  // where each sidebar row's own text stopped.
  let band = frame.historyBounds;
  if (band !== undefined) {
    for (let [row, line] of frame.historyRows.entries()) {
      if (row >= band.height) {
        continue;
      }
      ops.push(
        open(`repl:history:${row}`, {
          layout: { width: fixed(band.width), height: fixed(1) },
          floating: { x: band.x, y: band.y + row, attachTo: "root" },
        }),
      );
      ops.push(text(line));
      ops.push(close());
    }
  }

  ops.push(close());
  return ops;
}

/** The frame map: what the engine measured, paired with the node that asked. */
function mapOf(
  snapshot: ReplRenderSnapshot,
  info: {
    get(
      id: string,
    ): { bounds: { x: number; y: number; width: number; height: number } } | undefined;
  },
): ReplFrameMap {
  let targets: ReplTarget[] = [];
  for (let cell of drawn(snapshot)) {
    let measured = info.get(cell.id);
    if (measured === undefined) {
      // Not measured means not on screen, and something not on screen must not
      // be pointable: leaving it out is the whole point of the map.
      continue;
    }
    if (!cell.targetable) {
      continue;
    }
    targets.push(
      Object.freeze({
        id: cell.id,
        node: cell.node,
        bounds: Object.freeze({
          x: measured.bounds.x,
          y: measured.bounds.y,
          width: measured.bounds.width,
          height: measured.bounds.height,
        }),
      }),
    );
  }

  let frozen = Object.freeze(targets);
  let byId = new Map(frozen.map((target) => [target.id, target]));
  let map: ReplFrameMap = {
    targets: frozen,
    at(x, y) {
      // Back to front: the last thing drawn is the thing on top, which is how a
      // drawer keeps a pointer off the controls it covers.
      for (let index = frozen.length - 1; index >= 0; index -= 1) {
        let { bounds, node } = frozen[index];
        if (
          x >= bounds.x &&
          x < bounds.x + bounds.width &&
          y >= bounds.y &&
          y < bounds.y + bounds.height
        ) {
          return node;
        }
      }
      return undefined;
    },
    boundsOf(id) {
      return byId.get(id)?.bounds;
    },
    nodeOf(id) {
      return byId.get(id)?.node;
    },
  };
  return Object.freeze(map);
}

/** The pointer member of the normalized union, which is all this can produce. */
export type ReplPointerInput = Extract<ReplInputEvent, { readonly kind: "pointer" }>;

/**
 * Which node a pointer landed on, according to the frame it was resolved
 * against.
 *
 * The frame id travels with the answer, so a pointer resolved against a frame
 * the tree has moved past arrives at `dispatch` carrying that older number and
 * is dropped there. That is why this takes a whole render result rather than a
 * map: a map on its own could be paired with any frame id, and a pointer that
 * borrowed a current number would reach a node from a tree that no longer
 * exists.
 */
export function resolvePointer(
  rendered: ReplRendered,
  at: { readonly column: number; readonly row: number },
): ReplPointerInput | undefined {
  const target = rendered.map.at(at.column, at.row);
  if (target === undefined) {
    return undefined;
  }
  return { kind: "pointer", target, frame: rendered.tree };
}
