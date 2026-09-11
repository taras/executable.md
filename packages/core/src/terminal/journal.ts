/**
 * Core's answer to the neutral terminal journal boundary (spec §6.21
 * Durability and replay).
 *
 * The terminal package defines three durable boundaries and calls them; this
 * is where they become entries in *this* document's journal, described from the
 * source position that wrote the grid. Only provider-neutral layouts, outcomes
 * and lazy operations cross the boundary, so the terminal package imports
 * nothing of core's and core supplies nothing of a provider's.
 *
 * Provider-neutral throughout. No command, socket, path, process, session,
 * window or terminal identifier, no argv or environment, and no terminal byte
 * is written here: none of that describes the document, it describes whichever
 * provider happened to present it, and a resumed run builds a fresh one.
 */

import { withResolvers } from "effection";
import type { Operation, Task } from "effection";
import {
  createDurableOperation,
  DurableContext,
  durableSpawn,
  ephemeral,
  StaleInputError,
} from "@executablemd/durable-streams";
import type { EffectDescription, Json, Workflow } from "@executablemd/durable-streams";
import type {
  RetainedCellOutcome,
  RetainedGrid,
  RetainedGridLayout,
  TerminalGridJournal,
} from "@executablemd/terminal";

import { sourceDescription } from "../source-position.ts";
import type { SourcePosition } from "../types.ts";

/** A grid's identity within one execution: where it was written. */
export interface GridIdentity {
  /** The structural path that reached this element (§5.6). */
  readonly path: string;
  readonly position?: Readonly<SourcePosition>;
}

function describe(identity: GridIdentity): EffectDescription {
  return {
    type: "terminal_grid_layout",
    name: `terminal_grid:${identity.path}:layout`,
    ...sourceDescription(identity.position),
  };
}

/** Whether this expansion has a journal to read and append to at all. */
function* durable(): Operation<boolean> {
  return (yield* DurableContext.get()) !== undefined;
}

/**
 * Append one entry and return what the entry holds.
 *
 * Live it is the value passed in; on replay it is the value the journal already
 * held, which is the only way a caller tells the two apart.
 */
function* append(description: EffectDescription, value: Json): Workflow<unknown> {
  return yield createDurableOperation(description, function* () {
    return value;
  });
}

/**
 * The layout a journal entry holds, parsed member by member.
 *
 * Total: every field is read and checked, and anything the record does not say
 * exactly — a missing member, a member of the wrong kind, an extra one, a row
 * or column that does not follow from the columns it claims — makes the record
 * unreadable rather than half-read. A layout is what a resumed run is held to,
 * so a record that cannot be believed in full must not be believed in part.
 */
function readLayout(value: unknown): RetainedGridLayout | undefined {
  const record = members(value);
  if (record === undefined || !onlyNames(record, ["columns", "rows", "cells"])) {
    return undefined;
  }
  const columns = positiveInteger(record.columns);
  const rows = positiveInteger(record.rows);
  const list = record.cells;
  if (columns === undefined || rows === undefined || !Array.isArray(list)) {
    return undefined;
  }
  const cells: RetainedGridLayout["cells"][number][] = [];
  for (const [index, entry] of list.entries()) {
    const cell = readCell(entry, index, columns);
    if (cell === undefined) {
      return undefined;
    }
    cells.push(cell);
  }
  // The rows a grid claims have to be the rows its cells need, or the record
  // describes a grid nothing could have derived.
  if (cells.length === 0 || Math.ceil(cells.length / columns) !== rows) {
    return undefined;
  }
  return { columns, rows, cells };
}

/** One retained cell, checked against the position it sits at. */
function readCell(
  value: unknown,
  index: number,
  columns: number,
): RetainedGridLayout["cells"][number] | undefined {
  const record = members(value);
  if (record === undefined || !onlyNames(record, ["title", "form", "row", "column"])) {
    return undefined;
  }
  const { title, form, row, column } = record;
  if (typeof title !== "string" || title.length === 0) {
    return undefined;
  }
  if (form !== "paired" && form !== "self-closing") {
    return undefined;
  }
  // Derived, not asserted: a position that does not follow from the array index
  // and the column count is a record that disagrees with itself.
  if (row !== Math.floor(index / columns) || column !== index % columns) {
    return undefined;
  }
  return { title, form, row, column };
}

function readCellOutcome(value: unknown): RetainedCellOutcome | undefined {
  const record = members(value);
  if (record === undefined || !onlyNames(record, ["status", "reason"])) {
    return undefined;
  }
  const { status, reason } = record;
  if (status !== "succeeded" && status !== "failed" && status !== "closed") {
    return undefined;
  }
  if (typeof reason !== "string") {
    return undefined;
  }
  return { status, reason };
}

function readGrid(value: unknown): RetainedGrid | undefined {
  const record = members(value);
  if (record === undefined || !onlyNames(record, ["layout", "close", "cells"])) {
    return undefined;
  }
  const layout = readLayout(record.layout);
  const { close } = record;
  if (layout === undefined || (close !== "reader" && close !== "failed")) {
    return undefined;
  }
  if (!Array.isArray(record.cells) || record.cells.length !== layout.cells.length) {
    return undefined;
  }
  const cells: RetainedCellOutcome[] = [];
  for (const entry of record.cells) {
    const outcome = readCellOutcome(entry);
    if (outcome === undefined) {
      return undefined;
    }
    cells.push(outcome);
  }
  return { layout, close, cells };
}

