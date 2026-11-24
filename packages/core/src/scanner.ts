// @ts-nocheck
import { markdownStream } from "./markdown.ts";
/**
 * Boundary scanner for Executable MDX (spec §2.2, §3.5).
 *
 * Parses raw markdown text into a flat sequence of Segments.
 * Identifies two kinds of execution boundaries:
 *   1. Component invocations — `<PascalCase ...>` tags
 *   2. Executable code blocks — fenced blocks with `exec` in the info string
 *
 * Everything else is passive text.
 */

import { Err, Ok } from "effection";
import type { Result } from "effection";
import { validateBindingName } from "./live-env.ts";
import type { SourceRange } from "./document-targets.ts";
import { bindsByReference, isStructural } from "./structural.ts";
import type {
  Segment,
  TextSegment,
  ComponentElement,
  ExecutableCodeBlock,
  Modifier,
  ParsedInfoString,
  Json,
  SourcePosition,
} from "./types.ts";

/**
 * The one spelling a binding annotation has: trailing, and quoted.
 *
 * Everything else a word beginning `as` can be is a malformed annotation
 * rather than a modifier, because `as` is the vocabulary every other binding
 * construct uses and reading it as middleware would run the command instead of
 * refusing it.
 */
const BINDING_ANNOTATION = /^as="([^"]*)"$/;

/**
 * Read the `as="name"` annotation out of the words after the language.
 *
 * The annotation is removed from the chain — it is not middleware — and what
 * comes back is the name it binds, or the refusal that names why it does not
 * bind anything.
 */
function takeBindingAnnotation(
  tokens: string[],
  modifiers: Modifier[],
): Result<string> | undefined {
  const found: number[] = [];
  for (const [index, modifier] of modifiers.entries()) {
    if (modifier.name === "as") {
      found.push(index);
    }
  }
  if (found.length === 0) {
    return undefined;
  }
  for (let i = found.length - 1; i >= 0; i--) {
    modifiers.splice(found[i]!, 1);
  }
  if (found.length > 1) {
    return Err(new Error('an executable block takes one `as="name"` annotation, not several.'));
  }
  const at = found[0]!;
  if (at !== tokens.length - 2) {
    return Err(
      new Error('`as="name"` must be the last word in the info string: `bash exec as="name"`.'),
    );
  }
  const matched = BINDING_ANNOTATION.exec(tokens[at + 1]!);
  if (!matched) {
    return Err(new Error('`as` must name a binding in double quotes: `exec as="name"`.'));
  }
  const name = validateBindingName(matched[1]!);
  if (!name.ok) {
    return Err(new Error(`\`as\` ${name.error.message}`));
  }
  if (name.value === undefined) {
    return Err(new Error("`as` must be non-empty."));
  }
  return Ok(name.value);
}

export function parseInfoString(infoString: string): ParsedInfoString {
  const tokens = infoString.trim().split(/\s+/);
  const language = tokens[0] ?? "";
  const modifiers: Modifier[] = [];

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!;

    // Bracket params: sample[model=phi3-mini]
    const bracketIdx = token.indexOf("[");
    if (bracketIdx >= 0) {
      const closeBracket = token.indexOf("]", bracketIdx);
      if (closeBracket >= 0) {
        modifiers.push({
          name: token.slice(0, bracketIdx),
          params: token.slice(bracketIdx + 1, closeBracket),
        });
        continue;
      }
    }

    // Plain params: timeout=30s
    const eqIdx = token.indexOf("=");
    if (eqIdx >= 0) {
      modifiers.push({
        name: token.slice(0, eqIdx),
        params: token.slice(eqIdx + 1),
      });
    } else {
      modifiers.push({ name: token });
    }
  }

  const binding = takeBindingAnnotation(tokens, modifiers);

  return {
    language,
    modifiers,
    executable: modifiers.some((m) => m.name === "exec" || m.name === "eval"),
    ...(binding === undefined ? {} : { binding }),
  };
}

/**
 * Where scanned text sits in the source it came from. `baseOffset`/`baseLine`
 * translate body-relative positions to original-file positions (frontmatter
 * included). Omitted for dynamically scanned strings.
 *
 * One of two sources, never both: a file states its `path`, and a generated
 * fragment states the `generatedSource` its admission was decided under —
 * generated text has no path, and the id is what an effect inside it can name.
 */
export interface SourceOrigin {
  path?: string;
  generatedSource?: string;
  baseOffset: number;
  baseColumn?: number;
  baseLine: number;
}

/**
 * Positioning state threaded through the scan: the origin translation plus a
 * precomputed line-start index so per-tag position lookups avoid rescanning.
 */
interface PositionIndex {
  origin?: SourceOrigin;
  lineStarts: number[];
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      starts.push(i + 1);
    }
  }
  return starts;
}

