/**
 * A Journal prefix in, one semantic model out.
 *
 * Two functions, and the relationship between them is the point.
 * `projectPrefix()` folds a prefix from nothing, every time it is asked.
 * `foldMarkers()` folds once and snapshots at each marker, which is what a
 * live session accumulating records does. They must agree at every marker, and
 * they agree because neither can read the other: `projectPrefix()` takes
 * records and a marker, and there is no snapshot argument it could be handed.
 *
 * That is the whole hydration claim in one signature. A projector that could
 * accept a cached checkpoint would make the cache load-bearing the first time
 * someone passed one, and no test written afterwards would find it.
 *
 * Nothing here knows the pause controller exists. Expansion may be held (#841)
 * while background work appends durable outcomes, and that is not a fact about
 * this fold: the prefix ending at the pause marker is the same prefix whether
 * or not a process is currently holding a continuation there.
 */

import { Err, Ok } from "effection";
import type { Result } from "effection";

import { markerWeight, mintsMarker } from "./journal.ts";
import type { SemanticEvent } from "./journal.ts";
import { deepFreeze } from "./model.ts";
import type {
  Binding,
  Entry,
  Marker,
  Outcome,
  Provenance,
  Recorded,
  Scope,
  SemanticModel,
  Suspension,
} from "./model.ts";

/** A journal that is internally inconsistent: readable records describing an impossible run. */
export class ProjectionError extends Error {
  /** The record that could not be applied. */
  readonly record: string;
  readonly seq: number;
  readonly kind: string;

  constructor(event: SemanticEvent, message: string) {
    super(`${event.id} (${event.kind} in ${event.entry}): ${message}`);
    this.name = "ProjectionError";
    this.record = event.id;
    this.seq = event.seq;
    this.kind = event.kind;
  }
}

/** A marker no record in this journal minted. */
export class UnknownMarkerError extends Error {
  readonly marker: string;
  readonly markers: readonly string[];

  constructor(marker: string, markers: readonly string[]) {
    super(
      `${JSON.stringify(marker)} names no semantic marker; the markers are ${
        markers.length === 0 ? "none" : markers.join(", ")
      }`,
    );
    this.name = "UnknownMarkerError";
    this.marker = marker;
    this.markers = [...markers];
  }
}

interface DraftScope {
  readonly name: string;
  readonly source: number;
  outcome: Outcome;
  readonly marker: string;
  readonly children: DraftScope[];
}

interface DraftEntry {
  readonly id: string;
  readonly title: string;
  outcome: Outcome;
  readonly marker: string;
  readonly scopes: DraftScope[];
  readonly inherited: readonly Binding[];
}

interface Draft {
  provenance: Provenance;
  readonly entries: DraftEntry[];
  readonly bindings: Binding[];
  readonly suspensions: Suspension[];
  readonly outcomes: Recorded[];
  readonly markers: Marker[];
}

function draft(): Draft {
  return {
    provenance: { kind: "root" },
    entries: [],
    bindings: [],
    suspensions: [],
    outcomes: [],
    markers: [],
  };
}

function findScope(scopes: readonly DraftScope[], path: readonly string[]): DraftScope | undefined {
  let level = scopes;
  let found: DraftScope | undefined;
  for (const name of path) {
    found = level.find((scope) => scope.name === name);
    if (found === undefined) {
      return undefined;
    }
    level = found.children;
  }
  return found;
}

function running(scopes: readonly DraftScope[]): DraftScope | undefined {
  for (const scope of scopes) {
    if (scope.outcome.status === "running") {
      return scope;
    }
    const deeper = running(scope.children);
    if (deeper !== undefined) {
      return deeper;
    }
  }
  return undefined;
}

/**
 * Every descendant scope still running becomes interrupted; the rest are left
 * exactly as they are.
 *
 * The status check is what keeps a scope that completed before the terminal
 * record completed. Walking a whole subtree and stamping it would rewrite
 * history the Journal already recorded.
 */
function interrupt(scopes: readonly DraftScope[], reason: string): void {
  for (const scope of scopes) {
    if (scope.outcome.status === "running") {
      scope.outcome = { status: "interrupted", reason };
    }
    interrupt(scope.children, reason);
  }
}

