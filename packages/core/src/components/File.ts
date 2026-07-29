/**
 * `<File>` — read and write UTF-8 text inside the contextual working directory
 * (specs/executable-mdx-spec.md §6.13).
 *
 * Both forms take one relative `path`, resolved against `Env.cwd`, so a
 * document composes with `<TempDir>` without choosing where anything lives.
 * Everything the component touches is confined to that directory, checked in
 * two stages that answer different questions at different times.
 *
 * The first stage is pure path arithmetic against `Env.cwd`: an empty path, an
 * absolute path, and a lexical `..` escape are refused with no filesystem call
 * at all. It runs **before** the children expand, so an unusable path costs
 * nothing and its diagnostic is written before there is any child failure to
 * report alongside it.
 *
 * The second stage resolves what is actually on disk and re-checks the result,
 * which is what catches a symlink leaving the workspace. It runs **after** the
 * children have finished, because a child can change what a path means —
 * replacing a directory with a symlink out of the workspace, for instance —
 * and a destination resolved earlier would not be the one the write lands on.
 *
 * Writes go through a sibling temporary file and a rename. That is what makes
 * a failed or cancelled write leave the previous content in place, and it is
 * what closes the one containment hole resolution cannot: a dangling symlink
 * has nothing to resolve, and `rename` replaces the link rather than following
 * it wherever it points.
 *
 * Diagnostics name only the path the document wrote. A resolved workspace
 * path, the destination a symlink pointed at, and a rejected absolute path are
 * all withheld — §1.2 keeps absolute paths out of diagnostics, and a
 * containment failure is the last place to start reporting them.
 *
 * Every filesystem call goes through the contextual `API.Fs`, so a host can
 * observe or sandbox a document's own file access on the same terms as the
 * engine's component resolution.
 */

import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import {
  cwd,
  ensureDir,
  readTextFile,
  realpath,
  remove,
  rename,
  stat,
  writeTextFile,
} from "@executablemd/runtime";
import { Component } from "../component-api.ts";
import { hasContent, useContent } from "../content-context.ts";
import type { Json } from "../types.ts";

export const props = {
  type: "object",
  properties: {
    path: { type: "string" },
  },
  required: ["path"],
  additionalProperties: false,
};

/** A path that leaves the working directory, or a target that cannot be text. */
export class FileAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileAccessError";
  }
}

export default function* (props: Record<string, Json>): Operation<string> {
  const requested = String(props.path);
  const admitted = yield* admissible(requested);

  if (yield* hasContent()) {
    // The children run only once the path is known to be usable, and the
    // destination is resolved only once they are done.
    const text = yield* content(requested);
    yield* write(requested, yield* destination(admitted), text);
    return "";
  }

  return yield* read(requested, yield* destination(admitted));
}

/**
 * The rendered children, or a failure if anything went wrong producing them.
 *
 * A code block that fails is a diagnostic under a collecting policy: the
 * children still render, with the diagnostic embedded in the text. For a
 * component that renders its content that is right — the reader sees what
 * failed, in place. A write has nowhere to show it, and writing the diagnostic
 * into the file would be worse than useless, so this watches for one being
 * raised and turns the whole invocation into a failure instead. Nothing
 * reaches the filesystem, and the target keeps whatever it already held.
 *
 * The messages come along, because `<File>` renders nothing: this diagnostic
 * is the only place the reader would learn what actually went wrong.
 */
function* content(requested: string): Operation<string> {
  const failures: string[] = [];

  yield* Component.around({
    *raise([error], next) {
      failures.push(error.message);
      return yield* next(error);
    },
  });

  const rendered = yield* useContent();
  if (failures.length > 0) {
    throw new FileAccessError(
      `did not write "${requested}": its content failed to expand. ${failures.join(" ")}`,
    );
  }
  return rendered;
}

/** A path that has passed the lexical stage, carried to the resolving one. */
interface Admissible {
  /** The path the document wrote, for diagnostics. */
  requested: string;
  /** `requested` joined onto the contextual directory and normalized. */
  lexical: string;
}

/**
 * Stage one: what can be decided without touching the filesystem.
 *
 * An empty path, an absolute path, and a `..` escape are all answerable from
 * `Env.cwd` and path arithmetic alone. Deciding them here means an unusable
 * path is refused before the children of a write run at all, and that the
 * diagnostic never has to mention a path that was rejected for being absolute.
 *
 * `resolve` normalizes `..` lexically, so this holds against the contextual
 * directory as given — canonicalizing it is stage two's job and would only
 * move the same comparison onto a different pair of strings.
 */
