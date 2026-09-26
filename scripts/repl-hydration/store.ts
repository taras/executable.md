/**
 * The actual StarFX store, hydrated from Journal plus URL.
 *
 * This is `starfx` itself — `createSchema`, `createStore`, `slice` — and not a
 * stand-in. The store is bound to the enclosing Effection scope through
 * `useScope()`, so it ends when the session that asked for it ends rather than
 * owning a scope nobody can reach.
 *
 * Everything in it is derived. Records and a URL go in; the semantic model,
 * the Execution History and the resolved location come out. Nothing is written
 * here that was not computed from those two inputs, which is what makes
 * discarding the whole store and building another one at the same URL a
 * no-op that the evidence can check by deep comparison.
 *
 * **Snapshots accelerate and never testify.** `snapshots` memoizes the model
 * of a *marker* prefix, because a prefix that ends at a record can never
 * change. The live head is never memoized: it is exactly the prefix that grows.
 * A new store starts with an empty cache and cannot be handed a populated one,
 * so a snapshot cannot outlive the process that derived it — which is the only
 * reason reading one is safe.
 *
 * The pause controller is not here. A store holds what a Journal and a URL can
 * say, and neither can say that this process is holding a continuation.
 */

import { Ok, useScope } from "effection";
import type { Operation, Result } from "effection";
import { createSchema, createStore, slice } from "starfx";
import type { FxStore } from "starfx";

import { parseJournal } from "./journal.ts";
import type { SemanticEvent } from "./journal.ts";
import { decodeRoute, encodeRoute, resolveIn } from "./location.ts";
import type { Route, SemanticLocation } from "./location.ts";
import type { Marker, SemanticModel } from "./model.ts";
import { projectPrefix } from "./project.ts";

/**
 * One Execution History row.
 *
 * Every marker the Journal has minted appears, including those after the
 * selected one: a future marker is navigation context, and the scrubber needs
 * to know it is there. What a future marker must never do is carry a fact into
 * the model, and it cannot — `position` is the only thing said about it here.
 */
export interface HistoryEntry {
  readonly id: string;
  readonly at: number;
  readonly kind: string;
  readonly weight: string;
  readonly entry: string;
  /** `past`, `selected` or `future`, relative to what the URL named. */
  readonly position: string;
}

/** What the URL selected, as identifiers rather than as model values. */
export type LocationState =
  | {
      readonly kind: "surface";
      readonly surface: string;
      readonly inspecting: boolean;
      readonly draft: string;
    }
  | {
      readonly kind: "entry";
      readonly surface: string;
      readonly entry: string;
      readonly scopes: readonly string[];
      readonly drawers: readonly string[];
      readonly inspecting: boolean;
      readonly draft: string;
    };

/**
 * Everything a reconstruction has to reproduce.
 *
 * The snapshot cache is deliberately absent. Two sessions that agree here
 * agree about the execution, whatever either one has memoized, which is what
 * makes "the cache is an accelerator" a statement the comparison can hold.
 */
export interface SemanticState {
  readonly execution: string;
  /** The one canonical spelling of the selected location. */
  readonly url: string;
  readonly model: SemanticModel;
  readonly history: readonly HistoryEntry[];
  readonly location: LocationState;
}

interface StoreShape {
  execution: string;
  url: string;
  records: readonly unknown[];
  model: SemanticModel;
  history: readonly HistoryEntry[];
  location: LocationState;
  snapshots: Readonly<Record<string, SemanticModel>>;
}

function emptyModel(): SemanticModel {
  const projected = projectPrefix("", [], undefined);
  if (!projected.ok) {
    throw projected.error;
  }
  return projected.value;
}

const EMPTY_MODEL = emptyModel();

const EMPTY_LOCATION: LocationState = {
  kind: "surface",
  surface: "transcript",
  inspecting: false,
  draft: "",
};

function schemaFor() {
  return createSchema({
    // `cache` and `loaders` are StarFX's own and this REPL uses neither. They
    // are required by the schema, and staying empty is something the evidence
    // reads rather than assumes.
    cache: slice.table(),
    loaders: slice.loaders(),
    execution: slice.str(""),
    url: slice.str(""),
    records: slice.any<readonly unknown[]>([]),
    model: slice.any<SemanticModel>(EMPTY_MODEL),
    history: slice.any<readonly HistoryEntry[]>([]),
    location: slice.any<LocationState>(EMPTY_LOCATION),
    snapshots: slice.any<Readonly<Record<string, SemanticModel>>>({}),
  });
}

type Schema = ReturnType<typeof schemaFor>[0];
type State = ReturnType<typeof schemaFor>[1];

function historyOf(
  events: readonly SemanticEvent[],
  selected: string,
  markers: readonly Marker[],
): readonly HistoryEntry[] {
  const within = new Set(markers.map((marker) => marker.id));
  const all = projectPrefix("", events, undefined);
  if (!all.ok) {
    return [];
  }
  return all.value.markers.map((marker) => ({
    id: marker.id,
    at: marker.at,
    kind: marker.kind,
    weight: marker.weight,
    entry: marker.entry,
    position: marker.id === selected ? "selected" : within.has(marker.id) ? "past" : "future",
  }));
}

function locationOf(where: SemanticLocation): LocationState {
  if (where.kind === "surface") {
    return {
      kind: "surface",
      surface: where.surface,
      inspecting: where.inspecting,
      draft: where.draft,
    };
  }
  return {
    kind: "entry",
    surface: where.surface,
    entry: where.entry.id,
    scopes: where.scopes.map((scope) => scope.name),
    drawers: where.drawers.map((drawer) => drawer.wait),
    inspecting: where.inspecting,
    draft: where.draft,
  };
}

