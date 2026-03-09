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

import type {
  Segment,
  TextSegment,
  ComponentInvocation,
  ExecutableCodeBlock,
  Modifier,
  ParsedInfoString,
  Json,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Info string parsing (spec §3.5)
// ---------------------------------------------------------------------------

export function parseInfoString(infoString: string): ParsedInfoString {
  const tokens = infoString.trim().split(/\s+/);
  const language = tokens[0] ?? "";
  const modifiers: Modifier[] = [];

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!;
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

  return {
    language,
    modifiers,
    executable: modifiers.some((m) => m.name === "exec" || m.name === "eval"),
  };
}

// ---------------------------------------------------------------------------
// Segment scanner
// ---------------------------------------------------------------------------

/**
 * Scan raw markdown text into segments.
 *
 * Identifies component invocations (`<PascalCase ...>`), executable code
 * blocks (fenced with `exec` in info string), and everything else as text.
 */
export function scanSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let pos = 0;
  let textStart = 0;

  while (pos < text.length) {
    // Check for fenced code block
    const fenceMatch = matchFenceOpen(text, pos);
    if (fenceMatch) {
      // Flush text before fence
      if (pos > textStart) {
        pushText(segments, text.slice(textStart, pos));
      }

      const fenceEnd = findFenceClose(
        text,
        fenceMatch.contentStart,
        fenceMatch.fenceChar,
        fenceMatch.fenceLen,
      );
      const content = text.slice(fenceMatch.contentStart, fenceEnd.contentEnd);
      const fullFence = text.slice(pos, fenceEnd.fenceEnd);

      const parsed = parseInfoString(fenceMatch.infoString);

      if (parsed.executable) {
        segments.push({
          type: "codeBlock",
          language: parsed.language,
          content,
          modifiers: parsed.modifiers,
          executable: true,
        } satisfies ExecutableCodeBlock);
      } else {
        // Non-executable code block: preserve as text
        pushText(segments, fullFence);
      }

      pos = fenceEnd.fenceEnd;
      textStart = pos;
      continue;
    }

    // Check for component invocation: `<` followed by uppercase letter
    if (
      text[pos] === "<" &&
      pos + 1 < text.length &&
      /[A-Z]/.test(text[pos + 1]!)
    ) {
      // Make sure we're not inside a fenced code block (handled above)
      const component = parseComponentTag(text, pos);
      if (component) {
        // Flush text before component
        if (pos > textStart) {
          pushText(segments, text.slice(textStart, pos));
        }
        segments.push(component.segment);
        pos = component.end;
        textStart = pos;
        continue;
      }
    }

    pos++;
  }

  // Flush remaining text
  if (textStart < text.length) {
    pushText(segments, text.slice(textStart));
  }

  return segments;
}

// ---------------------------------------------------------------------------
// Fenced code block detection
// ---------------------------------------------------------------------------

interface FenceOpen {
  fenceChar: string;
  fenceLen: number;
  infoString: string;
  contentStart: number;
}

interface FenceClose {
  contentEnd: number;
  fenceEnd: number;
}

/**
 * Check if position is at the start of a fenced code block opening.
 * Must be at the start of a line (pos === 0 or preceded by newline).
 * Supports both backtick and tilde fences, with optional leading spaces (0-3).
 */
function matchFenceOpen(text: string, pos: number): FenceOpen | null {
  // Must be at start of line
  if (pos > 0 && text[pos - 1] !== "\n") return null;

  let i = pos;

  // Optional leading spaces (0-3)
  let spaces = 0;
  while (spaces < 3 && i < text.length && text[i] === " ") {
    spaces++;
    i++;
  }

  if (i >= text.length) return null;

  const fenceChar = text[i]!;
  if (fenceChar !== "`" && fenceChar !== "~") return null;

  // Count fence characters (minimum 3)
  let fenceLen = 0;
  while (i < text.length && text[i] === fenceChar) {
    fenceLen++;
    i++;
  }
  if (fenceLen < 3) return null;

  // Info string goes to end of line
  const lineEnd = text.indexOf("\n", i);
  const infoString =
    lineEnd === -1 ? text.slice(i).trim() : text.slice(i, lineEnd).trim();

  // Backtick fences: info string must not contain backticks
  if (fenceChar === "`" && infoString.includes("`")) return null;

  const contentStart = lineEnd === -1 ? text.length : lineEnd + 1;

  return { fenceChar, fenceLen, infoString, contentStart };
}

/**
 * Find the closing fence for an open code block.
 */
