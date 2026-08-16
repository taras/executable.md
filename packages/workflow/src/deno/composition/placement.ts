/**
 * Where a named Repository or Worktree lands in the Workspace.
 *
 * The provider owns placement, and a name is identity rather than a path. Two
 * documents may name a Repository `../etc` and `project`, and both must land
 * somewhere inside the Workspace without one being able to reach the other or
 * to escape.
 *
 * A slot is therefore a readable stem and a digest of the whole identity. The
 * digest is what makes placement collision-free — two distinct identities have
 * distinct slots even when their stems collapse to the same characters — and the
 * stem is what makes a retained path legible to somebody reading the database.
 * Neither half is parsed back: the retained `checkout_path` column is the
 * authority on where a checkout is, and this is only how the first one was
 * chosen.
 */

import { createHash } from "node:crypto";

const STEM = /[^A-Za-z0-9._-]+/g;

function slot(identity: string): string {
  const digest = createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 16);
  const stem = identity
    .replace(STEM, "-")
    .replace(/^[-.]+/, "")
    .replace(/-+$/, "")
    .slice(0, 40);
  return stem === "" ? digest : `${stem}-${digest}`;
}

export function repositoryCheckoutPath(name: string): string {
  return `/repositories/${slot(name)}`;
}

/**
 * A Worktree's checkout, outside the Repository's own tree.
 *
 * A linked worktree inside the repository it belongs to would be walked by that
 * repository's own status and search, and importing one tree would then import
 * the other. Keeping them siblings makes each retained tree exactly one
 * checkout.
 */
export function worktreeCheckoutPath(repositoryName: string, name: string): string {
  // Length-prefixed rather than joined by a separator: any character may appear
  // in either name, so a separator would let one pair of names produce the slot
  // that belongs to another pair.
  return `/worktrees/${slot(`${repositoryName.length}:${repositoryName}:${name}`)}`;
}
