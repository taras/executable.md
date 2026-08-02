/**
 * The record `deno task deps` leaves behind, and the digest that dates it.
 *
 * This module imports nothing. `scripts/preflight.ts` reads it on a cold cache,
 * where any third-party specifier would fail to resolve before a line of it
 * ran, and a relative source file is the only kind of import that costs
 * nothing there.
 *
 * The digest is content-based rather than a timestamp so that a checkout, a
 * branch switch, or a restored file does not read as a change. It is FNV-1a
 * rather than SHA-256 because the question is "did this file change since
 * preparation", not "can an adversary forge it", and `crypto.subtle` is
 * asynchronous — which this module cannot be, since the preflight that uses it
 * is synchronous.
 */

/** What preparation writes, and where. Inside `node_modules/`, which is untracked. */
export const PREPARED_MARKER = "node_modules/.xmd-prepared";

/** The files whose contents decide whether a preparation is still current. */
export const PREPARED_INPUTS = ["deno.lock", "package.json"];

export interface Prepared {
  /** Digest per entry of `PREPARED_INPUTS`, in that order. */
  inputs: string[];
}

const OFFSET = 0x811c9dc5;
const PRIME = 0x01000193;

export function digest(bytes: Uint8Array): string {
  let hash = OFFSET;
  for (const byte of bytes) {
    hash = Math.imul(hash ^ byte, PRIME) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function isCurrent(marker: unknown, inputs: string[]): boolean {
  if (typeof marker !== "object" || marker === null) {
    return false;
  }
  const recorded = (marker as { inputs?: unknown }).inputs;
  if (!Array.isArray(recorded) || recorded.length !== inputs.length) {
    return false;
  }
  return recorded.every((entry, index) => entry === inputs[index]);
}
