/**
 * `<File.Delete>` — remove one file inside the contextual working directory
 * (specs/executable-mdx-spec.md §6.13.1).
 *
 * ```md
 * <File.Delete path="obsolete.md" />
 * ```
 *
 * It is the counterpart of `<File>`'s write form and is built the same way: one
 * relative `path` resolved against `Env.cwd`, one semantic `API.Files` call, and
 * no filesystem access of its own. What "resolved" means belongs to the
 * installed provider — a path in the caller's filesystem under `xmd run`, an
 * entry in a run-owned logical filesystem under a workflow run — and this
 * component names neither.
 *
 * ## Why it renders nothing, and returns nothing
 *
 * There is no outcome to hand back. A deletion that succeeded leaves the path
 * naming nothing, which is the whole of what the document asked for; a document
 * that also learned *whether something had been there* could branch on it, and
 * that is a different question about the filesystem, asked with `<File>` or
 * `<Glob>`. So this renders the empty string and declares no `returns`. `as`
 * stays what it is for any component that returns text — it captures that empty
 * string and suppresses rendering — rather than acquiring a special refusal
 * here.
 *
 * Absence is therefore success rather than a refusal. Deleting a path twice
 * succeeds twice, and a document that removes a file it may or may not have
 * created does not have to ask first.
 *
 * ## The one form
 *
 * Self-closing, and the check is the invocation's **shape** rather than what its
 * content would render. `<File.Delete path="x"></File.Delete>` is refused
 * exactly like a paired invocation carrying text: an author who wrote children
 * meant something this component does not do, and the empty rendering of those
 * children is not evidence that they meant nothing. That refusal happens before
 * `Env.cwd` is read and before the provider is reached, so a mistaken paired
 * spelling costs the document nothing.
 *
 * ## Failure
 *
 * The `printErrors` declaration is `<File>`'s: an ordinary filesystem condition
 * becomes a printed error owned by this component, and a provider that is
 * absent, refuses, or breaks its contract stays fatal rather than becoming
 * something a document renders. A printed error names the path the document
 * wrote and selects its phrase from the fixed vocabulary — no resolved path, no
 * symlink target, and no rejected absolute path (§1.2).
 */

import type { Operation } from "effection";
import { printErrors } from "../component-failures.ts";
import { cwd } from "@executablemd/runtime";
import { parseFilesFailure } from "@executablemd/runtime";
import type { FilesFailureData } from "@executablemd/runtime";
import { hasContent } from "../content-context.ts";
import { deleteFile } from "../files.ts";
import type { Json } from "../types.ts";
import { reason } from "./fs-error-phrases.ts";

export const props = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1 },
  },
  required: ["path"],
  additionalProperties: false,
};

/** A path that names nothing this component may remove. */
export class FileDeleteError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FileDeleteError";
  }
}

const PAIRED =
  '<File.Delete> is self-closing and has no content: write <File.Delete path="…" /> instead.';

export default printErrors(function* (props: Record<string, Json>): Operation<string> {
  // Before the working directory and before the provider: the shape decides
  // this, and neither of them has anything to contribute to that decision.
  if (yield* hasContent()) {
    throw new FileDeleteError(PAIRED);
  }

  const requested = String(props.path);
  const directory = yield* cwd();
  const removed = yield* deleteFile({ cwd: directory, path: requested });
  if (!removed.ok) {
    throw new FileDeleteError(refusal(requested, parseFilesFailure(removed.error)));
  }
  return "";
});

const EMPTY = "path is empty; give a path relative to the working directory.";
const ABSOLUTE = "an absolute path is not accepted; give a path relative to the working directory.";

/**
 * The sentence for a deletion that did not happen.
 *
 * The same shape as `<File>`'s: the lexical refusals and the containment escape
 * are named rather than phrased, because each says something about the path the
 * document wrote; a target that turned out to be the wrong kind of thing is
 * named too, because "it is a directory" is a better answer than whatever
 * removing one reports on a given platform. Everything else is the verb, the
 * document's own path, and an allowlisted phrase.
 *
 * A rejected absolute path is deliberately not echoed, for the reason it was
 * rejected: it named somewhere else.
 */
function refusal(requested: string, data: FilesFailureData | undefined): string {
  if (data === undefined) {
    return `cannot delete "${requested}": ${reason(undefined)}.`;
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
  if (data.phase === "target" && data.reason === "directory") {
    return `cannot delete "${requested}": it is a directory, not a file.`;
  }
  if (data.phase === "target" && data.reason === "special-file") {
    return `cannot delete "${requested}": it is not a regular file.`;
  }
  if (data.phase === "resolution") {
    return `cannot resolve "${requested}": ${reason(data.reason)}.`;
  }
  return `cannot delete "${requested}": ${reason(data.reason)}.`;
}
