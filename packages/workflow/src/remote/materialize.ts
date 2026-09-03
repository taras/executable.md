/**
 * Putting one retained Workspace root on a runner, and reading it back.
 *
 * The owner holds the run and cannot run anything. Git, an Agent, an evidence
 * command — all of it needs real files, and real files are the runner's. So a
 * root is materialized into a temporary tree the invocation owns, worked in,
 * and captured back into a proposal the owner validates and publishes.
 *
 * Two things this module refuses to know. It does not know a runtime: every
 * native operation arrives as an injected Effection operation, so the same code
 * materializes onto whatever filesystem the host adapter wrapped. And it does
 * not treat the host path as identity — the logical Workspace root is `/`, the
 * temporary directory is an implementation detail of this invocation, and no
 * part of the host path reaches a manifest, a journal event, a proposal or an
 * error. A run that recorded where it happened to be unpacked would be a run
 * that could not be resumed anywhere else.
 *
 * Everything is verified twice. The owner validated the root before sending it
 * and the connection verified each piece on arrival; this verifies again on the
 * way to disk, because what must be true is not "the owner was honest" but
 * "these bytes are the bytes this root names". The same holds coming back: a
 * capture is checked against the rules a stored root is read through before it
 * is ever proposed.
 */

import { type Operation } from "effection";
import {
  captureContent,
  type CapturedContent,
  type CapturedNode,
  type CapturedRoot,
  captureWorkspaceRoot,
} from "../workspace/capture.ts";
import {
  compareUtf8,
  decodeDofsManifest,
  type WorkspaceRejection,
  type WorkspaceRootManifest,
} from "../workspace/root-manifest.ts";
import { sha256Hex } from "../workspace/sha256.ts";
import type { RemoteReadLink } from "./read.ts";

/** One node the runner found, as its host describes one. */
export interface RunnerNode {
  readonly name: string;
  readonly kind: "directory" | "file" | "symlink";
  readonly mode: number;
  /** Whole seconds, matching what a retained entry carries. */
  readonly mtime: number;
  readonly size: number;
  /**
   * What makes two paths one file.
   *
   * The host's own answer — an inode, or whatever stands in for one. Absent
   * means the host cannot say, and every file is then its own.
   */
  readonly identity: string | undefined;
  /** Present only for a symbolic link, and never followed. */
  readonly target: string | undefined;
}

/**
 * The native operations materialization needs, and only those.
 *
 * Deliberately small and deliberately injected. Nothing here opens a process,
 * resolves a symbolic link, or reaches outside the directory it was given.
 */
export interface RunnerFiles {
  makeDirectory(path: string, mode: number): Operation<void>;
  writeFile(path: string, bytes: Uint8Array, mode: number): Operation<void>;
  makeSymlink(target: string, path: string): Operation<void>;
  makeHardlink(existing: string, path: string): Operation<void>;
  /** Applied last, because writing into a directory moves its own time. */
  setModifiedAt(path: string, mtime: number): Operation<void>;
  readFile(path: string): Operation<Uint8Array>;
  /** One directory's entries, described without following a link. */
  list(path: string): Operation<RunnerNode[]>;
  /** One path, described without following a link. */
  describe(path: string): Operation<RunnerNode>;
}

/** Where one logical Workspace path sits on this host, for this invocation. */
export type HostPath = (logical: string) => string;

/**
 * Materialize the exact root, one bounded piece at a time.
 *
 * Entries are created in canonical order, which is also parent-before-child
 * order for everything but the depth ordering a restore needs — so directories
 * are created as they are met and a file never arrives before the directory
 * holding it. A hardlink group's first member is written and the rest are
 * linked to it, which is what makes them one file again rather than copies.
 *
 * Times are set after the tree exists. Writing a file into a directory updates
 * that directory's own time, so setting times as we went would leave every
 * directory carrying the moment it was filled rather than the moment the root
 * records.
 */
export function* materializeWorkspaceRoot(
  files: RunnerFiles,
  reads: RemoteReadLink,
  at: HostPath,
  workspaceRootId: string,
  reject: WorkspaceRejection,
): Operation<WorkspaceRootManifest> {
  const manifest = yield* reads.root(workspaceRootId);
  const written = new Map<string, string>();
  const times: { path: string; mtime: number }[] = [];

  for (const entry of manifest.entries) {
    const path = at(entry.path);
    if (entry.kind === "directory") {
      if (entry.path !== "/") {
        yield* files.makeDirectory(path, entry.mode);
      }
      times.push({ path, mtime: entry.mtime });
      continue;
    }
    if (entry.kind === "symlink") {
      // Created, never followed. A retained link may point anywhere, including
      // outside the tree, and resolving one here would be this code deciding to
      // read something the Workspace merely mentions.
      yield* files.makeSymlink(entry.target, path);
      continue;
    }

    const first = written.get(entry.manifest);
    if (entry.hardlink !== null && first !== undefined) {
      yield* files.makeHardlink(first, path);
      continue;
    }
    const bytes = yield* fetchFile(reads, workspaceRootId, entry.manifest, entry.size, reject);
    yield* files.writeFile(path, bytes, entry.mode);
    if (entry.hardlink !== null) {
      written.set(entry.manifest, path);
    }
    times.push({ path, mtime: entry.mtime });
  }

  // Deepest first, so filling a directory cannot move a time already set.
  for (const entry of times.toReversed()) {
    yield* files.setModifiedAt(entry.path, entry.mtime);
  }
  return manifest;
}

