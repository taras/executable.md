/**
 * The authorized way one push reaches this run's Git objects, and nothing more.
 *
 * Never the selected checkout itself. A checkout carries a `.git/config` the
 * Workspace retains and a document can write, and several ordinary settings in
 * one name a program or a destination: `remote.origin.pushurl`, a
 * `url.<base>.pushInsteadOf` rewrite, a `pre-push` hook, a credential helper,
 * `gpg.program`. Running the transport there would let retained document data
 * choose where this run publishes and what else runs while it happens.
 *
 * So the transport runs in a bare repository this provider created, configured
 * by nothing but its own creation, which reads the checkout's object database
 * through a read-only alternate. Same objects, different door — and the door
 * this run owns.
 *
 * ## The door is not the whole of what is behind it
 *
 * Pointing that alternate at the checkout's object database says where Git
 * starts reading, not where it stops. An object database names further ones in
 * `objects/info/alternates`, Git follows that chain transitively, and every
 * file in the chain is inside the Workspace this run restores — so a document
 * that writes one is choosing which objects a push may publish. A symbolic link
 * anywhere under `objects/` does the same thing without a chain at all: the
 * operating system resolves it before Git reports anything about it.
 *
 * Neither is repaired here. Deleting an authored alternate would publish from a
 * database this run edited on the author's behalf, and ignoring one would
 * publish from a database that is not the one it verified. The graph is
 * *rejected*: everything Git may traverse has to resolve inside the object
 * database this run authenticated, and a graph that leaves it is not a source
 * this push has an authorized way to read.
 *
 * ## Why it is lazy
 *
 * Nothing here runs until a live provider first needs the source, which is
 * before its first remote observation and after every local authority check. An
 * execution that replays a completed push reaches no provider at all: the
 * shared engine hands back the retained record, so no control repository is
 * built, no object graph is walked and no Git runs for the push.
 */

