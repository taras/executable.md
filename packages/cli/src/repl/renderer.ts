/**
 * Asking the engine where things go, and drawing one committed frame.
 *
 * The renderer is the only thing that talks to `@bomb.sh/tty`, and it does two
 * jobs that must not be done by one instance. It **measures**: it renders a
 * structural skeleton to read back the geometry the engine gave each region, so
 * how many rows a viewport holds is the engine's answer rather than arithmetic
 * repeated here. And it **draws**: it commits one frame and reports the geometry
 * that came back, so a pointer landing at a column and row can be answered with
 * the exact live node that occupies it.
 *
 * ## Why two engines
 *
 * `Term.render()` diffs against the previous render **on that instance**,
 * whoever asked for it and whatever was done with the bytes. A render taken only
 * to read geometry back is still a render, so on a shared instance it becomes
 * the front buffer the next committed frame is compared against — and the
 * committed frame then emits only the difference from a frame nobody ever saw.
 * Measured: a Sessions reading filtered from twelve rows to two left the
 * thirteenth row still reading `conversation 11`, because the measurement
 * skeleton left that cell blank too and the diff therefore had nothing to say
 * about it.
 *
 * So there are exactly two instances, acquired once with the resource and reused
 * for every frame. Both are told the same size. Only the drawing instance owns
 * committed display state, and only a capacity refusal replaces an instance —
 * the one that refused, at the size the frame was laid out for.
 *
 * ## Why the geometry is copied
 *
 * `render()` hands back a view into WASM memory and an `info` the next render
 * invalidates. Everything a caller may hold — bytes, bounds, the whole target
 * map — is copied out the moment it arrives, so an older frame's answers stay
 * the answers it gave.
 */

import { Err, Ok, type Operation, resource, type Result, until } from "effection";
import { createTerm, type Op, type PointerEvent, type Term } from "@bomb.sh/tty";
import type { ReplInputEvent } from "./description.ts";
import type { ReplBounds } from "./layout.ts";
import type { ReplTerminalSize } from "./terminal.ts";

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

/** What one measurement answered. Geometry, and nothing that can be drawn. */
export interface ReplMeasured {
  /**
   * The geometry one structural id was given, or none if the engine gave it
   * none.
   *
   * Reported as the engine reported it, fractions included. A caller that turns
   * one of these into a target has to refuse a fractional bound rather than
   * round it, which is what `draw()` does: rounding would name a row that is not
   * a row.
   */
  boundsOf(id: string): ReplBounds | undefined;
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
  /**
   * The geometry one region or viewport was given, or none.
   *
   * Separate from `boundsOf`, which answers for targets: a region is placed and
   * measured but never activated, so publishing it among the targets would make
   * the whole sidebar a hit box.
   */
  regionOf(id: string): ReplBounds | undefined;
}

/**
 * One box the committed frame may publish a target for.
 *
 * Membership is the claim: a target exists because an admitted box mounted a
 * live node and that node is a control. Bounds alone cannot establish it — the
 * engine reports a clipped child's full rectangle, so geometry says nothing
 * about whether anything was painted.
 */
export interface ReplDrawnBox {
  /** The element id this was drawn under, which is its live node id. */
  readonly id: string;
  readonly node: string;
  /** Whether activating it means something. */
  readonly control: boolean;
}

/** Everything one committed frame needs. */
export interface ReplDrawRequest {
  readonly ops: readonly Op[];
  readonly boxes: readonly ReplDrawnBox[];
  /**
   * Structural ids whose geometry this frame publishes beside its targets.
   *
   * The regions and viewports the frame placed. They are not targets — a region
   * is not something a person activates — but where one actually landed is the
   * only honest answer to how much room it had, so it is snapshotted with the
   * frame rather than recomputed by whoever asks later.
   */
  readonly regions: readonly string[];
  /** The tree revision these ops were built from. A pointer travels with it. */
  readonly tree: number;
  readonly size: ReplTerminalSize;
  /** Seconds since the last frame, for the engine's transitions. */
  readonly deltaTime: number;
  readonly pointer: { readonly x: number; readonly y: number; readonly down: boolean } | undefined;
}

/** What one committed render produced. Its bytes and bounds are its own. */
export interface ReplRendered {
  readonly tree: number;
  /** Bytes this result owns. Safe to hold. */
  readonly output: Uint8Array;
  readonly map: ReplFrameMap;
  readonly pointers: readonly PointerEvent[];
  readonly animating: boolean;
  /** Whether the drawing engine had to be rebuilt to fit this frame. */
  readonly recovered: boolean;
  readonly size: ReplTerminalSize;
}

/** How many engines this renderer has built, by role. */
export interface ReplEngineCount {
  readonly measuring: number;
  readonly drawing: number;
}

