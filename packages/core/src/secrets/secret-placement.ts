import type { SecretSpan } from "./scanner.ts";

/** One approved match, in the coordinates of the field it was found in. */
export interface ApprovedMatch extends SecretSpan {
  /** The exact matched bytes, held only in memory for the life of the approval. */
  readonly bytes: string;
}

/** Whether one located span is exactly one approved match. */
export function exactly(
  approved: readonly SecretSpan[],
  span: SecretSpan,
  start: number,
  end: number,
): boolean {
  return approved.some(
    (one) =>
      one.ruleId === span.ruleId &&
      one.messageId === span.messageId &&
      one.start === start &&
      one.end === end,
  );
}

export type Path = readonly (string | number)[];

/** One string field, where the event's serialization holds its literal. */
interface Placed {
  readonly value: string;
  /** Offset of the literal's opening quote in the serialized event. */
  readonly at: number;
  /** For each content offset of the literal, the value index it begins, or -1. */
  readonly boundaries: Map<number, number>;
  readonly length: number;
}

/**
 * Where each named string field sits in this exact serialization.
 *
 * Found by serializing the same event with each field replaced by a unique
 * marker and then putting the real literals back: what that reconstructs must
 * be byte-identical to what the gate scanned, or nothing is placed. A field
 * that is absent or not a string places nothing either.
 */
export function place(
  serialized: string,
  paths: readonly Path[],
  indent?: number,
): Placed[] | undefined {
  let copy: unknown;
  try {
    copy = JSON.parse(serialized);
  } catch {
    return undefined;
  }
  const nonce = crypto.randomUUID();
  const values: string[] = [];
  for (const [index, path] of paths.entries()) {
    const parent = walk(copy, path.slice(0, -1));
    const key = path[path.length - 1];
    if (parent === undefined || key === undefined || !Object.hasOwn(parent, key)) {
      return undefined;
    }
    const value = (parent as Record<string | number, unknown>)[key];
    if (typeof value !== "string") {
      return undefined;
    }
    values.push(value);
    (parent as Record<string | number, unknown>)[key] = `\u0001${nonce}:${index}\u0001`;
  }
  const marked = `${JSON.stringify(copy, null, indent)}\n`;
  const located = values
    .map((value, index) => {
      const marker = JSON.stringify(`\u0001${nonce}:${index}\u0001`);
      const at = marked.indexOf(marker);
      return { index, value, at, marker };
    })
    .sort((a, b) => a.at - b.at);
  if (located.some((one) => one.at < 0)) {
    return undefined;
  }
  let rebuilt = "";
  let cursor = 0;
  const placed: Placed[] = new Array(values.length);
  for (const one of located) {
    rebuilt += marked.slice(cursor, one.at);
    const literal = JSON.stringify(one.value);
    const boundaries = boundariesOf(one.value);
    if (boundaries === undefined) {
      return undefined;
    }
    placed[one.index] = {
      value: one.value,
      at: rebuilt.length,
      boundaries,
      length: literal.length,
    };
    rebuilt += literal;
    cursor = one.at + one.marker.length;
  }
  rebuilt += marked.slice(cursor);
  return rebuilt === serialized ? placed : undefined;
}

export function encodedOffset(field: Placed | undefined, index: number): number | undefined {
  if (field === undefined) {
    return undefined;
  }
  for (const [offset, unit] of field.boundaries) {
    if (unit === index) {
      return field.at + 1 + offset;
    }
  }
  return undefined;
}

/** Translate one serialized span into a field's own value coordinates. */
export function within(
  placed: readonly Placed[],
  span: SecretSpan,
): { leaf: number; value: string; start: number; end: number } | undefined {
  for (const [leaf, one] of placed.entries()) {
    if (span.start <= one.at || span.end >= one.at + one.length) {
      continue;
    }
    const start = one.boundaries.get(span.start - one.at - 1);
    const end = one.boundaries.get(span.end - one.at - 1);
    if (start === undefined || end === undefined || start < 0 || end < 0) {
      return undefined;
    }
    return { leaf, value: one.value, start, end };
  }
  return undefined;
}

/**
 * Each content offset of `JSON.stringify(value)` that begins a code unit of
 * `value`, mapped to that unit's index — with the end of the value mapped to
 * its length. Offsets inside an escape sequence or between the halves of a
 * surrogate pair are not boundaries.
 */
export function boundariesOf(value: string): Map<number, number> | undefined {
  const boundaries = new Map<number, number>();
  let offset = 0;
  for (let index = 0; index < value.length; ) {
    const code = value.charCodeAt(index);
    let width = 1;
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        width = 2;
      }
    }
    boundaries.set(offset, index);
    offset += JSON.stringify(value.slice(index, index + width)).length - 2;
    index += width;
  }
  boundaries.set(offset, value.length);
  return offset === JSON.stringify(value).length - 2 ? boundaries : undefined;
}

function walk(value: unknown, path: Path): object | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, key)) {
      return undefined;
    }
    current = (current as Record<string | number, unknown>)[key];
  }
  return current !== null && typeof current === "object" ? current : undefined;
}
