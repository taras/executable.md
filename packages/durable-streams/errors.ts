/**
 * Error types for the durable execution protocol.
 */

import type { Close, CoroutineId, EffectDescription, Json, Yield } from "./types.ts";

/**
 * The description field an authored source position occupies.
 *
 * A durable effect's identity is its `type` and `name` and nothing else, so a
 * position travels beside them under this stable namespaced field. It is
 * stored, filtered diagnostic data: never compared during divergence
 * detection, never part of admission.
 */
export const SOURCE_POSITION_FIELD = "executablemd.source-position";

/**
 * Render one effect description for a divergence diagnostic.
 *
 * The identity renders as `type("name")`. When the description retains the
 * exact normalized source shape under `SOURCE_POSITION_FIELD` — an optional
 * non-empty `path`, an integer `offset` of at least 0, integer `line` and
 * `column` of at least 1, and no other member — its human spelling,
 * `path:line:column` or `line:column` without a path, never the offset, is
 * appended as ` at …`. Anything else renders nothing at all: formatting a
 * diagnostic must not introduce a new failure.
 */
export function describeEffect(description: EffectDescription): string {
  return `${description.type}("${description.name}")${renderedSource(description)}`;
}

const SOURCE_MEMBERS = ["path", "offset", "line", "column"];

function renderedSource(description: EffectDescription): string {
  const field = description[SOURCE_POSITION_FIELD];
  if (field === null || typeof field !== "object" || Array.isArray(field)) {
    return "";
  }
  if (Object.keys(field).some((member) => !SOURCE_MEMBERS.includes(member))) {
    return "";
  }
  const { path, offset, line, column } = field;
  if (!isCoordinate(offset, 0) || !isCoordinate(line, 1) || !isCoordinate(column, 1)) {
    return "";
  }
  if (path === undefined) {
    return ` at ${line}:${column}`;
  }
  if (typeof path !== "string" || path === "") {
    return "";
  }
  return ` at ${path}:${line}:${column}`;
}

function isCoordinate(value: Json | undefined, least: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= least;
}

/**
 * The terminal-divergence message, naming the first retained entry the
 * terminating subtree did not reach when one was selected.
 */
function withUnreached(message: string, unconsumed: Yield | Close | undefined): string {
  if (unconsumed === undefined) {
    return message;
  }
  if (unconsumed.type === "close") {
    return `${message}; first unreached entry is the Close of coroutine ${unconsumed.coroutineId}`;
  }
  return `${message}; first unreached entry is ${describeEffect(unconsumed.description)}`;
}

/**
 * Raised when a durable event cannot be persisted.
 *
 * Persistence failures are protocol failures, not workflow outcomes. The
 * adapter error remains available as the cause, and no compensating Close is
 * written over the unpersisted event.
 */
export class DurablePersistenceError extends Error {
  override name = "DurablePersistenceError";

  constructor(eventType: "yield" | "close", cause: unknown) {
    super(`Failed to persist durable ${eventType} event`, { cause });
  }
}

/**
 * Raised when a persisted record does not describe a `DurableEvent`.
 *
 * `path` locates the offending member within the record, such as
 * `$.result.error.message`. Members the protocol does not name appear as `*`,
 * because a record's own member names are as much retained content as its
 * values. Neither the path nor the message repeats anything from the record: a
 * journal is retained, filtered history, and a parse failure is not a reason to
 * copy its contents into an error that travels to logs and terminals.
 */
export class MalformedDurableEventError extends Error {
  override name = "MalformedDurableEventError";

  /** Location of the offending member within the record. */
  path: string;

  constructor(reason: string, path: string) {
    super(`${reason} at ${path}`);
    this.path = path;
  }
}

/**
 * Raised when the replay index entry at the current cursor position
 * does not match the effect yielded by the generator. See spec §6.2.
 *
 * A DivergenceError is NOT recoverable. The workflow cannot continue
 * because the generator's execution path has diverged from the recorded
 * history.
 */
export class DivergenceError extends Error {
  override name = "DivergenceError";

