/**
 * What an arriving generated root already says, read from the source so far.
 *
 * A host streaming an Agent's reply has a prefix rather than a document, and it
 * wants to show the person what the reply *says* while the rest arrives. The
 * question "what does this prefix safely say?" has one honest answer and
 * several tempting wrong ones, so this module is deliberately narrow.
 *
 * ## It is a projection, not a run
 *
 * Nothing here reads a file, resolves a name, invokes a component, evaluates an
 * expression, grants an admission or writes a history. It needs no `Operation`
 * because it performs no suspended work: the same prefix always projects to the
 * same answer, whatever is installed around it. Deciding whether this source
 * may *run* is `evaluateGeneratedXmdRoot()`'s, and a prefix that projects
 * cleanly here has been granted nothing at all.
 *
 * ## Incomplete is not invalid
 *
 * `<Output>Hello` is the beginning of something; `<If condition={true}>
 * <Output>ok</Output></If>` is a finished thing the language does not allow. The
 * first waits, the second refuses, and conflating them would either hide a real
 * mistake behind "still arriving" or report a mistake about text that has not
 * been written yet. The scanner's own walk is what tells them apart — it is the
 * only reader that knows how far it got and why it stopped — and the structure
 * rule is `body-structure.ts`'s, the same one an authored root is held to.
 *
 * ## The safe reading stops where the text stops being whole
 *
 * Everything before the first construct the scan could not finish is text the
 * scan committed, and it reads the same whether more arrives or not. From there
 * on it does not: an `<Output>` written inside an `<If>` that has not closed
 * looks like a top-level region until the `</If>` arrives and makes it a
 * misplaced one. So the projection ends there — with one exception, which is the
 * case this whole module exists for: when the unfinished construct *is* a
 * top-level `<Output>` whose opening tag completed, the literal text already
 * inside it is exactly what the person should be reading.
 *
 * ## Only text whose meaning is already settled
 *
 * A region's literal text projects. An expression, an interpolation and a
 * nested component do not — their meaning is what evaluation decides, and a
 * preview that guessed would show the person something the finished root never
 * says. What is left out waits rather than being approximated.
 */

import { Err, Ok } from "effection";
import type { Result } from "effection";

import { readsBinding } from "./generated-interpolation.ts";
import { outputPropsViolation, validateBodyStructure } from "./body-structure.ts";
import { scanSegments } from "./scanner.ts";
import type { UnfinishedConstruct } from "./scanner.ts";
import type { ComponentElement, Segment } from "./types.ts";

/** What a source prefix safely says, and whether it has finished saying it. */
export interface GeneratedXmdRootPreview {
  /** The literal root Output text safely recognized in this source prefix. */
  readonly output: string;
  /** Whether this source prefix ends in syntax that needs more input. */
  readonly incomplete: boolean;
}

/** Source a generated root cannot be read from, however much more arrives. */
export class GeneratedXmdPreviewError extends Error {
  override name = "GeneratedXmdPreviewError";
}

/**
 * The literal root Output text this prefix safely says.
 *
 * `source` is the whole prefix received so far rather than the latest chunk:
 * the answer is a complete projection of what has arrived, so a caller replaces
 * what it was showing rather than appending to it. Two identical prefixes
 * always project identically, however the transport happened to split them.
 */
export function previewGeneratedXmdRoot(source: string): Result<GeneratedXmdRootPreview> {
  const unfinished: UnfinishedConstruct[] = [];
  scanSegments(source, undefined, undefined, undefined, unfinished);
  const pending = earliest(unfinished);
  // Everything the scan committed whole. Re-read from the exact prefix that
  // ends where wholeness does, so nothing half-delivered takes part in the
  // structure rule below.
  const settled = pending === undefined ? source : source.slice(0, pending.start);
  const segments = scanSegments(settled);

  const violation = validateBodyStructure(segments, undefined);
  if (violation !== undefined) {
    return Err(new GeneratedXmdPreviewError(violation.message));
  }
  const declared = regions(segments);
  // `validateBodyStructure` reads where regions are written; what one may carry
  // is `outputPropsViolation`'s, which expansion asks when it builds the body.
  // Both rules belong to a root, so a preview asks both.
  for (const region of declared) {
    const props = outputPropsViolation(region.element);
    if (props !== undefined) {
      return Err(new GeneratedXmdPreviewError(props));
    }
  }
  const tail = unfinishedRegion(source, pending);
  if (tail !== undefined && tail.violation !== undefined) {
    return Err(new GeneratedXmdPreviewError(tail.violation));
  }

  const projected = declared.map((region) => literal(region.element.children)).join("");
  return Ok(
    Object.freeze({
      output: tail === undefined ? projected : projected + tail.output,
      incomplete: pending !== undefined,
    }),
  );
}

