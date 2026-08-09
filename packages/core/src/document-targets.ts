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

import { Err, Ok } from "effection";
import type { Result } from "effection";
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

const KINDS: readonly DocumentTargetErrorKind[] = [
  "invalid-selector",
  "no-match",
  "multiple-matches",
];

const KIND_WORDING: ReadonlyMap<DocumentTargetErrorKind, string> = new Map([
  ["invalid-selector", "is not a valid document target selector"],
  ["no-match", "matches no document target"],
  ["multiple-matches", "matches more than one document target"],
]);

/**
 * The structural tag a document-target failure carries.
 *
 * Namespaced and stable, because it is the whole recognition mechanism. Two
 * loaded copies of this package are two classes, so `instanceof` answers false
 * between them; a failure built by one copy has to be recognized by the other
 * on exactly the same terms as one built here (AGENTS.md rule 15).
 */
const DOCUMENT_TARGET_FAILURE = "executablemd.document-target-failure";

/**
 * Why one requested selector did not name exactly one section, as data.
 *
 * Frozen and rebuilt from validated parts wherever it crosses a boundary. The
 * selector is retained because reproducing an ordinary failed execution needs
 * to say what was asked for — it is sanitized invocation metadata, never
 * identity, and it never stands in for an exact target.
 */
export interface DocumentTargetFailure {
  readonly type: typeof DOCUMENT_TARGET_FAILURE;
  readonly kind: DocumentTargetErrorKind;
  /** The selector fragment as it was requested, still encoded. */
  readonly selector: string;
  /** Canonical encoded targets the selector matched; empty unless ambiguous. */
  readonly matches: readonly string[];
  /** Every canonical encoded target the document offers. */
  readonly available: readonly string[];
}

/** The fields a failure carries, without the tag that authenticates them. */
interface TargetFailureFields {
  kind: DocumentTargetErrorKind;
  selector: string;
  matches: string[];
  available: string[];
}

function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether this is an Error, without trusting its prototype chain. */
function isError(value: unknown): value is Error {
  return attempt(() => value instanceof Error) === true;
}

/** One property, read through a trap that may refuse or fail. */
function property(target: object, name: string): unknown {
  return attempt(() => Reflect.get(target, name));
}

function stringList(value: unknown): string[] | undefined {
  return attempt(() => {
    if (!Array.isArray(value)) {
      return undefined;
    }
    const items: string[] = [];
    for (let index = 0; index < value.length; index++) {
      const item = index in value ? value[index] : undefined;
      if (typeof item !== "string") {
        return undefined;
      }
      items.push(item);
    }
    return items;
  });
}

/**
 * Read a candidate's failure fields, rebuilding every one of them.
 *
 * Total: an unreadable property, a missing one, a kind outside the closed set,
 * a sparse or non-string list, and matches on a kind that has none are all "not
 * this shape" rather than a throw. Nothing the candidate owns is retained — the
 * arrays that come back are new.
 */
function targetFailureFields(value: unknown): TargetFailureFields | undefined {
  return attempt(() => {
    if (!isRecord(value)) {
      return undefined;
    }
    const kind = KINDS.find((candidate) => candidate === property(value, "kind"));
    const selector = property(value, "selector");
    const matches = stringList(property(value, "matches"));
    const available = stringList(property(value, "available"));
    if (kind === undefined || typeof selector !== "string") {
      return undefined;
    }
    if (matches === undefined || available === undefined) {
      return undefined;
    }
    // `matches` is the ambiguity list and nothing else; a populated one under
    // any other kind is not the closed shape this contract describes.
    if (kind !== "multiple-matches" && matches.length > 0) {
      return undefined;
    }
    return { kind, selector, matches, available };
  });
}

/** Freeze validated fields into the failure data an error carries. */
function sealFailure(fields: TargetFailureFields): DocumentTargetFailure {
  return Object.freeze({
    type: DOCUMENT_TARGET_FAILURE,
    kind: fields.kind,
    selector: fields.selector,
    matches: Object.freeze([...fields.matches]),
    available: Object.freeze([...fields.available]),
  });
}

