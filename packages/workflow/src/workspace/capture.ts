/**
 * Turning a tree of nodes into the canonical root that names it.
 *
 * Capture happens in two places that share nothing else. The local host walks
 * the DOFS tables inside its SQLite file; a remote runner walks a real
 * directory it materialized on disk. Neither walk is shareable — one reads rows
 * and the other reads a filesystem — but what the walk *means* has to be
 * identical, because the root identity is a digest of the encoding and two
 * hosts that encoded differently would produce two roots for one Workspace.
 *
 * So the walk stays with whoever can perform it, and everything after the walk
 * lives here: ordering, hardlink numbering, manifest encoding, chunk identity
 * and the root digest. A caller hands over what it found and receives the root
 * that describes it, or a refusal saying it does not describe one.
 *
 * The rule this exists to protect is narrow and worth stating plainly: an
 * untouched materialization must capture back to the exact root it came from.
 * If it did not, every no-op Workspace operation would propose a new root, and
 * a run would appear to change its Workspace by looking at it.
 */

import {
  compareUtf8,
  type WorkspaceRejection,
  type WorkspaceRootEntry,
  validateWorkspaceRootEntries,
  WORKSPACE_ROOT_DOMAIN,
  WORKSPACE_ROOT_FORMAT,
} from "./root-manifest.ts";
import {
  CHUNK_SIZE,
  type ContentChunkReference,
  encodeContentManifest,
} from "./content-manifest.ts";
import { sha256Hex } from "./sha256.ts";

/** One node a walk found, before anything is ordered or numbered. */
export type CapturedNode =
  | {
      readonly path: string;
      readonly kind: "directory";
      readonly mode: number;
      readonly mtime: number;
    }
  | {
      readonly path: string;
      readonly kind: "symlink";
      readonly mode: number;
      readonly mtime: number;
      readonly target: string;
    }
  | {
      readonly path: string;
      readonly kind: "file";
      readonly mode: number;
      readonly mtime: number;
      readonly size: number;
      /** The content manifest identity of this file's bytes. */
      readonly manifest: string;
      /**
       * What makes two paths the same file rather than two copies.
       *
       * An inode on a real filesystem, an inode number in DOFS. Two entries
       * sharing one are a hardlink group; `undefined` is a file reached by one
       * path. Identical bytes are deliberately *not* enough — two independent
       * files that happen to match are two files, and a capture that merged
       * them would materialize back as something the run never had.
       */
      readonly identity: string | undefined;
    };

/** What one file's bytes are, once chunked. */
export interface CapturedContent {
  readonly manifest: string;
  readonly manifestBytes: Uint8Array;
  readonly chunks: readonly ContentChunkReference[];
}

/** The root one capture describes, and the content it closes over. */
export interface CapturedRoot {
  readonly rootId: string;
  readonly manifest: string;
  readonly entries: readonly WorkspaceRootEntry[];
  /** Every content manifest identity this root names, in canonical order. */
  readonly manifests: readonly string[];
  /** Every blob identity those manifests name, in canonical order. */
  readonly blobs: readonly string[];
}

const encoder = new TextEncoder();

/**
 * Split one file's bytes the way the content store splits them.
 *
 * An empty file has no chunks, which is not the same as having one chunk of
 * nothing: its manifest names zero bytes and is still a manifest, and every
 * empty file in a Workspace shares it.
 */
export function captureContent(bytes: Uint8Array): CapturedContent {
  const chunks: ContentChunkReference[] = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    const slice = bytes.subarray(offset, Math.min(offset + CHUNK_SIZE, bytes.length));
    chunks.push({ hash: sha256Hex(slice), size: slice.length });
  }
  const manifestBytes = encodeContentManifest(chunks);
  return { manifest: sha256Hex(manifestBytes), manifestBytes, chunks };
}

/** The identity a canonical root manifest has. */
export function workspaceRootIdOf(manifest: string): string {
  return sha256Hex(`${WORKSPACE_ROOT_DOMAIN}${manifest}`);
}

/**
 * Order the nodes, number the hardlink groups, and encode the root.
 *
 * Ordering is by UTF-8 bytes because that is what the format declares, and
 * hardlink groups are numbered by the byte order of their first path so that
 * the same tree numbers the same way whoever walked it — a group numbered by
 * discovery order would depend on the walk, and the two walks are different.
 *
 * The result is validated against the same entry rules a stored root is read
 * back through. A capture that produced something the reader would refuse is a
 * bug worth finding here rather than at the owner.
 */
export function captureWorkspaceRoot(
  nodes: readonly CapturedNode[],
  contents: ReadonlyMap<string, CapturedContent>,
  reject: WorkspaceRejection,
): CapturedRoot {
  const ordered = nodes.toSorted((left, right) => compareUtf8(left.path, right.path));

  const shared = new Map<string, string[]>();
  for (const node of ordered) {
    if (node.kind === "file" && node.identity !== undefined) {
      shared.set(node.identity, [...(shared.get(node.identity) ?? []), node.path]);
    }
  }
  const group = new Map<string, string>();
  const groups = [...shared.values()]
    .filter((paths) => paths.length > 1)
    .map((paths) => paths.toSorted(compareUtf8))
    .toSorted((left, right) => compareUtf8(left[0] ?? "", right[0] ?? ""));
  for (const [index, paths] of groups.entries()) {
    for (const path of paths) {
      group.set(path, `h${index}`);
    }
  }

  const entries: WorkspaceRootEntry[] = ordered.map((node) => {
    if (node.kind === "directory") {
      return { path: node.path, kind: node.kind, mode: node.mode, mtime: node.mtime };
    }
    if (node.kind === "symlink") {
      return {
        path: node.path,
        kind: node.kind,
        mode: node.mode,
        mtime: node.mtime,
        target: node.target,
      };
    }
    return {
      path: node.path,
      kind: node.kind,
      mode: node.mode,
      mtime: node.mtime,
      size: node.size,
      manifest: node.manifest,
      hardlink: group.get(node.path) ?? null,
    };
  });

  validateWorkspaceRootEntries(entries, reject);
  const manifest = JSON.stringify({ format: WORKSPACE_ROOT_FORMAT, entries });

  const manifests = new Set<string>();
  const blobs = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "file") {
      continue;
    }
    const content = contents.get(entry.manifest);
    if (content === undefined) {
      reject("a captured Workspace file names content the capture did not produce");
    }
    if (entry.size !== content.chunks.reduce((total, chunk) => total + chunk.size, 0)) {
      reject("a captured Workspace file size disagrees with its content");
    }
    manifests.add(entry.manifest);
    for (const chunk of content.chunks) {
      blobs.add(chunk.hash);
    }
  }

  return {
    rootId: workspaceRootIdOf(manifest),
    manifest,
    entries,
    manifests: [...manifests].toSorted(compareUtf8),
    blobs: [...blobs].toSorted(compareUtf8),
  };
}
