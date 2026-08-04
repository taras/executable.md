/**
 * The vocabulary a failed filesystem call may be reported in.
 *
 * Shared by the components that touch the filesystem — `<File>` (§6.13) and
 * `<Glob>` (§6.14) — because the constraint is the same for both. A platform
 * error message names the path it failed on: `ENOTDIR: not a directory, stat
 * '/private/var/…'`. That is the resolved path §1.2 keeps out of printed errors,
 * and it can be a path the document never wrote — a generated temporary, or a
 * file somewhere under a directory that was only ever named by a pattern.
 *
 * So nothing from the caught error is reproduced. The errno code **selects** a
 * phrase written here, and an unrecognized code selects the generic one. The
 * code itself is never emitted, because whatever implements the Fs Api chooses
 * it and can put a path, markup, or a newline there as easily as `ENOENT`.
 */

/**
 * Every phrase, and the whole allowlist.
 *
 * A `Map` rather than an object, because a lookup on an object literal answers
 * for inherited keys — `REASONS["toString"]` would hand back a function whose
 * source would then be interpolated into a printed error.
 */
const REASONS: ReadonlyMap<string, string> = new Map([
  ["ENOENT", "no such file or directory"],
  ["ENOTDIR", "a component of the path is not a directory"],
  ["EISDIR", "it is a directory"],
  ["ENOTEMPTY", "the directory is not empty"],
  ["EACCES", "permission denied"],
  ["EPERM", "permission denied"],
  ["EROFS", "the filesystem is read-only"],
  ["ELOOP", "too many levels of symbolic links"],
  ["ENAMETOOLONG", "the path is too long"],
  ["ENOSPC", "no space left on the device"],
  ["EDQUOT", "the disk quota is exhausted"],
  ["EXDEV", "the destination is on a different filesystem"],
  ["EBUSY", "the file is in use"],
  ["EMFILE", "too many open files"],
]);

const UNRECOGNIZED = "the filesystem operation failed";

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const { code } = error;
  return typeof code === "string" ? code : undefined;
}

/**
 * A phrase for a failure, chosen from `REASONS` or the generic one.
 *
 * `code` is attacker-supplied as far as a component is concerned — anything
 * installed as Fs middleware can put a path, markup, or a newline in it — so it
 * is used to select a phrase and never to build one.
 */
export function reason(error: unknown): string {
  const code = errorCode(error);
  if (code === undefined) {
    return UNRECOGNIZED;
  }
  return REASONS.get(code) ?? UNRECOGNIZED;
}
