/**
 * `<File>` — read and write UTF-8 text inside the contextual working directory
 * (specs/executable-mdx-spec.md §6.13).
 *
 * Both forms take one relative `path`, resolved against `Env.cwd`, so a
 * document composes with `<TempDir>` without choosing where anything lives.
 * What "resolved" means belongs to the installed `API.Files` provider: under
 * `xmd run` it is a path in the caller's own filesystem, and under a workflow
 * run it names an entry in a logical filesystem the run owns. This component
 * names neither, and makes no filesystem call of its own.
 *
 * What it does own is **order**, and the order is the whole design. A write
 * happens in two stages that answer different questions at different times.
 *
 * The first is `checkFilePath`: pure path arithmetic, no filesystem access, and
 * nothing usable comes back. An empty path, an absolute path, and a lexical
 * `..` escape are refused there. It runs **before** the children expand, so an
 * unusable path costs nothing and its printed error is written before there is
 * any child failure to report alongside it.
 *
 * The second is `writeTextFile`, which runs **after** the children have
 * finished, because a child can change what a path means — replacing a
 * directory with a symlink out of the workspace, for instance — and a
 * destination resolved earlier would not be the one the write lands on. That
 * call repeats admission from the same authored path and then owns every later
 * step: resolution, target classification, parent creation, and the commit. The
 * earlier check therefore authorizes nothing; it only decides whether children
 * run.
 *
 * Printed errors name only the path the document wrote. A resolved path, the
 * destination a symlink pointed at, a temporary file, and a rejected absolute
 * path never cross the provider boundary at all — what comes back is a
 * `FilesReason` from a fixed vocabulary, which *selects* a phrase from
 * `fs-error-phrases.ts`. §1.2 keeps absolute paths out of printed errors, and a
 * containment failure is the last place to start reporting them.
 *
 * A failed cleanup of a provider's temporary is the one thing reported that the
 * document did not ask for, and it is reported alongside the write's own
 * outcome rather than instead of it — a file the document did not create may be
 * sitting in its directory, which it cannot learn any other way.
 *
 * ## Failure, and the two kinds of it
 *
 * An ordinary filesystem condition arrives as a structured `Err` and becomes a
 * printed error. A provider that is not installed, that refuses an operation,
 * or that breaks its own contract throws instead, and `invokeFiles` keeps it
 * fatal: there is nothing for the document to read in "no filesystem provider
 * is installed", and printing it would let the siblings after this one run as
 * though the file work had happened.
 *
 * ## Threat model
 *
 * Containment is the provider's claim, not this component's. The host provider
 * judges it against the filesystem as it observes it, which is sound while the
 * host pathname namespace is stable; a transaction-bound provider resolves
 * logical paths that never reach a host filesystem call at all. Deferring the
 * second stage until immediately before the write is what covers the
 * document's own children under either.
 */

import type { Operation } from "effection";
import { printErrors } from "../component-failures.ts";
import { cwd } from "@executablemd/runtime";
import { parseFilesFailure } from "@executablemd/runtime";
import type { FilesFailureData, FileWriteFailureData, FilesReason } from "@executablemd/runtime";
import { content } from "../component-api.ts";
import { hasContent } from "../content-context.ts";
import { ContentError, DocumentationError, ProjectedContentError } from "../errors.ts";
import { checkFilePath, readFileText, writeFileText } from "../files.ts";
import type { Json } from "../types.ts";
import { reason } from "./fs-error-phrases.ts";

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
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FileAccessError";
  }
}

export default printErrors(function* (props: Record<string, Json>): Operation<string> {
  const requested = String(props.path);
  const directory = yield* cwd();

  if (yield* hasContent()) {
    const admitted = yield* checkFilePath({ cwd: directory, path: requested });
    if (!admitted.ok) {
      throw new FileAccessError(refusal(requested, "write", parseFilesFailure(admitted.error)));
    }

    // The children run only once the path is known to be usable, and the
    // destination is resolved only once they are done.
    const text = yield* rendered(requested);
    const failure = yield* writeFileText({ cwd: directory, path: requested, content: text });
    if (failure !== undefined) {
      throw new FileAccessError(report(requested, failure));
    }
    return "";
  }

  const read = yield* readFileText({ cwd: directory, path: requested });
  if (!read.ok) {
    throw new FileAccessError(refusal(requested, "read", parseFilesFailure(read.error)));
  }
  return read.value;
});

/**
 * The rendered children, or a failure if anything went wrong producing them.
 *
 * `content()` is a failure boundary: content that fails to expand throws
 * `ContentError` there rather than coming back as text with the printed error
 * embedded in it. For a component that renders its content, embedding is the
 * right outcome — the reader sees what failed, in place. A write has nowhere to
 * show it, and writing the printed error into the file would be worse than
 * useless, so this recovers from the boundary and turns the whole invocation
 * into a failure instead. Nothing reaches the provider, and the target keeps
 * whatever it already held.
 *
 * The original messages come along, because `<File>` renders nothing: this
 * sentence is the only place the reader would learn what actually went wrong.
 * Anything else thrown is not a content failure and passes through untouched.
 *
 * **Saying what was not written is not the same as owning the failure.** Which
 * of the two this is depends on what the caller's region already did with the
 * error, and the content failure says so:
 *
 * - It carries a **decided** failure when the region the content is written in
 *   settled it as one. That decision is the caller's, so the sentence travels
 *   as an account of it (`ProjectedContentError`), passes outward through this
 *   component's own printing declaration, and is settled where the element was
 *   written — at a plain root, by ending the run (§6.8.1, §6.9).
 * - It carries none when the content merely *printed* its errors. The caller's
 *   region already settled those as data, and refusing to write a document
 *   holding a printed error is this component's own decision — an ordinary
 *   `FileAccessError`, printed by this component's declaration, with the
 *   content failure and its segments reachable underneath.
 */
