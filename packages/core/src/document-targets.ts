/**
 * Document targets (spec §5.4).
 *
 * A target is an addressable static heading in a root document's Markdown flow.
 * Selecting one projects the document down to the preamble, the direct content
 * of every ancestor needed to reach it, and its complete subtree — so a section
 * of a document runs on its own without its siblings.
 *
 * Two properties shape everything here.
 *
 * The outline is discovered from *static* Markdown only. Component children can
 * hold text that looks like a heading, and Remark cannot tell the difference: a
 * blank line inside component children ends its HTML block and the child heading
 * surfaces as a root heading. Discovery therefore parses a masked copy of the
 * body, where every top-level component span is replaced by spaces of the same
 * length. Offsets, lines, and everything outside those spans are untouched, so
 * the mask changes what is *seen*, never where anything *is*.
 *
 * Projection retains original source ranges rather than a rebuilt document. Each
 * retained range is scanned with its own origin, so every retained element keeps
 * the offset and line it was authored at — which is what keeps expansion
 * identifiers equal between a full run and a targeted one.
 */

import { remark } from "remark";
import { toString as mdastToString } from "mdast-util-to-string";

import type { ComponentSpan } from "./scanner.ts";

/** A half-open slice of the original document body. */
export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

/** One catalog entry: an addressable heading and the path that reaches it. */
export interface DocumentTarget {
  /** The canonical encoded target fragment, without a leading `#`. */
  readonly target: string;
  /** The decoded, normalized labels the fragment encodes. */
  readonly labels: readonly string[];
  /** Which heading in the outline this entry addresses. */
  readonly heading: number;
}

interface OutlineHeading {
  readonly depth: number;
  readonly start: number;
  readonly end: number;
  readonly parent: number | undefined;
  readonly addressable: boolean;
  readonly label: string;
}

/** The static heading structure of one document body, and what it addresses. */
export interface DocumentOutline {
  readonly headings: readonly OutlineHeading[];
  readonly entries: readonly DocumentTarget[];
  /** Canonical encoded fragments in source order, duplicates retained. */
  readonly targets: readonly string[];
  /** Where the preamble ends: the first outermost heading, or the body end. */
  readonly preambleEnd: number;
  readonly bodyLength: number;
}

/** Why a requested target did not resolve to exactly one catalog entry. */
export type DocumentTargetErrorKind = "invalid-selector" | "no-match" | "multiple-matches";

const KIND_WORDING: ReadonlyMap<DocumentTargetErrorKind, string> = new Map([
  ["invalid-selector", "is not a valid document target selector"],
  ["no-match", "matches no document target"],
  ["multiple-matches", "matches more than one document target"],
]);

/**
 * A requested document target that does not name exactly one section.
 *
 * An ordinary invocation failure: the caller asked for something the document
 * does not offer, and nothing durable or contained is involved. It is raised
 * before the document expands, so a run that cannot decide what to execute
 * executes nothing.
 *
 * Everything it carries is rebuilt and frozen here. The selector arrives from a
 * command line and the catalog from a parser, and neither object belongs to a
 * failure that outlives them. Every reference in the message is canonically
 * encoded, so a heading holding a control character cannot reach a diagnostic
 * literally.
 */
export class DocumentTargetError extends Error {
  readonly kind: DocumentTargetErrorKind;
  /** The selector fragment as it was requested, still encoded. */
  readonly selector: string;
  /** Canonical encoded targets the selector matched; empty unless ambiguous. */
  readonly matches: readonly string[];
  /** Every canonical encoded target the document offers. */
  readonly available: readonly string[];

  constructor(
    kind: DocumentTargetErrorKind,
    selector: string,
    matches: readonly string[],
    available: readonly string[],
  ) {
    const listed = kind === "multiple-matches" ? matches : available;
    const heading = kind === "multiple-matches" ? "Matched targets:" : "Available targets:";
    super(
      `${JSON.stringify(selector)} ${KIND_WORDING.get(kind)}.\n` +
        (listed.length === 0
          ? "The document has no targets."
          : `${heading}\n${listed.map((target) => `  ${target}`).join("\n")}`),
    );
    this.name = "DocumentTargetError";
    this.kind = kind;
    this.selector = selector;
    this.matches = Object.freeze([...matches]);
    this.available = Object.freeze([...available]);
  }
}

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
const HEX = /^[0-9A-Fa-f]$/;

const ENCODER = new TextEncoder();

