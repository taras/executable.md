/**
 * What a fork's source selection is, said once.
 *
 * A source owner computes this over rows it reads out of its own storage; a
 * destination owner computes it over the parts it was offered. They have to
 * agree exactly, or the anchor proves nothing — so the ordered logical value
 * and the digest over it live here, in one place, and both sides build the same
 * shape rather than each spelling their own.
 *
 * What goes in is everything a destination copies that a content identity does
 * not already imply: the checkpoint and the three head roots, the inherited
 * rows with their exact retained bytes and their root associations, each root's
 * record and its ordered reference arrays, each manifest's and blob's retained
 * metadata *including its watermark* — a digest stands for bytes and for the
 * size derived from them, never for a watermark, which is copied and can move
 * while the content stands still — and every selected checkout in the owner's
 * own order.
 */

import { sha256Hex } from "../workspace/sha256.ts";

/** One inherited row, as both sides describe it. */
export interface AnchorRow {
  readonly eventId: string;
  readonly record: string;
  readonly workspaceRootId: string;
}

/** One Workspace root's retained record and its ordered references. */
export interface AnchorRoot {
  readonly rootId: string;
  readonly formatVersion: number;
  readonly manifest: string;
  readonly manifestHashes: readonly string[];
  readonly blobHashes: readonly string[];
}

/** One content manifest's retained metadata and bytes. */
export interface AnchorManifest {
  readonly hash: string;
  readonly size: number;
  readonly lastSeen: number;
  /** The encoded manifest, base64 as the private protocol carries it. */
  readonly encoded: string;
}

/** One blob's retained metadata, without its bytes. */
export interface AnchorBlob {
  readonly hash: string;
  readonly size: number;
  readonly lastSeen: number;
}

/** One checkout, by the key it is paged under and the record it is. */
export interface AnchorCheckout {
  readonly key: string;
  readonly value: Record<string, unknown>;
}

/** The whole selection, in the order it is hashed. */
export interface ForkSelection {
  readonly checkpointEventId: string;
  readonly checkpointWorkspaceRootId: string;
  readonly runRecordWorkspaceRootId: string;
  readonly rootImportWorkspaceRootId: string;
  readonly inherited: readonly AnchorRow[];
  readonly roots: readonly AnchorRoot[];
  readonly manifests: readonly AnchorManifest[];
  readonly blobs: readonly AnchorBlob[];
  readonly checkouts: readonly AnchorCheckout[];
}

/**
 * The identity of one committed selection.
 *
 * Ordered throughout: the members are hashed in the order the owner selected
 * them, so a reordering is a different selection rather than the same one
 * described differently.
 */
export function forkSelectionAnchor(selection: ForkSelection): string {
  return sha256Hex(
    JSON.stringify({
      checkpointEventId: selection.checkpointEventId,
      checkpointWorkspaceRootId: selection.checkpointWorkspaceRootId,
      runRecordWorkspaceRootId: selection.runRecordWorkspaceRootId,
      rootImportWorkspaceRootId: selection.rootImportWorkspaceRootId,
      inherited: selection.inherited.map((row) => [row.eventId, row.record, row.workspaceRootId]),
      roots: selection.roots.map((root) => ({
        rootId: root.rootId,
        formatVersion: root.formatVersion,
        manifest: root.manifest,
        manifestHashes: [...root.manifestHashes],
        blobHashes: [...root.blobHashes],
      })),
      manifests: selection.manifests.map((manifest) => ({
        hash: manifest.hash,
        size: manifest.size,
        lastSeen: manifest.lastSeen,
        encoded: manifest.encoded,
      })),
      blobs: selection.blobs.map((blob) => ({
        hash: blob.hash,
        size: blob.size,
        lastSeen: blob.lastSeen,
      })),
      checkouts: selection.checkouts.map((checkout) => [checkout.key, checkout.value]),
    }),
  );
}

/**
 * One checkout's identity, as a key nothing else can spell.
 *
 * A Repository name and a Worktree name are retained text and may hold any
 * character, so joining them with a separator is not an identity: `("a:b", "c")`
 * and `("a", "b:c")` are two retained Worktrees that would join to one string.
 * A JSON array of the parts escapes what it must and separates what it must.
 */
export function checkoutKey(parts: readonly string[]): string {
  return JSON.stringify(parts);
}