function* rendered(requested: string): Operation<string> {
  try {
    return yield* content();
  } catch (error) {
    if (!(error instanceof ContentError)) {
      throw error;
    }
    const failures = error.errors.map((segment) => segment.message);
    const sentence = `did not write "${requested}": its content failed to expand. ${failures.join(
      " ",
    )}`;
    // One read of the caught error, not a search of its causes: `content()`
    // puts the region's decision here when there was one.
    const decided = error.cause;
    if (decided instanceof DocumentationError) {
      throw new ProjectedContentError(sentence, decided);
    }
    throw new FileAccessError(sentence, { cause: error });
  }
}

const EMPTY = "path is empty; give a path relative to the working directory.";
const ABSOLUTE = "an absolute path is not accepted; give a path relative to the working directory.";

/**
 * The sentence for a failure that stopped before anything was written.
 *
 * The lexical refusals and the two containment escapes are named rather than
 * phrased, because each says something about the path the document wrote rather
 * than about a filesystem condition. A rejected absolute path is deliberately
 * not echoed: §1.2 keeps absolute paths out of printed errors, and the whole
 * reason this one was refused is that it named somewhere else.
 *
 * Everything else is the verb, the document's own path, and an allowlisted
 * phrase.
 */
function refusal(
  requested: string,
  verb: "read" | "write",
  data: FilesFailureData | FileWriteFailureData | undefined,
): string {
  if (data === undefined) {
    return `cannot ${verb} "${requested}": ${reason(undefined)}.`;
  }
  if (data.reason === "empty-path") {
    return EMPTY;
  }
  if (data.reason === "absolute-path") {
    return ABSOLUTE;
  }
  if (data.reason === "lexical-escape") {
    return `"${requested}" resolves outside the working directory.`;
  }
  if (data.reason === "resolved-escape") {
    return `"${requested}" leads through a symlink outside the working directory.`;
  }
  if (data.phase === "resolution") {
    return `cannot resolve "${requested}": ${reason(data.reason)}.`;
  }
  if (data.phase === "target") {
    return classified(requested, verb, data.reason);
  }
  return `cannot ${verb} "${requested}": ${reason(data.reason)}.`;
}

/**
 * What the target turned out to be, when that is the answer rather than an
 * errno.
 *
 * A directory is not text, and saying so is better than whatever reading one
 * produces on a given platform. "No such file" is the read's own phrasing of
 * the same idea: the document asked for a file, and there is not one.
 */
function classified(requested: string, verb: "read" | "write", why: FilesReason | undefined) {
  if (verb === "read") {
    if (why === "missing") {
      return `cannot read "${requested}": no such file.`;
    }
    if (why === "directory") {
      return `cannot read "${requested}": it is a directory, not a text file.`;
    }
    if (why === "special-file") {
      return `cannot read "${requested}": it is not a regular file.`;
    }
  }
  if (verb === "write" && (why === "directory" || why === "special-file")) {
    const kind = why === "directory" ? "directory" : "special file";
    return `cannot write "${requested}": it is a ${kind}, not a text file.`;
  }
  return `cannot ${verb} "${requested}": ${reason(why)}.`;
}

/**
 * What can be said about the target, given where the write stopped.
 *
 * Only three of these are conclusions. Everything up to the commit changed
 * nothing, a commit that returned committed, and a transaction that rolled its
 * change back is back where it started. A commit that *threw* is the honest
 * "unknown": the provider cannot tell whether the underlying replacement ran, so
 * the answer is one of two whole files, but not which.
 *
 * The phases before the commit have no outcome sentence at all. Nothing was
 * attempted on the target, so there is nothing to report about it beyond why the
 * write did not start.
 */
const OUTCOMES: ReadonlyMap<string, string> = new Map([
  ["temporary", "The previous file is unchanged."],
  [
    "commit",
    "Whether the replacement committed is unknown: the target holds either the " +
      "complete previous content or the complete replacement, never a partial write.",
  ],
  ["cleanup", "The file was written."],
  ["transaction", "The Workspace change was rolled back."],
]);

/**
 * Orthogonal to the outcome: a temporary that could not be removed is a separate
 * fact about the directory, and composes with any of them.
 */
const LEFTOVER = "A temporary file beside it may remain.";

/**
 * The complete report for a failed write.
 *
 * The write's own failure and a failed cleanup are both reported, in that order,
 * because neither may hide the other: one says what is known about the target,
 * the other that something was left behind, and a reader needs both to know what
 * the directory now holds. The outcome sentence follows them, and the leftover
 * warning follows that.
 */
function report(requested: string, data: FileWriteFailureData): string {
  const parts: string[] = [];
  if (data.reason !== undefined) {
    parts.push(refusal(requested, "write", data));
  }
  if (data.cleanup !== undefined) {
    parts.push(`cannot clean up "${requested}": ${reason(data.cleanup)}.`);
  }
  const outcome = OUTCOMES.get(data.phase);
  if (outcome !== undefined) {
    parts.push(outcome);
  }
  if (data.cleanup !== undefined) {
    parts.push(LEFTOVER);
  }
  return parts.join(" ");
}
