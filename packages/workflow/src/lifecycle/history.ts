/**
 * One retained protocol row, as history reads it.
 *
 * History is the run's record, not a reconstruction of it. An entry holds the
 * event exactly as the journal filtered and retained it, the opaque id that row
 * keeps, and the Workspace root the row was already associated with. Nothing
 * here materializes a root, reopens a definition or asks a provider anything.
 *
 * The authored source is the one optional part. A durable operation written by
 * an author carries its normalized position under the stable namespaced
 * description field, so history parses that field and never derives a location
 * from an expansion id, an effect name or the current source. A field that is
 * present and does not parse makes the entry unreadable — reporting it as
 * source-less would describe history the run does not hold — and the diagnostic
 * repeats no part of the value, which is retained filtered data.
 */

import type { DurableEvent } from "@executablemd/durable-streams";
import { SOURCE_POSITION_FIELD } from "@executablemd/core";
import type { SourcePosition } from "@executablemd/core";
import { WorkflowRecordMalformedError } from "../storage/errors.ts";
import { classifyForkability, type Forkability } from "./forkability.ts";
import type { ForkabilityCandidate } from "./forkability.ts";
import { describe, parseMembers, requireMemberNames } from "../storage/members.ts";

/** One public history row. */
export interface WorkflowHistoryEntry {
  readonly eventId: string;
  readonly event: DurableEvent;
  readonly workspaceRootId: string;
  /** Where the authored operation was written, when the event retained it. */
  readonly source?: Readonly<SourcePosition>;
  /** Whether a fork may select this event, and what stands in the way. */
  readonly forkability: Forkability;
  /** Where an inherited row came from. Absent on a row this run wrote itself. */
  readonly inherited?: InheritedEventProvenance;
}

/** The source run and source event one inherited row was admitted from. */
export interface InheritedEventProvenance {
  readonly sourceRunId: string;
  readonly sourceEventId: string;
}

const MEMBERS = ["path", "offset", "line", "column"];

/**
 * The authored position an event retained, or none when it retained none.
 *
 * A Close carries no description at all, and a trusted-host Yield may carry one
 * without this field. Both are ordinary absence.
 */
export function readEventSource(event: DurableEvent): Readonly<SourcePosition> | undefined {
  if (event.type !== "yield") {
    return undefined;
  }
  const field = event.description[SOURCE_POSITION_FIELD];
  if (field === undefined) {
    return undefined;
  }
  return parseSourcePosition(field);
}

function parseSourcePosition(value: unknown): Readonly<SourcePosition> {
  const members = parseMembers(value, "$", fail);
  requireMemberNames(members, MEMBERS, "$", fail);

  const path = members.get("path");
  if (path !== undefined && (typeof path !== "string" || path === "")) {
    throw fail(`expected a non-empty string, found ${describe(path)}`, "$.path");
  }

  return Object.freeze({
    ...(path === undefined ? {} : { path }),
    offset: coordinate(members.get("offset"), "$.offset", 0),
    line: coordinate(members.get("line"), "$.line", 1),
    column: coordinate(members.get("column"), "$.column", 1),
  });
}

function coordinate(value: unknown, path: string, least: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < least) {
    throw fail(`expected an integer of at least ${least}, found ${describe(value)}`, path);
  }
  return value;
}

/**
 * The offending member is named; what it held is not.
 *
 * `describe()` reports a value's kind rather than its contents, so a diagnostic
 * about damaged history never becomes a second copy of filtered data.
 */
function fail(reason: string, path: string): Error {
  return new WorkflowRecordMalformedError(
    `journal_events.record ${SOURCE_POSITION_FIELD}`,
    `${reason} at ${path}`,
  );
}

/**
 * What a caller knows about the rows it is projecting.
 *
 * Two sources produce these rows — a live run's database and a sealed artifact
 * — and they answer both questions from different places. Passing them in keeps
 * the projection itself ignorant of which one it is serving, which is the point:
 * a second mapping written beside this one is how history quietly starts meaning
 * something different depending on where it was read.
 */
export interface HistoryProjectionContext {
  /** Every Workspace root the source still holds. */
  readonly retainedRoots: ReadonlySet<string>;
  /** Where each inherited row came from. Rows a run wrote itself are absent. */
  readonly inherited: ReadonlyMap<string, InheritedEventProvenance>;
}

/**
 * The answer for an event the classification did not reach.
 *
 * It never happens — one forkability is produced per event — and reporting a
 * forkable checkpoint if it ever did would offer a fork a prefix nothing
 * examined.
 */
const UNCLASSIFIED: Forkability = Object.freeze({
  forkable: false,
  blockers: Object.freeze([Object.freeze({ code: "unsupported-effect" as const, eventId: "" })]),
});

/**
 * Ordered retained rows, as the public history they project to.
 *
 * Everything history adds to a retained row happens here: the authored source
 * is parsed out of the event, forkability is classified cumulatively over the
 * whole ordered prefix, inherited provenance is attached where there is any,
 * and each entry is frozen.
 */
export function projectHistory(
  candidates: readonly ForkabilityCandidate[],
  context: HistoryProjectionContext,
): readonly WorkflowHistoryEntry[] {
  const forkability = classifyForkability(candidates, { retainedRoots: context.retainedRoots });
  return Object.freeze(
    candidates.map((candidate, index) =>
      Object.freeze({
        eventId: candidate.eventId,
        event: candidate.event,
        workspaceRootId: candidate.workspaceRootId,
        ...sourceOf(candidate.event),
        forkability: forkability[index] ?? UNCLASSIFIED,
        ...provenanceOf(context.inherited, candidate.eventId),
      }),
    ),
  );
}

function sourceOf(event: DurableEvent): Partial<WorkflowHistoryEntry> {
  const source = readEventSource(event);
  return source === undefined ? {} : { source };
}

function provenanceOf(
  inherited: ReadonlyMap<string, InheritedEventProvenance>,
  eventId: string,
): Partial<WorkflowHistoryEntry> {
  const provenance = inherited.get(eventId);
  return provenance === undefined ? {} : { inherited: provenance };
}
