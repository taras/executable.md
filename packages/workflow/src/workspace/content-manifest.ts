/**
 * How a file's bytes are described, once they are in the content store.
 *
 * A Workspace root names a file's content by one identity; it says nothing
 * about how those bytes are kept. That is this format's job: an ordered list of
 * chunks, each named by its own digest, encoded canonically so that identical
 * bytes always produce one identity.
 *
 * Every host keeps content this way, so the rules are shared and name no host.
 * Which store implements them, and in what tables, is the storage adapter's
 * business and stays there — a neutral module that named one would be the
 * Workspace surface learning where it happened to be kept.
 *
 * Nothing here opens a store, hashes anything or names a runtime. It decides
 * whether a sequence of bytes is a canonically encoded manifest, and produces
 * the bytes one ought to be.
 */

import { SHA256, type WorkspaceRejection } from "./root-manifest.ts";

/**
 * The size a file's bytes are split at.
 *
 * Pinned to what the vendored content layer uses. A writer that chunked
 * differently would compute different manifest identities for identical bytes,
 * and the store would then hold two names for one file.
 */
export const CHUNK_SIZE = 512 * 1024;

/** One chunk a file's bytes are stored as. */
export interface ContentChunkReference {
  readonly hash: string;
  readonly size: number;
}

/** One file's bytes, as the store describes them. */
export interface ContentManifest {
  readonly size: number;
  readonly chunks: readonly ContentChunkReference[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** The bytes a content manifest is stored and identified as. */
export function encodeContentManifest(chunks: readonly ContentChunkReference[]): Uint8Array {
  return encoder.encode(
    JSON.stringify({
      version: 1,
      chunks: chunks.map((chunk) => ({ hash: chunk.hash, size: chunk.size })),
    }),
  );
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function members(value: unknown): Map<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return new Map(Object.entries(value));
}

function declares(found: Map<string, unknown>, expected: readonly string[]): boolean {
  return found.size === expected.length && expected.every((name) => found.has(name));
}

/**
 * The manifest one encoding describes, without a store to look anything up
 * in.
 *
 * The same bytes are validated in more than one place — by a live run reading
 * its own content store, by a reader checking a detached copy, and by an owner
 * about to send a copy to a runner. What is decided here is only whether these
 * bytes are a canonically encoded content manifest at all, and what size the
 * chunks it names add up to. That the chunks exist is whoever called's to prove.
 */
export function decodeContentManifest(
  encoded: Uint8Array,
  reject: WorkspaceRejection,
): ContentManifest {
  let text: string;
  let offered: unknown;
  try {
    text = decoder.decode(encoded);
    offered = JSON.parse(text);
  } catch {
    reject("a content manifest is not canonical UTF-8 JSON");
  }
  const found = members(offered);
  const chunks = found?.get("chunks");
  if (
    found === undefined ||
    !declares(found, ["version", "chunks"]) ||
    found.get("version") !== 1 ||
    !Array.isArray(chunks)
  ) {
    reject("a content manifest is not canonically encoded");
  }
  const references: ContentChunkReference[] = [];
  for (const chunk of chunks) {
    const entry = members(chunk);
    const hash = entry?.get("hash");
    const size = entry?.get("size");
    if (
      entry === undefined ||
      !declares(entry, ["hash", "size"]) ||
      typeof hash !== "string" ||
      !SHA256.test(hash) ||
      !isSafeInteger(size) ||
      size < 1
    ) {
      // A zero-length chunk names no bytes, so a manifest that lists one is
      // describing content it does not have.
      reject("a content manifest is not canonically encoded");
    }
    references.push({ hash, size });
  }
  if (JSON.stringify({ version: 1, chunks: references }) !== text) {
    reject("a content manifest is not canonically encoded");
  }
  const total = references.reduce((sum, chunk) => sum + chunk.size, 0);
  if (!Number.isSafeInteger(total)) {
    reject("a content manifest names more bytes than a size can hold");
  }
  return Object.freeze({ size: total, chunks: Object.freeze(references) });
}