/** The members of a JSON object, or `undefined` for anything else. */
function members(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value));
}

/** Whether a record carries exactly these member names, and no others. */
function onlyNames(record: Record<string, unknown>, names: readonly string[]): boolean {
  const present = Object.keys(record);
  return present.length === names.length && names.every((name) => name in record);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** How two layouts differ, in the words an author can act on. */
function divergence(held: RetainedGridLayout, derived: RetainedGridLayout): string | undefined {
  if (held.columns !== derived.columns) {
    return `columns ${held.columns} rather than ${derived.columns}`;
  }
  if (held.cells.length !== derived.cells.length) {
    return `${held.cells.length} terminals rather than ${derived.cells.length}`;
  }
  for (const [index, cell] of derived.cells.entries()) {
    const before = held.cells[index]!;
    if (before.title !== cell.title) {
      return `terminal ${index} titled "${before.title}" rather than "${cell.title}"`;
    }
    if (before.form !== cell.form) {
      return `terminal ${index} written ${before.form} rather than ${cell.form}`;
    }
    if (before.row !== cell.row || before.column !== cell.column) {
      return (
        `terminal ${index} at row ${before.row}, column ${before.column} rather than row ` +
        `${cell.row}, column ${cell.column}`
      );
    }
  }
  return undefined;
}

/**
 * Hand out the right to allocate a durable child, in authored order.
 *
 * The lifecycle starts every cell concurrently, so the order its operations
 * *reach* this adapter is whatever the scheduler chose. A durable child's
 * identity may not depend on that, so each position waits for the one before it
 * to have allocated and then releases the one after — which makes the ordinals
 * the journal records the authored ones, on every run.
 */
interface OrderedTurns {
  wait(position: number): Operation<void>;
  done(position: number): void;
}

function createOrderedTurns(count: number): OrderedTurns {
  const gates = Array.from({ length: count }, () => withResolvers<void>());
  gates[0]?.resolve();
  return {
    wait: (position) => gates[position]!.operation,
    done: (position) => gates[position + 1]?.resolve(),
  };
}

/**
 * Build the journal one grid expansion retains through.
 *
 * The adapter closes over the source description, so the terminal lifecycle
 * names nothing but an array position and the lazy work at it.
 */
export function createTerminalGridJournal(
  identity: GridIdentity,
  cellCount: number,
): TerminalGridJournal {
  const turns = createOrderedTurns(cellCount);

  /**
   * Take a turn, allocate the durable child, and hand the turn straight on.
   *
   * Only the allocation is ordered. The child runs beside its siblings from the
   * moment it exists, so holding the turn any longer would run the grid one
   * cell at a time.
   */
  function* allocate(
    position: number,
    operation: Operation<RetainedCellOutcome>,
  ): Operation<Task<RetainedCellOutcome>> {
    try {
      yield* turns.wait(position);
      return yield* durableSpawn(function* (): Workflow<RetainedCellOutcome> {
        return yield* ephemeral(operation);
      });
    } finally {
      // Released however this leaves — allocated, refused, or cancelled — so
      // the position after this one is never waiting on a turn nobody holds.
      turns.done(position);
    }
  }

  return {
    *reconcileLayout(layout: RetainedGridLayout): Operation<void> {
      if (!(yield* durable())) {
        return;
      }
      const description = describe(identity);
      const stored = yield* append(description, layout);
      const held = readLayout(stored);
      if (held === undefined) {
        throw new StaleInputError(
          `The journal's record of "${description.name}" is not a terminal-grid layout. Re-run ` +
            "the document from the start rather than resuming from this journal.",
          { coroutineId: identity.path, description },
        );
      }
      const changed = divergence(held, layout);
      if (changed !== undefined) {
        throw new StaleInputError(
          `The journal records this terminal grid as a grid with ${changed}. A grid whose ` +
            "layout changed cannot be replayed onto this run. Re-run the document from the " +
            "start rather than resuming from this journal.",
          { coroutineId: identity.path, description },
        );
      }
    },

    retainGrid(operation: Operation<RetainedGrid>): Operation<RetainedGrid> {
      return (function* (): Operation<RetainedGrid> {
        if (!(yield* durable())) {
          return yield* operation;
        }
        // A completed grid short-circuits here: the child's workflow never
        // runs, so no provider is contacted, no store is created, no cell
        // content expands and no shell starts.
        const task = yield* durableSpawn(function* (): Workflow<RetainedGrid> {
          return yield* ephemeral(operation);
        });
        return parsed(readGrid(yield* task), "terminal grid");
      })();
    },

    retainCell(
      position: number,
      operation: Operation<RetainedCellOutcome>,
    ): Operation<RetainedCellOutcome> {
      return (function* (): Operation<RetainedCellOutcome> {
        if (!(yield* durable())) {
          return yield* operation;
        }
        const task = yield* allocate(position, operation);
        return parsed(readCellOutcome(yield* task), "terminal cell outcome");
      })();
    },
  };
}

/**
 * What a record said, or a refusal.
 *
 * A record that cannot be read in full is not read in part: a resumed run that
 * believed half of one would present a grid nobody authored.
 */
function parsed<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new StaleInputError(
      `The journal's record of this ${what} is not one. Re-run the document from the start ` +
        "rather than resuming from this journal.",
    );
  }
  return value;
}
