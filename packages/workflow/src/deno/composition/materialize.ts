/**
 * Moving a checkout between the authoritative Workspace and a place Git can run.
 *
 * The Workspace is a database, and native Git is a program that reads
 * directories. Every native operation therefore happens in a disposable host
 * tree exported from the Workspace, and what it produced is imported back
 * inside the same transaction. Deleting a materialization costs time and
 * nothing else: the database is what the run is made of.
 *
 * ## Why the layout is mirrored
 *
 * A materialization holds the Workspace's own paths beneath one host root:
 * Workspace `/repositories/api` becomes `<root>/repositories/api`. That is what
 * makes canonicalization subtraction rather than interpretation. Git writes
 * absolute paths into a linked worktree's administration, and the absolute path
 * it writes is exactly `<root>` followed by a Workspace path — so removing the
 * root leaves a provider-neutral Workspace path, and prepending a different root
 * later reconstructs a working one on another machine.
 *
 * ## What carries and what does not
 *
 * Bytes, modes and symbolic link targets carry, because Git's own behavior
 * depends on all three: an executable bit is content as far as a commit is
 * concerned, and a symbolic link is an object rather than the file it points at.
 * Modification times do not carry — Git treats a changed mtime as a hint to
 * re-hash a file, never as truth — and hard links do not, which is why a local
 * clone is taken with `--no-hardlinks`: an imported tree must be complete on its
 * own rather than sharing objects with a remote that may be gone by the time the
 * run resumes.
 */

import { type Operation, until } from "effection";
import { ensureDir, lstat, readdir, readTextFile, writeTextFile } from "@effectionx/fs";
import type { Stats } from "node:fs";
import { chmod, readFile, readlink, realpath, symlink, writeFile } from "node:fs/promises";
import { RepositoryStaleStateError } from "../../composition/errors.ts";
import type { DenoWorkspaceFilesystem } from "../workspace/filesystem.ts";

/**
 * The host path a Workspace path names beneath this materialization root.
 *
 * The subtraction the module is built on only works in one direction for free.
 * Removing a root from an absolute path always leaves something; prepending a
 * root to an arbitrary string does not always land beneath it, and a Workspace
 * path that arrived from a retained row is not this provider's own word — a
 * database somebody edited can hold `/../../etc`, and concatenation would walk
 * out of the disposable tree and into the host.
 *
 * So containment is proven rather than assumed, here, at the one place the two
 * are joined. A Workspace path is absolute and made of ordinary segments: no
 * empty one, no `.`, no `..`. That is a property of the path itself, decided
 * before any host call, which is what makes it a proof rather than a check of
 * what the filesystem happened to resolve — `realpath` after the fact would
 * already have followed a symbolic link somewhere.
 */
/**
 * The one place beneath the Workspace root this string names, or `undefined`.
 *
 * Absolute, and made of ordinary segments: no empty one, no `.`, no `..`. It is
 * a property of the string, decided before any host call, which is what makes it
 * a proof rather than a check of what a filesystem happened to resolve — a
 * `realpath` after the fact has already followed a link by the time it answers.
 */
function canonicalWorkspacePath(value: string): string | undefined {
  if (!value.startsWith("/")) {
    return undefined;
  }
  for (const segment of value.slice(1).split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      return undefined;
    }
  }
  return value;
}

function hostPath(root: string, workspacePath: string): string {
  if (canonicalWorkspacePath(workspacePath) === undefined) {
    throw new RepositoryStaleStateError(
      "a retained checkout",
      "the Workspace path it recorded does not name one place beneath the Workspace root",
    );
  }
  return `${root}${workspacePath}`;
}

/**
 * What the host holds at this path, or `undefined` when it holds nothing.
 *
 * `lstat` rather than `stat`, so a symbolic link answers as itself rather than
 * as whatever it points at — which is the whole question every control-plane
 * check below asks. Absence is keyed on the code rather than on a runtime's own
 * error class, so this reads the same wherever the adapter runs.
 */
