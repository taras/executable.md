/**
 * Which grid a run opened, and how a resumed run is held to it
 * (spec §6.21 Durability and replay).
 *
 * One entry, appended in the **parent** coroutine and **before** the foreground
 * lease is taken or any provider is contacted: the columns and rows, and the
 * ordered pane forms, titles and positions. A resumed run compares what it
 * derived against what is held and refuses a document whose grid changed while
 * nothing has been opened and nothing has started.
 *
 * It sits in the parent deliberately. The grid itself is a durable child, and a
 * completed child short-circuits without running — so a comparison written
 * inside it would never happen on the run that most needs it.
 *
 * Provider-neutral throughout. No command, socket, path, process, session,
 * window or pane identifier, no argv or environment, and no terminal byte is
 * written here: none of that describes the document, it describes whichever
 * provider happened to present it, and a resumed run builds a fresh one.
 */

import type { Operation } from "effection";
import {
  createDurableOperation,
  DurableContext,
  StaleInputError,
} from "@executablemd/durable-streams";
import type { EffectDescription, Json, Workflow } from "@executablemd/durable-streams";
import type { TerminalGridRequest } from "@executablemd/runtime";

import { sourceDescription } from "../source-position.ts";
import type { SourcePosition } from "../types.ts";
import { retainedLayout } from "./grid.ts";
import type { RetainedGrid } from "./grid.ts";

/** A grid's identity within one execution: where it was written. */
export interface GridIdentity {
  /** The structural path that reached this element (§5.6). */
  readonly path: string;
  readonly position?: Readonly<SourcePosition>;
}

type RetainedLayout = RetainedGrid["layout"];

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
 * exactly — a missing member, a member of the wrong kind, an extra one, a pane
 * whose ordinal is not its position, a row or column that does not follow from
 * the columns it claims — makes the record unreadable rather than half-read. A
 * layout is what a resumed run is held to, so a record that cannot be believed
 * in full must not be believed in part.
 */
function readLayout(value: unknown): RetainedLayout | undefined {
  const record = members(value);
  if (record === undefined || !onlyNames(record, ["columns", "rows", "panes"])) {
    return undefined;
  }
  const columns = positiveInteger(record.columns);
  const rows = positiveInteger(record.rows);
  const list = record.panes;
  if (columns === undefined || rows === undefined || !Array.isArray(list)) {
    return undefined;
  }
  const panes: RetainedLayout["panes"] = [];
  for (const [index, entry] of list.entries()) {
    const pane = readPane(entry, index, columns);
    if (pane === undefined) {
      return undefined;
    }
    panes.push(pane);
  }
  // The rows a grid claims have to be the rows its panes need, or the record
  // describes a grid nothing could have derived.
  if (panes.length === 0 || Math.ceil(panes.length / columns) !== rows) {
    return undefined;
  }
  return { columns, rows, panes };
}

/** One retained pane, checked against the position it claims to occupy. */
function readPane(
  value: unknown,
  index: number,
  columns: number,
): RetainedLayout["panes"][number] | undefined {
  const record = members(value);
  if (record === undefined || !onlyNames(record, ["ordinal", "title", "form", "row", "column"])) {
    return undefined;
  }
  const { ordinal, title, form, row, column } = record;
  if (ordinal !== index) {
    return undefined;
  }
  if (typeof title !== "string" || title.length === 0) {
    return undefined;
  }
  if (form !== "paired" && form !== "self-closing") {
    return undefined;
  }
  // Derived, not asserted: a position that does not follow from the ordinal and
  // the column count is a record that disagrees with itself.
  if (row !== Math.floor(index / columns) || column !== index % columns) {
    return undefined;
  }
  return { ordinal, title, form, row, column };
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
function divergence(held: RetainedLayout, derived: RetainedLayout): string | undefined {
  if (held.columns !== derived.columns) {
    return `columns ${held.columns} rather than ${derived.columns}`;
  }
  if (held.panes.length !== derived.panes.length) {
    return `${held.panes.length} panes rather than ${derived.panes.length}`;
  }
  for (const [index, pane] of derived.panes.entries()) {
    const before = held.panes[index]!;
    if (before.title !== pane.title) {
      return `pane ${index} titled "${before.title}" rather than "${pane.title}"`;
    }
    if (before.form !== pane.form) {
      return `pane ${index} written ${before.form} rather than ${pane.form}`;
    }
    if (before.row !== pane.row || before.column !== pane.column) {
      return (
        `pane ${index} at row ${before.row}, column ${before.column} rather than row ` +
        `${pane.row}, column ${pane.column}`
      );
    }
  }
  return undefined;
}

/**
 * Record which grid this is, and refuse a resumed run whose grid changed.
 *
 * Expansion driven without a journal records nothing and behaves identically.
 */
export function* recordGridLayout(
  identity: GridIdentity,
  request: TerminalGridRequest,
): Operation<void> {
  if (!(yield* durable())) {
    return;
  }
  const derived = retainedLayout(request);
  const description = describe(identity);
  const stored = yield* append(description, derived);
  const held = readLayout(stored);
  if (held === undefined) {
    throw new StaleInputError(
      `The journal's record of "${description.name}" is not a terminal-grid layout. Re-run the ` +
        "document from the start rather than resuming from this journal.",
      { coroutineId: identity.path, description },
    );
  }
  const changed = divergence(held, derived);
  if (changed !== undefined) {
    throw new StaleInputError(
      `The journal records this terminal grid as a grid with ${changed}. A grid whose layout ` +
        "changed cannot be replayed onto this run. Re-run the document from the start rather " +
        "than resuming from this journal.",
      { coroutineId: identity.path, description },
    );
  }
}