/** Close every wait the entry still had open when it ended. */
function closeWaits(state: Draft, entry: string): void {
  for (let index = state.suspensions.length - 1; index >= 0; index -= 1) {
    if (state.suspensions[index].entry === entry) {
      state.suspensions.splice(index, 1);
    }
  }
}

/** Whether `path` names `scope` itself or something inside it. */
function within(path: readonly string[], scope: readonly string[]): boolean {
  return scope.length <= path.length && scope.every((name, at) => name === path[at]);
}

function openEntry(state: Draft, event: SemanticEvent): Result<DraftEntry> {
  const entry = state.entries.find((candidate) => candidate.id === event.entry);
  if (entry === undefined) {
    return Err(new ProjectionError(event, "names an entry no record submitted"));
  }
  if (entry.outcome.status !== "running") {
    return Err(
      new ProjectionError(event, `names ${entry.id}, which is already ${entry.outcome.status}`),
    );
  }
  return Ok(entry);
}

function apply(state: Draft, event: SemanticEvent): Result<void> {
  if (event.kind === "entry.submitted" || event.kind === "entry.inherited") {
    if (state.entries.some((entry) => entry.id === event.entry)) {
      return Err(new ProjectionError(event, "submits an entry that is already recorded"));
    }
    // What this entry was submitted into, read before it publishes anything.
    // A fork's synthetic entry inherits nothing: it *is* the inheritance, and
    // reporting the environment it just introduced as its own inheritance
    // would make the fork look like it started from itself.
    const before = state.bindings.map((binding) => ({ ...binding }));

    if (event.kind === "entry.inherited") {
      // One fork, one inheritance. A second would describe an execution with
      // two pasts, and nothing could say which environment it started in.
      if (state.provenance.kind === "forked") {
        return Err(
          new ProjectionError(
            event,
            `inherits again; this execution already forked from ${state.provenance.parent}`,
          ),
        );
      }
      if (state.entries.length > 0) {
        return Err(new ProjectionError(event, "inherits after this execution already began"));
      }
      state.provenance = {
        kind: "forked",
        parent: event.parent,
        source: event.source,
        entry: event.entry,
      };
      // The environment arrives with the entry, from this one record. There
      // is no prefix of a fork that has the entry and only some of it.
      for (const inherited of event.bindings) {
        state.bindings.push({
          name: inherited.name,
          value: inherited.value,
          entry: event.entry,
          marker: event.id,
        });
      }
    }
    // Top-level entries run serially. Two overlapping is a shape the product
    // never reaches, and describing one would carry a second live scope tree
    // into everything that reads the model.
    const live = state.entries.find((entry) => entry.outcome.status === "running");
    if (live !== undefined) {
      return Err(new ProjectionError(event, `overlaps ${live.id}, which is still running`));
    }
    state.entries.push({
      id: event.entry,
      title: event.title,
      outcome: { status: "running" },
      marker: event.id,
      scopes: [],
      inherited: before,
    });
    return Ok();
  }

  const owner = openEntry(state, event);
  if (!owner.ok) {
    return owner;
  }
  const entry = owner.value;

  if (event.kind === "entry.settled") {
    const waiting = state.suspensions.find((suspension) => suspension.entry === entry.id);
    if (waiting !== undefined) {
      return Err(new ProjectionError(event, `settles an entry still waiting on ${waiting.wait}`));
    }
    const open = running(entry.scopes);
    if (open !== undefined) {
      return Err(
        new ProjectionError(event, `settles an entry whose ${open.name} scope has not completed`),
      );
    }
    entry.outcome = { status: "settled" };
    return Ok();
  }

  if (event.kind === "entry.failed" || event.kind === "entry.interrupted") {
    // One terminal record ends the entry and interrupts whatever it still had
    // open. The entry carries what the record said; each still-running scope
    // carries the same reason, because the Journal recorded one ending and
    // not one per scope. Published bindings are untouched.
    interrupt(entry.scopes, event.reason);
    closeWaits(state, entry.id);
    entry.outcome =
      event.kind === "entry.failed"
        ? { status: "failed", reason: event.reason }
        : { status: "interrupted", reason: event.reason };
    return Ok();
  }

  if (event.kind === "binding.published") {
    const published: Binding = {
      name: event.name,
      value: event.value,
      entry: entry.id,
      marker: event.id,
    };
    const at = state.bindings.findIndex((binding) => binding.name === event.name);
    if (at === -1) {
      state.bindings.push(published);
    } else {
      state.bindings[at] = published;
    }
    return Ok();
  }

  const parent = event.scope.length === 0 ? undefined : findScope(entry.scopes, event.scope);
  if (event.scope.length > 0 && parent === undefined) {
    return Err(new ProjectionError(event, `names a scope path no record opened`));
  }
  const level = parent === undefined ? entry.scopes : parent.children;

  if (event.kind === "scope.opened") {
    if (parent !== undefined && parent.outcome.status !== "running") {
      return Err(
        new ProjectionError(
          event,
          `opens inside ${parent.name}, which is already ${parent.outcome.status}`,
        ),
      );
    }
    if (level.some((scope) => scope.name === event.name)) {
      return Err(new ProjectionError(event, "opens a scope that is already open there"));
    }
    // Two siblings claiming one position in their parent's body cannot be put
    // in source order, and the transcript is a reading of the document.
    const taken = level.find((scope) => scope.source === event.source);
    if (taken !== undefined) {
      return Err(
        new ProjectionError(
          event,
          `claims source position ${event.source}, which ${taken.name} holds`,
        ),
      );
    }
    level.push({
      name: event.name,
      source: event.source,
      outcome: { status: "running" },
      marker: event.id,
      children: [],
    });
    return Ok();
  }

  if (event.kind === "scope.completed") {
    const leaving = level.find((scope) => scope.name === event.name);
    if (leaving === undefined) {
      return Err(new ProjectionError(event, "completes a scope no record opened"));
    }
    if (leaving.outcome.status !== "running") {
      return Err(
        new ProjectionError(
          event,
          `completes ${leaving.name}, which is already ${leaving.outcome.status}`,
        ),
      );
    }
    const inside = running(leaving.children);
    if (inside !== undefined) {
      return Err(
        new ProjectionError(
          event,
          `completes ${leaving.name} while ${inside.name} is still open inside it`,
        ),
      );
    }
    const path = [...event.scope, event.name];
    const waiting = state.suspensions.find(
      (suspension) => suspension.entry === entry.id && within(suspension.scope, path),
    );
    if (waiting !== undefined) {
      return Err(
        new ProjectionError(event, `completes ${leaving.name} while it waits on ${waiting.wait}`),
      );
    }
    leaving.outcome = { status: "settled" };
    return Ok();
  }

  if (parent !== undefined && parent.outcome.status !== "running") {
    return Err(
      new ProjectionError(event, `names ${parent.name}, which is already ${parent.outcome.status}`),
    );
  }

  if (event.kind === "suspension.opened") {
    const already = state.suspensions.find(
      (suspension) =>
        suspension.entry === entry.id &&
        suspension.wait === event.wait &&
        suspension.scope.length === event.scope.length &&
        suspension.scope.every((name, at) => name === event.scope[at]),
    );
    if (already !== undefined) {
      return Err(
        new ProjectionError(event, `opens a ${event.wait} wait that is already open there`),
      );
    }
    state.suspensions.push({
      wait: event.wait,
      entry: entry.id,
      scope: [...event.scope],
      prompt: event.prompt,
      secret: event.secret,
      marker: event.id,
    });
    return Ok();
  }

  if (event.kind === "suspension.answered") {
    // An answer names one wait completely: the entry, the exact scope path
    // inside it, and the kind. Matching on less lets an answer consume a wait
    // that belongs somewhere else and reconstruct a moment that never was.
    let answered = -1;
    for (let index = state.suspensions.length - 1; index >= 0 && answered === -1; index -= 1) {
      const suspension = state.suspensions[index];
      const same =
        suspension.entry === entry.id &&
        suspension.wait === event.wait &&
        suspension.scope.length === event.scope.length &&
        suspension.scope.every((name, at) => name === event.scope[at]);
      if (same) {
        answered = index;
      }
    }
    if (answered === -1) {
      return Err(new ProjectionError(event, "answers no wait this entry has open there"));
    }
    // A secret answer is not stored anywhere, so a record carrying one is a
    // journal that already leaked. Refusing it is the last place that can be
    // said, and saying it by dropping the value instead would leave the leak
    // written down and merely unread.
    if (state.suspensions[answered].secret && event.answer !== "") {
      return Err(
        new ProjectionError(event, `answers the secret wait ${event.wait} with a recorded value`),
      );
    }
    state.suspensions.splice(answered, 1);
    return Ok();
  }

  state.outcomes.push({
    entry: entry.id,
    scope: [...event.scope],
    request: event.request,
    label: event.label,
    marker: event.id,
  });
  return Ok();
}

