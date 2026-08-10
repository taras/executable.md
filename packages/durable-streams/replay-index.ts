/**
 * ReplayIndex — derived, in-memory structure built from the stream on startup.
 *
 * Provides per-coroutine cursored access to Yield events and keyed access
 * to Close events. See spec §4.1.
 */

import type {
  Close,
  CoroutineId,
  DurableEvent,
  EffectDescription,
  Json,
  Result,
  SerializedError,
  Yield,
} from "./types.ts";

export interface YieldEntry {
  description: EffectDescription;
  result: Result;
}

/** What one retained Yield's single read of the stream produced. */
type Settled =
  | { readonly kind: "result"; readonly result: Result }
  | { readonly kind: "refusal"; readonly refusal: unknown };

/**
 * A detached copy of one retained JSON value.
 *
 * Every property is read once and rebuilt, so nothing the stream still owns
 * remains reachable: a nested accessor cannot answer one thing to a guard and
 * another to replay, and no later mutation of the source changes what replay
 * used. Keys are defined rather than assigned, because `__proto__` reaches an
 * inherited setter on some runtimes and would rewrite the copy's prototype
 * instead of becoming a member of it.
 *
 * The copy is not frozen through. Detaching is what makes the settlement
 * stable against the journal; freezing would be a claim against the *consumer*,
 * and replayed values are legitimately mutable — an eval binding restored from
 * a journal is pushed to by the iteration that resumes on it.
 *
 * A cycle is refused. `Json` has none, and a value that does is not a retained
 * result this can detach — refusing is remembered like any other refusal.
 */
