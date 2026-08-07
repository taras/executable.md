/**
 * Which paths this branch and worktree touched, from git's two answers.
 *
 * Verify asks one question of these: did anything under `site/` change? The
 * answer has to survive a rename, which is where the two sources stop agreeing.
 * Measured on this repository, renaming `site/page.md` to `moved-out.md`:
 *
 * ```text
 * git status --porcelain=v1 -z   "R  moved-out.md"\0"site/page.md"\0
 *                                ^^^^^^^^^^^^^^^^^   ^^^^^^^^^^^^^
 *                                status and NEW path share one field, then old
 *
 * git diff --name-status -z -M -C   "R100"\0"site/page.md"\0"moved-out.md"\0
 *                                    ^^^^^   ^^^^^^^^^^^^^   ^^^^^^^^^^^^
 *                                    status  OLD path        new path
 * ```
 *
 * The path order is reversed between them, so one parser cannot read both.
 * Both paths are always yielded: a rename out of `site/` changes `site/` just
 * as much as a rename into it does.
 *
 * Two more shapes came out of the same measurements. An *unstaged* rename is
 * not reported as a rename at all — git emits ` D site/page.md` and
 * `?? moved-out.md` — so nothing here may assume an `R` exists. And a copy does
 * reach porcelain when `status.renames=copies` is configured
 * (`C  site/copy2.md\0keep.md\0`), so `C` is read, not guessed at.
 *
 * A status neither parser recognises raises. Reading one path where git meant
 * two would silently drop the side that mattered.
 */

export class ChangedPathsError extends Error {}

/** Every status letter git may put in a porcelain field or a name-status record. */
const STATUS_LETTERS = new Set([" ", "M", "A", "D", "R", "C", "U", "T", "X", "B", "?", "!"]);

function fields(output: string): string[] {
  return output.split("\0").filter((field) => field.length > 0);
}

function known(letter: string): boolean {
  return STATUS_LETTERS.has(letter);
}

/**
 * Paths from `git status --porcelain=v1 -z`.
 *
 * The status is a fixed two-character prefix, not a split: `slice(0, 2)` and
 * `slice(3)`, because a path may itself contain spaces.
 */
export function parsePorcelain(output: string): string[] {
  const parts = fields(output);
  const paths: string[] = [];
  let index = 0;
  while (index < parts.length) {
    const record = parts[index]!;
    index += 1;
    const status = record.slice(0, 2);
    const [staged, worktree] = [status[0]!, status[1]!];
    if (!known(staged) || !known(worktree)) {
      throw new ChangedPathsError(
        `git status reported \`${status}\`, which this parser cannot read`,
      );
    }
    paths.push(record.slice(3));
    if (staged === "R" || staged === "C" || worktree === "R" || worktree === "C") {
      const origin = parts[index];
      if (origin === undefined) {
        throw new ChangedPathsError(`git status reported \`${status}\` without its second path`);
      }
      index += 1;
      paths.push(origin);
    }
  }
  return paths;
}

/** Paths from `git diff --name-status -z -M -C`. */
export function parseNameStatus(output: string): string[] {
  const parts = fields(output);
  const paths: string[] = [];
  let index = 0;
  while (index < parts.length) {
    const status = parts[index]!;
    index += 1;
    const letter = status[0]!;
    if (!known(letter)) {
      throw new ChangedPathsError(`git diff reported \`${status}\`, which this parser cannot read`);
    }
    const wanted = letter === "R" || letter === "C" ? 2 : 1;
    for (let taken = 0; taken < wanted; taken += 1) {
      const path = parts[index];
      if (path === undefined) {
        throw new ChangedPathsError(`git diff reported \`${status}\` without ${wanted} paths`);
      }
      index += 1;
      paths.push(path);
    }
  }
  return paths;
}

/** Whether any changed path lies under `directory`. */
export function touches(paths: string[], directory: string): boolean {
  const prefix = directory.endsWith("/") ? directory : `${directory}/`;
  return paths.some((path) => path.startsWith(prefix));
}