  coroutineId: CoroutineId;
  /** Cursor position within the coroutine where divergence was detected. */
  position: number;
  /** The description from the journal (what was expected). */
  expected: EffectDescription;
  /** The description from the generator (what was actually yielded). */
  actual: EffectDescription;

  constructor(
    coroutineId: CoroutineId,
    position: number,
    expected: EffectDescription,
    actual: EffectDescription,
    message?: string,
  ) {
    super(
      message ??
        `Divergence at ${coroutineId}[${position}]: ` +
          `expected ${describeEffect(expected)}, got ${describeEffect(actual)}`,
    );
    this.coroutineId = coroutineId;
    this.position = position;
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Raised when a workflow terminates while replay still has unconsumed entries.
 * The retained journal describes effects that the current execution did not
 * reach, so no terminal Close may be appended over that history.
 */
export class TerminalDivergenceError extends Error {
  override name = "TerminalDivergenceError";

  coroutineId: CoroutineId;
  consumedCount: number;
  totalCount: number;
  /** The first retained entry the terminating subtree did not reach. */
  unconsumed?: Yield | Close;

  constructor(
    coroutineId: CoroutineId,
    consumedCount: number,
    totalCount: number,
    options: { cause?: unknown; message?: string; unconsumed?: Yield | Close } = {},
  ) {
    super(
      withUnreached(
        options.message ??
          `Divergence: workflow ${coroutineId} terminated after ${consumedCount} yields, ` +
            `but journal has ${totalCount} yield entries`,
        options.unconsumed,
      ),
      { cause: options.cause },
    );
    this.coroutineId = coroutineId;
    this.consumedCount = consumedCount;
    this.totalCount = totalCount;
    this.unconsumed = options.unconsumed;
  }
}

/**
 * Raised when the generator finishes (returns) while the replay index
 * still has unconsumed entries for this coroutine. See spec §6.3.
 */
export class EarlyReturnDivergenceError extends TerminalDivergenceError {
  override name = "EarlyReturnDivergenceError";

  constructor(
    coroutineId: CoroutineId,
    consumedCount: number,
    totalCount: number,
    unconsumed?: Yield | Close,
  ) {
    super(coroutineId, consumedCount, totalCount, {
      message:
        `Divergence: generator ${coroutineId} returned after ${consumedCount} yields, ` +
        `but journal has ${totalCount} yield entries`,
      unconsumed,
    });
  }
}

/**
 * Raised when the journal has a Close event for a coroutine but the
 * generator has not finished after consuming all recorded yields.
 * See spec §6.3.
 */
export class ContinuePastCloseDivergenceError extends Error {
  override name = "ContinuePastCloseDivergenceError";

  coroutineId: CoroutineId;
  yieldCount: number;

  constructor(coroutineId: CoroutineId, yieldCount: number) {
    super(
      `Divergence: journal shows ${coroutineId} closed after ${yieldCount} yields, but generator continues to yield effects`,
    );
    this.coroutineId = coroutineId;
    this.yieldCount = yieldCount;
  }
}

/**
 * Raised by a replay guard when a journal entry's recorded result is
 * stale (e.g., the source file has changed since the effect was
 * originally executed).
 *
 * Guards detect staleness by comparing current state against data stored
 * in the effect description (input fields like file path) and result
 * value (output fields like content hash).
 *
 * StaleInputError is NOT a divergence — the effect identity matches,
 * but the external world has changed. The correct response depends on
 * application policy: re-run from scratch, accept stale results, or
 * (in future versions) re-execute the effect and continue.
 *
 * See replay-guard-spec.md §4.4.
 */
export class StaleInputError extends Error {
  override name = "StaleInputError";

  /** The Yield event that was detected as stale. */
  event?: { coroutineId: string; description: { type: string; name: string } };

  constructor(
    /** Human-readable description of what changed. */
    message: string,
    /** The Yield event that was detected as stale. */
    event?: {
      coroutineId: string;
      description: { type: string; name: string };
    },
  ) {
    super(message);
    this.event = event;
  }
}
