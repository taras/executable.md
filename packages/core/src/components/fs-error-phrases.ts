/**
 * The vocabulary a failed filesystem operation may be reported in.
 *
 * Shared by the components that reach the filesystem — `<File>` (§6.13) and
 * `<Glob>` (§6.14) — because the constraint is the same for both. A platform
 * error message names the path it failed on: `ENOTDIR: not a directory, stat
 * '/private/var/…'`. That is the resolved path §1.2 keeps out of printed errors,
 * and it can be a path the document never wrote — a generated temporary, or a
 * file somewhere under a directory that was only ever named by a pattern.
 *
 * So nothing from the failure is reproduced. The provider has already reduced
 * whatever its platform produced to a `FilesReason`, and that reason **selects**
 * a phrase written here. An unrecognized reason selects the generic one, which
 * is also what a provider reports when it could not classify the condition.
 */

import type { FilesReason } from "@executablemd/runtime";

/**
 * Every phrase, and the whole allowlist.
 *
 * A `Map` rather than an object literal, because a lookup on one answers for
 * inherited keys — `PHRASES["toString"]` would hand back a function whose source
 * would then be interpolated into a printed error.
 *
 * The reasons that are not here are the ones a component has a sentence of its
 * own for: the lexical refusals, the containment escapes, a target that is a
 * directory or a special file, and a pattern that cannot be compiled.
 */
const PHRASES: ReadonlyMap<string, string> = new Map<FilesReason, string>([
  ["missing", "no such file or directory"],
  ["not-directory", "a component of the path is not a directory"],
  ["directory", "it is a directory"],
  ["directory-not-empty", "the directory is not empty"],
  ["permission-denied", "permission denied"],
  ["read-only", "the filesystem is read-only"],
  ["too-many-symlinks", "too many levels of symbolic links"],
  ["path-too-long", "the path is too long"],
  ["no-space", "no space left on the device"],
  ["quota-exhausted", "the disk quota is exhausted"],
  ["cross-device", "the destination is on a different filesystem"],
  ["busy", "the file is in use"],
  ["too-many-open-files", "too many open files"],
]);

const UNRECOGNIZED = "the filesystem operation failed";

/** A phrase for a failure, chosen from `PHRASES` or the generic one. */
export function reason(value: FilesReason | undefined): string {
  if (value === undefined) {
    return UNRECOGNIZED;
  }
  return PHRASES.get(value) ?? UNRECOGNIZED;
}