function encodeCharacter(character: string): string {
  let encoded = "";
  for (const byte of ENCODER.encode(character)) {
    encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

/**
 * Percent-encode one canonical label. Everything outside RFC 3986's unreserved
 * set is escaped, so `/`, `*`, `#`, and `%` inside a heading cannot be read as
 * hierarchy or operator syntax.
 */
export function encodeTargetLabel(label: string): string {
  let encoded = "";
  for (const character of label) {
    encoded += UNRESERVED.test(character) ? character : encodeCharacter(character);
  }
  return encoded;
}

/**
 * Percent-encode a decoded filesystem path. Separators survive as raw `/`; a
 * `/` that is part of a filename cannot be told apart from one afterwards, so
 * this is a formatter for paths the caller already holds, not a round trip.
 */
export function encodeDocumentPath(path: string): string {
  let encoded = "";
  for (const character of path) {
    encoded +=
      character === "/" || UNRESERVED.test(character) ? character : encodeCharacter(character);
  }
  return encoded;
}

/**
 * Decode one percent-encoded chunk, or `undefined` when it is not decodable.
 *
 * Malformed escapes, byte sequences that are not UTF-8, and NUL are all
 * refused rather than repaired: a selector that cannot be read exactly is not a
 * selector this can match against. `+` is an ordinary character — this is URI
 * path syntax, not a form encoding.
 */
export function decodePercentEncoded(text: string): string | undefined {
  const characters = Array.from(text);
  const bytes: number[] = [];
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index]!;
    if (character !== "%") {
      for (const byte of ENCODER.encode(character)) {
        bytes.push(byte);
      }
      continue;
    }
    const high = characters[index + 1];
    const low = characters[index + 2];
    if (high === undefined || low === undefined || !HEX.test(high) || !HEX.test(low)) {
      return undefined;
    }
    bytes.push(Number.parseInt(`${high}${low}`, 16));
    index += 2;
  }
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
    return decoded.includes("\u0000") ? undefined : decoded;
  } catch {
    return undefined;
  }
}

/**
 * The canonical form of rendered heading text: NFC, every run of Unicode
 * whitespace collapsed to one ASCII space, trimmed, case preserved.
 */