function findFenceClose(
  text: string,
  contentStart: number,
  fenceChar: string,
  fenceLen: number,
): FenceClose {
  let pos = contentStart;

  while (pos < text.length) {
    // Must be at start of line
    let lineStart = pos;

    // Optional leading spaces (0-3)
    let spaces = 0;
    while (spaces < 3 && pos < text.length && text[pos] === " ") {
      spaces++;
      pos++;
    }

    // Check for closing fence
    if (pos < text.length && text[pos] === fenceChar) {
      let closeFenceLen = 0;
      while (pos < text.length && text[pos] === fenceChar) {
        closeFenceLen++;
        pos++;
      }

      // Closing fence must be at least as long as opening and followed by
      // only optional spaces then newline or end of string
      if (closeFenceLen >= fenceLen) {
        // Skip optional trailing spaces
        while (pos < text.length && text[pos] === " ") {
          pos++;
        }
        if (pos >= text.length || text[pos] === "\n") {
          const fenceEnd = pos < text.length ? pos + 1 : pos;
          return { contentEnd: lineStart, fenceEnd };
        }
      }
    }

    // Skip to next line
    const nextNewline = text.indexOf("\n", pos);
    if (nextNewline === -1) {
      // No closing fence found — content goes to end
      return { contentEnd: text.length, fenceEnd: text.length };
    }
    pos = nextNewline + 1;
  }

  return { contentEnd: text.length, fenceEnd: text.length };
}

// ---------------------------------------------------------------------------
// JSX component tag parser (12-state machine, spec §2.2)
// ---------------------------------------------------------------------------

interface ParsedComponent {
  segment: ComponentInvocation;
  end: number;
}

/**
 * Parse a JSX component tag starting at `<` (pos).
 * Returns the parsed component invocation and the position after it,
 * or null if this is not a valid component tag.
 */
function parseComponentTag(text: string, start: number): ParsedComponent | null {
  let pos = start + 1; // Skip '<'

  // Parse tag name — must start with uppercase, can contain dots
  const nameStart = pos;
  if (pos >= text.length || !/[A-Z]/.test(text[pos]!)) return null;

  while (pos < text.length && /[A-Za-z0-9._]/.test(text[pos]!)) {
    pos++;
  }
  const name = text.slice(nameStart, pos);
  if (!name) return null;

  // Parse attributes
  const { props, end: attrEnd } = parseAttributes(text, pos);
  if (attrEnd === -1) return null;
  pos = attrEnd;

  // Skip whitespace
  pos = skipWhitespace(text, pos);

  // Self-closing tag?
  if (pos < text.length && text[pos] === "/") {
    pos++; // Skip '/'
    if (pos >= text.length || text[pos] !== ">") return null;
    pos++; // Skip '>'

    return {
      segment: {
        type: "component",
        name,
        props,
        children: [],
        selfClosing: true,
      },
      end: pos,
    };
  }

  // Opening tag: must end with '>'
  if (pos >= text.length || text[pos] !== ">") return null;
  pos++; // Skip '>'

  // Parse children until closing tag
  const { children, end: childEnd } = parseChildren(text, pos, name);
  if (childEnd === -1) return null;

  return {
    segment: {
      type: "component",
      name,
      props,
      children,
      selfClosing: false,
    },
    end: childEnd,
  };
}

// ---------------------------------------------------------------------------
// Attribute parsing
// ---------------------------------------------------------------------------

interface ParsedAttributes {
  props: Record<string, Json>;
  end: number; // position after last attribute, before /> or >
}