function* entry(path: string): Operation<Stats | undefined> {
  try {
    return yield* lstat(path);
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Whether the Workspace holds anything at this path.
 *
 * `lstat` rather than `stat`, so a dangling symbolic link is present rather
 * than missing: what matters is whether the entry the record names is there.
 */
export function* workspaceEntryPresent(
  filesystem: DenoWorkspaceFilesystem,
  workspacePath: string,
): Operation<boolean> {
  try {
    yield* filesystem.lstat(workspacePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write one Workspace subtree into a host directory Git can be pointed at.
 *
 * Directory modes are applied after their contents, because a directory
 * exported read-only cannot be written into while the export is still running.
 */
function* exportEntry(
  filesystem: DenoWorkspaceFilesystem,
  workspacePath: string,
  target: string,
): Operation<void> {
  const info = yield* filesystem.lstat(workspacePath);

  if (info.kind === "symlink") {
    yield* until(symlink(yield* filesystem.readlink(workspacePath), target));
    return;
  }

  if (info.kind === "file") {
    yield* until(writeFile(target, yield* filesystem.readFile(workspacePath), { mode: info.mode }));
    yield* until(chmod(target, info.mode));
    return;
  }

  yield* ensureDir(target);
  for (const child of yield* filesystem.readdir(workspacePath)) {
    yield* exportEntry(filesystem, `${workspacePath}/${child.name}`, `${target}/${child.name}`);
  }
  yield* until(chmod(target, info.mode));
}

/**
 * Export one retained checkout into `<root><workspacePath>`, parents included.
 *
 * ## Why the root is not an ordinary entry
 *
 * Inside a repository a symbolic link is content: Git tracks it, a commit
 * records its target, and the exporter recreates it verbatim because anything
 * else would hand Git a tree it never produced. The checkout *root* is not
 * content — it is where the run's authoritative Git state is kept — and a link
 * there means something entirely different. The operating system resolves the
 * working directory before Git sees it, so a root that is a link to
 * `/tmp/somewhere` sends every Git command this provider runs outside the
 * materialization and into whatever is at the other end. A compatible clone
 * there answers the identity questions correctly, and the run continues on
 * state the database does not hold — which is exactly the guarantee the
 * Workspace exists to make.
 *
 * So the root must be a real retained directory, and the export must land where
 * it was aimed. Both are decided here, before Git runs and before any
 * administration path is rewritten, because either one is what the next step
 * would trust.
 */
export function* exportTree(
  filesystem: DenoWorkspaceFilesystem,
  root: string,
  workspacePath: string,
  subject: string,
): Operation<string> {
  const target = hostPath(root, workspacePath);

  // `lstat`, so a link is seen as a link rather than as whatever it points at.
  const info = yield* filesystem.lstat(workspacePath);
  if (info.kind !== "directory") {
    throw new RepositoryStaleStateError(
      subject,
      "what the Workspace holds at the path it recorded is not a directory, so the checkout " +
        "this run would operate on is not the one it retained",
    );
  }

  const parent = target.slice(0, target.lastIndexOf("/"));
  yield* ensureDir(parent);
  yield* exportEntry(filesystem, workspacePath, target);

  // The materialization root is already resolved, and every directory above the
  // target was created here, so an export that landed where it was aimed
  // resolves to exactly its own path. Anything else reaches outside the
  // directory this provider owns.
  if ((yield* until(realpath(target))) !== target) {
    throw new RepositoryStaleStateError(
      subject,
      "the checkout exported for it does not resolve inside the directory this run owns",
    );
  }
  return target;
}

function* importEntry(
  filesystem: DenoWorkspaceFilesystem,
  source: string,
  workspacePath: string,
): Operation<void> {
  const info = yield* lstat(source);

  if (info.isSymbolicLink()) {
    yield* filesystem.symlink(yield* until(readlink(source)), workspacePath);
    return;
  }

  const mode = info.mode;

  if (info.isFile()) {
    // A fresh view rather than the `Buffer` Node hands back: what this writes
    // into the Workspace is bytes, and a `Buffer` carries methods a DOFS blob
    // has no use for.
    const bytes = new Uint8Array(yield* until(readFile(source)));
    yield* filesystem.writeFile(workspacePath, bytes, mode & 0o7777);
    return;
  }

  yield* filesystem.mkdir(workspacePath, { recursive: true });
  const entries = (yield* readdir(source)).slice().sort();
  for (const name of entries) {
    yield* importEntry(filesystem, `${source}/${name}`, `${workspacePath}/${name}`);
  }
  yield* filesystem.chmod(workspacePath, mode & 0o7777);
}

/**
 * Replace `workspacePath` with what `<root><workspacePath>` now holds.
 *
 * The existing subtree is removed first, so an import is what the tree is
 * rather than what it is merged with. A worktree that Git removed a file from
 * must not keep that file in the Workspace, and a union of the two would be a
 * checkout Git never produced.
 */
export function* importTree(
  filesystem: DenoWorkspaceFilesystem,
  root: string,
  workspacePath: string,
): Operation<void> {
  // Proven before the removal below, not at the point of use: this path decides
  // what is deleted from the Workspace as well as what is read from the host,
  // and a malformed one must not get as far as removing anything.
  const source = hostPath(root, workspacePath);

  yield* filesystem.remove(workspacePath, { recursive: true, force: true });
  const parent = workspacePath.slice(0, workspacePath.lastIndexOf("/"));
  if (parent !== "") {
    yield* filesystem.mkdir(parent, { recursive: true });
  }
  yield* importEntry(filesystem, source, workspacePath);
}
