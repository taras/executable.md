import type { Operation } from "effection";
import { readTextFile } from "@executablemd/runtime";

/** The stable identity an inline root document reports. */
export const INLINE_SOURCE_PATH = "<eval>";

/**
 * A root document supplied as text. The identity is part of the value, so text
 * and identity cannot be separated once constructed.
 */
export interface InlineRootDocument {
  readonly path: typeof INLINE_SOURCE_PATH;
  readonly source: string;
}

/** Where a root document's text comes from: a path, or supplied text. */
export type RootDocumentSource =
  | { readonly path: string; readonly source?: undefined }
  | InlineRootDocument;

/** Supplied text as a root document carrying the `<eval>` identity. */
export function inlineSource(source: string): InlineRootDocument {
  return { path: INLINE_SOURCE_PATH, source };
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