function* admissible(requested: string): Operation<Admissible> {
  if (requested.length === 0) {
    throw new FileAccessError("path is empty; give a path relative to the working directory.");
  }
  if (isAbsolute(requested)) {
    throw new FileAccessError(
      "an absolute path is not accepted; give a path relative to the working directory.",
    );
  }

  const directory = yield* cwd();
  const lexical = resolve(directory, requested);
  if (!within(directory, lexical)) {
    throw new FileAccessError(`"${requested}" resolves outside the working directory.`);
  }

  return { requested, lexical };
}

/**
 * Stage two: the path as the filesystem currently has it.
 *
 * Resolves the part of the path that is already on disk — the file itself when
 * it is there, the deepest existing ancestor when it is not — and re-checks
 * the result, which is what catches a symlink pointing out of the workspace.
 * What comes back is that resolved path, so an internal symlink is followed to
 * the file it names rather than being replaced by the write.
 *
 * Both sides of the comparison are canonical here, so a working directory
 * reached through a symlink — macOS's `/var` against `/private/var` — does not
 * read as an escape.
 */
function* destination({ requested, lexical }: Admissible): Operation<string> {
  const directory = yield* cwd();
  const base = (yield* realpath(directory)) ?? directory;

  const effective = yield* resolveExisting(lexical);
  if (!within(base, effective)) {
    throw new FileAccessError(
      `"${requested}" leads through a symlink outside the working directory.`,
    );
  }

  return effective;
}

/**
 * Whether `path` names something strictly inside `base`.
 *
 * Only a complete `..` segment leaves the directory. A name that merely starts
 * with two dots — `..notes.md`, `..config/settings.json` — is an ordinary file
 * inside it, and a prefix test would refuse it.
 */
function within(base: string, path: string): boolean {
  const rel = relative(base, path);
  if (rel.length === 0 || isAbsolute(rel)) {
    return false;
  }
  return rel !== ".." && !rel.startsWith(`..${sep}`);
}

/**
 * `path` with every symlink in its existing prefix resolved.
 *
 * `realpath` needs the whole path to exist, and a write commonly names one
 * that does not yet, so the walk gives up one trailing segment at a time until
 * something answers and then puts the segments back. The working directory
 * always exists, so the loop terminates there at the latest.
 */
function* resolveExisting(path: string): Operation<string> {
  const trailing: string[] = [];
  let current = path;

  while (true) {
    const resolved = yield* realpath(current);
    if (resolved !== undefined) {
      return trailing.length === 0 ? resolved : join(resolved, ...trailing);
    }
    const parent = dirname(current);
    if (parent === current) {
      return join(current, ...trailing);
    }
    trailing.unshift(basename(current));
    current = parent;
  }
}

function* read(requested: string, target: string): Operation<string> {
  const info = yield* stat(target);
  if (!info.exists) {
    throw new FileAccessError(`cannot read "${requested}": no such file.`);
  }
  if (info.isDirectory) {
    throw new FileAccessError(`cannot read "${requested}": it is a directory, not a text file.`);
  }
  if (!info.isFile) {
    throw new FileAccessError(`cannot read "${requested}": it is not a regular file.`);
  }

  return yield* readTextFile(target);
}

/**
 * Replace `target` with exactly `content`.
 *
 * The content is whole by the time this runs — the children expanded first —
 * so a child that failed never reaches the filesystem at all. What remains is
 * the write itself, and the temporary file is what keeps that atomic: the
 * rename either publishes the complete text or leaves the previous file
 * exactly as it was.
 *
 * Removal is registered before the temporary is written rather than after.
 * `writeTextFile` is where an interruption is most likely to land, and a
 * cleanup installed on the far side of it would not run for the one failure it
 * exists to handle. `remove` is forced, so registering it for a file that was
 * never created — or one the rename has already consumed — is a no-op.
 */
function* write(requested: string, target: string, content: string): Operation<void> {
  const info = yield* stat(target);
  if (info.exists && !info.isFile) {
    throw new FileAccessError(
      `cannot write "${requested}": it is a ${info.isDirectory ? "directory" : "special file"}, ` +
        "not a text file.",
    );
  }

  yield* ensureDir(dirname(target));

  yield* scoped(function* () {
    const temporary = `${target}.xmd-${randomUUID().slice(0, 8)}.tmp`;
    yield* ensure(() => remove(temporary, { force: true }));
    yield* writeTextFile(temporary, content);
    yield* rename(temporary, target);
  });
}
