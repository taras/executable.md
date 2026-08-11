/**
 * The duration grammar, in one place.
 *
 * Every timeout a caller or a document writes is spelled the same way: the
 * three CLI options, and the `timeout=` modifier a block declares. A duration
 * is a positive whole number with a unit — `500ms`, `30s`, `5min`, `20min` —
 * or bare digits, which are milliseconds.
 *
 * Nothing here substitutes a value. An empty, zero, negative, or malformed
 * duration is refused where it was written, because the alternative is a run
 * bounded by a number nobody asked for.
 */

const DURATION = /^(\d+)(ms|s|min|m)?$/;

const MULTIPLIER: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  min: 60_000,
};

/** Milliseconds, or `undefined` when `text` is not a duration. */
export function asDuration(text: string): number | undefined {
  const match = DURATION.exec(text.trim());
  if (match === null) {
    return undefined;
  }
  const [, digits = "", unit = "ms"] = match;
  const value = Number(digits) * (MULTIPLIER[unit] ?? 1);
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

/** What a rejected duration says, with `label` naming where it was written. */
export function durationError(label: string, text: string): Error {
  return new Error(
    `${label} must be a duration like 500ms, 30s, or 5min, got ${JSON.stringify(text)}`,
  );
}

/** Milliseconds. Throws when `text` is not a duration this grammar accepts. */
export function parseDuration(text: string, label: string): number {
  const value = asDuration(text);
  if (value === undefined) {
    throw durationError(label, text);
  }
  return value;
}
