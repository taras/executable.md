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

/** The retained layout a journal entry holds, or undefined if it holds anything else. */
function readLayout(value: unknown): RetainedLayout | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const fields: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  const { columns, rows, panes } = fields;
  if (typeof columns !== "number" || typeof rows !== "number" || !Array.isArray(panes)) {
    return undefined;
  }
  return { columns, rows, panes: panes as RetainedLayout["panes"] };
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
