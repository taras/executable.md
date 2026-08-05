/**
 * What every tracked path looked like, so a battery can prove it changed none.
 *
 * A successful battery leaves tracked files byte-for-byte and mode-for-mode
 * unchanged (#279). Proving that needs a record per path and a comparison of
 * two records — not a "is the tree clean" question, which a worktree that was
 * already dirty when verify started would answer wrongly.
 *
 * ## Reading the index
 *
 * `git ls-files --stage -z` emits `<mode> <sha> <stage>\t<path>\0`. Two details
 * decide the parser, both measured:
 *
 * - **Only the first tab delimits.** A tracked filename may contain a tab —
 *   `tab\tname.txt` arrives as `100644 <sha> 0\ttab\tname.txt` — so splitting
 *   on every tab truncates the path. NUL delimits records, so a filename
 *   containing a newline needs nothing special.
 * - **Mode `160000` is rejected before anything touches the filesystem.** A
 *   gitlink whose working copy was emptied `lstat`s as a *directory*; one whose
 *   directory was removed raises `ENOENT` and would be recorded as an absent
 *   file, so an uninitialized submodule would compare equal to a deleted one.
 *   Refusing on the recorded mode is what makes that impossible.
 *
 * A stage other than 0 is an unmerged path. A conflicted worktree is not a
 * state in which "nothing moved" means anything, so it is reported rather than
 * fingerprinted.
 */

export class UnsupportedEntryError extends Error {}

export const GITLINK_MODE = "160000";

export interface TrackedRecord {
  mode: string;
  oid: string;
  path: string;
}

export type TrackedEntry =
  | { kind: "file"; digest: string; executable: boolean }
  | { kind: "symlink"; target: string }
  | { kind: "absent" };

export type TrackedState = ReadonlyMap<string, TrackedEntry>;

/**
 * Records from `git ls-files --stage -z`, with the entries no fingerprint can
 * describe refused rather than skipped.
 */
export function parseStageRecords(output: string): TrackedRecord[] {
  const records: TrackedRecord[] = [];
  for (const field of output.split("\0")) {
    if (field.length === 0) {
      continue;
    }
    const tab = field.indexOf("\t");
    if (tab < 0) {
      throw new UnsupportedEntryError(`git ls-files emitted a record with no path: ${field}`);
    }
    const [mode, oid, stage] = field.slice(0, tab).split(" ");
    const path = field.slice(tab + 1);
    if (mode === undefined || oid === undefined || stage === undefined) {
      throw new UnsupportedEntryError(`git ls-files emitted incomplete metadata for ${path}`);
    }
    if (stage !== "0") {
      throw new UnsupportedEntryError(
        `${path} is unmerged (stage ${stage}); resolve the conflict before verifying`,
      );
    }
    if (mode === GITLINK_MODE) {
      throw new UnsupportedEntryError(
        `${path} is a submodule, which this fingerprint cannot describe`,
      );
    }
    records.push({ mode, oid, path });
  }
  return records;
}

function describe(entry: TrackedEntry): string {
  if (entry.kind === "file") {
    return `${entry.digest.slice(0, 12)}${entry.executable ? " +x" : ""}`;
  }
  if (entry.kind === "symlink") {
    return `-> ${entry.target}`;
  }
  return "absent";
}

/**
 * Every tracked path whose content, mode, symlink target, or presence moved.
 *
 * Both states cover the same paths by construction — the enumeration is the
 * index, not the filesystem — so a path missing from either is itself a change
 * worth naming.
 */
export function compareTracked(before: TrackedState, after: TrackedState): string[] {
  const moved: string[] = [];
  for (const [path, entry] of [...before].sort(([left], [right]) => left.localeCompare(right))) {
    const found = after.get(path);
    if (!found) {
      moved.push(`${path}: no longer tracked`);
      continue;
    }
    if (!same(entry, found)) {
      moved.push(`${path}: ${describe(entry)} -> ${describe(found)}`);
    }
  }
  for (const path of [...after.keys()].sort()) {
    if (!before.has(path)) {
      moved.push(`${path}: newly tracked`);
    }
  }
  return moved;
}

function same(left: TrackedEntry, right: TrackedEntry): boolean {
  if (left.kind === "file" && right.kind === "file") {
    return left.digest === right.digest && left.executable === right.executable;
  }
  if (left.kind === "symlink" && right.kind === "symlink") {
    return left.target === right.target;
  }
  return left.kind === "absent" && right.kind === "absent";
}