/** The renderer, for as long as its scope lives. */
export interface ReplRenderer {
  /**
   * Ask the engine for geometry.
   *
   * Draws nothing a caller can present, publishes no target, advances no
   * committed display state and does not replace `last()`. Its bytes are
   * discarded here rather than handed out, so there is nothing to present by
   * mistake.
   */
  measure(ops: readonly Op[], size: ReplTerminalSize): Operation<Result<ReplMeasured>>;
  /** Commit one frame. */
  draw(input: ReplDrawRequest): Operation<Result<ReplRendered>>;
  /** Tell both engines the terminal changed size. */
  resize(size: ReplTerminalSize): void;
  /** The last frame committed, for a caller that wants to read it back. */
  last(): ReplRendered | undefined;
  /** How many engines exist, which is two unless a capacity refusal replaced one. */
  engines(): ReplEngineCount;
}

/**
 * Build a renderer owned by the calling scope.
 *
 * Each engine is a WASM instance, so they are resources: two per renderer, torn
 * down with the scope that asked for them, and replaced in place when a frame
 * overflows one's arenas. The installed engine exposes no disposal, so ownership
 * ends by releasing the references with this scope rather than by calling a
 * cleanup API that does not exist.
 */
export function useReplRenderer(size: ReplTerminalSize): Operation<ReplRenderer> {
  return resource(function* (provide) {
    let current: ReplTerminalSize = { columns: size.columns, rows: size.rows };
    let drawing = yield* until(createTerm({ width: current.columns, height: current.rows }));
    let measuring = yield* until(createTerm({ width: current.columns, height: current.rows }));
    let built: ReplEngineCount = { measuring: 1, drawing: 1 };
    let committed: ReplRendered | undefined;

    yield* provide({
      *measure(ops, size) {
        let attempt = attempted(measuring, ops, undefined);
        if (attempt.kind === "refused") {
          if (!attempt.capacity) {
            return Err(new ReplRenderError(attempt.reason));
          }
          // Only the instance that refused, and at the size these ops were laid
          // out for. The drawing engine holds the frame a person is looking at,
          // and rebuilding it here would throw that away to answer a question
          // about geometry.
          measuring = yield* until(createTerm({ width: size.columns, height: size.rows }));
          built = { ...built, measuring: built.measuring + 1 };
          const again = attempted(measuring, ops, undefined);
          if (again.kind === "refused") {
            return Err(
              new ReplRenderError(
                `the layout does not fit the measuring engine even after rebuilding it: ${again.reason}`,
              ),
            );
          }
          attempt = again;
        }
        // Copied out of `info` now, because the next render on this instance
        // invalidates it and measurement is the pass that runs most often.
        const measured = new Map<string, ReplBounds>();
        for (const id of idsOf(ops)) {
          const bounds = attempt.result.info.get(id)?.bounds;
          if (bounds !== undefined) {
            measured.set(id, Object.freeze({ ...bounds }));
          }
        }
        return Ok(Object.freeze({ boundsOf: (id: string) => measured.get(id) }));
      },
      *draw(input) {
        let attempt = attempted(drawing, input.ops, input.pointer);
        let recovered = false;
        if (attempt.kind === "refused") {
          if (!attempt.capacity) {
            return Err(new ReplRenderError(attempt.reason));
          }
          // Sized for the frame in hand: the engine's measurement arenas scale
          // with width and height, so an engine built when the terminal was
          // smaller is exactly the one that overflows.
          drawing = yield* until(
            createTerm({ width: input.size.columns, height: input.size.rows }),
          );
          built = { ...built, drawing: built.drawing + 1 };
          const again = attempted(drawing, input.ops, input.pointer);
          if (again.kind === "refused") {
            return Err(
              new ReplRenderError(
                `the frame does not fit the layout engine even after rebuilding it: ${again.reason}`,
              ),
            );
          }
          attempt = again;
          recovered = true;
        }

        const map = mapOf(input.boxes, input.regions, attempt.result.info);
        if (!map.ok) {
          return map;
        }
        const rendered: ReplRendered = Object.freeze({
          tree: input.tree,
          // Copied now: this view points into the engine's memory and the next
          // render invalidates it.
          output: new Uint8Array(attempt.result.output),
          map: map.value,
          pointers: Object.freeze([...attempt.result.events]),
          animating: attempt.result.animating,
          recovered,
          size: Object.freeze({ ...input.size }),
        });
        committed = rendered;
        return Ok(rendered);
      },
      resize(next) {
        if (next.columns === current.columns && next.rows === current.rows) {
          // Nothing to tell them. The engine emits a complete redraw after any
          // update that is not a no-op, so telling it a size it already has
          // would throw away the diff the next committed frame is computed
          // against — and this is called before every frame, not only on a
          // resize event.
          return;
        }
        current = { columns: next.columns, rows: next.rows };
        drawing.update({ width: next.columns, height: next.rows });
        measuring.update({ width: next.columns, height: next.rows });
      },
      last() {
        return committed;
      },
      engines() {
        return built;
      },
    });
  });
}