function positionAt(index: PositionIndex, offset: number): SourcePosition {
  const { lineStarts, origin } = index;
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid]! <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  const localLine = low + 1;
  const column = offset - lineStarts[low]! + (low === 0 ? (origin?.baseColumn ?? 1) : 1);
  return {
    path: origin?.path,
    ...(origin?.generatedSource === undefined ? {} : { generatedSource: origin.generatedSource }),
    offset: (origin?.baseOffset ?? 0) + offset,
    line: (origin?.baseLine ?? 1) + localLine - 1,
    column,
  };
}

/**
 * Where one top-level component invocation begins and ends in the scanned text.
 *
 * Half-open, relative to the text handed to the scanner. Internal: this is the
 * scanner's own boundary decision, recorded so heading discovery can blank the
 * regions this scanner owns before a Markdown parser looks at them. It is not a
 * public say over what a component is.
 */
export interface ComponentSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * Scan raw markdown text into segments.
 *
 * Identifies component invocations (`<PascalCase ...>`), executable code
 * blocks (fenced with `exec` in info string), and everything else as text.
 *
 * When `origin` is provided, component invocations carry `position` values
 * expressed in the original file's coordinates.
 *
 * When `spans` is provided, each top-level component invocation records its
 * source span into it, in source order. Collecting them changes nothing about
 * the segments produced.
 */
export function scanSegments(
  text: string,
  origin?: SourceOrigin,
  spans?: ComponentSpan[],
  /**
   * Where every recognized element's delimiters are, collected as the scan
   * commits each one.
   *
   * The same walk, asked for one more thing. A second reader looking for `<`
   * and `>` afterwards would be a second grammar — it would have to decide
   * again what a fence, a quoted `>` and a tag-like expression are — and the
   * two readings would disagree the first time one of them was wrong.
   */
  elements?: SourceElement[],
  /**
   * Every construct this scan began and could not finish because the text ran
   * out, collected as the scan gives each one up.
   *
   * The same walk again, and for the same reason. Reading text this scan left
   * as prose and looking for an unclosed tag would be a second grammar, and it
   * would have to re-decide every question this one already answered — whether
   * a `>` was quoted, whether a backtick opened a code span, whether a `{` was
   * an expression. Only this walk knows the difference between a tag it refused
   * and a tag it ran out of text in the middle of.
   */
  unfinished?: UnfinishedConstruct[],
  /** A suffix rescan retains its authored prefix for line-boundary decisions. */
  start = 0,
  /**
   * How many block elements enclose `start`: a rescan of a block's body
   * removes the same structural prefix the original walk removed.
   */
  depth = 0,
  diagnostics?: ScanDiagnostic[],
  fences?: SourceFence[],
): Segment[] {
  const found: ScanDiagnostic[] = [];
  const walk: Walk = {
    text,
    index: { origin, lineStarts: computeLineStarts(text) },
    elements,
    unfinished,
    diagnostics: found,
    fences,
  };
  const segments: Segment[] = [];
  const lineContent = start === 0 ? 0 : text.lastIndexOf("\n", start - 1) + 1;
  scanBody(walk, { pos: start, depth, lineContent }, undefined, segments, spans);
  if (diagnostics !== undefined) {
    diagnostics.push(...found);
  } else if (found.length > 0) {
    const { message, position } = found[0];
    throw Object.assign(new Error(message), { position });
  }
  return segments;
}

/** Two spaces of source indentation for each enclosing block element (§2.2). */
const STRUCTURAL_INDENT = "  ";

/** What one scan reads and what it reports, shared by every body it walks. */
interface Walk {
  readonly text: string;
  readonly headerOnly?: boolean;
  readonly index: PositionIndex;
  readonly elements?: SourceElement[];
  readonly unfinished?: UnfinishedConstruct[];
  readonly diagnostics?: ScanDiagnostic[];
  readonly fences?: SourceFence[];
}

/** Where a body begins. */
interface BodyStart {
  readonly pos: number;
  /** How many block elements enclose this body. */
  readonly depth: number;
  readonly delimiterIndent?: string;
  /** Where the content of the line holding `pos` begins, after its prefix. */
  readonly lineContent: number;
}

/**
 * Walk one body — the document, or one element's children — into `segments`.
 *
 * Returns the position after `closingTag`, or -1 when the body never closes.
 * Without a closing tag the body runs to the end of the text.
 */
function scanBody(
  walk: Walk,
  body: BodyStart,
  closingTag: string | undefined,
  segments: Segment[],
  spans?: ComponentSpan[],
): number {
  const { text } = walk;
  const prefix = STRUCTURAL_INDENT.repeat(body.depth);
  const markdown = markdownStream(text, prefix, readHeader, closingTag);
  try {
    return scanTrackedBody(walk, body, closingTag, segments, spans, markdown);
  } finally {
    markdown.close();
  }
}