/** Everything one hydration produces, and the memo it produced on the way. */
type Derived = Omit<StoreShape, "snapshots"> & {
  readonly memo: Readonly<Record<string, SemanticModel>>;
};

/** One hydration: records and a URL in, everything the store holds out. */
function derive(
  execution: string,
  url: string,
  records: readonly unknown[],
  snapshots: Readonly<Record<string, SemanticModel>>,
): Result<Derived> {
  const parsed = parseJournal(records);
  if (!parsed.ok) {
    return parsed;
  }
  const route = decodeRoute(url);
  if (!route.ok) {
    return route;
  }
  return deriveFrom(execution, route.value, parsed.value, records, snapshots);
}

function deriveFrom(
  execution: string,
  route: Route,
  events: readonly SemanticEvent[],
  records: readonly unknown[],
  snapshots: Readonly<Record<string, SemanticModel>>,
): Result<Derived> {
  // Only a marker prefix is memoized. The live head is the one prefix that
  // grows, so caching it would cache an answer that stops being true.
  const cached = route.at === undefined ? undefined : snapshots[route.at];
  let memo = snapshots;
  let model = cached;
  if (model === undefined) {
    const projected = projectPrefix(execution, events, route.at);
    if (!projected.ok) {
      return projected;
    }
    model = projected.value;
    if (route.at !== undefined) {
      memo = { ...snapshots, [route.at]: model };
    }
  }

  const where = resolveIn(route, model);
  if (!where.ok) {
    return where;
  }

  return Ok({
    execution,
    url: encodeRoute(route),
    records,
    model,
    history: historyOf(events, model.marker, model.markers),
    location: locationOf(where.value),
    memo,
  });
}

/**
 * One REPL session over one StarFX store.
 *
 * Every method that changes anything re-derives from the records and the URL.
 * There is no incremental patch of the semantic model, because a patch would
 * be a second way to arrive at a state and the whole claim is that there is
 * one.
 */
export interface ReplSession {
  /** What a reconstruction must reproduce. */
  semantic(): SemanticState;
  /** The whole StarFX state, for evidence that walks it. */
  state(): State;
  /** Apply one newly appended durable record, keeping the selected location. */
  append(record: unknown): Operation<Result<void>>;
  /** Select another location. The URL is authoritative. */
  navigate(url: string): Operation<Result<void>>;
  /** Throw away every memoized marker model. */
  discardSnapshots(): Operation<void>;
  /** Which markers the accelerator is currently holding. */
  cached(): readonly string[];
}

class Session implements ReplSession {
  readonly #store: FxStore<State>;
  readonly #schema: Schema;
  readonly #execution: string;

  constructor(store: FxStore<State>, schema: Schema, execution: string) {
    this.#store = store;
    this.#schema = schema;
    this.#execution = execution;
  }

  semantic(): SemanticState {
    const state = this.#store.getState();
    // Frozen like everything it holds: a caller comparing two of these is
    // comparing values, and a caller that could edit one would be editing a
    // reading of the Journal.
    return Object.freeze({
      execution: state.execution,
      url: state.url,
      model: state.model,
      history: state.history,
      location: state.location,
    });
  }

  state(): State {
    return this.#store.getState();
  }

  cached(): readonly string[] {
    return Object.keys(this.#store.getState().snapshots).toSorted();
  }

  *append(record: unknown): Operation<Result<void>> {
    const state = this.#store.getState();
    return yield* this.#settle(state.url, [...state.records, record]);
  }

  *navigate(url: string): Operation<Result<void>> {
    return yield* this.#settle(url, this.#store.getState().records);
  }

  *discardSnapshots(): Operation<void> {
    yield* this.#store.update(this.#schema.snapshots.set({}));
  }

  *#settle(url: string, records: readonly unknown[]): Operation<Result<void>> {
    const derived = derive(this.#execution, url, records, this.#store.getState().snapshots);
    if (!derived.ok) {
      return derived;
    }
    yield* this.#write(derived.value);
    return Ok();
  }

  *#write(derived: Derived): Operation<void> {
    yield* write(this.#store, this.#schema, derived);
  }
}

function* write(store: FxStore<State>, schema: Schema, derived: Derived): Operation<void> {
  yield* store.update([
    schema.execution.set(derived.execution),
    schema.url.set(derived.url),
    schema.records.set(derived.records),
    schema.model.set(derived.model),
    schema.history.set(derived.history),
    schema.location.set(derived.location),
    schema.snapshots.set(derived.memo),
  ]);
}

/**
 * Build a store and hydrate it, or refuse.
 *
 * The store takes the caller's Effection scope, so its lifetime is the
 * caller's. Hydration is the whole construction: a session that exists has
 * already read its records and resolved its URL, and there is no half-built
 * state for anything to observe.
 */
export function* hydrate(
  execution: string,
  url: string,
  records: readonly unknown[],
): Operation<Result<ReplSession>> {
  const derived = derive(execution, url, records, {});
  if (!derived.ok) {
    return derived;
  }

  const [schema, initialState] = schemaFor();
  const scope = yield* useScope();
  const store = createStore({ initialState, scope });
  yield* write(store, schema, derived.value);
  return Ok(new Session(store, schema, execution));
}
