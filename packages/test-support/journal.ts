/**
 * What a suite can read out of a `readonly DurableEvent[]` it already holds.
 *
 * These are pure projections over an array. They open no database, own no
 * effect vocabulary beyond the four replay-bookkeeping types below, and parse
 * a retained record only through the parser the package that defines that
 * record supplies. A suite that needs a different selection asks for it by
 * effect type rather than redefining what this repository calls bookkeeping.
 */

import type { DurableEvent, Json, SerializedError, Yield } from "@executablemd/durable-streams";

/** One selected Yield, and where it sits in the selection it came from. */
export interface SelectedYield {
  readonly position: number;
  readonly effect: string;
  readonly event: Yield;
}

/** What a package that owns a record type does with a retained value. */
export type RetainedRecordParser<T> = (value: unknown) => T | undefined;

/** What one selected effect settled as, and what it retained when it settled. */
export type RetainedOutcome<T> =
  | {
      readonly position: number;
      readonly effect: string;
      readonly status: "ok";
      readonly record: T;
    }
  | {
      readonly position: number;
      readonly effect: string;
      readonly status: "err";
      readonly error: SerializedError;
    }
  | {
      readonly position: number;
      readonly effect: string;
      readonly status: "cancelled";
    };

/**
 * The effect types replay bookkeeping writes, which no ordered claim is about.
 *
 * Fixed and private. A caller-configurable list would let two suites disagree
 * about what this repository considers bookkeeping, which is the disagreement
 * this module exists to remove.
 */
const BOOKKEEPING = new Set(["import_component", "loop", "loop_iteration", "workflow_run"]);

/**
 * The Yields of these effect types, in journal order, numbered from zero.
 *
 * The position is where the event sits in *this* selection — not a durable
 * event id and not a SQLite sequence — so it stays the coordinate a reader can
 * use to say which one a claim is about.
 */
export function selectYields(
  events: readonly DurableEvent[],
  effects: readonly string[],
): readonly SelectedYield[] {
  const wanted = new Set(effects);
  const selected: SelectedYield[] = [];
  for (const event of events) {
    if (event.type !== "yield" || !wanted.has(event.description.type)) {
      continue;
    }
    selected.push({ position: selected.length, effect: event.description.type, event });
  }
  return selected;
}

/**
 * The meaningful effect order, as values that diff readably.
 *
 * Numbering happens after the bookkeeping types are dropped, so adding or
 * removing one of them does not renumber everything a claim is about.
 */
export function effectSequence(events: readonly DurableEvent[]): readonly string[] {
  const sequence: string[] = [];
  for (const event of events) {
    if (event.type !== "yield" || BOOKKEEPING.has(event.description.type)) {
      continue;
    }
    sequence.push(`${sequence.length} ${event.description.type}`);
  }
  return sequence;
}

/**
 * What each Yield of this effect type settled as, parsing `result.value`.
 *
 * The layout a Git-host reconciliation record is retained in: the record is
 * the result value itself.
 */
export function readRetainedValues<T>(
  events: readonly DurableEvent[],
  effect: string,
  parse: RetainedRecordParser<T>,
): readonly RetainedOutcome<T>[] {
  return read(events, effect, parse, (value) => value);
}

/**
 * What each Yield of this effect type settled as, parsing `result.value.record`.
 *
 * The layout a Workspace composition or Git envelope is retained in: the
 * record is a member of the result value.
 */
export function readRetainedRecords<T>(
  events: readonly DurableEvent[],
  effect: string,
  parse: RetainedRecordParser<T>,
): readonly RetainedOutcome<T>[] {
  return read(events, effect, parse, nestedRecord);
}

function read<T>(
  events: readonly DurableEvent[],
  effect: string,
  parse: RetainedRecordParser<T>,
  retained: (value: Json) => unknown,
): readonly RetainedOutcome<T>[] {
  return selectYields(events, [effect]).map((selected) => {
    const { position } = selected;
    const result = selected.event.result;
    if (result.status === "cancelled") {
      return { position, effect, status: result.status };
    }
    if (result.status === "err") {
      return { position, effect, status: result.status, error: result.error };
    }
    const value = result.value === undefined ? undefined : retained(result.value);
    const record = value === undefined ? undefined : parse(value);
    if (record === undefined) {
      throw new Error(
        `the value retained at ${position} ${effect} is not a record its parser reads`,
      );
    }
    return { position, effect, status: result.status, record };
  });
}

function nestedRecord(value: Json): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value["record"];
}
