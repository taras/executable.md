/**
 * The canonical inventory an XMD artifact is identified by.
 *
 * The manifest names every semantic record and retained byte the artifact
 * holds, and nothing about the file those bytes ended up in. Page size, free
 * space, insertion order, index layout and the path the file was written to are
 * all outside it — which is what makes the identity a statement about the
 * evidence rather than about one encoding of it.
 *
 * ## Ordering is part of the version
 *
 * Entries are sorted by kind, then by the UTF-8 byte order of the canonical
 * JSON encoding of the entry's logical identity. An identity is that kind's
 * complete natural key as a JSON scalar or array, never a delimiter-joined
 * string: joining `("a/b", "c")` and `("a", "b/c")` produces the same text, and
 * two distinct records that collided into one manifest row would be an artifact
 * whose inventory is smaller than its content.
 *
 * ## Key order is core's, not a second comparator
 *
 * Canonical JSON here is `canonicalize()` followed by `JSON.stringify`, exactly
 * as every other identity in this repository spells it. Restating the ordering
 * rule with a comparator of this module's own would be a second definition of
 * canonical JSON that could drift from the first.
 */

import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { canonicalize } from "@executablemd/core";
import type { Json } from "@executablemd/durable-streams";
import type {
  XmdArtifactContentEntry,
  XmdArtifactManifestEntryV1,
  XmdArtifactManifestV1,
} from "../../artifact/types.ts";

/** The artifact manifest version this build produces and reads. */
export const XMD_ARTIFACT_MANIFEST_VERSION = 1;

/**
 * What the artifact identity is a hash *of*, beyond the manifest bytes.
 *
 * Domain separation, so the same bytes appearing as some other structure's
 * canonical encoding cannot be presented as an artifact identity.
 */
export const XMD_ARTIFACT_IDENTITY_DOMAIN = "xmd-artifact\0v1\0";

const encoder = new TextEncoder();

/** The compact canonical JSON encoding of a value, as UTF-8 bytes. */
export function canonicalJsonBytes(value: Json): Uint8Array {
  return encoder.encode(canonicalJsonText(value));
}

/** The compact canonical JSON encoding of a value, as text. */
export function canonicalJsonText(value: Json): string {
  const text = JSON.stringify(canonicalize(value));
  if (typeof text !== "string") {
    throw new TypeError("an artifact manifest admits only JSON values");
  }
  return text;
}

/** The lowercase SHA-256 of some bytes. */
export function sha256Hex(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** The manifest row one accepted entry produces. */
export function manifestEntry(entry: XmdArtifactContentEntry): XmdArtifactManifestEntryV1 {
  return Object.freeze({
    kind: entry.kind,
    identity: entry.identity,
    encoding: entry.encoding,
    length: entry.content.byteLength,
    sha256: sha256Hex(entry.content),
  });
}

/** Two byte strings in UTF-8 order, which is `Buffer.compare` on their bytes. */
function compareBytes(left: Uint8Array, right: Uint8Array): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

/**
 * The canonical sort key of one entry: its kind, then its identity.
 *
 * Both compared as UTF-8 bytes rather than as JavaScript strings, because `<`
 * on strings compares UTF-16 code units and orders a supplementary character
 * before some of the ones that precede it in UTF-8.
 */
function compareEntries(
  left: XmdArtifactManifestEntryV1,
  right: XmdArtifactManifestEntryV1,
): number {
  const kinds = compareBytes(encoder.encode(left.kind), encoder.encode(right.kind));
  if (kinds !== 0) {
    return kinds;
  }
  return compareBytes(canonicalJsonBytes(left.identity), canonicalJsonBytes(right.identity));
}

/** The key a `(kind, identity)` pair is unique under. */
export function entryKey(kind: string, identity: Json): string {
  return `${JSON.stringify(kind)} ${canonicalJsonText(identity)}`;
}

/** One artifact's canonical manifest, its bytes, and the identity they derive. */
export interface XmdArtifactManifestBuild {
  readonly manifest: XmdArtifactManifestV1;
  /** Compact canonical JSON as UTF-8, with no byte-order mark and no newline. */
  readonly bytes: Uint8Array;
  readonly identity: string;
  /** The entries in canonical manifest order, with their content. */
  readonly ordered: readonly XmdArtifactContentEntry[];
}

/**
 * Build the manifest one set of accepted entries produces.
 *
 * `duplicate` is raised by whoever called: the writer is refusing its own
 * caller's snapshot and the reader is refusing a file, and those are different
 * conditions with different diagnostics even though the arithmetic is the same.
 */
export function buildXmdArtifactManifest(
  entries: readonly XmdArtifactContentEntry[],
  duplicate: (kind: string) => never,
): XmdArtifactManifestBuild {
  const seen = new Set<string>();
  const rows: Array<{ row: XmdArtifactManifestEntryV1; entry: XmdArtifactContentEntry }> = [];
  for (const entry of entries) {
    const key = entryKey(entry.kind, entry.identity);
    if (seen.has(key)) {
      duplicate(entry.kind);
    }
    seen.add(key);
    rows.push({ row: manifestEntry(entry), entry });
  }
  rows.sort((left, right) => compareEntries(left.row, right.row));

  const manifest: XmdArtifactManifestV1 = Object.freeze({
    version: XMD_ARTIFACT_MANIFEST_VERSION,
    entries: Object.freeze(rows.map((each) => each.row)),
  });
  const bytes = canonicalJsonBytes(manifestToJson(manifest));
  return Object.freeze({
    manifest,
    bytes,
    identity: deriveXmdArtifactIdentity(bytes),
    ordered: Object.freeze(rows.map((each) => each.entry)),
  });
}

/**
 * The manifest as a plain JSON value.
 *
 * An interface has no index signature, so the manifest is written out member by
 * member rather than asserted into `Json`. Doing it here is also what keeps the
 * encoded shape and the declared shape one decision.
 */
export function manifestToJson(manifest: XmdArtifactManifestV1): Json {
  return {
    version: manifest.version,
    entries: manifest.entries.map((entry) => ({
      kind: entry.kind,
      identity: entry.identity,
      encoding: entry.encoding,
      length: entry.length,
      sha256: entry.sha256,
    })),
  };
}

/** The lowercase SHA-256 of the domain prefix followed by the manifest bytes. */
export function deriveXmdArtifactIdentity(manifestBytes: Uint8Array): string {
  return createHash("sha256")
    .update(XMD_ARTIFACT_IDENTITY_DOMAIN, "utf8")
    .update(manifestBytes)
    .digest("hex");
}
