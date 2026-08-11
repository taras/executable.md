/**
 * Where a document's path lands in a run's logical Workspace.
 *
 * Every path a workflow document writes is resolved here, and the result is an
 * absolute POSIX path inside the run's own filesystem. Nothing this module
 * produces is a host path: there is no drive, no separator to choose, and no
 * outside for a resolution to reach — the Workspace root *is* the boundary, so
 * containment is decided by arithmetic on segments rather than by observing a
 * filesystem.
 *
 * That is why admission here is purely lexical. The host provider has to defer
 * part of its judgement until it can see a symlink, because a host path can
 * point anywhere; a logical path resolves inside a tree the run owns entirely,
 * and `/..` is `/` the way POSIX says it is.
 */

import { Err, Ok, type Result } from "effection";
import type { FilesReason } from "@executablemd/runtime";

/** A path the document wrote that names nothing this Workspace can hold. */
export class LogicalPathError extends Error {
  override name = "LogicalPathError";
  readonly reason: FilesReason;

  constructor(reason: FilesReason) {
    super("logical path refused");
    this.reason = reason;
  }
}

export const WORKSPACE_ROOT = "/";

/** No filesystem holds a name containing one, so no path here may carry one. */
const NUL = "\u0000";

/**
 * The segments of a directory this Workspace can be working in.
 *
 * A caller's working directory is arrangement rather than a document's own
 * text, so it is clamped rather than refused: a leading `..` at the root stays
 * at the root, exactly as it would in a POSIX filesystem, and a directory that
 * is not written as an absolute path is read relative to the root. Neither can
 * name anything outside the Workspace, which is the only property this needs.
 */
function directorySegments(cwd: string): string[] {
  const segments: string[] = [];
  for (const segment of cwd.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments;
}

function posix(segments: readonly string[]): string {
  return segments.length === 0 ? WORKSPACE_ROOT : `/${segments.join("/")}`;
}

/** The absolute logical directory a document is working in. */
export function logicalDirectory(cwd: string): string {
  return posix(directorySegments(cwd));
}

/**
 * The absolute logical path an authored path names, or why it names none.
 *
 * The three lexical refusals are the ones a document can act on: it wrote
 * nothing, it wrote somewhere absolute, or it wrote its way out of the
 * directory it is working in. A NUL is none of those, so it is reported as an
 * operation that cannot be carried out rather than described back to the
 * document.
 */
export function resolveLogicalPath(cwd: string, path: string): Result<string> {
  if (path === "") {
    return Err(new LogicalPathError("empty-path"));
  }
  if (path.startsWith("/")) {
    return Err(new LogicalPathError("absolute-path"));
  }
  if (path.includes(NUL) || cwd.includes(NUL)) {
    return Err(new LogicalPathError("operation-failed"));
  }

  const base = directorySegments(cwd);
  const segments = [...base];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length <= base.length) {
        return Err(new LogicalPathError("lexical-escape"));
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  // `.` and `a/..` normalize back onto the working directory. That is not an
  // escape, and saying so would misdescribe it: the path names a directory, and
  // target classification is what reports that.
  return Ok(posix(segments));
}

/** The logical parent directory of an absolute logical path. */
export function logicalParent(path: string): string {
  const segments = path.split("/").filter((segment) => segment !== "");
  segments.pop();
  return posix(segments);
}

/** The path of `entry` relative to `directory`, POSIX-separated. */
export function logicalRelative(directory: string, entry: string): string {
  const base = directory === WORKSPACE_ROOT ? "" : directory;
  return entry.startsWith(`${base}/`) ? entry.slice(base.length + 1) : entry;
}

/** One more segment beneath an absolute logical directory. */
export function logicalJoin(directory: string, name: string): string {
  return directory === WORKSPACE_ROOT ? `/${name}` : `${directory}/${name}`;
}
