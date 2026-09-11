/**
 * A stable name for a JSON value, with no host behind it.
 *
 * Two values that differ only in key order are the same value, and
 * `JSON.stringify` would otherwise make them different names — so a document
 * that reordered a schema's properties would look like a different question and
 * replay would stop matching. Sorting the keys before serializing is what makes
 * the name depend on what the value *is*.
 *
 * This is a leaf on purpose. The operation is pure arithmetic over a JSON
 * value, and it sat beside `canonicalFingerprint()`, which reaches
 * `node:crypto` — so a runtime that has no Node builtins could not import one
 * without the other, and a Cloudflare Worker that needs to canonicalize a
 * record could not do it at all. Nothing here imports anything but a type.
 */

import type { Json, JsonObject } from "./types.ts";

/** The same value with every object's keys in sorted order. */
export function canonicalize(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const sorted: JsonObject = {};
  for (const key of Object.keys(value).sort()) {
    // Defined rather than assigned: `sorted[key] = …` reaches
    // `Object.prototype`'s setter for `__proto__` and drops the key on Node and
    // Bun, so a schema declaring that name would canonicalize differently
    // depending on where it ran.
    Object.defineProperty(sorted, key, {
      value: canonicalize(value[key]),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return sorted;
}
