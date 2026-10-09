/**
 * Where the executable elements of a source text are written (spec §5.8).
 *
 * A reading, not a run. It answers where each recognized element's delimiters
 * are and what the author called it, and it does nothing else: no name is
 * resolved, no schema compiled, no prop evaluated, no frontmatter interpreted
 * and no component invoked. A caller that wants to show somebody their own
 * source — with the parts that execute marked — needs exactly this and must
 * not pay execution to get it.
 *
 * It is the scanner's own reading. The ranges come from the same walk that
 * decides what a fence, an inline code span, a quoted `>` and a tag-like
 * expression are, so there is no second grammar to disagree with the first.
 *
 * Offsets are half-open UTF-16 slices into the exact text that was passed in,
 * a document's header prefix included, so `text.slice(opening.start,
 * opening.end)` is the delimiter as authored.
 */

import { Err, Ok } from "effection";
import type { Result } from "effection";
import { scanSegments } from "./scanner.ts";
import type { SourceElement } from "./scanner.ts";
import type { SourceRange } from "./document-targets.ts";

export type { SourceElement, SourceRange };

/**
 * Every executable element `text` is written with, in opening order.
 *
 * `"document"` reads the markdown body beneath a frontmatter header, with
 * offsets still counted from the start of the whole text. `"fragment"` reads
 * all of it. Text the scanner does not recognize as an element — prose, a
 * fence, an inline code span, an incomplete tag — is simply absent, which is
 * success and not a refusal.
 */
export function inspectSource(
  text: string,
  kind: "document" | "fragment",
): Result<readonly SourceElement[]> {
  const body = kind === "document" ? envelopeBody(text) : 0;
  const elements: SourceElement[] = [];
  try {
    scanSegments(text.slice(body), undefined, undefined, elements);
  } catch (error) {
    // The scanner refused this text. Inspection reports that rather than
    // guessing at a reading the engine itself would not accept.
    return Err(error instanceof Error ? error : new Error(String(error)));
  }
  return Ok(Object.freeze(body === 0 ? elements : elements.map((one) => shifted(one, body))));
}

function shifted(element: SourceElement, by: number): SourceElement {
  return Object.freeze({
    name: element.name,
    opening: Object.freeze({ start: element.opening.start + by, end: element.opening.end + by }),
    ...(element.closing === undefined
      ? {}
      : {
          closing: Object.freeze({
            start: element.closing.start + by,
            end: element.closing.end + by,
          }),
        }),
  });
}

/**
 * Where a document's markdown body starts, read lexically.
 *
 * The same boundary `parseSource` ends up with, found without asking the
 * frontmatter engine for a value: inspection must not run a YAML parser over
 * somebody's header to learn where their body begins, and a document whose
 * header is itself executable text must stay unexecuted. `parseSource` asserts
 * the two agree, so a divergence is loud rather than a quiet offset drift.
 *
 * The rule is the installed extractor's: an optional byte-order mark, then
 * `---` on its own opening line — `----` is not one — an optional language
 * after it, the first following newline, and the first later line that is
 * exactly the closing delimiter. A header with no closing delimiter is not a
 * header, and the body is the whole text.
 */
export function envelopeBody(text: string): number {
  const mark = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (!text.startsWith("---", mark) || text.charAt(mark + 3) === "-") {
    return 0;
  }
  const opened = text.indexOf("\n", mark + 3);
  if (opened === -1) {
    return 0;
  }
  const closed = closingDelimiter(text, opened + 1);
  if (closed === -1) {
    return 0;
  }
  // Past the closing line's own newline, and the carriage return before it.
  const line = text.indexOf("\n", closed);
  return line === -1 ? text.length : line + 1;
}

/** Where the line that is exactly the closing delimiter begins, or -1. */
function closingDelimiter(text: string, from: number): number {
  let at = from;
  while (at <= text.length) {
    const end = text.indexOf("\n", at);
    const stop = end === -1 ? text.length : end;
    const line = text.slice(at, stop).replace(/\r$/, "");
    if (line === "---") {
      return at;
    }
    if (end === -1) {
      return -1;
    }
    at = end + 1;
  }
  return -1;
}
