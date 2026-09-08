/**
 * A stable name for one value, computed the same way on every host.
 *
 * `canonicalFingerprint` says exactly this and reaches `node:crypto` to say it,
 * which is a host builtin a run's owner cannot load. The two halves it is made
 * of are both here already — the canonicalization the shared record module
 * uses, and the SHA-256 the Workspace identities are computed with — so this
 * composes them and produces the same digest for the same value.
 */

import type { Json } from "@executablemd/durable-streams";
import { canonicalJson } from "../storage/record.ts";
import { sha256Hex } from "../workspace/sha256.ts";

/** The SHA-256 of a canonicalized value, as hex. */
export function fingerprintOfValue(value: Json): string {
  return sha256Hex(canonicalJson(value));
}