function copyScope(scope: DraftScope): Scope {
  return {
    name: scope.name,
    source: scope.source,
    outcome: { ...scope.outcome },
    marker: scope.marker,
    // Concurrent siblings open in dispatch order; the transcript reads them in
    // the order the document writes them.
    children: scope.children.toSorted((one, other) => one.source - other.source).map(copyScope),
  };
}

function copyEntry(entry: DraftEntry): Entry {
  return {
    id: entry.id,
    title: entry.title,
    outcome: { ...entry.outcome },
    marker: entry.marker,
    scopes: entry.scopes.toSorted((one, other) => one.source - other.source).map(copyScope),
    inherited: entry.inherited.map((binding) => ({ ...binding })),
  };
}

function snapshot(execution: string, state: Draft, records: number): SemanticModel {
  const head = state.markers[state.markers.length - 1];
  return deepFreeze({
    execution,
    provenance: { ...state.provenance },
    marker: head === undefined ? "" : head.id,
    at: head === undefined ? 0 : head.at,
    records,
    entries: state.entries.map(copyEntry),
    bindings: state.bindings.map((binding) => ({ ...binding })),
    suspensions: state.suspensions.map((suspension) => ({
      ...suspension,
      scope: [...suspension.scope],
    })),
    outcomes: state.outcomes.map((outcome) => ({ ...outcome, scope: [...outcome.scope] })),
    markers: state.markers.map((marker) => ({ ...marker })),
  });
}

