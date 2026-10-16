/**
 * Where an ordinary run keeps the repositories and worktrees it manages.
 *
 * A workflow run's checkouts live inside the run's own Workspace, so their
 * layout is Workspace-relative and their lifetime is the run's. An ordinary
 * run has no Workspace and no run. Its checkouts are the person's work — a
 * branch they will look at tomorrow, a worktree an agent is still editing — so
 * they live under one host root, they survive every execution, and nothing here
 * ever deletes one.
 *
 * ## Every authored string is a digest
 *
 * A document may name a Repository `../etc`, and a locator may be anything Git
 * accepts. Neither reaches a path: a slot is a SHA-256 digest of the whole
 * identity and nothing else, so no arrangement of authored characters can name
 * another slot or escape the root. That costs legibility — the layout is not
 * browsable by name — and buys the one property a shared host root has to have.
 *
 * The encoding under each digest is length-prefixed for the same reason the
 * durable Git-operation fingerprint is: any character may appear in a name or a
 * locator, so a separator scheme would let one pair of values produce the slot
 * that belongs to another pair.
 */

import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

/** The layout, relative to whichever root the entrypoint chose. */
export const REPOSITORIES = "repositories";
export const WORKTREES = "worktrees";
export const LOCKS = "locks";

/** What every slot holds: the checkout itself, and the sidecar describing it. */
export const CHECKOUT = "checkout";
export const METADATA = "metadata.json";

function digest(...values: readonly string[]): string {
  const canonical = values.map((value) => `${value.length}:${value}`).join("");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * A managed Repository's slot, named by the locator and the name together.
 *
 * Both, because both are identity: two documents that name the same url
 * `project` and `review` are asking for two checkouts, and two that name
 * different urls `project` are asking for two more.
 */
export function repositorySlot(root: string, locator: string, name: string): string {
  return `${root}/${REPOSITORIES}/${digest(locator, name)}`;
}

/**
 * A Worktree's slot, named by the repository it belongs to and its own name.
 *
 * The owner is identified by its canonical common directory rather than by its
 * locator, so a Worktree of the repository the caller is standing in and a
 * Worktree of a managed clone of the same url are different slots — as they
 * must be, since they are linked checkouts of different `.git` directories.
 */
export function worktreeSlot(root: string, commonDirectory: string, name: string): string {
  return `${root}/${WORKTREES}/${digest(commonDirectory)}/${digest(name)}`;
}

/** The checkout inside a slot. */
export function checkoutOf(slot: string): string {
  return `${slot}/${CHECKOUT}`;
}

/** The metadata sidecar inside a slot. */
export function metadataOf(slot: string): string {
  return `${slot}/${METADATA}`;
}

/**
 * The lock sidecar for one slot.
 *
 * Outside the slot, because a lock file inside a directory this provider may be
 * about to create would be part of the thing it is protecting. Different slots
 * never share one: the digest is of the whole slot identity, kind included.
 */
export function lockOf(root: string, kind: "repository" | "worktree", slot: string): string {
  return `${root}/${LOCKS}/${kind}/${digest(slot)}.lock`;
}

/** Where the locks keyed on a shared Git directory rather than on a slot live. */
export const COMMON_DIRECTORIES = "xmd-common-lanes";

/**
 * The lock sidecar for one shared Git directory.
 *
 * Outside both the checkout and the managed root, because the directory this
 * protects is the person's own: a lock file written inside a checkout would be
 * an untracked file appearing in their status, and one under the managed root
 * would tie an ambient checkout's exclusion to a root an ambient run never
 * creates. The host's temporary directory is where a lock that belongs to a
 * running process belongs, and the digest is of the canonical common directory,
 * so no arrangement of path characters names another repository's lock.
 *
 * Nothing unlinks it. Unlinking a locked path lets the next caller create and
 * lock a different file at the same name while this lock is still held.
 */
export function commonDirectoryLock(commonDirectory: string): string {
  return `${tmpdir()}/${COMMON_DIRECTORIES}/${digest(commonDirectory)}.lock`;
}
