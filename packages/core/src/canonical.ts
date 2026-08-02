/**
 * A stable name for a JSON value.
 *
 * Two values that differ only in key order are the same value, and
 * `JSON.stringify` would otherwise make them different names — so a document
 * that reordered a schema's properties would look like a different question and
 * replay would stop matching. Sorting the keys before serializing is what makes
 * the name depend on what the value *is*.
 *
 * Callers compose their own identity and hash it here, rather than handing over
 * a shape this module defines: what belongs in a fingerprint is a property of
 * the thing being identified, and two callers disagree about it. `<WebForm>`
 * names a question by its schema, UI schema, and rendered body; `<Elicit>` names
 * one by its schema and rendered message. Only the canonicalization is shared.
 */

import { createHash } from "node:crypto";
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

/** The SHA-256 of a canonicalized value, as hex. */
export function canonicalFingerprint(value: Json): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}