/**
 * The failure data this value carries, if it carries valid, tagged, frozen
 * data.
 *
 * Every field is checked, the member count with them, and that the object is
 * frozen: extra keys are not the shape this contract describes, and a mutable
 * one is not the shape a constructor here produces.
 */
export function parseDocumentTargetFailure(value: unknown): DocumentTargetFailure | undefined {
  return attempt(() => {
    if (!isRecord(value) || property(value, "type") !== DOCUMENT_TARGET_FAILURE) {
      return undefined;
    }
    if (attempt(() => Object.isFrozen(value)) !== true) {
      return undefined;
    }
    if (attempt(() => Object.keys(value).length) !== 5) {
      return undefined;
    }
    const fields = targetFailureFields(value);
    return fields === undefined ? undefined : sealFailure(fields);
  });
}

/**
 * The failure a journal record describes, rebuilt and sealed.
 *
 * The record is untagged — its place inside a recorded root-import selection is
 * what identifies it — so this validates the fields and supplies the tag,
 * rather than requiring a tag the journal never held.
 */
export function recordedDocumentTargetFailure(value: unknown): DocumentTargetFailure | undefined {
  const fields = targetFailureFields(value);
  return fields === undefined ? undefined : sealFailure(fields);
}

/**
 * The one diagnostic a failure carries, derived from its data alone.
 *
 * Recognition compares against this, so the message cannot disagree with the
 * fields. Every reference is canonically encoded and the selector is JSON
 * quoted, so a heading holding a control character cannot reach a diagnostic
 * literally.
 */
function documentTargetMessage(failure: DocumentTargetFailure): string {
  const ambiguous = failure.kind === "multiple-matches";
  const listed = ambiguous ? failure.matches : failure.available;
  const heading = ambiguous ? "Matched targets:" : "Available targets:";
  return (
    `${JSON.stringify(failure.selector)} ${KIND_WORDING.get(failure.kind)}.\n` +
    (listed.length === 0
      ? "The document has no targets."
      : `${heading}\n${listed.map((target) => `  ${target}`).join("\n")}`)
  );
}

/**
 * Everything a constructor here puts on the Error itself, and nothing else.
 *
 * `message` and `stack` are non-enumerable own properties of every Error, so
 * what remains enumerable is exactly what this constructor assigned.
 */
const FAILURE_MEMBERS: readonly string[] = ["data", "name"];

function hasOnlyContractMembers(error: Error): boolean {
  const keys = attempt(() => [...Object.keys(error)].sort());
  if (keys === undefined || keys.length !== FAILURE_MEMBERS.length) {
    return false;
  }
  if (!keys.every((key, index) => key === FAILURE_MEMBERS[index])) {
    return false;
  }
  const payload = attempt(() =>
    Object.getOwnPropertySymbols(error).filter(
      (symbol) => Object.getOwnPropertyDescriptor(error, symbol)?.enumerable === true,
    ),
  );
  return payload !== undefined && payload.length === 0;
}

/**
 * A requested document target that does not name exactly one section.
 *
 * An ordinary invocation failure: the caller asked for something the document
 * does not offer, and nothing durable or contained is involved. It is raised
 * before the document expands, so a run that cannot decide what to execute
 * executes nothing.
 *
 * Its data is the contract; the message is derived from it. Construct one from
 * validated data — `documentTargetError()` — rather than from parts, so a
 * failure rebuilt at a journal boundary is indistinguishable from the one the
 * live run raised.
 */
export class DocumentTargetError extends Error {
  readonly data: DocumentTargetFailure;

  constructor(data: DocumentTargetFailure) {
    super(documentTargetMessage(data));
    this.name = "DocumentTargetError";
    this.data = data;
  }
}

/** Build the failure this selector produced, from parts this module owns. */
export function documentTargetFailure(
  kind: DocumentTargetErrorKind,
  selector: string,
  matches: readonly string[],
  available: readonly string[],
): DocumentTargetFailure {
  return sealFailure({
    kind,
    selector,
    matches: [...matches],
    available: [...available],
  });
}

