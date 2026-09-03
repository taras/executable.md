/**
 * ReplayIndex — derived, in-memory structure built from the stream on startup.
 *
 * Provides per-coroutine cursored access to Yield events and keyed access
 * to Close events. See spec §4.1.
 */

import { retainEvents } from "./retained.ts";
import type {
  Close,
  CoroutineId,
  DurableEvent,
  EffectDescription,
  Result,
  Yield,
} from "./types.ts";

export interface YieldEntry {
  description: EffectDescription;
  result: Result;
}

export class ReplayIndex {
  private yields = new Map<CoroutineId, Yield[]>();
  /** Every retained Yield in stream order, each owning its own settled cells. */
  private retained: Yield[] = [];
  private cursors = new Map<CoroutineId, number>();
  private closes = new Map<CoroutineId, Close>();
  /** Coroutines where replay has been disabled (run-live mode). */
  private disabled = new Set<CoroutineId>();
  /** Retained coroutine identities reached by the current definition. */
  private claimed = new Set<CoroutineId>();

  /**
   * Index a journal's events by identity, without reading what they settled to.
   *
   * The events are retained first — idempotently, so a caller that already
   * produced the stable history hands the same objects on rather than a second
   * wrapping of them, and every phase then observes one identity and one
   * settlement per event.
   */
  constructor(events: DurableEvent[]) {
    for (const event of retainEvents(events)) {
      if (event.type === "yield") {
        let list = this.yields.get(event.coroutineId);
        if (!list) {
          list = [];
          this.yields.set(event.coroutineId, list);
        }
        this.retained.push(event);
        list.push(event);
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

  /**
   * Forget the retained Close for one coroutine, keeping its retained yields.
   *
   * A spawned region whose run was interrupted continues the work it had left,
   * so its retained history must stay replayable while its retained
   * `Close(cancelled)` stops standing in the way — otherwise the divergence
   * guard reads the extra effects as a coroutine continuing past its own close.
   *
   * Deliberately narrower than `disableReplay`, which would throw the history
   * away and re-run the child from the beginning. Internal: nothing exports
   * this, because deciding that a closed coroutine may continue is the
   * combinator's, and never a caller's.
   */
  reopen(coroutineId: CoroutineId): void {
    this.closes.delete(coroutineId);
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

  /**
   * Whether this coroutine walked away from retained history it never consumed.
   *
   * True once replay has been disabled for it while entries it had not reached
   * are still there — which is what a run-live decision leaves behind. It stays
   * true for every later operation in that coroutine, because the history is
   * still unconsumed however far past it execution has gone.
   *
   * An effect whose live work reaches a service this journal does not enclose
   * reads it to decide whether running live here is something it may do at all.
   * It is the index's own account, so nothing a document supplies takes part.
   */
  abandonedHistory(coroutineId: CoroutineId): boolean {
    if (!this.disabled.has(coroutineId)) {
      return false;
    }
    const list = this.yields.get(coroutineId);
    return list !== undefined && (this.cursors.get(coroutineId) ?? 0) < list.length;
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

  /**
   * Return the first retained coroutine not aligned with the current subtree.
   *
   * `entry` is the first unmatched retained protocol entry itself — the Yield
   * at the cursor, or for an unclaimed completed child its first Yield when it
   * has one and otherwise its Close — so a terminal diagnostic can name what
   * the terminating subtree did not reach, not just where it stopped.
   */
  firstUnaligned(subtreeId: CoroutineId):
    | {
        coroutineId: CoroutineId;
        cursor: number;
        totalYields: number;
        entry: Yield | Close;
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
      const close = this.closes.get(coroutineId);
      if (close !== undefined) {
        if (!this.claimed.has(coroutineId)) {
          const entries = this.yields.get(coroutineId) ?? [];
          return {
            coroutineId,
            cursor: 0,
            totalYields: entries.length,
            entry: entries[0] ?? close,
          };
        }
        continue;
      }
      const entries = this.yields.get(coroutineId) ?? [];
      const cursor = this.cursors.get(coroutineId) ?? 0;
      if (cursor < entries.length) {
        return { coroutineId, cursor, totalYields: entries.length, entry: entries[cursor] };
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