export function normalizeLabel(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/**
 * Whether a fragment is already an exact canonical target: raw `/` between
 * nonempty levels, every level percent-encoded exactly as this module encodes
 * it, and no wildcard operator anywhere.
 */
export function isCanonicalTarget(target: string): boolean {
  if (target.length === 0) {
    return false;
  }
  return target.split("/").every((level) => {
    if (level.length === 0 || level.includes("*")) {
      return false;
    }
    const decoded = decodePercentEncoded(level);
    if (decoded === undefined || decoded.length === 0) {
      return false;
    }
    return encodeTargetLabel(decoded) === level;
  });
}

type LevelPart =
  | { readonly kind: "literal"; readonly text: string }
  | { readonly kind: "wildcard" };

type SelectorLevel =
  | { readonly kind: "recursive" }
  | { readonly kind: "label"; readonly parts: readonly LevelPart[] };

/**
 * Parse a target selector into levels, or `undefined` when the syntax is not a
 * selector at all.
 *
 * Raw `/` separates levels and raw `*` is an operator, so the split happens
 * before decoding: `%2F` stays a slash inside one label and `%2A` stays a
 * literal asterisk. Only the literal chunks between operators are decoded.
 */
function parseSelector(selector: string): readonly SelectorLevel[] | undefined {
  if (selector.length === 0 || selector.startsWith("/") || selector.endsWith("/")) {
    return undefined;
  }
  const levels: SelectorLevel[] = [];
  for (const raw of selector.split("/")) {
    if (raw.length === 0) {
      return undefined;
    }
    if (raw === "**") {
      levels.push({ kind: "recursive" });
      continue;
    }
    const chunks: string[] = [];
    for (const chunk of raw.split("*")) {
      const decoded = decodePercentEncoded(chunk);
      if (decoded === undefined) {
        return undefined;
      }
      chunks.push(decoded.normalize("NFC").replace(/\s+/gu, " "));
    }
    // Only the outer edges are trimmed: whitespace beside a wildcard is part of
    // what the author asked to match, while the whole level is compared against
    // an already-trimmed label.
    chunks[0] = chunks[0]!.trimStart();
    chunks[chunks.length - 1] = chunks[chunks.length - 1]!.trimEnd();

    const parts: LevelPart[] = [];
    for (const [index, chunk] of chunks.entries()) {
      if (index > 0 && parts[parts.length - 1]?.kind !== "wildcard") {
        parts.push({ kind: "wildcard" });
      }
      if (chunk.length > 0) {
        parts.push({ kind: "literal", text: chunk });
      }
    }
    levels.push({ kind: "label", parts });
  }
  return levels;
}

/**
 * Whether one level's parts match one label, by code point.
 *
 * A reachability sweep rather than backtracking: each part advances a set of
 * positions the label could have been consumed to, so a selector holding many
 * wildcards costs the product of its size and the label's, never an exponential
 * search.
 */
function matchLabel(parts: readonly LevelPart[], label: readonly string[]): boolean {
  let reachable = new Array<boolean>(label.length + 1).fill(false);
  reachable[0] = true;
  for (const part of parts) {
    const next = new Array<boolean>(label.length + 1).fill(false);
    if (part.kind === "wildcard") {
      let open = false;
      for (let index = 0; index <= label.length; index++) {
        open ||= reachable[index]!;
        next[index] = open;
      }
    } else {
      const literal = Array.from(part.text);
      for (let index = 0; index + literal.length <= label.length; index++) {
        if (!reachable[index]) {
          continue;
        }
        if (literal.every((character, offset) => label[index + offset] === character)) {
          next[index + literal.length] = true;
        }
      }
    }
    reachable = next;
  }
  return reachable[label.length]!;
}

/** Whether a parsed selector matches a canonical label path. */
function matchPath(levels: readonly SelectorLevel[], path: readonly string[]): boolean {
  const characters = path.map((label) => Array.from(label));
  let reachable = new Array<boolean>(path.length + 1).fill(false);
  reachable[0] = true;
  for (const level of levels) {
    const next = new Array<boolean>(path.length + 1).fill(false);
    if (level.kind === "recursive") {
      let open = false;
      for (let index = 0; index <= path.length; index++) {
        open ||= reachable[index]!;
        next[index] = open;
      }
    } else {
      for (let index = 0; index < path.length; index++) {
        if (reachable[index] && matchLabel(level.parts, characters[index]!)) {
          next[index + 1] = true;
        }
      }
    }
    reachable = next;
  }
  return reachable[path.length]!;
}

/**
 * The one catalog entry a selector names.
 *
 * Zero matches and several matches are both failures, and both are decided
 * here — before the document expands — so an ambiguous request never runs half
 * a document to discover it was ambiguous. Duplicate canonical paths stay
 * duplicate entries, which is what makes that ambiguity observable at all.
 */
export function selectTarget(outline: DocumentOutline, selector: string): DocumentTarget {
  const levels = parseSelector(selector);
  if (levels === undefined) {
    throw new DocumentTargetError("invalid-selector", selector, [], outline.targets);
  }
  const matched = outline.entries.filter((entry) => matchPath(levels, entry.labels));
  const first = matched[0];
  if (first === undefined) {
    throw new DocumentTargetError("no-match", selector, [], outline.targets);
  }
  if (matched.length > 1) {
    throw new DocumentTargetError(
      "multiple-matches",
      selector,
      matched.map((entry) => entry.target),
      outline.targets,
    );
  }
  return first;
}

/**
 * The interpolation forms a heading's own source may not contain.
 *
 * A heading whose text is computed is not a stable address, so it is not one.
 * `\{` escapes an interpolation back into literal text, which stays static and
 * stays addressable.
 */
const INTERPOLATION =
  /(\\?)\{(?:(?:meta|props)\.[^}]+|[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\}/g;

function hasUnescapedInterpolation(source: string): boolean {
  for (const match of source.matchAll(INTERPOLATION)) {
    if (match[1] !== "\\") {
      return true;
    }
  }
  return false;
}

/**
 * A copy of the body with every top-level component span blanked.
 *
 * Length, newline positions, and every offset are preserved, so a heading found
 * in the mask sits at the same place in the original.
 */
function maskComponents(body: string, spans: readonly ComponentSpan[]): string {
  if (spans.length === 0) {
    return body;
  }
  let masked = "";
  let cursor = 0;
  for (const span of spans) {
    masked += body.slice(cursor, span.start);
    masked += body.slice(span.start, span.end).replace(/[^\n]/g, " ");
    cursor = span.end;
  }
  return masked + body.slice(cursor);
}

interface RawHeading {
  readonly depth: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function rootHeadings(masked: string): RawHeading[] {
  const headings: RawHeading[] = [];
  for (const child of remark().parse(masked).children) {
    if (child.type !== "heading") {
      continue;
    }
    const start = child.position?.start.offset;
    const end = child.position?.end.offset;
    if (start === undefined || end === undefined) {
      continue;
    }
    headings.push({
      depth: child.depth,
      start,
      end,
      // Read from the masked tree, which is the original text for every heading
      // that does not overlap a component span — and one that does is refused
      // below, so no label is ever built from blanked source.
      text: mdastToString(child, { includeHtml: false, includeImageAlt: true }),
    });
  }
  return headings;
}

function overlapsComponent(heading: RawHeading, spans: readonly ComponentSpan[]): boolean {
  return spans.some((span) => span.start < heading.end && heading.start < span.end);
}

/**
 * Discover the outline of one document body and the targets it addresses.
 *
 * The hierarchy is the standard outline stack — a heading's parent is the
 * nearest preceding heading with a smaller depth — so skipped depths are
 * ordinary. "Outermost" is the smallest depth present, not `h1`.
 *
 * A single outermost heading is the document's title: it is retained in every
 * projection and takes no level in any path, which is why a document that opens
 * with one title still addresses its sections by their own names.
 */
export function outlineDocument(body: string, spans: readonly ComponentSpan[]): DocumentOutline {
  const raw = rootHeadings(maskComponents(body, spans));
  if (raw.length === 0) {
    return {
      headings: [],
      entries: [],
      targets: [],
      preambleEnd: body.length,
      bodyLength: body.length,
    };
  }

  const outermostDepth = Math.min(...raw.map((heading) => heading.depth));
  const outermost = raw.filter((heading) => heading.depth === outermostDepth);
  const titleIndex = outermost.length === 1 ? raw.indexOf(outermost[0]!) : undefined;

  const headings: OutlineHeading[] = [];
  const stack: number[] = [];
  for (const [index, heading] of raw.entries()) {
    while (stack.length > 0 && raw[stack[stack.length - 1]!]!.depth >= heading.depth) {
      stack.pop();
    }
    const label = normalizeLabel(heading.text);
    headings.push({
      depth: heading.depth,
      start: heading.start,
      end: heading.end,
      parent: stack[stack.length - 1],
      addressable:
        label.length > 0 &&
        !overlapsComponent(heading, spans) &&
        !hasUnescapedInterpolation(body.slice(heading.start, heading.end)),
      label,
    });
    stack.push(index);
  }

  const entries: DocumentTarget[] = [];
  for (let index = 0; index < headings.length; index++) {
    const labels = pathLabels(headings, index, titleIndex);
    if (labels !== undefined) {
      entries.push({
        target: labels.map(encodeTargetLabel).join("/"),
        labels,
        heading: index,
      });
    }
  }

  return {
    headings,
    entries,
    targets: entries.map((entry) => entry.target),
    preambleEnd: outermost[0]!.start,
    bodyLength: body.length,
  };
}

/**
 * The canonical path a heading is addressed by, or `undefined` when it has
 * none.
 *
 * Every level has to be addressable: a heading under one whose text is not
 * static cannot be named, so its subtree is unreachable. The sole title is not
 * a level, which is what lets a static section under a computed title stay
 * addressable.
 */
function pathLabels(
  headings: readonly OutlineHeading[],
  index: number,
  titleIndex: number | undefined,
): readonly string[] | undefined {
  if (index === titleIndex) {
    return undefined;
  }
  const labels: string[] = [];
  for (let current: number | undefined = index; current !== undefined; ) {
    if (current !== titleIndex) {
      if (!headings[current]!.addressable) {
        return undefined;
      }
      labels.unshift(headings[current]!.label);
    }
    current = headings[current]!.parent;
  }
  return labels.length === 0 ? undefined : labels;
}

/** Where a heading's own subtree ends: the next heading at its depth or above. */
function subtreeEnd(outline: DocumentOutline, index: number): number {
  const depth = outline.headings[index]!.depth;
  for (let next = index + 1; next < outline.headings.length; next++) {
    if (outline.headings[next]!.depth <= depth) {
      return outline.headings[next]!.start;
    }
  }
  return outline.bodyLength;
}

/** An ancestor's own content: its heading through its first child heading. */
function directPrefixEnd(outline: DocumentOutline, index: number): number {
  const child = outline.headings[index + 1];
  if (child !== undefined && child.depth > outline.headings[index]!.depth) {
    return child.start;
  }
  return subtreeEnd(outline, index);
}

/**
 * The original source ranges a target retains: the preamble, each ancestor's
 * own content, and the selected subtree.
 *
 * The ranges are returned in source order and never overlap, so scanning them
 * in turn reproduces authored positions exactly. Sibling subtrees fall in the
 * gaps between them and are never scanned, which is what keeps their
 * components, resources, and code blocks from running at all.
 */
export function retainedRanges(
  outline: DocumentOutline,
  entry: DocumentTarget,
): readonly SourceRange[] {
  const ancestors: number[] = [];
  for (
    let current = outline.headings[entry.heading]!.parent;
    current !== undefined;
    current = outline.headings[current]!.parent
  ) {
    ancestors.unshift(current);
  }

  const ranges: SourceRange[] = [{ start: 0, end: outline.preambleEnd }];
  for (const ancestor of ancestors) {
    ranges.push({
      start: outline.headings[ancestor]!.start,
      end: directPrefixEnd(outline, ancestor),
    });
  }
  ranges.push({
    start: outline.headings[entry.heading]!.start,
    end: subtreeEnd(outline, entry.heading),
  });

  const retained: SourceRange[] = [];
  let consumed = 0;
  for (const range of ranges) {
    const start = Math.max(range.start, consumed);
    if (start < range.end) {
      retained.push({ start, end: range.end });
      consumed = range.end;
    }
  }
  return retained;
}