function detachJson(value: Json, seen: Set<object>): Json {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    throw new TypeError("a retained result cannot contain a cycle");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items: Json[] = [];
      for (let index = 0; index < value.length; index++) {
        items.push(detachJson(value[index]!, seen));
      }
      return items;
    }
    const detached: { [key: string]: Json } = {};
    for (const [key, member] of Object.entries(value)) {
      Object.defineProperty(detached, key, {
        value: detachJson(member, seen),
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    return detached;
  } finally {
    seen.delete(value);
  }
}

/** A detached copy of a retained failure's description. */
function detachError(error: SerializedError): SerializedError {
  const detached: SerializedError = { message: error.message };
  const name = error.name;
  const stack = error.stack;
  return Object.freeze({
    ...detached,
    ...(name === undefined ? {} : { name }),
    ...(stack === undefined ? {} : { stack }),
  });
}

/**
 * A retained result detached from everything the stream still owns.
 *
 * Each member is read exactly once, here, and the tree beneath it is rebuilt.
 * Freezing only the outer object would leave a `value` the journal can still
 * rewrite — which is the whole substitution this exists to prevent.
 */
function detachResult(result: Result): Result {
  const status = result.status;
  if (status === "ok") {
    if (!("value" in result)) {
      return Object.freeze({ status });
    }
    const value = result.value;
    return Object.freeze(
      value === undefined ? { status } : { status, value: detachJson(value, new Set()) },
    );
  }
  if (status === "err") {
    if (!("error" in result)) {
      throw new TypeError("a retained failure carries the error it failed with");
    }
    return Object.freeze({ status, error: detachError(result.error) });
  }
  return Object.freeze({ status });
}

/**
 * One retained Yield, and the one cell that owns what it settled to.
 *
 * Indexing reads a Yield's identity, because that is what indexing is for. It
 * deliberately does not read the *result*: a replay guard's check phase runs
 * after the index is built and before anything is replayed, and a guard that
 * would have refused an event must get to refuse it before the stream is asked
 * to produce what that event settled to. Reading eagerly took that chance away
 * — a backend that could not produce a result failed during construction,
 * carrying its own error out past every guard.
 *
 * The cell spans the whole replay lifecycle, not one accessor. A guard
 * validates a retained result and a replay consumer then uses it, and those
 * must be the same value: a source answering differently between the two would
 * have the guard approve one thing and execution perform another, which no
 * amount of validation downstream can detect. This is therefore the object the
 * check phase is handed as well as the one replay reads from, and the stream's
 * event is consulted at most once for either.
 *
 * The settlement is detached from the stream entirely, not merely frozen at the
 * top: the whole result tree is rebuilt from members read once each, so a
 * nested accessor beneath `value` cannot answer one thing to a guard and
 * another to replay. Both outcomes are kept — a refusal is remembered and
 * re-raised rather than retried, so a source cannot refuse the guard and then
 * answer replay.
 */
class RetainedYield implements YieldEntry {
  readonly type = "yield" as const;
  readonly coroutineId: CoroutineId;
  readonly description: EffectDescription;
  private event: Yield;
  private settled: Settled | undefined;

  constructor(event: Yield) {
    this.event = event;
    this.coroutineId = event.coroutineId;
    this.description = event.description;
  }

  get result(): Result {
    if (this.settled === undefined) {
      try {
        this.settled = { kind: "result", result: detachResult(this.event.result) };
      } catch (refusal) {
        this.settled = { kind: "refusal", refusal };
      }
    }
    if (this.settled.kind === "refusal") {
      throw this.settled.refusal;
    }
    return this.settled.result;
  }
}

export class ReplayIndex {
  private yields = new Map<CoroutineId, YieldEntry[]>();
  /** Every retained Yield in stream order, each owning its own result cell. */
  private retained: RetainedYield[] = [];
  private cursors = new Map<CoroutineId, number>();
  private closes = new Map<CoroutineId, Close>();
  /** Coroutines where replay has been disabled (run-live mode). */
  private disabled = new Set<CoroutineId>();
  /** Retained coroutine identities reached by the current definition. */
  private claimed = new Set<CoroutineId>();

  constructor(events: DurableEvent[]) {
    for (const event of events) {
      if (event.type === "yield") {
        let list = this.yields.get(event.coroutineId);
        if (!list) {
          list = [];
          this.yields.set(event.coroutineId, list);
        }
        const entry = new RetainedYield(event);
        this.retained.push(entry);
        list.push(entry);
      }
      if (event.type === "close") {
        this.closes.set(event.coroutineId, event);
      }
    }
  }

  /**
   * Every retained Yield in stream order, as the events a check phase sees.
   *
   * The same objects the replay path consumes, so a guard and a later consumer
   * observe one settled result rather than two reads of the stream.
   */
  retainedYields(): Yield[] {
    return [...this.retained];
  }

  /**
   * Disable replay for a coroutine (run-live mode).
   *
   * Once disabled, peekYield() returns undefined and hasClose() returns
   * false for this coroutine, so all subsequent effects execute live
   * and no further divergence checks are triggered.
   */
  disableReplay(coroutineId: CoroutineId): void {
    this.disabled.add(coroutineId);
  }

  /** Returns true if replay has been disabled for this coroutine. */
  isReplayDisabled(coroutineId: CoroutineId): boolean {
    return this.disabled.has(coroutineId);
  }

  /** Mark a retained coroutine identity as reached by the current run. */
  claim(coroutineId: CoroutineId): void {
    this.claimed.add(coroutineId);
    if (!this.closes.has(coroutineId)) {
      return;
    }

    const retainedIds = new Set([...this.yields.keys(), ...this.closes.keys()]);
    for (const retainedId of retainedIds) {
      if (retainedId.startsWith(`${coroutineId}.`)) {
        this.claimed.add(retainedId);
      }
    }
  }

  /**
   * Returns the next unconsumed yield for this coroutine,
   * or undefined if the cursor is past the end or replay is disabled.
   */
  peekYield(coroutineId: CoroutineId): YieldEntry | undefined {
    if (this.disabled.has(coroutineId)) {
      return undefined;
    }
    const list = this.yields.get(coroutineId);
    const cursor = this.cursors.get(coroutineId) ?? 0;
    return list?.[cursor];
  }

  /** Advances the cursor for this coroutine by one position. */
  consumeYield(coroutineId: CoroutineId): void {
    const cursor = this.cursors.get(coroutineId) ?? 0;
    this.cursors.set(coroutineId, cursor + 1);
  }

  /** Returns the current cursor position for this coroutine. */
  getCursor(coroutineId: CoroutineId): number {
    return this.cursors.get(coroutineId) ?? 0;
  }

  /** Returns true if a Close event exists for this coroutine (and replay is not disabled). */
  hasClose(coroutineId: CoroutineId): boolean {
    if (this.disabled.has(coroutineId)) {
      return false;
    }
    return this.closes.has(coroutineId);
  }

  /** Returns the Close event for this coroutine, or undefined. */
  getClose(coroutineId: CoroutineId): Close | undefined {
    if (this.disabled.has(coroutineId)) {
      return undefined;
    }
    return this.closes.get(coroutineId);
  }

  /**
   * Returns true if any non-disabled coroutine still has unconsumed yields.
   *
   * This is used by durableRun to detect early-return divergence even when
   * unconsumed entries belong to child coroutines rather than the root.
   */
  hasAnyUnconsumedYields(): boolean {
    for (const [coroutineId, entries] of this.yields.entries()) {
      if (this.disabled.has(coroutineId)) {
        continue;
      }
      const cursor = this.cursors.get(coroutineId) ?? 0;
      if (cursor < entries.length) {
        return true;
      }
    }
    return false;
  }

  /** Return the first retained coroutine not aligned with the current subtree. */
  firstUnaligned(subtreeId: CoroutineId):
    | {
        coroutineId: CoroutineId;
        cursor: number;
        totalYields: number;
      }
    | undefined {
    if (this.disabled.has(subtreeId)) {
      return undefined;
    }

    const coroutineIds = new Set([...this.yields.keys(), ...this.closes.keys()]);
    for (const coroutineId of coroutineIds) {
      if (coroutineId !== subtreeId && !coroutineId.startsWith(`${subtreeId}.`)) {
        continue;
      }
      if (this.disabled.has(coroutineId)) {
        continue;
      }
      if (this.closes.has(coroutineId)) {
        if (!this.claimed.has(coroutineId)) {
          const entries = this.yields.get(coroutineId) ?? [];
          return { coroutineId, cursor: 0, totalYields: entries.length };
        }
        continue;
      }
      const entries = this.yields.get(coroutineId) ?? [];
      const cursor = this.cursors.get(coroutineId) ?? 0;
      if (cursor < entries.length) {
        return { coroutineId, cursor, totalYields: entries.length };
      }
    }
    return undefined;
  }

  /**
   * Returns true if the cursor for this coroutine has been fully consumed
   * AND a Close event exists. This means the coroutine completed in a
   * previous run and can be treated as fully replayed.
   *
   * Returns false if replay is disabled (run-live mode).
   */
  isFullyReplayed(coroutineId: CoroutineId): boolean {
    if (this.disabled.has(coroutineId)) {
      return false;
    }
    return this.peekYield(coroutineId) === undefined && this.hasClose(coroutineId);
  }

  /** Returns the total number of yield entries for this coroutine. */
  yieldCount(coroutineId: CoroutineId): number {
    return this.yields.get(coroutineId)?.length ?? 0;
  }
}
