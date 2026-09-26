/**
 * What one Journal prefix means, said as immutable values.
 *
 * This is the semantic model: the state of one REPL execution as of one
 * selected marker. It is not the Journal, and it is not a store. A StarFX
 * store is hydrated *from* this in Slice 2, and if the two ever disagree the
 * Journal is right — which is only true while this value can be rebuilt from
 * records alone.
 *
 * So a model holds one prefix, not a table of every prefix. Asking what an
 * earlier marker looked like means projecting that prefix again, never reading
 * a snapshot kept beside this one. A model that carried its own history of
 * moments would make a cached checkpoint the cheapest way to answer, and then
 * the accelerator would quietly have become the evidence.
 *
 * Every value here is frozen deeply, and every value here is plain data:
 * strings, numbers, booleans and frozen containers of them. There is no
 * optional member anywhere — a state that has a reason is a different shape
 * from one that does not — so `undefined` reaching this model is a defect and
 * `purity.ts` reports it as one.
 */

import { deepFreeze } from "../repl-compose/model.ts";

export { deepFreeze };

/** A root binding as it stood at one marker. */
export interface Binding {
  readonly name: string;
  readonly value: string;
  /** The entry whose execution published this version. */
  readonly entry: string;
  /** The marker that published this version. */
  readonly marker: string;
}

/**
 * What became of something that was opened.
 *
 * An entry or a scope is running until a record closes it. Settling carries
 * nothing. A failure and an interruption each carry their reason, and an
 * interrupted scope carries its entry's, because the Journal recorded one
 * terminal record and not one per scope.
 *
 * There are four statuses and no fifth. A scope that was still open when its
 * entry ended is `interrupted` — never `settled`, which would claim an
 * outcome the execution never reached, and never `failed`, which would invent
 * a failure for each scope out of the one the entry recorded.
 */
export type Outcome =
  | { readonly status: "running" }
  | { readonly status: "settled" }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "interrupted"; readonly reason: string };

/**
 * One user-visible scope, and the scopes opened inside it.
 *
 * Children are held in source order — the ordinal each scope has in its
 * parent's body — because concurrent siblings open in whatever order their
 * coroutines are dispatched, and the transcript is a reading of the document.
 *
 * A completed scope stays in the tree. Leaving a scope closes it rather than
 * erasing it, which is how a finished scope remains a place a URL can name.
 */
export interface Scope {
  readonly name: string;
  readonly source: number;
  readonly outcome: Outcome;
  /** The marker the scope's opening minted. */
  readonly marker: string;
  readonly children: readonly Scope[];
}

/** One durable wait, and the scope inside one entry that owns it. */
export interface Suspension {
  readonly wait: string;
  readonly entry: string;
  /** The owning scope path, outermost first. Empty means the entry's own body. */
  readonly scope: readonly string[];
  readonly prompt: string;
  readonly marker: string;
}

/** One durable outcome a background coroutine recorded. */
export interface Recorded {
  readonly entry: string;
  readonly scope: readonly string[];
  readonly label: string;
  readonly marker: string;
}

/**
 * One submitted top-level entry.
 *
 * `inherited` is the root environment the entry was submitted into: the
 * bindings published before it, as they stood then. It is what makes
 * "sequential entries inherit the latest published root bindings" a value
 * rather than a claim about ordering, and it is why a binding published by an
 * entry that later failed is still visible to the entry after it.
 */
export interface Entry {
  readonly id: string;
  readonly title: string;
  readonly outcome: Outcome;
  /** The marker the submission minted. */
  readonly marker: string;
  readonly scopes: readonly Scope[];
  readonly inherited: readonly Binding[];
}

/**
 * One semantic History marker: a navigable position, not a durable record.
 *
 * Execution History is the UI projection of the Journal, and this is its unit.
 * `weight` is how prominent the position is, which is the marker policy said
 * as a value: a submission is a boundary, an entry's end is terminal, an
 * opening is an opening, and a point fact is a small checkpoint. Only a
 * closing record mints nothing at all.
 */
export interface Marker {
  readonly id: string;
  readonly at: number;
  readonly kind: string;
  readonly weight: string;
  readonly entry: string;
}

/** One execution as of one selected marker. */
export interface SemanticModel {
  readonly execution: string;
  /** The newest marker in this prefix, which is this prefix's History head. */
  readonly marker: string;
  readonly at: number;
  /**
   * How many durable records this prefix applied.
   *
   * A marker names a record, and records after it that mint no marker are
   * still part of the live head. Holding the count is what lets the evidence
   * say whether selecting the newest marker and selecting the live head are
   * the same prefix, rather than assuming it.
   */
  readonly records: number;
  readonly entries: readonly Entry[];
  /** The root environment at this prefix, in first-publication order. */
  readonly bindings: readonly Binding[];
  /** Every unanswered wait at this prefix, in the order each opened. */
  readonly suspensions: readonly Suspension[];
  /** Every durable outcome recorded at this prefix, in append order. */
  readonly outcomes: readonly Recorded[];
  /** The Execution History of this prefix, in append order. */
  readonly markers: readonly Marker[];
}