import { type Operation, until } from "effection";
import { ensureDir, lstat, readdir, readTextFile, writeTextFile } from "@effectionx/fs";
import { realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { GitOperationInfrastructureError } from "../../composition/errors.ts";
import type { GitObjectFormat } from "../../composition/records.ts";
import { commonDirectory, gitSession, initControlPlane, type GitSession } from "./git.ts";
import type { RepositoryHost } from "./host.ts";
import type { GitCheckout } from "./operations.ts";

/**
 * A source the transport may read, once something needs it.
 *
 * `ready()` answers with the control repository, having proven on its first
 * call that the object graph behind it is contained. Later calls answer with
 * the same one: a source is validated once per invocation, and the invocation
 * owns it.
 */
export interface PushObjectSource {
  readonly git: GitSession;
  ready(): Operation<string>;
}

/**
 * A containment failure, said without saying what it found.
 *
 * The path an author wrote is untrusted input, and a diagnostic is the last
 * place it should reappear. Nothing that reaches here quotes one — and the
 * Git-host boundary withholds even this sentence, because a provider's failure
 * is not something a document may read.
 */
function uncontained(operation: string, reason: string): never {
  throw new GitOperationInfrastructureError(operation, reason);
}

/** What the host holds at this path, or `undefined` when it holds nothing. */
function* entry(path: string): Operation<Stats | undefined> {
  try {
    return yield* lstat(path);
  } catch (error) {
    const code = error instanceof Error ? Reflect.get(error, "code") : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Every entry beneath the object database is one the operating system will not
 * redirect.
 *
 * `lstat` throughout, so a symbolic link answers as itself rather than as
 * whatever it points at. A link under `objects/` — `objects/pack` is the one
 * worth planting — makes an external directory the thing Git reads packs from,
 * and no question asked about the object database afterwards would say so,
 * because every one of them would already have followed it.
 */
function* containedTree(directory: string, operation: string): Operation<void> {
  for (const name of yield* readdir(directory)) {
    const path = `${directory}/${name}`;
    const info = yield* entry(path);
    if (info === undefined) {
      continue;
    }
    if (info.isSymbolicLink()) {
      uncontained(
        operation,
        "its object database holds a symbolic link, so what native Git would read is not what " +
          "this run retained",
      );
    }
    if (info.isDirectory()) {
      yield* containedTree(path, operation);
      continue;
    }
    if (!info.isFile()) {
      uncontained(
        operation,
        "its object database holds an entry that is neither a file nor a directory",
      );
    }
  }
}

/**
 * The object directories one alternates file names, as Git would read them.
 *
 * One path per line. A blank line is nothing and a `#` line is a comment, which
 * is what Git's own reader does with them; every other line is a path, absolute
 * or relative to the object directory that named it.
 */
function alternatePaths(content: string, from: string): string[] {
  const paths: string[] = [];
  for (const line of content.split("\n")) {
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    paths.push(line.startsWith("/") ? line : `${from}/${line}`);
  }
  return paths;
}

/**
 * Walk the alternates chain, and refuse a graph that leaves the database.
 *
 * Transitive, because Git's is: an alternate may name a database that names
 * another. Cycles are the author's to write and this one's to survive, so a
 * directory already walked is not walked again.
 *
 * Containment is decided on the resolved path. `realpath` is what a traversal
 * actually reaches, and a relative entry, a `..` entry and a link at the far
 * end all arrive at the same question — is what Git would read part of the
 * object database this run authenticated?
 */
function* containedAlternates(
  objects: string,
  directory: string,
  seen: Set<string>,
  operation: string,
): Operation<void> {
  if (seen.has(directory)) {
    return;
  }
  seen.add(directory);

  const file = `${directory}/info/alternates`;
  if ((yield* entry(file))?.isFile() !== true) {
    return;
  }
  for (const named of alternatePaths(yield* readTextFile(file), directory)) {
    let resolved: string;
    try {
      resolved = yield* until(realpath(named));
    } catch {
      uncontained(
        operation,
        "its object database names an alternate object directory that does not resolve",
      );
    }
    if (resolved !== objects && !resolved.startsWith(`${objects}/`)) {
      uncontained(
        operation,
        "its object database names an alternate object directory outside the database this " +
          "run authenticated, so a push from it could publish objects this run does not hold",
      );
    }
    if ((yield* entry(resolved))?.isDirectory() !== true) {
      uncontained(
        operation,
        "its object database names an alternate that is not a real object directory",
      );
    }
    yield* containedAlternates(objects, resolved, seen, operation);
  }
}

/**
 * The object database this checkout publishes from, once it is contained.
 *
 * Three questions in one order, and the order is what makes each answerable.
 * The database has to be the retained Repository's own — a linked worktree
 * shares it, which is why one proof covers both kinds of checkout. It has to be
 * a real directory that resolves to itself, so the walk below is walking the
 * export rather than somewhere a link led. And then everything Git may traverse
 * from it — every entry beneath it, and every object directory the alternates
 * chain names — has to resolve inside it.
 */
function* containedObjectDatabase(checkout: GitCheckout, operation: string): Operation<string> {
  const administration = `${checkout.repositoryDirectory}/.git`;
  if ((yield* commonDirectory(checkout.git, checkout.directory)) !== administration) {
    uncontained(
      operation,
      "the checkout it ran in does not share the retained repository's object database",
    );
  }

  const objects = `${administration}/objects`;
  if ((yield* entry(objects))?.isDirectory() !== true) {
    uncontained(operation, "the retained repository holds no object database to publish from");
  }
  if ((yield* until(realpath(objects))) !== objects) {
    uncontained(
      operation,
      "its object database does not resolve inside the checkout this run materialized",
    );
  }

  yield* containedTree(objects, operation);
  yield* containedAlternates(objects, objects, new Set<string>(), operation);
  return objects;
}

/**
 * A source for one push, built the first time something needs to read it.
 *
 * The directory is acquired by the caller's scope, so it is removed with the
 * push whether or not anything was ever built inside it. What is deferred is
 * every Git command and every filesystem walk: on a completed replay none of
 * them happens, because no provider is reached to ask.
 */
export function objectSource(
  host: RepositoryHost,
  root: string,
  checkout: GitCheckout,
  format: GitObjectFormat,
  operation: string,
): PushObjectSource {
  const git = gitSession(host, root);
  const directory = `${root}/control`;
  let built = false;
  return {
    git,
    *ready(): Operation<string> {
      if (!built) {
        const objects = yield* containedObjectDatabase(checkout, operation);
        yield* initControlPlane(git, root, directory, format);
        yield* ensureDir(`${directory}/objects/info`);
        yield* writeTextFile(`${directory}/objects/info/alternates`, `${objects}\n`);
        built = true;
      }
      return directory;
    },
  };
}