/**
 * The construct the scan gave up on earliest.
 *
 * Earliest rather than first reported, because the walk reports a nested
 * construct before the one enclosing it and recovery can report the same text
 * twice. The construct that begins earliest is the one everything after it is
 * inside, so it is the one the safe reading ends at.
 */
function earliest(found: readonly UnfinishedConstruct[]): UnfinishedConstruct | undefined {
  let chosen: UnfinishedConstruct | undefined;
  for (const candidate of found) {
    if (chosen === undefined || candidate.start < chosen.start) {
      chosen = candidate;
    }
  }
  return chosen;
}

/** What the prefix says inside a region it has not finished delivering. */
interface UnfinishedRegion {
  readonly output: string;
  /** Why this region is refused rather than awaited, when it is. */
  readonly violation?: string;
}

/**
 * The literal text inside an `<Output>` whose closing tag has not arrived.
 *
 * Only for a region at the prefix's own top level, which is the only place the
 * earliest unfinished construct can be: everything before it the scan committed
 * whole, so nothing recognized encloses it, and a construct that *did* enclose
 * it would have begun earlier and been chosen instead.
 *
 * A region whose opening tag carried an attribute is refused here rather than
 * awaited, because `<Output>` accepts none and no further text changes that —
 * the same rule, from the same function, that an authored body is held to.
 */
function unfinishedRegion(
  source: string,
  pending: UnfinishedConstruct | undefined,
): UnfinishedRegion | undefined {
  if (pending?.name !== "Output" || pending.contentStart === undefined) {
    return undefined;
  }
  if (pending.attributed === true) {
    return { output: "", violation: OUTPUT_PROPS };
  }
  // The same walk again over the content delivered so far, so what counts as a
  // nested tag, a fence or an inline code span is decided once.
  const content = source.slice(pending.contentStart);
  return { output: literal(scanSegments(settledTail(content))) };
}

/**
 * The content of an unfinished region, up to where its delimiters stop being
 * settled.
 *
 * A conservative cut rather than a reading: a `<` with no `>` after it is the
 * first character of a delimiter whose rest has not arrived — this element's
 * own closing tag, or a nested element — and the scanner's answer about it
 * changes with the next character. `</` is prose to the scan until the name
 * and the `>` arrive, and `<P` is prose until the `>` does, so projecting
 * either would show a person a delimiter instead of their text and then take
 * it away again.
 *
 * It only ever shortens what the scan already committed. Nothing here decides
 * what a construct *is*; that stays the walk's, which has already said this
 * region is still arriving.
 */
function settledTail(content: string): string {
  const opened = content.lastIndexOf("<");
  if (opened === -1 || content.indexOf(">", opened) !== -1) {
    return content;
  }
  return content.slice(0, opened);
}

/**
 * What `<Output>` carrying a prop says.
 *
 * Read from the canonical rule rather than written again here: the sentence an
 * author sees for a region with props is the sentence a preview reports.
 */
const OUTPUT_PROPS: string =
  outputPropsViolation({
    type: "component",
    name: "Output",
    props: { stated: true },
    expressions: {},
    children: [],
    selfClosing: false,
  }) ?? "<Output> accepts no props.";

/** Every top-level `<Output>` region, in source order. */
function regions(segments: readonly Segment[]): { element: ComponentElement }[] {
  const found: { element: ComponentElement }[] = [];
  for (const segment of segments) {
    if (segment.type === "component" && segment.name === "Output") {
      found.push({ element: segment });
    }
  }
  return found;
}

/**
 * The text of these segments whose meaning is already settled.
 *
 * A text segment that reads nothing is what it says. Everything else — an
 * expression, an interpolation, a nested component, an executable block — means
 * whatever evaluation decides, so it is left out and waits. A passive fence is
 * ordinary text to the scanner and projects as the literal example it is, which
 * is why a tag written inside one creates no region.
 */
function literal(segments: readonly Segment[]): string {
  let text = "";
  for (const segment of segments) {
    if (segment.type === "text" && !readsBinding(segment.content)) {
      text += segment.content;
    }
  }
  return text;
}
