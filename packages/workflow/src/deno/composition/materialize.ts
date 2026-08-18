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
import { canonicalWorkspacePath } from "../../composition/parse.ts";
import type { DenoWorkspaceFilesystem } from "../workspace/filesystem.ts";

/** Where the two administration files a linked worktree needs are written. */
const GITDIR_PREFIX = "gitdir: ";

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
 * are joined.
 */
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

/**
 * Git's control plane is not ordinary content.
 *
 * A tracked symbolic link inside a checkout is data: Git recorded its target in
 * a commit, and the exporter recreates it verbatim because anything else would
 * hand Git a tree it never produced. `.git` is not data. It is where Git is told
 * what repository it is operating on, and the operating system resolves it
 * before Git reports anything about it — so a `.git` that is a link to a
 * compatible external repository answers every identity question this provider
 * asks while native Git works entirely outside the export.
 *
 * The same is true of everything the linked-worktree administration is made of.
 * `.git/worktrees` is read to discover which pointers exist, so a link there
 * makes an external directory the thing that is read — and then rewritten, since
 * localization writes back to whatever it found. And the pointers themselves are
 * paths: one relative or traversal-shaped value is an administration directory
 * outside the export, reached without any link at all.
 *
 * So the control plane is an explicitly validated exception. Every entry it is
 * made of has to be the kind Git writes, present as a real entry rather than as
 * something standing in for one, and every pointer value has to name one place
 * beneath the Workspace root. Checked before any rewriting and before any Git
 * command, because both are what would otherwise trust it.
 */
interface ControlPlane {
  /** `<repository>/.git`, a real directory. */
  readonly administration: string;
  /** Slot name to its real `<repository>/.git/worktrees/<slot>` directory. */
  readonly slots: ReadonlyMap<string, string>;
}

function* realDirectory(path: string): Operation<boolean> {
  return (yield* entry(path))?.isDirectory() === true;
}

function* realFile(path: string): Operation<boolean> {
  return (yield* entry(path))?.isFile() === true;
}

function refuse(subject: string, reason: string): never {
  throw new RepositoryStaleStateError(subject, reason);
}

/**
 * The exported repository's control plane, once every part of it is real.
 *
 * `lstat` throughout: a symbolic link reports as a link rather than as whatever
 * it points at, so nothing here is decided by following one.
 */
function* repositoryControlPlane(
  repositoryHostPath: string,
  subject: string,
): Operation<ControlPlane> {
  const administration = `${repositoryHostPath}/.git`;
  if (!(yield* realDirectory(administration))) {
    refuse(
      subject,
      "the `.git` in the checkout it holds is not a real directory, so native Git would be " +
        "told to operate on a repository this run did not retain",
    );
  }

  const worktrees = `${administration}/worktrees`;
  const slots = new Map<string, string>();
  if ((yield* entry(worktrees)) !== undefined) {
    if (!(yield* realDirectory(worktrees))) {
      refuse(subject, "its `.git/worktrees` is not a real directory");
    }
    for (const name of yield* readdir(worktrees)) {
      const slot = `${worktrees}/${name}`;
      if (!(yield* realDirectory(slot))) {
        refuse(subject, "one of its linked-worktree administration directories is not a real one");
      }
      // A slot is a pair or it is nothing. `git worktree add` creates the
      // directory and writes this pointer together, so a slot that exists
      // without one is not a stage of anything — it is a repository whose
      // record of its own worktrees is incomplete, and native Git will still
      // answer every identity query while it is.
      if (!(yield* realFile(`${slot}/gitdir`))) {
        refuse(
          subject,
          "one of its linked-worktree administration directories has no real `gitdir` pointer, " +
            "so the repository's own record of its worktrees is incomplete",
        );
      }
      slots.set(name, slot);
    }
  }
  return { administration, slots };
}

/** The `<worktree>/.git` pointer file, once it is a real regular file. */
function* worktreePointer(worktreeHostPath: string, subject: string): Operation<string> {
  const pointer = `${worktreeHostPath}/.git`;
  if (!(yield* realFile(pointer))) {
    refuse(
      subject,
      "the `.git` in the worktree it holds is not a real file, so the administration native " +
        "Git would follow is not the one this run retained",
    );
  }
  return pointer;
}

function rewriteLine(content: string, rewrite: (path: string) => string): string {
  const trimmed = content.trimEnd();
  if (trimmed.startsWith(GITDIR_PREFIX)) {
    return `${GITDIR_PREFIX}${rewrite(trimmed.slice(GITDIR_PREFIX.length))}\n`;
  }
  return `${rewrite(trimmed)}\n`;
}

