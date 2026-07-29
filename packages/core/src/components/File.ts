/**
 * `<File>` — read and write UTF-8 text inside the contextual working directory
 * (specs/executable-mdx-spec.md §6.13).
 *
 * Both forms take one relative `path`, resolved against `Env.cwd`, so a
 * document composes with `<TempDir>` without choosing where anything lives.
 * Everything the component touches is confined to that directory: the path is
 * checked lexically before any filesystem call, then again once the existing
 * part of it has been resolved, so a symlink cannot carry a read or a write
 * outside the workspace.
 *
 * Writes go through a sibling temporary file and a rename. That is what makes
 * a failed or cancelled write leave the previous content in place, and it is
 * what closes the one containment hole resolution cannot: a dangling symlink
 * has nothing to resolve, and `rename` replaces the link rather than following
 * it wherever it points.
 *
 * Every filesystem call goes through the contextual `API.Fs`, so a host can
 * observe or sandbox a document's own file access on the same terms as the
 * engine's component resolution.
 */

import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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
  const target = yield* destination(requested);

  if (yield* hasContent()) {
    yield* write(requested, target, framed(yield* content(requested)));
    return "";
  }

  return yield* read(requested, target);
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

/**
 * The rendered children with their framing newlines removed.
 *
 * A block-form invocation renders the line break that follows the opening tag
 * and the one that precedes the closing tag, because both are inside the
 * element. They are markup, not content: dropping exactly one at each end is
 * what makes the two ways of writing the same file produce the same bytes.
 *
 * ```md
 * <File path="a.txt">one line</File>
 * <File path="a.txt">
 * one line
 * </File>
 * ```
 *
 * Nothing else is touched. Indentation survives, a deliberate blank line
 * before the closing tag still ends the file with a newline, and no newline is
 * added to content that does not have one.
 */
function framed(content: string): string {
  const start = content.startsWith("\n") ? 1 : 0;
  const end =
    content.length > start && content.endsWith("\n") ? content.length - 1 : content.length;
  return content.slice(start, end);
}

/**
 * The absolute path this invocation may touch, or a failure naming why not.
 *
 * Two checks, because they catch different things. The lexical one runs before
 * any filesystem call, so `../` and an absolute path are refused without
 * revealing whether what they name exists. The second resolves the part of the
 * path that is already on disk — the file itself when it is there, the deepest
 * existing ancestor when it is not — and re-checks the result, which is what
 * catches a symlink pointing out of the workspace. What comes back is that
 * resolved path, so an internal symlink is followed to the file it names
 * rather than being replaced by the write.
 */
function* destination(requested: string): Operation<string> {
  if (requested.length === 0) {
    throw new FileAccessError("path is empty; give a path relative to the working directory.");
  }
  if (isAbsolute(requested)) {
    throw new FileAccessError(
      `cannot use the absolute path "${requested}": give a path relative to the working directory.`,
    );
  }

  const directory = yield* cwd();
  const base = (yield* realpath(directory)) ?? directory;
  const lexical = resolve(base, requested);
  if (!within(base, lexical)) {
    throw new FileAccessError(`"${requested}" resolves outside the working directory ${base}.`);
  }

  const effective = yield* resolveExisting(lexical);
  if (!within(base, effective)) {
    throw new FileAccessError(
      `"${requested}" leads through a symlink to ${effective}, outside the working directory ${base}.`,
    );
  }

  return effective;
}

/** Whether `path` names something strictly inside `base`. */
function within(base: string, path: string): boolean {
  const rel = relative(base, path);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
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
 * exactly as it was. The temporary is removed on every exit, including
 * cancellation, and is already gone after a successful rename.
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
    yield* writeTextFile(temporary, content);
    yield* ensure(() => remove(temporary, { force: true }));
    yield* rename(temporary, target);
  });
}