function scanTrackedBody(
  walk: Walk,
  body: BodyStart,
  closingTag: string | undefined,
  segments: Segment[],
  spans: ComponentSpan[] | undefined,
  markdown: ReturnType<typeof markdownStream>,
): number {
  const { text } = walk;
  const prefix = STRUCTURAL_INDENT.repeat(body.depth);
  let pos = body.pos;
  let textStart = pos;
  let lineContent = body.lineContent;
  let lineHandled = -1;
  let pendingLine = body.pos > 0 && text[body.pos - 1] !== "\n" ? body.pos : undefined;
  const sendPendingLine = () => {
    if (pendingLine !== undefined) {
      markdown.line(pendingLine, undefined, "none");
      pendingLine = undefined;
    }
  };

  // Inside an inline code span until here: nothing in it is syntax, but its
  // later lines still carry the structural prefix.
  let codeSpanEnd = -1;

  const flush = (end: number): void => {
    if (end > textStart) {
      pushText(segments, text.slice(textStart, end));
    }
  };

  function feedPhysical(rawLine: number, fenceScope: "all" | "container" = "all") {
    const contentStart = text.startsWith(prefix, rawLine) ? rawLine + prefix.length : rawLine;
    let cut: number | undefined;
    if (closingTag !== undefined) {
      const line = text.slice(contentStart, endOfLine(text, contentStart));
      if (indentation(line) >= 4) {
        const candidate = contentStart + line.length - line.trimStart().length;
        if (candidate >= codeSpanEnd && text.startsWith(closingTag, candidate)) {
          cut = candidate + closingTag.length;
        }
      }
    }
    return markdown.line(rawLine, cut, fenceScope);
  }

  const afterLine = (at: number) => Math.min(endOfLine(text, at) + 1, text.length);

  while (pos < text.length) {
    if (pos !== lineHandled && (pos === 0 || text[pos - 1] === "\n")) {
      sendPendingLine();
      const rawLine = pos;
      if (prefix !== "" && text.startsWith(prefix, pos)) {
        flush(pos);
        pos += prefix.length;
        textStart = pos;
      }
      lineContent = pos;
      lineHandled = pos;
      const lineEnd = endOfLine(text, pos);
      const line = text.slice(pos, lineEnd);
      const inInlineSpan = pos < codeSpanEnd;
      const facts = feedPhysical(rawLine, inInlineSpan ? "container" : "all");
      if (facts.opensAt !== undefined) {
        codeSpanEnd = -1;
        flush(pos);
        const contentStart = afterLine(facts.opensAt);
        let contentEnd = contentStart;
        let fenceEnd = contentStart;
        let end: SourceFence["end"] = "unfinished";
        while (fenceEnd < text.length) {
          const next = feedPhysical(fenceEnd);
          if (next.fenceExit) {
            end = "container";
            break;
          }
          contentEnd = fenceEnd;
          fenceEnd = afterLine(fenceEnd);
          if (next.fenceClose) {
            end = "marker";
            break;
          }
          contentEnd = fenceEnd;
        }
        if (end === "unfinished") {
          walk.unfinished?.push({ start: pos });
        }
        const opening = text.slice(pos, facts.opensAt);
        const info = text.slice(facts.opensAt, lineEnd).replace(/^(?:`+|~+)/, "");
        const parsed = parseInfoString(info.trim());
        // Preserve XMD's executable opener syntax. A Markdown container may
        // make additional fence starts visible, including quote markers.
        const executable = parsed.executable && !inInlineSpan && /^ {0,3}$/.test(opening);
        walk.fences?.push({
          range: { start: rawLine, end: fenceEnd },
          marker: facts.opensAt,
          executable,
          end,
        });
        if (executable) {
          segments.push({
            type: "codeBlock",
            language: parsed.language,
            content: dedentLines(text, contentStart, contentEnd, prefix),
            modifiers: parsed.modifiers,
            executable: true,
            ...(parsed.binding === undefined ? {} : { binding: parsed.binding }),
            position: positionAt(walk.index, pos),
          } satisfies ExecutableCodeBlock);
        } else {
          pushText(
            segments,
            text.slice(pos, contentStart) + dedentLines(text, contentStart, fenceEnd, prefix),
            true,
          );
        }
        pos = fenceEnd;
        textStart = pos;
        continue;
      }
      const alignedClose =
        closingTag !== undefined &&
        body.delimiterIndent !== undefined &&
        text.slice(rawLine, lineEnd) === body.delimiterIndent + closingTag;
      if (facts.code && !alignedClose && /[^ \t]/.test(line)) {
        pos = afterLine(pos);
        continue;
      }
    }

    if (pos < codeSpanEnd) {
      pos++;
      continue;
    }

    if (closingTag !== undefined && text.startsWith(closingTag, pos)) {
      flush(beginsLine(text, lineContent, pos) ? lineContent : pos);
      return pos + closingTag.length;
    }

    // Skip inline code spans — content inside backticks is inert
    if (text[pos] === "`") {
      const codeEnd = skipInlineCode(text, pos);
      if (codeEnd !== -1) {
        codeSpanEnd = codeEnd;
        pos++;
        continue;
      }
      // A span that never closes is a span this text has not finished
      // delivering, not prose that happens to contain a backtick.
      walk.unfinished?.push({ start: pos });
    }

    if (text[pos] === "<" && pos + 1 < text.length && /[A-Z]/.test(text[pos + 1]!)) {
      const begins = beginsLine(text, lineContent, pos);
      const headerEnd = readHeader(text, pos);
      if (
        headerEnd !== undefined &&
        text.indexOf("\n", pos) >= 0 &&
        text.indexOf("\n", pos) < headerEnd
      ) {
        sendPendingLine();
        const reason = !begins
          ? "starts after prose"
          : !markdown.header(pos, headerEnd)
            ? "crosses its Markdown list item"
            : undefined;
        if (reason !== undefined) {
          const position = positionAt(walk.index, pos);
          walk.diagnostics?.push({
            message: `Multiline XMD opening tag ${reason} at ${position.line}:${position.column}`,
            position,
          });
          if (!begins) {
            markdown.lines(pos, headerEnd);
          }
          pos = headerEnd;
          continue;
        }
      }
      const component = parseComponentTag(walk, pos, body.depth, lineContent, begins);
      if (component) {
        // A standalone element and a block's opening line are delimiter lines,
        // and a standalone element owns its line ending. A block's indentation
        // is not content; a standalone element that renders text carries the
        // indentation left after the prefix, so it is held until the rendering
        // is known.
        const ending = begins ? lineEndingAfter(text, component.end) : undefined;
        flush(ending !== undefined || component.block ? lineContent : pos);
        if (ending !== undefined && !component.block && pos > lineContent) {
          component.segment.lineIndent = text.slice(lineContent, pos);
        }
        segments.push(component.segment);
        spans?.push({ start: pos, end: component.end });
        if (
          ending === undefined &&
          text.indexOf("\n", pos) < component.end &&
          text.indexOf("\n", pos) >= 0
        ) {
          sendPendingLine();
          pendingLine = component.end;
        }
        pos = ending?.end ?? component.end;
        textStart = pos;
        if (ending?.newline === true) {
          component.segment.lineEnd = true;
        }
        continue;
      }
    }

    pos++;
  }

  sendPendingLine();
  if (closingTag !== undefined) {
    return -1;
  }
  flush(text.length);
  return text.length;
}

function endOfLine(text: string, pos: number): number {
  const newline = text.indexOf("\n", pos);
  return newline === -1 ? text.length : newline;
}

/** Columns of leading whitespace, a tab advancing to the next multiple of four. */
function indentation(line: string): number {
  let columns = 0;
  for (const ch of line) {
    if (ch === " ") {
      columns += 1;
    } else if (ch === "\t") {
      columns += 4 - (columns % 4);
    } else {
      break;
    }
  }
  return columns;
}

/** Whether only spaces and tabs stand between a line's content start and `pos`. */
function beginsLine(text: string, lineContent: number, pos: number): boolean {
  for (let i = lineContent; i < pos; i++) {
    if (text[i] !== " " && text[i] !== "\t") {
      return false;
    }
  }
  return true;
}

/**
 * Whether only spaces and tabs follow `pos` on its line, and where that line
 * ends: after its newline, or at the end of the text.
 */
function lineEndingAfter(text: string, pos: number): { end: number; newline: boolean } | undefined {
  let at = pos;
  while (at < text.length && (text[at] === " " || text[at] === "\t")) {
    at++;
  }
  if (at >= text.length) {
    return { end: at, newline: false };
  }
  return text[at] === "\n" ? { end: at + 1, newline: true } : undefined;
}

/** `text` from a line start `from` to `to`, with `prefix` removed where a line has it. */
function dedentLines(text: string, from: number, to: number, prefix: string): string {
  if (prefix === "") {
    return text.slice(from, to);
  }
  let out = "";
  let pos = from;
  while (pos < to) {
    if (text.startsWith(prefix, pos) && pos + prefix.length <= to) {
      pos += prefix.length;
    }
    const newline = text.indexOf("\n", pos);
    const lineEnd = newline === -1 || newline >= to ? to : newline + 1;
    out += text.slice(pos, lineEnd);
    pos = lineEnd;
  }
  return out;
}

export interface SourceFence {
  readonly range: SourceRange;
  readonly marker: number;
  readonly executable: boolean;
  readonly end: "marker" | "container" | "unfinished";
}

export interface ScanDiagnostic {
  readonly message: string;
  readonly position: SourcePosition;
}

/**
 * One recognized element's delimiters, as the scanner committed them.
 *
 * `name` is the authored spelling, dots included. It says nothing about
 * whether the name resolves, what it is allowed to do, or whether anything
 * ever ran: this is where the characters are, and no more than that.
 *
 * `closing` is absent for exactly self-closing syntax. An element written with
 * paired delimiters and no content between them still has one.
 */
export interface SourceElement {
  readonly name: string;
  readonly opening: SourceRange;
  readonly closing?: SourceRange;
}

/**
 * One construct this scan began and could not finish, because the text ended.
 *
 * Told apart from a construct the scan *refused*: `<Probe x=!>` is not a tag
 * and no amount of further text makes it one, while `<Probe` and
 * `<Output>Hello` are the beginning of tags whose rest has not arrived. Only
 * the walk can say which, because only the walk knows how far it got and why it
 * stopped — so a reader that needs to know asks for this rather than looking at
 * the prose the scan left behind.
 *
 * Offsets index the exact text that was scanned.
 */
export interface UnfinishedConstruct {
  /** Where the construct begins. */
  readonly start: number;
  /** The authored spelling, for a component tag whose name the scan read. */
  readonly name?: string;
  /**
   * Where this element's own content begins.
   *
   * Present only for an element whose opening tag completed and whose closing
   * tag never arrived, which is the one case where the text already delivered
   * contains content belonging to a known element.
   */
  readonly contentStart?: number;
  /**
   * How many block elements enclose that content, present with
   * `contentStart`: a rescan of it removes the same structural prefix.
   */
  readonly contentDepth?: number;
  /** Whether that opening tag carried any attribute at all. */
  readonly attributed?: boolean;
}

export function scanFacts(text: string, origin?: SourceOrigin) {
  const elements: SourceElement[] = [];
  const unfinished: UnfinishedConstruct[] = [];
  const diagnostics: ScanDiagnostic[] = [];
  const fences: SourceFence[] = [];
  scanSegments(text, origin, undefined, elements, unfinished, 0, 0, diagnostics, fences);
  return { elements, unfinished, diagnostics, fences };
}

/** The source spans of the top-level component invocations in `text`. */
export function scanComponentSpans(text: string): ComponentSpan[] {
  const spans: ComponentSpan[] = [];
  scanSegments(text, undefined, spans);
  return spans;
}

/** Return the authored passive ranges recorded by the scanner. */
export function splitTextFences(segment: TextSegment): { content: string; passive: boolean }[] {
  const slices: { content: string; passive: boolean }[] = [];
  let start = 0;
  for (const range of segment.passiveFences ?? []) {
    if (range.start > start) {
      slices.push({ content: segment.content.slice(start, range.start), passive: false });
    }
    slices.push({ content: segment.content.slice(range.start, range.end), passive: true });
    start = range.end;
  }
  if (start < segment.content.length) {
    slices.push({ content: segment.content.slice(start), passive: false });
  }
  return slices;
}

interface ParsedComponent {
  segment: ComponentElement;
  end: number;
  /** Whether the opening tag is a line of its own, so the body is one level deeper. */
  block: boolean;
}

/**
 * Parse a JSX component tag starting at `<` (pos).
 * Returns the parsed component invocation and the position after it,
 * or null if this is not a valid component tag.
 */
function parseComponentTag(
  walk: Walk,
  start: number,
  depth: number,
  /** Where the content of the line holding `start` begins. */
  lineContent: number,
  /** Whether only indentation precedes `start` on its line. */
  begins: boolean,
): ParsedComponent | null {
  const { text, index, elements, unfinished } = walk;
  let pos = start + 1;

  // Parse tag name — must start with uppercase, can contain dots
  const nameStart = pos;
  if (pos >= text.length || !/[A-Z]/.test(text[pos]!)) {
    return null;
  }

  while (pos < text.length && /[A-Za-z0-9._]/.test(text[pos]!)) {
    pos++;
  }
  const name = text.slice(nameStart, pos);
  if (!name) {
    return null;
  }
  // A name that reached the end of the text is a tag still arriving: there is
  // no `/>` or `>` yet because there is no more text yet.
  if (pos >= text.length) {
    unfinished?.push({ start, name });
    return null;
  }

  const {
    props,
    expressions,
    authoredExpressions,
    end: attrEnd,
    exhausted,
  } = parseAttributes(text, pos, name);
  if (attrEnd === -1) {
    if (exhausted) {
      unfinished?.push({ start, name });
    }
    return null;
  }
  pos = attrEnd;
  const attributed =
    Object.keys(props).length > 0 ||
    Object.keys(expressions).length > 0 ||
    Object.keys(authoredExpressions).length > 0;

  pos = skipWhitespace(text, pos);

  if (pos < text.length && text[pos] === "/") {
    pos++;
    if (pos >= text.length) {
      unfinished?.push({ start, name, attributed });
      return null;
    }
    if (text[pos] !== ">") {
      return null;
    }
    pos++;

    elements?.push(Object.freeze({ name, opening: Object.freeze({ start, end: pos }) }));
    return {
      segment: {
        type: "component",
        name,
        props,
        expressions,
        authoredExpressions,
        children: [],
        selfClosing: true,
        position: positionAt(index, start),
      },
      end: pos,
      block: false,
    };
  }

  // Opening tag: must end with '>'
  if (pos >= text.length) {
    unfinished?.push({ start, name, attributed });
    return null;
  }
  if (text[pos] !== ">") {
    return null;
  }
  pos++;
  const openingEnd = pos;
  if (walk.headerOnly) {
    return {
      segment: {
        type: "component",
        name,
        props,
        expressions,
        authoredExpressions,
        children: [],
        selfClosing: false,
      },
      end: openingEnd,
      block: false,
    };
  }

  // Parse children until closing tag. Nested elements are collected aside and
  // committed only with this parse: an incomplete passive tag has no children
  // the scanner recognized, so it must leave none behind.
  const nested: SourceElement[] | undefined = elements === undefined ? undefined : [];
  // An opening tag that is its own line opens a block: the body starts on the
  // next line, one structural level deeper.
  const opening = begins ? lineEndingAfter(text, openingEnd) : undefined;
  const block = opening?.newline === true;
  const children: Segment[] = [];
  const nestedFences: SourceFence[] | undefined = walk.fences === undefined ? undefined : [];
  const childEnd = scanBody(
    { ...walk, elements: nested, fences: nestedFences },
    block
      ? {
          pos: opening.end,
          depth: depth + 1,
          lineContent: opening.end,
          delimiterIndent: text.slice(text.lastIndexOf("\n", start - 1) + 1, start),
        }
      : { pos: openingEnd, depth, lineContent },
    `</${name}>`,
    children,
  );
  if (childEnd === -1) {
    // The opening tag completed and the closing one never arrived, so the text
    // already delivered holds content belonging to a known element. Reported
    // with where that content starts, because a reader projecting a region it
    // has not finished receiving needs exactly that.
    unfinished?.push(
      block
        ? { start, name, attributed, contentStart: opening.end, contentDepth: depth + 1 }
        : { start, name, attributed, contentStart: openingEnd, contentDepth: depth },
    );
    return null;
  }

  if (elements !== undefined && nested !== undefined) {
    // This element before the ones inside it, which is opening order.
    elements.push(
      Object.freeze({
        name,
        opening: Object.freeze({ start, end: openingEnd }),
        closing: Object.freeze({ start: childEnd - `</${name}>`.length, end: childEnd }),
      }),
    );
    elements.push(...nested);
  }
  if (nestedFences !== undefined) {
    walk.fences?.push(...nestedFences);
  }

  return {
    segment: {
      type: "component",
      name,
      props,
      expressions,
      authoredExpressions,
      children,
      selfClosing: false,
      position: positionAt(index, start),
    },
    end: childEnd,
    block,
  };
}

interface ParsedAttributes {
  props: Record<string, Json>;
  expressions: Record<string, string>;
  /** Authored text of the `{…}` props resolved into `props` above. */
  authoredExpressions: Record<string, string>;
  end: number; // position after last attribute, before /> or >
  /**
   * Whether `end: -1` means the text ran out rather than that an attribute was
   * written wrongly.
   *
   * Both end the tag, and they are different facts about the same `-1`: a
   * quote, a brace or a value that never arrived is a tag still being
   * delivered, while a character that cannot begin an attribute name or a value
   * is one no further text repairs.
   */
  exhausted: boolean;
}

function parseAttributes(
  text: string,
  pos: number,
  /** Whose attributes these are: a construct may bind one of them by reference. */
  componentName: string,
): ParsedAttributes {
  const props: Record<string, Json> = {};
  const expressions: Record<string, string> = {};
  const authoredExpressions: Record<string, string> = {};

  while (pos < text.length) {
    pos = skipWhitespace(text, pos);
    if (pos >= text.length) {
      return { props, expressions, authoredExpressions, end: -1, exhausted: true };
    }

    if (text[pos] === "/" || text[pos] === ">") {
      return { props, expressions, authoredExpressions, end: pos, exhausted: false };
    }

    // Spread props: {...expr}
    if (
      text[pos] === "{" &&
      pos + 2 < text.length &&
      text[pos + 1] === "." &&
      text[pos + 2] === "."
    ) {
      // Skip spread — consume the expression
      const exprEnd = findMatchingBrace(text, pos);
      if (exprEnd === -1) {
        return { props, expressions, authoredExpressions, end: -1, exhausted: true };
      }
      // We don't evaluate spread props — just skip them
      pos = exprEnd + 1;
      continue;
    }

    const attrNameStart = pos;
    while (pos < text.length && /[A-Za-z0-9_-]/.test(text[pos]!)) {
      pos++;
    }
    const attrName = text.slice(attrNameStart, pos);
    if (!attrName) {
      return { props, expressions, authoredExpressions, end: -1, exhausted: false };
    }

    pos = skipWhitespace(text, pos);

    // Boolean attribute (no value): `verbose`
    if (
      pos >= text.length ||
      text[pos] === "/" ||
      text[pos] === ">" ||
      /[A-Za-z{]/.test(text[pos]!)
    ) {
      // Check it's not `=`
      if (pos < text.length && text[pos] !== "=") {
        props[attrName] = true;
        continue;
      }
    }

    // Must have '='
    if (pos >= text.length || text[pos] !== "=") {
      // Boolean attribute before /> or >
      props[attrName] = true;
      continue;
    }
    pos++;
    pos = skipWhitespace(text, pos);

    if (pos >= text.length) {
      return { props, expressions, authoredExpressions, end: -1, exhausted: true };
    }

    if (text[pos] === '"') {
      // String attribute: "value"
      const strEnd = findClosingQuote(text, pos + 1, '"');
      if (strEnd === -1) {
        return { props, expressions, authoredExpressions, end: -1, exhausted: true };
      }
      props[attrName] = text.slice(pos + 1, strEnd);
      pos = strEnd + 1;
    } else if (text[pos] === "'") {
      // String attribute: 'value'
      const strEnd = findClosingQuote(text, pos + 1, "'");
      if (strEnd === -1) {
        return { props, expressions, authoredExpressions, end: -1, exhausted: true };
      }
      props[attrName] = text.slice(pos + 1, strEnd);
      pos = strEnd + 1;
    } else if (text[pos] === "{") {
      // Expression attribute: {expr}
      const exprEnd = findMatchingBrace(text, pos);
      if (exprEnd === -1) {
        return { props, expressions, authoredExpressions, end: -1, exhausted: true };
      }
      const exprText = text.slice(pos + 1, exprEnd).trim();
      if (bindsByReference(componentName, attrName)) {
        expressions[attrName] = exprText;
      } else if (exprText === "undefined" && !isStructural(componentName)) {
        // An ordinary component's prop is absent when its expression produces
        // `undefined`, and the resolver that crosses the JSON boundary at
        // expansion is where that is decided (§6.5). Reading the literal here
        // would answer with `null` before the prop ever reaches it. A construct
        // evaluates its own operand under its own contract, so what it is
        // handed at scan time is unchanged.
        expressions[attrName] = exprText;
      } else {
        const result = parseExpressionValue(exprText);
        if (result.kind === "resolved") {
          props[attrName] = result.value;
          // Kept beside the reading of it: whether this prop is a capture is
          // the selected definition's answer, and no definition is selected
          // yet.
          authoredExpressions[attrName] = exprText;
        } else {
          expressions[attrName] = result.expression;
        }
      }
      pos = exprEnd + 1;
    } else {
      // A value that begins with something no attribute value begins with.
      // Further text does not make this a tag.
      return { props, expressions, authoredExpressions, end: -1, exhausted: false };
    }
  }

  return { props, expressions, authoredExpressions, end: -1, exhausted: true };
}

/**
 * Find matching closing brace, respecting nested braces, strings, and
 * template literals.
 */
function findMatchingBrace(text: string, start: number): number {
  let depth = 0;
  let pos = start;

  while (pos < text.length) {
    const ch = text[pos]!;

    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return pos;
      }
    } else if (ch === '"' || ch === "'") {
      const end = findClosingQuote(text, pos + 1, ch);
      if (end === -1) {
        return -1;
      }
      pos = end;
    } else if (ch === "`") {
      pos = skipTemplateLiteral(text, pos);
      if (pos === -1) {
        return -1;
      }
    }

    pos++;
  }

  return -1;
}

/**
 * Skip a template literal starting at the opening backtick.
 * Returns the position of the closing backtick, or -1.
 */
function skipTemplateLiteral(text: string, start: number): number {
  let pos = start + 1;

  while (pos < text.length) {
    const ch = text[pos]!;

    if (ch === "`") {
      return pos;
    } else if (ch === "\\" && pos + 1 < text.length) {
      pos += 2;
      continue;
    } else if (ch === "$" && pos + 1 < text.length && text[pos + 1] === "{") {
      // Template expression — find matching brace
      const braceEnd = findMatchingBrace(text, pos + 1);
      if (braceEnd === -1) {
        return -1;
      }
      pos = braceEnd + 1;
      continue;
    }

    pos++;
  }

  return -1;
}

function findClosingQuote(text: string, start: number, quote: string): number {
  let pos = start;
  while (pos < text.length) {
    if (text[pos] === "\\") {
      pos += 2;
      continue;
    }
    if (text[pos] === quote) {
      return pos;
    }
    pos++;
  }
  return -1;
}

/** A value fully resolved at scan time (JSON literal). */
export interface ResolvedValue {
  kind: "resolved";
  value: Json;
}

/** An expression that must be evaluated at expansion time against env.values. */
export interface EvalExpression {
  kind: "eval";
  expression: string;
}

/** Result of parsing an expression attribute value. */
export type ExpressionResult = ResolvedValue | EvalExpression;

/**
 * Parse a JSX expression value.
 *
 * JSON-compatible literals (numbers, booleans, null, objects, arrays) are
 * resolved at scan time. Everything else is an eval expression — raw
 * expression text to be evaluated against env.values at expansion time.
 */
export function parseExpressionValue(expr: string): ExpressionResult {
  const trimmed = expr.trim();

  // Try JSON-compatible parse for objects, arrays
  try {
    // Handle some JSX expression patterns
    // Convert single-quoted strings to double-quoted for JSON
    const jsonCandidate = trimmed
      // Object/array shorthand: { key: "value" } → {"key": "value"}
      .replace(/(\{|,)\s*([A-Za-z_]\w*)\s*:/g, '$1 "$2":')
      // Single-quoted string values inside objects
      .replace(/:\s*'([^']*)'/g, ': "$1"');

    const parsed = JSON.parse(jsonCandidate) as Json;
    return { kind: "resolved", value: parsed };
  } catch {
    // Fall through
  }

  // Number
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return { kind: "resolved", value: Number(trimmed) };
  }

  // Boolean
  if (trimmed === "true") {
    return { kind: "resolved", value: true };
  }
  if (trimmed === "false") {
    return { kind: "resolved", value: false };
  }

  // `null` is JSON. A literal `undefined` reads as `null` here for a construct
  // that takes an arbitrary operand and is asked for a scan-time reading of it;
  // an ordinary component's is kept as an expression by the caller, because
  // absence is what it means there.
  if (trimmed === "null" || trimmed === "undefined") {
    return { kind: "resolved", value: null };
  }

  // Everything else is an eval expression — evaluate at expansion time
  return { kind: "eval", expression: trimmed };
}

/**
 * If `pos` is at a backtick, skip past the closing backtick sequence
 * of the inline code span. Returns the position after the closing
 * backticks, or -1 if no matching close is found (unclosed code span).
 *
 * Handles multi-backtick sequences per CommonMark: the opening and
 * closing sequences must have the same number of backticks.
 */
function skipInlineCode(text: string, pos: number): number {
  if (text[pos] !== "`") {
    return -1;
  }

  // Count opening backticks
  let backtickLen = 0;
  let p = pos;
  while (p < text.length && text[p] === "`") {
    backtickLen++;
    p++;
  }

  // Search for matching closing sequence (same length)
  while (p < text.length) {
    if (text[p] === "`") {
      let closeLen = 0;
      while (p < text.length && text[p] === "`") {
        closeLen++;
        p++;
      }
      if (closeLen === backtickLen) {
        return p; // position after closing backticks
      }
      // Wrong length — keep searching
      continue;
    }
    p++;
  }

  return -1; // unclosed code span
}

function skipWhitespace(text: string, pos: number): number {
  while (pos < text.length && /\s/.test(text[pos]!)) {
    pos++;
  }
  return pos;
}

function pushText(segments: Segment[], content: string, passive = false): void {
  if (content.length === 0) {
    return;
  }
  const last = segments.at(-1);
  if (last?.type === "text") {
    const start = last.content.length;
    last.content += content;
    if (passive) {
      (last.passiveFences ??= []).push({ start, end: last.content.length });
    }
    return;
  }
  segments.push({
    type: "text",
    content,
    ...(passive ? { passiveFences: [{ start: 0, end: content.length }] } : {}),
  });
}

export function readHeader(text: string, start: number): number | undefined {
  const index = { lineStarts: [0] };
  return parseComponentTag({ text, index, headerOnly: true }, start, 0, start, false)?.end;
}