/** One file's bytes, assembled from the chunks its manifest names. */
function* fetchFile(
  reads: RemoteReadLink,
  workspaceRootId: string,
  manifestDigest: string,
  size: number,
  reject: WorkspaceRejection,
): Operation<Uint8Array> {
  const encoded = yield* reads.content(workspaceRootId, {
    kind: "manifest",
    digest: manifestDigest,
  });
  const manifest = decodeDofsManifest(encoded.bytes, reject);
  if (manifest.size !== size) {
    reject("a retained Workspace file size disagrees with the manifest it names");
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of manifest.chunks) {
    const piece = yield* reads.content(workspaceRootId, {
      kind: "blob",
      digest: chunk.hash,
      manifestDigest,
    });
    if (piece.bytes.length !== chunk.size) {
      reject("a retained content piece is not the size its manifest declares");
    }
    bytes.set(piece.bytes, offset);
    offset += piece.bytes.length;
  }
  if (offset !== size) {
    reject("a retained Workspace file is not the size its entry declares");
  }
  return bytes;
}

/** What a capture produced, and the content it must be able to supply. */
export interface CapturedWorkspace {
  readonly root: CapturedRoot;
  readonly contents: ReadonlyMap<string, CapturedContent>;
  /** Every blob identity, with the bytes to send if the owner lacks it. */
  readonly blobs: ReadonlyMap<string, Uint8Array>;
}

/**
 * Read the tree back as the root it now describes.
 *
 * A walk, then the shared rules. Nothing here decides ordering, numbering or
 * encoding — those belong to the capture rules both hosts share, so that this
 * walk and the local provider's walk of its own tables cannot drift apart.
 */
export function* captureWorkspace(
  files: RunnerFiles,
  at: HostPath,
  reject: WorkspaceRejection,
): Operation<CapturedWorkspace> {
  const nodes: CapturedNode[] = [];
  const contents = new Map<string, CapturedContent>();
  const blobs = new Map<string, Uint8Array>();

  function* visit(logical: string): Operation<void> {
    const found = yield* files.list(at(logical));
    for (const node of found.toSorted((left, right) => compareUtf8(left.name, right.name))) {
      const path = logical === "/" ? `/${node.name}` : `${logical}/${node.name}`;
      if (node.kind === "directory") {
        nodes.push({ path, kind: "directory", mode: node.mode, mtime: node.mtime });
        yield* visit(path);
        continue;
      }
      if (node.kind === "symlink") {
        if (node.target === undefined) {
          reject("a Workspace symbolic link has no target");
        }
        nodes.push({
          path,
          kind: "symlink",
          mode: node.mode,
          mtime: node.mtime,
          target: node.target,
        });
        continue;
      }
      const bytes = yield* files.readFile(at(path));
      if (bytes.length !== node.size) {
        reject("a Workspace file changed size while it was being captured");
      }
      const content = captureContent(bytes);
      if (!contents.has(content.manifest)) {
        contents.set(content.manifest, content);
        let offset = 0;
        for (const chunk of content.chunks) {
          blobs.set(chunk.hash, bytes.slice(offset, offset + chunk.size));
          offset += chunk.size;
        }
      }
      nodes.push({
        path,
        kind: "file",
        mode: node.mode,
        mtime: node.mtime,
        size: node.size,
        manifest: content.manifest,
        identity: node.identity,
      });
    }
  }

  // The root directory is part of the root's identity like any other entry, so
  // its own mode and time are read rather than assumed.
  const top = yield* files.describe(at("/"));
  if (top.kind !== "directory") {
    reject("a Workspace root is not a directory");
  }
  nodes.push({ path: "/", kind: "directory", mode: top.mode, mtime: top.mtime });
  yield* visit("/");

  return { root: captureWorkspaceRoot(nodes, contents, reject), contents, blobs };
}

/** Whether a captured root is the one it was materialized from. */
export function unchangedFrom(captured: CapturedRoot, workspaceRootId: string): boolean {
  return captured.rootId === workspaceRootId;
}

/** The digest of a piece the runner is about to offer. */
export function pieceDigest(bytes: Uint8Array): string {
  return sha256Hex(bytes);
}
