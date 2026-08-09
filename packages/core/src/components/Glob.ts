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
 * Everything else about matching belongs to the `API.Files` provider, which is
 * the dialect and owns the whole search. This component adds no syntax of its
 * own, which is why a leading dot needs no special prop: `*` matches one, so a
 * pattern that names a hidden file finds it and a pattern that does not, does
 * not.
 *
 * Only regular files come back. A symbolic link is a link rather than a file,
 * so it is never a result and a link to a directory is never descended into —
 * which is also what keeps traversal inside `Env.cwd` and free of cycles.
 * Following one cannot be offered safely yet: nothing here confines a resolved
 * destination to the root or detects a traversal cycle.
 *
 * Printed errors name the pattern the document wrote, or nothing at all. A
 * traversal failure names no path: what failed is a directory somewhere under
 * `Env.cwd` that the document never wrote and §1.2 keeps out of printed errors
 * anyway, so the sentence says the working directory could not be listed and
 * selects its reason from the shared allowlist.
 *
 * `<Glob>` records no durable effect, so what a replay does depends on whether
 * expansion reaches it. A journal holding the root's close restores the captured
 * array without expanding anything; a partial journal reaches the component and
 * the search runs again against whatever is on disk now.
 */

import type { Operation } from "effection";
import { printErrors } from "../component-failures.ts";
import { cwd, parseFilesFailure } from "@executablemd/runtime";
import type { FilesFailureData } from "@executablemd/runtime";
import { globFiles } from "../files.ts";
import type { Json } from "../types.ts";
import { reason } from "./fs-error-phrases.ts";

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

export default printErrors(function* (props: Record<string, Json>): Operation<string[]> {
  const include = patterns("include", props.include);
  const exclude = patterns("exclude", props.exclude);

  const found = yield* globFiles({ cwd: yield* cwd(), include, exclude });
  if (!found.ok) {
    throw failed(parseFilesFailure(found.error), [...include, ...exclude]);
  }
  return found.value;
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
    if (absolute(pattern)) {
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
 * Whether a pattern names an absolute location.
 *
 * Decided from the pattern's own grammar rather than the running platform's.
 * Patterns match POSIX-relative paths on every host — that is what makes one
 * document mean one thing everywhere — so a leading `/` is absolute wherever
 * this runs, and so is a drive-letter prefix, which is absolute on the host that
 * has drives and matches nothing on the hosts that do not. A leading backslash
 * is left alone: in this dialect it escapes the character after it.
 */
function absolute(pattern: string): boolean {
  return pattern.startsWith("/") || /^[A-Za-z]:[\\/]/.test(pattern);
}

/**
 * One sanitized sentence for a failed search.
 *
 * The two questions an author can act on are separated from the rest. A working
 * directory that is missing or is a file is something about the document's own
 * environment; a pattern the dialect cannot compile — an unterminated character
 * class — is something about the document's own text. Which pattern it was does
 * not survive the provider boundary, so the sentence lists the candidates
 * instead of naming one. They are the document's own text.
 *
 * Everything else names no path. What failed is the working directory or
 * something under it, and both are absolute paths the document did not write
 * (§1.2).
 */
function failed(data: FilesFailureData | undefined, candidates: string[]): GlobError {
  if (data?.phase === "target" && data.reason === "missing") {
    return new GlobError("the working directory does not exist.");
  }
  if (data?.phase === "target" && data.reason === "not-directory") {
    return new GlobError("the working directory is not a directory.");
  }
  if (data?.phase === "pattern") {
    return new GlobError(
      `one of these patterns cannot be used: ${candidates.map((p) => `"${p}"`).join(", ")}.`,
    );
  }
  return new GlobError(`cannot search the working directory: ${reason(data?.reason)}.`);
}