/**
 * What one pass at an engine did.
 *
 * Not a `Result`: the caller has to tell a refusal a bigger engine would fix
 * from one it would not, and that is a second question about the same failure
 * rather than a different outcome.
 */
type Attempted =
  | { readonly kind: "drawn"; readonly result: ReturnType<Term["render"]> }
  | { readonly kind: "refused"; readonly capacity: boolean; readonly reason: string };

/** One pass at an engine, classifying whatever came back. */
function attempted(
  term: Term,
  ops: readonly Op[],
  pointer: { readonly x: number; readonly y: number; readonly down: boolean } | undefined,
): Attempted {
  let result;
  try {
    result = term.render([...ops], {
      row: 1,
      deltaTime: 0,
      ...(pointer === undefined ? {} : { pointer: { ...pointer } }),
    });
  } catch (error) {
    // `pack` throws rather than reporting when the ops themselves outgrow the
    // transfer buffer, which is the same problem a bigger engine solves.
    const reason = error instanceof Error ? error.message : String(error);
    return { kind: "refused", capacity: error instanceof RangeError, reason };
  }

  const capacity = result.errors.filter((error) => CAPACITY.has(error.type));
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
  return { kind: "drawn", result };
}

/** Every element id one op list opens, which is what measurement can ask about. */
function idsOf(ops: readonly Op[]): readonly string[] {
  const ids: string[] = [];
  for (const op of ops) {
    if ("id" in op && typeof op.id === "string") {
      ids.push(op.id);
    }
  }
  return ids;
}

/**
 * The frame map: what the engine measured, paired with the node that asked.
 *
 * Only an admitted box that mounted a live control becomes a target. A
 * fractional bound is refused rather than rounded: the engine produces them
 * wherever something is centred or sized by a share, and a target rounded into
 * whole cells is a hit box that disagrees with the text underneath it.
 */
function mapOf(
  boxes: readonly ReplDrawnBox[],
  regions: readonly string[],
  info: { get(id: string): { bounds: ReplBounds } | undefined },
): Result<ReplFrameMap> {
  const targets: ReplTarget[] = [];
  const placed = new Map<string, ReplBounds>();
  for (const box of boxes) {
    const measured = info.get(box.id);
    if (measured === undefined) {
      continue;
    }
    const checked = integral(box.id, measured.bounds);
    if (!checked.ok) {
      return checked;
    }
    // Every drawn row's geometry is published; only a control's becomes a
    // target. Where a row landed and whether it can be activated are two
    // different questions, and a line that answered the second one would make
    // the whole transcript a hit box.
    placed.set(box.id, checked.value);
    if (!box.control) {
      continue;
    }
    targets.push(Object.freeze({ id: box.id, node: box.node, bounds: checked.value }));
  }

  for (const id of regions) {
    const measured = info.get(id);
    if (measured === undefined) {
      continue;
    }
    const checked = integral(id, measured.bounds);
    if (!checked.ok) {
      return checked;
    }
    placed.set(id, checked.value);
  }

  const frozen = Object.freeze(targets);
  const byId = new Map(frozen.map((target) => [target.id, target]));
  return Ok(
    Object.freeze({
      targets: frozen,
      at(x: number, y: number) {
        // Back to front: the last thing drawn is the thing on top, which is how
        // a drawer keeps a pointer off the controls it covers. Half-open on both
        // axes — the engine's own hit test includes a box's trailing edge, so
        // every row of a stacked list would otherwise be claimed by two
        // neighbours.
        for (let index = frozen.length - 1; index >= 0; index -= 1) {
          const { bounds, node } = frozen[index];
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
      boundsOf(id: string) {
        return byId.get(id)?.bounds;
      },
      nodeOf(id: string) {
        return byId.get(id)?.node;
      },
      regionOf(id: string) {
        return placed.get(id);
      },
    }),
  );
}

/**
 * One measured rectangle, in whole cells, or the refusal it earns.
 *
 * Refused rather than rounded. The engine produces fractional geometry wherever
 * something is centred or sized by a share, and a rectangle rounded into whole
 * cells is a hit box that disagrees with the text underneath it — so a frame
 * that cannot be placed on cell boundaries is a frame this product does not draw.
 */
function integral(id: string, bounds: ReplBounds): Result<ReplBounds> {
  const { x, y, width, height } = bounds;
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    !Number.isInteger(width) ||
    !Number.isInteger(height)
  ) {
    return Err(
      new ReplRenderError(
        `the engine placed ${id} at a fractional position ` +
          `(x=${x}, y=${y}, width=${width}, height=${height}); a cell there would name ` +
          `a row and column that do not exist`,
      ),
    );
  }
  return Ok(Object.freeze({ x, y, width, height }));
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
