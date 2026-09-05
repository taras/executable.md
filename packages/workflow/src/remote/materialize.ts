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
  type WorkspaceRejection,
  type WorkspaceRootManifest,
} from "../workspace/root-manifest.ts";
import { decodeContentManifest } from "../workspace/content-manifest.ts";
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
  /**
   * Set permissions exactly, after creation.
   *
   * Creation modes are narrowed by the process umask, and a retained mode is
   * durable identity rather than a preference. Applied to a directory only once
   * its children exist, because a mode that forbids writing would otherwise
   * forbid filling it.
   */
  setMode(path: string, mode: number): Operation<void>;
  /** Applied last, because writing into a directory moves its own time. */
  setModifiedAt(path: string, mtime: number): Operation<void>;
  /**
   * Set a link's own time without following it.
   *
   * Separate because a link's target may not exist, may be outside the tree, or
   * may be something this code must never touch. `undefined` when the host
   * cannot do it at all, which materialization reports rather than works around.
   */
  readonly setLinkModifiedAt: ((path: string, mtime: number) => Operation<void>) | undefined;
  /** The same, for a link's own permissions. `undefined` where unsupported. */
  readonly setLinkMode: ((path: string, mode: number) => Operation<void>) | undefined;
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
  /**
   * The first path written for each hardlink group.
   *
   * Keyed by the group the root declares, never by the content digest. Two
   * groups may legally hold identical bytes and therefore share one manifest,
   * and linking the second to the first would merge two files into one — a
   * different Workspace, arriving under the identity of this one.
   */
  const groups = new Map<string, string>();
  const modes: { path: string; mode: number; link: boolean }[] = [];
  const times: { path: string; mtime: number; link: boolean }[] = [];

  for (const entry of manifest.entries) {
    const path = at(entry.path);
    if (entry.kind === "directory") {
      if (entry.path !== "/") {
        yield* files.makeDirectory(path, entry.mode);
      }
      modes.push({ path, mode: entry.mode, link: false });
      times.push({ path, mtime: entry.mtime, link: false });
      continue;
    }
    if (entry.kind === "symlink") {
      // Created, never followed. A retained link may point anywhere, including
      // outside the tree, and resolving one here would be this code deciding to
      // read something the Workspace merely mentions.
      yield* files.makeSymlink(entry.target, path);
      modes.push({ path, mode: entry.mode, link: true });
      times.push({ path, mtime: entry.mtime, link: true });
      continue;
    }

    const first = entry.hardlink === null ? undefined : groups.get(entry.hardlink);
    if (first !== undefined) {
      // One inode reached by a second name. Its mode and time belong to the
      // file, which the first member already carries.
      yield* files.makeHardlink(first, path);
      continue;
    }
    const bytes = yield* fetchFile(reads, workspaceRootId, entry.manifest, entry.size, reject);
    yield* files.writeFile(path, bytes, entry.mode);
    if (entry.hardlink !== null) {
      groups.set(entry.hardlink, path);
    }
    modes.push({ path, mode: entry.mode, link: false });
    times.push({ path, mtime: entry.mtime, link: false });
  }

  // Modes before times and both deepest-first: a mode that forbids writing must
  // not be applied while children are still arriving, and filling a directory
  // moves a time that was already restored.
  for (const entry of modes.toReversed()) {
    if (!entry.link) {
      yield* files.setMode(entry.path, entry.mode);
      continue;
    }
    if (files.setLinkMode !== undefined) {
      yield* files.setLinkMode(entry.path, entry.mode);
    }
  }
  for (const entry of times.toReversed()) {
    if (!entry.link) {
      yield* files.setModifiedAt(entry.path, entry.mtime);
      continue;
    }
    if (files.setLinkModifiedAt !== undefined) {
      yield* files.setLinkModifiedAt(entry.path, entry.mtime);
    }
  }

  // Proved rather than assumed. A host that cannot represent a legal retained
  // mode or time must say so here, before anything executes against this tree —
  // silently normalizing one would hand the run a Workspace with a different
  // durable identity than the history it accepted.
  yield* requireExactMaterialization(files, at, manifest, reject);
  return manifest;
}

/**
 * Whether what is on disk is what the root said.
 *
 * Every entry's kind, mode and time, read back without following a link. This
 * is not defensive duplication: umask, platform link semantics and filesystem
 * timestamp granularity are all real, and each of them turns one retained root
 * into a different one quietly. The refusal names what disagreed, not where the
 * tree happens to live.
 */
function* requireExactMaterialization(
  files: RunnerFiles,
  at: HostPath,
  manifest: WorkspaceRootManifest,
  reject: WorkspaceRejection,
): Operation<void> {
  for (const entry of manifest.entries) {
    const found = yield* files.describe(at(entry.path));
    if (found.kind !== entry.kind) {
      reject(`this host materialized a ${entry.kind} as a ${found.kind}`);
    }
    if (found.mode !== entry.mode) {
      reject(`this host cannot preserve the retained mode of a ${entry.kind}`);
    }
    if (found.mtime !== entry.mtime) {
      reject(`this host cannot preserve the retained modification time of a ${entry.kind}`);
    }
  }
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
  const manifest = decodeContentManifest(encoded.bytes, reject);
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
