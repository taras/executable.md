/**
 * A stable name for a JSON value.
 *
 * Two values that differ only in key order are the same value, and
 * `JSON.stringify` would otherwise make them different names — so a document
 * that reordered a schema's properties would look like a different question and
 * replay would stop matching. Sorting the keys before serializing is what makes
 * the name depend on what the value *is*.
 *
 * The canonicalization itself lives in `./canonicalize.ts`, which names no
 * host; this module adds the digest, which needs one. Both remain exported
 * from the package root, and `@executablemd/core/canonicalize` publishes the
 * pure half for consumers that cannot load a Node builtin.
 *
 * Callers compose their own identity and hash it here, rather than handing over
 * a shape this module defines: what belongs in a fingerprint is a property of
 * the thing being identified, and two callers disagree about it. `<WebForm>`
 * names a question by its schema, UI schema, and rendered body; `<Elicit>` names
 * one by its schema and rendered message. Only the canonicalization is shared.
 */

import { createHash } from "node:crypto";
import { canonicalize } from "./canonicalize.ts";
import type { Json } from "./types.ts";

export { canonicalize };

/** The SHA-256 of a canonicalized value, as hex. */
export function canonicalFingerprint(value: Json): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}