function mintMarker(event: SemanticEvent): Marker {
  return {
    id: event.id,
    at: event.at,
    kind: event.kind,
    weight: markerWeight(event.kind),
    entry: event.entry,
  };
}

/** Every semantic marker this journal mints, in append order. */
export function markersOf(events: readonly SemanticEvent[]): readonly string[] {
  return events.filter((event) => mintsMarker(event.kind)).map((event) => event.id);
}

/**
 * The model at one marker, or at the live head when no marker is named.
 *
 * The prefix ends at the record the marker identifies, so a later record is
 * not merely hidden — it is never applied, and there is nothing in the answer
 * for it to have touched. Naming the live head applies every record, including
 * any that arrived while expansion was held somewhere earlier.
 */
export function projectPrefix(
  execution: string,
  events: readonly SemanticEvent[],
  through?: string,
): Result<SemanticModel> {
  let end = events.length;
  if (through !== undefined) {
    const at = events.findIndex((event) => event.id === through && mintsMarker(event.kind));
    if (at === -1) {
      return Err(new UnknownMarkerError(through, markersOf(events)));
    }
    end = at + 1;
  }

  const state = draft();
  for (let index = 0; index < end; index += 1) {
    const event = events[index];
    const applied = apply(state, event);
    if (!applied.ok) {
      return applied;
    }
    if (mintsMarker(event.kind)) {
      state.markers.push(mintMarker(event));
    }
  }
  return Ok(snapshot(execution, state, end));
}

/**
 * One fold, snapshotting at every marker: what a live session accumulates.
 *
 * The answer is keyed by marker so the evidence can compare it against a
 * from-scratch projection of the same marker. It is an accelerator's shape,
 * and it is never an input to anything.
 */
export function foldMarkers(
  execution: string,
  events: readonly SemanticEvent[],
): Result<ReadonlyMap<string, SemanticModel>> {
  const state = draft();
  const accumulated = new Map<string, SemanticModel>();
  for (const [index, event] of events.entries()) {
    const applied = apply(state, event);
    if (!applied.ok) {
      return applied;
    }
    if (mintsMarker(event.kind)) {
      state.markers.push(mintMarker(event));
      accumulated.set(event.id, snapshot(execution, state, index + 1));
    }
  }
  return Ok(accumulated);
}
