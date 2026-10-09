/**
 * What one checkout is in, read off the host so a later open can tell whether
 * it is still there.
 *
 * A retained operation freezes the state it expects to find and the state it
 * means to leave, and attachment compares what it finds against those. So this
 * has to be *semantic*: two checkouts that differ only in a stat cache, a pack
 * layout or a reflog time are the same state, and an inventory that recorded
 * any of them would refuse honest work on the next open. What it does record is
 * everything a document can observe — HEAD, the refs, the complete index, and
 * the bytes and modes of every path in the worktree, including untracked and
 * ignored content and empty directories.
 *
 * Git's own administration is outside the worktree inventory for the same
 * reason: its contents move constantly without the checkout meaning anything
 * different. Its identity and its relationship to the common directory are
 * recorded instead, which is what tells a linked worktree from the repository
 * it belongs to.
 *
 * Anything this cannot read completely is a refusal rather than a partial
 * inventory. A frontier that silently omitted a path would compare equal to a
 * checkout that does not have it.
 */

import { Err, Ok, until } from "effection";
import type { Operation, Result } from "effection";
import { lstat, readdir } from "@effectionx/fs";
import { readFile, readlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { encodeBase64 } from "@std/encoding/base64";
import { isAbsolute, join, relative, resolve } from "node:path";
import { StaleInputError } from "@executablemd/durable-streams";
import { objectFormat } from "../composition/git.ts";
import type { GitSession } from "../composition/git.ts";
import type {
  RetainedFrontier,
  RetainedHead,
  RetainedIndexEntry,
  RetainedRef,
  RetainedWorktreeEntry,
} from "../../retained-repository/records.ts";

/** A checkout this host cannot describe completely. */
export class FrontierError extends StaleInputError {
  override name = "FrontierError";
}

/** Which checkout to inventory, and where it is. */
export interface FrontierSource {
  readonly git: GitSession;
  /** The logical identity this checkout is retained under. */
  readonly checkout: string;
  /** Where it is on this host right now. */
  readonly directory: string;
}

/**
 * The frontier this checkout is at.
 *
 * `Result`, because an unreadable or unsupported checkout is an answer this
 * caller acts on — it refuses a resume rather than failing the host.
 */
export function* inventoryFrontier(source: FrontierSource): Operation<Result<RetainedFrontier>> {
  const { git, directory } = source;
  const common = yield* administrationDirectory(git, directory, "--git-common-dir");
  const own = yield* administrationDirectory(git, directory, "--git-dir");
  if (common === undefined || own === undefined) {
    return refuse(`"${directory}" is not a Git checkout this host can read.`);
  }
  const linked = common !== own;

  const format = yield* objectFormat(git, directory);
  if (format !== "sha1" && format !== "sha256") {
    return refuse(`"${directory}" uses an object format this host does not retain.`);
  }

  const head = yield* readHead(git, directory);
  if (head === undefined) {
    return refuse(`"${directory}" has a HEAD this host cannot read.`);
  }

  const refs = yield* readRefs(git, directory);
  if (refs === undefined) {
    return refuse(`"${directory}" has refs this host cannot read.`);
  }

  const index = yield* readIndex(git, directory);
  if (index === undefined) {
    return refuse(`"${directory}" has an index this host cannot read.`);
  }

  const worktree = yield* readWorktree(directory, [common, own]);
  if (!worktree.ok) {
    return worktree;
  }

  return Ok(
    Object.freeze({
      checkout: source.checkout,
      administration: Object.freeze({
        common,
        worktree: linked ? own : null,
        role: linked ? "linked" : "primary",
      }),
      objectFormat: format,
      head,
      refs,
      index,
      worktree: worktree.value,
    }),
  );
}

function refuse(sentence: string): Result<never> {
  return Err(new FrontierError(sentence));
}

/**
 * One of Git's two administration directories, as an absolute path.
 *
 * `git rev-parse` answers relatively when it is run inside the checkout, so the
 * answer is resolved here: a frontier compared across two opens cannot hold a
 * path that means different things depending on where the command ran.
 */
function* administrationDirectory(
  git: GitSession,
  directory: string,
  flag: string,
): Operation<string | undefined> {
  const reported = yield* git.read(["rev-parse", flag], directory);
  if (reported === undefined) {
    return undefined;
  }
  return isAbsolute(reported) ? resolve(reported) : resolve(join(directory, reported));
}

/**
 * Where HEAD points, and whether it does so through a ref.
 *
 * An unborn branch is a symbolic HEAD with no commit, which is a real state a
 * fresh checkout is in — so the object id is absent rather than the read
 * failing.
 */
function* readHead(git: GitSession, directory: string): Operation<RetainedHead | undefined> {
  const ref = yield* git.read(["symbolic-ref", "--quiet", "HEAD"], directory);
  const oid = yield* git.read(["rev-parse", "--verify", "--quiet", "HEAD"], directory);
  if (ref !== undefined) {
    return Object.freeze({ kind: "symbolic", ref, oid: oid ?? null });
  }
  return oid === undefined ? undefined : Object.freeze({ kind: "detached", oid });
}

/** Every ref this repository holds, in one canonical order. */
function* readRefs(
  git: GitSession,
  directory: string,
): Operation<readonly RetainedRef[] | undefined> {
  const listed = yield* git.read(["for-each-ref", "--format=%(refname) %(objectname)"], directory);
  if (listed === undefined) {
    // No refs at all is an answer, not a failure: a repository with an unborn
    // branch has none.
    return Object.freeze([]);
  }
  const refs: RetainedRef[] = [];
  for (const line of listed.split("\n")) {
    const separator = line.indexOf(" ");
    if (separator <= 0) {
      return undefined;
    }
    refs.push(Object.freeze({ name: line.slice(0, separator), oid: line.slice(separator + 1) }));
  }
  refs.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return Object.freeze(refs);
}

/**
 * The complete index, with the flags that make two identical-looking entries
 * different.
 *
 * `--stage` gives the mode, object and stage of every entry, and `-v` reports
 * the two flags Git keeps beside them: a lowercase letter is an
 * assume-unchanged entry and `S` is a skip-worktree one. Both change what a
 * later command does with the path, so neither is a detail to drop.
 */
function* readIndex(
  git: GitSession,
  directory: string,
): Operation<readonly RetainedIndexEntry[] | undefined> {
  const staged = yield* git.read(["ls-files", "--stage"], directory);
  const flagged = yield* git.read(["ls-files", "-v"], directory);
  const flags = new Map<string, readonly string[]>();
  for (const line of (flagged ?? "").split("\n")) {
    if (line === "") {
      continue;
    }
    const letter = line.slice(0, 1);
    const path = line.slice(2);
    const held: string[] = [];
    if (letter === letter.toLowerCase() && letter !== letter.toUpperCase()) {
      held.push("assume-unchanged");
    }
    if (letter === "S") {
      held.push("skip-worktree");
    }
    if (held.length > 0) {
      flags.set(path, Object.freeze(held));
    }
  }

  const entries: RetainedIndexEntry[] = [];
  for (const line of (staged ?? "").split("\n")) {
    if (line === "") {
      continue;
    }
    const tab = line.indexOf("\t");
    if (tab <= 0) {
      return undefined;
    }
    const [mode, oid, stage] = line.slice(0, tab).split(/\s+/);
    const path = line.slice(tab + 1);
    if (mode === undefined || oid === undefined || stage === undefined) {
      return undefined;
    }
    const level = Number.parseInt(stage, 10);
    if (!Number.isSafeInteger(level) || level < 0) {
      return undefined;
    }
    entries.push(
      Object.freeze({
        path,
        stage: level,
        oid,
        mode,
        flags: flags.get(path) ?? Object.freeze([]),
      }),
    );
  }
  entries.sort(byPathThenStage);
  return Object.freeze(entries);
}

function byPathThenStage(left: RetainedIndexEntry, right: RetainedIndexEntry): number {
  if (left.path !== right.path) {
    return left.path < right.path ? -1 : 1;
  }
  return left.stage - right.stage;
}

/**
 * Every path in the worktree, whatever Git thinks of it.
 *
 * Walked rather than listed through Git, because untracked and ignored content
 * is part of what a document left behind: a resume that found an extra file is
 * looking at a checkout somebody else has been in. Empty directories are
 * entries of their own for the same reason — Git does not track them, and a
 * recursive ensure creates them.
 *
 * A symbolic link is recorded by its target, never by what the target holds:
 * following it would inventory something outside this checkout.
 */
function* readWorktree(
  directory: string,
  administration: readonly string[],
): Operation<Result<readonly RetainedWorktreeEntry[]>> {
  const excluded = new Set(administration.map((path) => resolve(path)));
  const entries: RetainedWorktreeEntry[] = [];
  const pending: string[] = [directory];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }
    let names: string[];
    try {
      names = yield* readdir(current);
    } catch {
      return refuse(`"${current}" could not be listed, so this checkout is not described.`);
    }
    for (const name of names) {
      const path = join(current, name);
      if (excluded.has(resolve(path))) {
        continue;
      }
      let info: Stats;
      try {
        info = yield* lstat(path);
      } catch {
        return refuse(`"${path}" could not be read, so this checkout is not described.`);
      }
      const at = posix(relative(directory, path));
      const mode = modeOf(info);
      if (info.isSymbolicLink()) {
        try {
          entries.push(
            Object.freeze({ kind: "symlink", path: at, target: yield* until(readlink(path)) }),
          );
        } catch {
          return refuse(`the link "${path}" could not be read.`);
        }
        continue;
      }
      if (info.isDirectory()) {
        entries.push(Object.freeze({ kind: "directory", path: at, mode }));
        pending.push(path);
        continue;
      }
      if (!info.isFile()) {
        return refuse(
          `"${path}" is neither a file, a directory nor a link, and this host does not ` +
            "retain what it is.",
        );
      }
      try {
        entries.push(
          Object.freeze({
            kind: "file",
            path: at,
            mode,
            bytes: encodeBase64(new Uint8Array(yield* until(readFile(path)))),
          }),
        );
      } catch {
        return refuse(`"${path}" could not be read, so this checkout is not described.`);
      }
    }
  }

  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return Ok(Object.freeze(entries));
}

/**
 * The permission bits, as four octal digits.
 *
 * The whole permission set rather than Git's two file modes: an executable bit
 * is content as far as a commit is concerned, and the rest is state a document
 * can set and a resume has to find again.
 */
function modeOf(info: Stats): string {
  return (info.mode & 0o7777).toString(8).padStart(4, "0");
}

/** One path spelling, whatever separator this host walks with. */
function posix(path: string): string {
  return path.split(/[\\/]/).join("/");
}
