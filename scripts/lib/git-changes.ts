/**
 * What this branch and worktree changed, with status intact.
 *
 * Deno's `--changed` computes its own change set from
 * `git diff --name-only`, `git diff --cached --name-only`, and
 * `git ls-files --other --modified --exclude-standard` (traced on 2.9.1). That
 * is enough to select tests but not enough to *classify* a change: `--name-only`
 * reports a rename as its new path alone, and a deleted path arrives with no
 * module graph node behind it, which is why deleting a file 76 tests depend on
 * selects nothing at all.
 *
 * So selection stays Deno's and classification reads git directly, with
 * `--name-status -z` and explicit `-M -C` rather than whatever rename detection
 * a user's configuration happens to enable.
 *
 * The records are NUL-delimited, and the status shares no field with its paths:
 * `A\0path\0` for one path, `R100\0old\0new\0` and `C100\0src\0dst\0` for two.
 * A status this parser does not recognise is an error rather than a guess —
 * an unmerged path or a type change classified as "nothing to do" is exactly
 * the silence this mechanism exists to prevent.
 */

import type { Operation } from "effection";
import { fileURLToPath } from "node:url";

import { captured } from "./captured.ts";

export type ChangeKind = "added" | "modified" | "deleted";

export interface Change {
  path: string;
  kind: ChangeKind;
}

export interface ChangeSet {
  /** The ref `--base` named, as given. */
  base: string;
  /** The commit `base` and `HEAD` share. */
  mergeBase: string;
  changes: Change[];
}

/** Rename detection is requested here, never inherited from configuration. */
const DIFF = ["diff", "--name-status", "-z", "-M", "-C"];

export class GitChangeError extends Error {}

function* git(root: URL, args: string[]): Operation<string> {
  const result = yield* captured("git", { arguments: args, cwd: fileURLToPath(root) });
  if (result.code !== 0) {
    throw new GitChangeError(`\`git ${args.join(" ")}\` failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function fields(output: string): string[] {
  return output.split("\0").filter((field) => field.length > 0);
}

/**
 * Records from `git diff --name-status -z`.
 *
 * A rename contributes both of its paths: the new one as an addition, and the
 * old one as a deletion, because the old path is gone. A copy contributes only
 * its new path — the source still exists, so it is not a deletion.
 */
export function parseNameStatus(output: string): Change[] {
  const parts = fields(output);
  const changes: Change[] = [];
  let index = 0;
  while (index < parts.length) {
    const status = parts[index]!;
    const letter = status[0];
    index += 1;
    if (letter === "R" || letter === "C") {
      const from = parts[index];
      const to = parts[index + 1];
      if (from === undefined || to === undefined) {
        throw new GitChangeError(`git reported \`${status}\` without both paths`);
      }
      index += 2;
      changes.push({ path: to, kind: "added" });
      if (letter === "R") {
        changes.push({ path: from, kind: "deleted" });
      }
      continue;
    }
    const path = parts[index];
    if (path === undefined) {
      throw new GitChangeError(`git reported \`${status}\` without a path`);
    }
    index += 1;
    changes.push({ path, kind: kindOf(status) });
  }
  return changes;
}

function kindOf(status: string): ChangeKind {
  if (status === "A") {
    return "added";
  }
  if (status === "D") {
    return "deleted";
  }
  if (status === "M" || status === "T") {
    return "modified";
  }
  throw new GitChangeError(
    `git reported status \`${status}\`, which this selector cannot classify`,
  );
}

/** Paths from `git ls-files -z --others --exclude-standard`. */
export function parseUntracked(output: string): Change[] {
  return fields(output).map((path) => ({ path, kind: "added" }));
}

/**
 * Everything that separates this worktree from `base`: what the branch
 * committed since their merge base, what is staged, what is not, and what is
 * untracked. Git-ignored paths appear nowhere — `--exclude-standard` and the
 * diffs cannot see them — so a generated output is never a change input.
 */
export function* changeSet(root: URL, base: string): Operation<ChangeSet> {
  const mergeBase = (yield* git(root, ["merge-base", base, "HEAD"])).trim();

  const committed = yield* git(root, [...DIFF, `${mergeBase}...HEAD`]);
  const staged = yield* git(root, [...DIFF, "--cached"]);
  const unstaged = yield* git(root, DIFF);
  const untracked = yield* git(root, ["ls-files", "-z", "--others", "--exclude-standard"]);

  return {
    base,
    mergeBase,
    changes: dedupe([
      ...parseNameStatus(committed),
      ...parseNameStatus(staged),
      ...parseNameStatus(unstaged),
      ...parseUntracked(untracked),
    ]),
  };
}

/**
 * One entry per path. A path both deleted and re-added — staged one way and
 * present the other — keeps the deletion, because that is the conservative half.
 */
function dedupe(changes: Change[]): Change[] {
  const byPath = new Map<string, Change>();
  for (const change of changes) {
    const seen = byPath.get(change.path);
    if (!seen || change.kind === "deleted") {
      byPath.set(change.path, change);
    }
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}