function parseAttributes(
  text: string,
  pos: number,
): ParsedAttributes {
  const props: Record<string, Json> = {};

  while (pos < text.length) {
    pos = skipWhitespace(text, pos);
    if (pos >= text.length) return { props, end: -1 };

    // End of attributes?
    if (text[pos] === "/" || text[pos] === ">") {
      return { props, end: pos };
    }

    // Spread props: {...expr}
    if (text[pos] === "{" && pos + 2 < text.length && text[pos + 1] === "." && text[pos + 2] === ".") {
      // Skip spread — consume the expression
      const exprEnd = findMatchingBrace(text, pos);
      if (exprEnd === -1) return { props, end: -1 };
      // We don't evaluate spread props — just skip them
      pos = exprEnd + 1;
      continue;
    }

    // Attribute name
    const attrNameStart = pos;
    while (
      pos < text.length &&
      /[A-Za-z0-9_-]/.test(text[pos]!)
    ) {
      pos++;
    }
    const attrName = text.slice(attrNameStart, pos);
    if (!attrName) return { props, end: -1 };

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
    pos++; // Skip '='
    pos = skipWhitespace(text, pos);

    // Attribute value
    if (pos >= text.length) return { props, end: -1 };

    if (text[pos] === '"') {
      // String attribute: "value"
      const strEnd = findClosingQuote(text, pos + 1, '"');
      if (strEnd === -1) return { props, end: -1 };
      props[attrName] = text.slice(pos + 1, strEnd);
      pos = strEnd + 1;
    } else if (text[pos] === "'") {
      // String attribute: 'value'
      const strEnd = findClosingQuote(text, pos + 1, "'");
      if (strEnd === -1) return { props, end: -1 };
      props[attrName] = text.slice(pos + 1, strEnd);
      pos = strEnd + 1;
    } else if (text[pos] === "{") {
      // Expression attribute: {expr}
      const exprEnd = findMatchingBrace(text, pos);
      if (exprEnd === -1) return { props, end: -1 };
      const exprText = text.slice(pos + 1, exprEnd).trim();
      props[attrName] = parseExpressionValue(exprText);
      pos = exprEnd + 1;
    } else {
      return { props, end: -1 };
    }
  }

  return { props, end: -1 };
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
      if (depth === 0) return pos;
    } else if (ch === '"' || ch === "'") {
      // Skip string literal
      const end = findClosingQuote(text, pos + 1, ch);
      if (end === -1) return -1;
      pos = end;
    } else if (ch === "`") {
      // Skip template literal
      pos = skipTemplateLiteral(text, pos);
      if (pos === -1) return -1;
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
  let pos = start + 1; // Skip opening `

  while (pos < text.length) {
    const ch = text[pos]!;

    if (ch === "`") {
      return pos;
    } else if (ch === "\\" && pos + 1 < text.length) {
      pos += 2; // Skip escape sequence
      continue;
    } else if (ch === "$" && pos + 1 < text.length && text[pos + 1] === "{") {
      // Template expression — find matching brace
      const braceEnd = findMatchingBrace(text, pos + 1);
      if (braceEnd === -1) return -1;
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
    if (text[pos] === quote) return pos;
    pos++;
  }
  return -1;
}

/**
 * Parse a JSX expression value to a JSON value.
 * Handles numbers, booleans, null, objects, arrays, and strings.
 */
function parseExpressionValue(expr: string): Json {
  const trimmed = expr.trim();

  // Try JSON-compatible parse for objects, arrays, numbers, booleans, null
  try {
    // Handle some JSX expression patterns
    // Convert single-quoted strings to double-quoted for JSON
    const jsonCandidate = trimmed
      // Object/array shorthand: { key: "value" } → {"key": "value"}
      .replace(/(\{|,)\s*([A-Za-z_]\w*)\s*:/g, '$1 "$2":')
      // Single-quoted string values inside objects
      .replace(/:\s*'([^']*)'/g, ': "$1"');

    const parsed = JSON.parse(jsonCandidate) as Json;
    return parsed;
  } catch {
    // Fall through
  }

  // Number
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  // Boolean
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  // null/undefined
  if (trimmed === "null" || trimmed === "undefined") return null;

  // String fallback — return the raw expression text
  return trimmed;
}

// ---------------------------------------------------------------------------
// Children parsing
// ---------------------------------------------------------------------------

interface ParsedChildren {
  children: Segment[];
  end: number; // position after closing tag
}

function parseChildren(
  text: string,
  start: number,
  tagName: string,
): ParsedChildren {
  let pos = start;
  let textStart = pos;
  const children: Segment[] = [];

  // Build the closing tag pattern
  const closingTag = `</${tagName}>`;

  while (pos < text.length) {
    // Check for closing tag
    if (text.startsWith(closingTag, pos)) {
      // Flush remaining text as child
      if (pos > textStart) {
        pushText(children, text.slice(textStart, pos));
      }
      return { children, end: pos + closingTag.length };
    }

    // Check for nested component
    if (
      text[pos] === "<" &&
      pos + 1 < text.length &&
      /[A-Z]/.test(text[pos + 1]!)
    ) {
      const nested = parseComponentTag(text, pos);
      if (nested) {
        if (pos > textStart) {
          pushText(children, text.slice(textStart, pos));
        }
        children.push(nested.segment);
        pos = nested.end;
        textStart = pos;
        continue;
      }
    }

    pos++;
  }

  // No closing tag found
  return { children, end: -1 };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function skipWhitespace(text: string, pos: number): number {
  while (pos < text.length && /\s/.test(text[pos]!)) {
    pos++;
  }
  return pos;
}

function pushText(segments: Segment[], content: string): void {
  if (content.length === 0) return;

  // Merge with previous text segment if possible
  const last = segments[segments.length - 1];
  if (last && last.type === "text") {
    last.content += content;
    return;
  }

  segments.push({ type: "text", content } satisfies TextSegment);
}
