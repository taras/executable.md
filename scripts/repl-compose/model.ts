/**
 * What the execution recorded, said as immutable values.
 *
 * This is where history-record access ends. Nothing downstream of here —
 * routing, composition, layout or rendering — reads a history record, which is
 * why the projection in `history.ts` is the only module that imports one. The
 * durable Journal those records are read from sits above this experiment
 * entirely and is not represented here. A consumer
 * that wants to know what was open at a moment asks a `Checkpoint`, and a
 * consumer that wants to know where the execution got to asks for the head.
 *
 * Every value here is frozen, and frozen deeply. A model handed to a router, a
 * component or a renderer is a value those layers may read and may not edit, so
 * the freeze is the contract rather than a convention: assigning through one
 * throws in a module, which is what the evidence checks.
 */

/**
 * One durable wait, and the scope that owns it.
 *
 * Ownership is the entry *and* the path inside it, because a scope path alone
 * is only meaningful within one entry: two entries can each run a `document`
 * scope, and a wait belonging to one of them is not a drawer the other can
 * open. `scope` is that path, outermost first, in the same spelling a route
 * segment uses; an empty path means the entry's own body owns the wait.
 */
export interface Suspension {
  readonly kind: string;
  readonly entry: string;
  readonly scope: readonly string[];
  readonly prompt: string;
}

/**
 * One scope the execution entered, and the scopes it opened inside itself.
 *
 * A scope that exited stays in the tree and becomes `settled`. An entry's
 * transcript keeps its whole structure — leaving a scope closes it, it does not
 * erase it — so a settled scope is still a place a URL can name, which is how
 * bindings a finished scope published stay reachable.
 */
export interface Scope {
  readonly name: string;
  readonly settled: boolean;
  readonly children: readonly Scope[];
}

/** One transcript entry, which owns its scope tree. */
export interface Entry {
  readonly id: string;
  readonly title: string;
  readonly scopes: readonly Scope[];
}

/**
 * The complete recorded moment at one history boundary.
 *
 * A checkpoint is self-contained on purpose: reconstructing the moment it names
 * needs nothing but this value. That is what lets the same URL resolve against
 * one checkpoint and refuse against another, and it is why the entries here are
 * this checkpoint's own snapshot rather than a reference to a mutable head.
 */
export interface Checkpoint {
  readonly marker: string;
  readonly at: number;
  readonly entries: readonly Entry[];
  /** The nested suspension stack, outermost first. The last one is the top. */
  readonly suspensions: readonly Suspension[];
}

/** One execution, its recorded checkpoints, and where its head reached. */
export interface ReplModel {
  readonly execution: string;
  /** The marker of the newest recorded checkpoint. */
  readonly head: string;
  readonly checkpoints: readonly Checkpoint[];
}

/** The checkpoint one marker names, or `undefined` when nothing recorded it. */
export function checkpointAt(model: ReplModel, marker: string): Checkpoint | undefined {
  return model.checkpoints.find((checkpoint) => checkpoint.marker === marker);
}

/** The head checkpoint, which is the newest moment the execution recorded. */
export function headCheckpoint(model: ReplModel): Checkpoint | undefined {
  return checkpointAt(model, model.head);
}

/**
 * `value`, frozen through every array and object it reaches.
 *
 * The projection builds each checkpoint by copying, so nothing here is shared
 * with a later moment and freezing one cannot freeze a value another moment is
 * still assembling.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const member of Object.values(value)) {
    deepFreeze(member);
  }
  return Object.freeze(value);
}
