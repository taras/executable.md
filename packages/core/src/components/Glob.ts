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
 * empty pattern, which matches nothing by construction. Those rules and the
 * sanitized sentence a failed search produces are `glob-source.ts`, shared with
 * the Glob capability an evaluation profile admits, so one document and one
 * generated fragment are held to one dialect.
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
import { globFiles } from "../files.ts";
import { GLOB_PROPS, GLOB_RETURNS, globFailure, globPatterns } from "../glob-source.ts";
import type { Json } from "../types.ts";

export const props = GLOB_PROPS;

/**
 * Declaring `returns` is what makes this a value component: the engine requires
 * `as`, renders nothing, and validates what comes back (§6.10).
 */
export const returns = GLOB_RETURNS;

/** A pattern that cannot be used, or a directory that cannot be searched. */
export class GlobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlobError";
  }
}

export default printErrors(function* (props: Record<string, Json>): Operation<string[]> {
  const include = globPatterns("include", props.include);
  if (!include.ok) {
    throw new GlobError(include.error.message);
  }
  const exclude = globPatterns("exclude", props.exclude);
  if (!exclude.ok) {
    throw new GlobError(exclude.error.message);
  }

  const found = yield* globFiles({
    cwd: yield* cwd(),
    include: include.value,
    exclude: exclude.value,
  });
  if (!found.ok) {
    throw new GlobError(
      globFailure(parseFilesFailure(found.error), [...include.value, ...exclude.value]),
    );
  }
  return found.value;
});