function* pointerValue(file: string): Operation<string> {
  const trimmed = (yield* readTextFile(file)).trimEnd();
  return trimmed.startsWith(GITDIR_PREFIX) ? trimmed.slice(GITDIR_PREFIX.length) : trimmed;
}

/**
 * The Workspace path a retained pointer names, once it names one at all.
 *
 * A retained pointer holds a Workspace path, because that is what
 * canonicalization left there. Relative, empty, dot-segmented and
 * traversal-shaped values are all refused rather than resolved: each of them
 * names an administration directory somewhere other than where this run put one,
 * and prefixing a root onto it would produce a path that leaves the export.
 */
function* retainedPointer(file: string, subject: string): Operation<string> {
  const value = canonicalWorkspacePath(yield* pointerValue(file));
  if (value === undefined) {
    refuse(
      subject,
      "a linked-worktree administration pointer does not name one place beneath the " +
        "Workspace root",
    );
  }
  return value;
}

/**
 * Hold the exported pair to each other before either is rewritten.
 *
 * Both ends are present here, so the check can be exact rather than merely
 * contained: the worktree's pointer must name a slot this repository really has,
 * and that slot's own pointer must name this worktree back. A pointer that
 * passed the shape rule and still named some other checkout is what this
 * catches.
 */
function* agreedPair(
  root: string,
  control: ControlPlane,
  worktreeHostPath: string,
  subject: string,
): Operation<void> {
  const pointer = yield* worktreePointer(worktreeHostPath, subject);
  const named = `${root}${yield* retainedPointer(pointer, subject)}`;
  const slot = [...control.slots.values()].find((candidate) => candidate === named);
  if (slot === undefined) {
    refuse(
      subject,
      "its `.git` names an administration directory the repository it belongs to does not have",
    );
  }
  // Unconditional: every slot reaching here has been proven to hold a real
  // pointer, so there is no absence for a comparison to be skipped over.
  if (`${root}${yield* retainedPointer(`${slot}/gitdir`, subject)}` !== pointer) {
    refuse(subject, "its administration directory names a different worktree");
  }
}

/** Put a materialization root back in front of every retained administration path. */
/**
 * Every administration file a rewrite may touch, and nothing else.
 *
 * Discovered from the validated control plane rather than from the filesystem
 * again, so the set that is rewritten is exactly the set that was proven real —
 * and nothing is filtered out of it, because a slot that could be filtered out
 * has already been refused.
 */
function* administrationFiles(
  control: ControlPlane,
  worktreeHostPaths: readonly string[],
  subject: string,
): Operation<string[]> {
  const files = [...control.slots.values()].map((slot) => `${slot}/gitdir`);
  for (const path of worktreeHostPaths) {
    files.push(yield* worktreePointer(path, subject));
  }
  return files;
}

export function* localizeAdministration(
  root: string,
  repositoryHostPath: string,
  worktreeHostPaths: readonly string[],
  subject: string,
): Operation<void> {
  const control = yield* repositoryControlPlane(repositoryHostPath, subject);
  for (const worktreeHostPath of worktreeHostPaths) {
    yield* agreedPair(root, control, worktreeHostPath, subject);
  }

  for (const file of yield* administrationFiles(control, worktreeHostPaths, subject)) {
    const value = yield* retainedPointer(file, subject);
    const content = yield* readTextFile(file);
    yield* writeTextFile(
      file,
      rewriteLine(content, () => `${root}${value}`),
    );
  }
}

/**
 * Take the materialization root back out of every administration path.
 *
 * What is left is a Workspace path, which is what may be retained. A value that
 * does not begin with the root is refused rather than left alone: Git wrote an
 * administration path this provider did not predict, and retaining it would keep
 * a host path — or a pointer to somewhere else entirely — in the run.
 */
export function* canonicalizeAdministration(
  root: string,
  repositoryHostPath: string,
  worktreeHostPaths: readonly string[],
  subject: string,
): Operation<void> {
  const control = yield* repositoryControlPlane(repositoryHostPath, subject);

  for (const file of yield* administrationFiles(control, worktreeHostPaths, subject)) {
    const value = yield* pointerValue(file);
    if (!value.startsWith(`${root}/`)) {
      refuse(
        subject,
        "a linked-worktree administration pointer names somewhere outside the directory this " +
          "run materialized it in",
      );
    }
    const retained = canonicalWorkspacePath(value.slice(root.length));
    if (retained === undefined) {
      refuse(
        subject,
        "a linked-worktree administration pointer does not name one place beneath the " +
          "Workspace root",
      );
    }
    const content = yield* readTextFile(file);
    yield* writeTextFile(
      file,
      rewriteLine(content, () => retained),
    );
  }
}
