import type { Operation } from "effection";
import { readTextFile } from "@executablemd/runtime";

import { decodePercentEncoded, encodeDocumentPath, isCanonicalTarget } from "./document-targets.ts";

/** The stable identity an inline root document reports. */
export const INLINE_SOURCE_PATH = "<eval>";

/** What a reference that cannot be read says, and all it says. */
const INVALID_REFERENCE = "Invalid document reference";

/** A root document read from a path, optionally projected to one target. */
export interface FileRootDocument {
  readonly path: string;
  readonly source?: undefined;
  /** The requested target selector, still encoded and possibly a glob. */
  readonly target?: string;
}

/**
 * A root document supplied as text. The identity is part of the value, so text
 * and identity cannot be separated once constructed.
 */
export interface InlineRootDocument {
  readonly path: typeof INLINE_SOURCE_PATH;
  readonly source: string;
  /** The requested target selector, still encoded and possibly a glob. */
  readonly target?: string;
}

/** Where a root document's text comes from: a path, or supplied text. */
export type RootDocumentSource = FileRootDocument | InlineRootDocument;

/** Supplied text as a root document carrying the `<eval>` identity. */
export function inlineSource(
  source: string,
  options?: { readonly target?: string },
): InlineRootDocument {
  const target = options?.target;
  return {
    path: INLINE_SOURCE_PATH,
    source,
    ...(target === undefined ? {} : { target }),
  };
}

/**
 * A file root document from a URI-style document reference.
 *
 * The reference is `<encoded-document-path>#<target-selector>`, split at the
 * first raw `#`. The path is percent-decoded; the fragment is not, because
 * `%2F` has to stay distinguishable from the raw `/` that separates target
 * levels — the selector parser splits the hierarchy and operator syntax first
 * and decodes only the literal chunks between them.
 *
 * A reference that cannot be read fails with a `TypeError` carrying nothing but
 * fixed wording: the input is a command-line argument, and echoing it back
 * would put arbitrary bytes into a diagnostic.
 *
 * A filename containing `#` is written `%23`, and one containing a literal
 * `%HH` sequence is written `%25HH`.
 */
export function fileSource(reference: string): FileRootDocument {
  const fragment = reference.indexOf("#");
  const encodedPath = fragment === -1 ? reference : reference.slice(0, fragment);
  const path = decodePercentEncoded(encodedPath);
  if (path === undefined || path.length === 0) {
    throw new TypeError(INVALID_REFERENCE);
  }
  return fragment === -1 ? { path } : { path, target: reference.slice(fragment + 1) };
}

/**
 * The canonical reference for a document, and optionally one exact target
 * inside it.
 *
 * The path arrives decoded and is encoded here; the target arrives already
 * canonical — `DocumentInfo.target`, or a stored workflow definition's — and is
 * validated rather than encoded again, so a canonical `%2F` is never turned
 * into `%252F`. Making an authored glob canonical is the selector parser's job,
 * not this one's.
 *
 * This is the one formatter diagnostics, command output, and workflow handoff
 * use, so a reference printed by one of them is a reference the others accept.
 */
export function formatDocumentReference(path: string, target?: string): string {
  if (path.length === 0) {
    throw new TypeError(INVALID_REFERENCE);
  }
  // The round trip is the rule, not a sample of it: a path only formats when
  // decoding what this would write reproduces it exactly. NUL, which the
  // decoder refuses, and an unpaired surrogate, which encodes lossily to the
  // replacement character, both fail here rather than producing a reference
  // that names a different file than the one asked about.
  const encoded = encodeDocumentPath(path);
  if (decodePercentEncoded(encoded) !== path) {
    throw new TypeError(INVALID_REFERENCE);
  }
  if (target === undefined) {
    return encoded;
  }
  if (!isCanonicalTarget(target)) {
    throw new TypeError(INVALID_REFERENCE);
  }
  return `${encoded}#${target}`;
}

/** The identity printed errors and source positions report for this root. */
export function rootSourcePath(root: RootDocumentSource): string {
  return root.path;
}

/**
 * The root's markdown, supplied or read.
 *
 * Internal: execution calls this inside the durable operation that journals the
 * result, which is what makes a replay restore the root without reading
 * anything. A caller reaching it directly would read outside that boundary.
 */
export function* readRootSource(root: RootDocumentSource): Operation<string> {
  if (root.source !== undefined) {
    return root.source;
  }
  return yield* readTextFile(root.path);
}