/**
 * Rebuild the error a failure describes.
 *
 * The one constructor call outside this module's own selection path, so a
 * replayed failure and a live one are the same object shape carrying the same
 * fields — a caller cannot tell which run raised it, and does not have to.
 */
export function documentTargetError(data: DocumentTargetFailure): DocumentTargetError {
  return new DocumentTargetError(data);
}

/**
 * Whether this failure satisfies the whole contract, not merely the tag.
 *
 * Structural throughout, so a failure constructed by a separately loaded copy
 * of this package is recognized on exactly the same terms as one constructed
 * here. The name is checked rather than the class for the same reason: a second
 * copy's constructor is a different function producing the same name.
 *
 * Stricter than `parseDocumentTargetFailure` because recognition hands the
 * object onward: the message has to be the one its own data derives, there can
 * be no cause, and no member beyond the contract — otherwise a candidate could
 * carry a path, a foreign object, or a second message past this boundary under
 * a recognized tag.
 */
export function isDocumentTargetError(error: unknown): error is DocumentTargetError {
  return (
    attempt(() => {
      if (!isError(error)) {
        return false;
      }
      const data = parseDocumentTargetFailure(property(error, "data"));
      if (data === undefined) {
        return false;
      }
      if (property(error, "name") !== "DocumentTargetError") {
        return false;
      }
      if (property(error, "message") !== documentTargetMessage(data)) {
        return false;
      }
      if (property(error, "cause") !== undefined) {
        return false;
      }
      return hasOnlyContractMembers(error);
    }) === true
  );
}

/** The document-target failure this error is, by identity. */
export function asDocumentTargetError(error: unknown): DocumentTargetError | undefined {
  return isDocumentTargetError(error) ? error : undefined;
}

/** Whether two failures describe the same selection outcome, field by field. */
export function sameDocumentTargetFailure(
  left: DocumentTargetFailure,
  right: DocumentTargetFailure,
): boolean {
  return (
    left.kind === right.kind &&
    left.selector === right.selector &&
    sameList(left.matches, right.matches) &&
    sameList(left.available, right.available)
  );
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
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
 * Whether a fragment is already an exact canonical target.
 *
 * A level is canonical only when decoding it, normalizing the label, and
 * re-encoding that label reproduce the level byte for byte. Requiring the whole
 * round trip is what makes this total: it rejects a wildcard operator, an empty
 * level, a lowercase escape, a raw `#`, an NFD spelling, a tab, and leading,
 * trailing, or uncollapsed whitespace without naming any of them, because none
 * of them is what this module would have written.
 */
export function isCanonicalTarget(target: string): boolean {
  if (target.length === 0) {
    return false;
  }
  return target.split("/").every((level) => {
    const decoded = decodePercentEncoded(level);
    if (decoded === undefined || decoded.length === 0) {
      return false;
    }
    const label = normalizeLabel(decoded);
    return label === decoded && encodeTargetLabel(label) === level;
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
  // A raw `#` is the reference's own delimiter, so it never reaches a selector
  // by the supported route and cannot be written back into one. `%23` addresses
  // a heading that really contains it.
  if (selector.includes("#")) {
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
  const found = findTarget(outline, selector);
  if (found.ok) {
    return found.value;
  }
  throw found.error;
}

/** The entry a selector names, or the failure describing why it names none. */
export function findTarget(outline: DocumentOutline, selector: string): Result<DocumentTarget> {
  const fail = (
    kind: DocumentTargetErrorKind,
    matches: readonly string[],
  ): Result<DocumentTarget> =>
    Err(documentTargetError(documentTargetFailure(kind, selector, matches, outline.targets)));

  const levels = parseSelector(selector);
  if (levels === undefined) {
    return fail("invalid-selector", []);
  }
  const matched = outline.entries.filter((entry) => matchPath(levels, entry.labels));
  const first = matched[0];
  if (first === undefined) {
    return fail("no-match", []);
  }
  if (matched.length > 1) {
    return fail(
      "multiple-matches",
      matched.map((entry) => entry.target),
    );
  }
  return Ok(first);
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
