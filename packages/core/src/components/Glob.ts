/**
 * `<Glob>` — the files under the contextual working directory that a set of
 * patterns selects (specs/executable-mdx-spec.md §6.14).
 *
 * A value component: it declares `returns`, so it must be captured with `as`,
 * renders nothing, and binds one `string[]`. What it binds is a *set* — every
 * path relative to `Env.cwd` with POSIX separators, deduplicated, and sorted by
 * code point. Nothing about the order or the spelling comes from the order the
 * filesystem happened to hand entries back in, because a document that branches
 * on a listing must branch the same way on every host.
 *
 * Patterns are checked before the filesystem is touched. A pattern that cannot
 * match anything under a relative root — an absolute one, or one whose first
 * segment is `..` — is refused rather than quietly contributing nothing: an
 * empty result is the answer to "there are no such files", and it must not also
 * be the answer to "that pattern was a mistake". The same stage refuses an
 * empty pattern, which matches nothing by construction.
 *
 * Everything else about matching belongs to the Fs Api's `glob`, which is the
 * dialect. This component adds no syntax of its own, which is why a leading dot
 * needs no special prop: `*` matches one, so a pattern that names a hidden file
 * finds it and a pattern that does not, does not.
 *
 * Only regular files come back. A symbolic link is a link rather than a file,
 * so it is never a result and a link to a directory is never descended into —
 * which is also what keeps traversal inside `Env.cwd` and free of cycles. The
 * Fs Api exposes symlink following, but nothing there confines a resolved
 * destination to the root or detects a traversal cycle, so following one cannot
 * be offered safely yet.
 *
 * Diagnostics name the pattern the document wrote, or nothing at all. A
 * traversal failure names no path: what failed is a directory somewhere under
 * `Env.cwd` that the document never wrote and §1.2 keeps out of diagnostics
 * anyway, so the sentence says the working directory could not be listed and
 * selects its reason from the shared allowlist.
 *
 * `<Glob>` records no durable effect, so what a replay does depends on whether
 * expansion reaches it. A journal holding the root's close restores the captured
 * array without expanding anything; a partial journal reaches the component and
 * the search runs again against whatever is on disk now.
 */

import { isAbsolute } from "node:path";
import type { Operation } from "effection";
import { captureErrors } from "../component-failures.ts";
import { cwd, glob, stat } from "@executablemd/runtime";
import type { Json } from "../types.ts";
import { reason } from "./fs-diagnostics.ts";

export const props = {
  type: "object",
  properties: {
    include: { type: "array", items: { type: "string" }, minItems: 1 },
    exclude: { type: "array", items: { type: "string" }, default: [] },
  },
  required: ["include"],
  additionalProperties: false,
};

/**
 * Declaring `returns` is what makes this a value component: the engine requires
 * `as`, renders nothing, and validates what comes back (§6.10).
 */
export const returns = {
  type: "array",
  items: { type: "string" },
};

/** A pattern that cannot be used, or a directory that cannot be searched. */
export class GlobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlobError";
  }
}

export default captureErrors(function* (props: Record<string, Json>): Operation<string[]> {
  const include = patterns("include", props.include);
  const exclude = patterns("exclude", props.exclude);

  const root = yield* directory();

  // The Api reports directories and symlinks too, so a caller says which of
  // them it wants. This one wants files.
  const matched = yield* search({ root, patterns: include, exclude });
  const files = matched.filter((entry) => entry.isFile).map((entry) => entry.path);

  return [...new Set(files)].sort(byCodePoint);
});

/**
 * The patterns a prop holds, checked for the two things that make one unusable.
 *
 * Prop validation has already established an array of strings, so the shape is
 * re-read rather than asserted (`as` would claim it instead) and a value that
 * somehow is not one contributes nothing. What validation cannot express is
 * *meaning*: patterns match paths relative to `Env.cwd`, so an absolute pattern
 * and one that starts by leaving cannot match anything a search can produce.
 *
 * Only a whole `..` first segment leaves. `..notes.md` is an ordinary name, and
 * a `..` further along — `docs/../*.md` — is a path the search never generates,
 * so it matches nothing for the ordinary reason and needs no special refusal.
 */
function patterns(prop: string, value: Json | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const found: string[] = [];
  for (const pattern of value) {
    if (typeof pattern !== "string") {
      continue;
    }
    if (pattern.length === 0) {
      throw new GlobError(
        `${prop} holds an empty pattern, which matches nothing; ` +
          "give a pattern relative to the working directory.",
      );
    }
    if (isAbsolute(pattern)) {
      throw new GlobError(
        `${prop} pattern "${pattern}" is absolute; ` +
          "give a pattern relative to the working directory.",
      );
    }
    if (pattern === ".." || pattern.startsWith("../")) {
      throw new GlobError(`${prop} pattern "${pattern}" reaches outside the working directory.`);
    }
    found.push(pattern);
  }
  return found;
}

/**
 * The contextual working directory, once it is known to be searchable.
 *
 * Checked here rather than left to the traversal, because the two failures read
 * very differently to an author: a directory that is missing or is a file is
 * something about the document's own environment, while a traversal failure is
 * something about one entry inside a directory that was fine.
 */
function* directory(): Operation<string> {
  const root = yield* cwd();

  const info = yield* guard(stat(root));
  if (!info.exists) {
    throw new GlobError("the working directory does not exist.");
  }
  if (!info.isDirectory) {
    throw new GlobError("the working directory is not a directory.");
  }

  return root;
}

interface Search {
  root: string;
  patterns: string[];
  exclude: string[];
}

/**
 * Run the search, reporting a pattern that cannot be compiled as the authoring
 * error it is.
 *
 * The Api compiles patterns as it starts, so an unusable one — an unterminated
 * character class — arrives as a `SyntaxError` from `RegExp` rather than as an
 * errno. It is separated from a traversal failure because it is the one failure
 * here the document can fix by editing a pattern, and because a `RegExp`
 * message describes a translated regular expression the author never wrote.
 *
 * Which pattern it was is not recoverable from the error, so the sentence lists
 * the candidates instead of naming one. They are the document's own text.
 */
function* search(options: Search): Operation<Array<{ path: string; isFile: boolean }>> {
  try {
    return yield* glob(options);
  } catch (error) {
    if (error instanceof SyntaxError) {
      const all = [...options.patterns, ...options.exclude];
      throw new GlobError(
        `one of these patterns cannot be used: ${all.map((p) => `"${p}"`).join(", ")}.`,
      );
    }
    throw failed(error);
  }
}

/**
 * Run a filesystem operation, replacing whatever it throws with a sanitized
 * sentence.
 *
 * Nothing is passed through, including a `GlobError`: this component's own
 * checks throw outside guarded calls, so an error surfacing from inside one came
 * from the Api, and an error's class says nothing about whether its message is
 * safe to show.
 */
function* guard<T>(operation: Operation<T>): Operation<T> {
  try {
    return yield* operation;
  } catch (error) {
    throw failed(error);
  }
}

/**
 * One sanitized sentence for a failed filesystem call.
 *
 * It names no path. What failed is the working directory or something under it,
 * and both are absolute paths the document did not write (§1.2).
 */
function failed(error: unknown): GlobError {
  return new GlobError(`cannot search the working directory: ${reason(error)}.`);
}

// Code point order, not `localeCompare`: what a document branches on must not
// depend on the locale the host happens to be configured with.
function byCodePoint(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
