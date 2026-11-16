/**
 * Markdown somebody wrote, as the logical lines and styled runs this screen
 * draws it with.
 *
 * Shared by the two readings that show written prose: a Sidekick conversation
 * body and an entry's rendered Output. Display only. The string passed in is
 * the one every journal, save and raw read keeps; nothing here reaches back
 * into it.
 *
 * Headings, emphasis, list markers, link labels and code are styled runs.
 * Fenced code keeps every payload line as it was written, indentation and blank
 * lines included, because the source span is what is drawn rather than the
 * lexer's normalized text. A construct this does not format — raw HTML, a
 * component-like tag, a table, a delimiter that never closed — is drawn as the
 * text it is. A link shows its label; its target is never drawn, opened or
 * written to the terminal as anything.
 *
 * Controls are made inert before the lexer sees the text, so a carriage return
 * cannot become a line break, and again on every run the walk produces. Line
 * breaks are the source's own: one written line is one logical line, and
 * wrapping stays with the measured fitting that every reading already uses.
 */

import { Lexer } from "marked";
import type { Token } from "marked";
import { inertCommandText } from "./command-output.ts";
import { tokenRuns } from "./description.ts";
import type { ReplTokenRun } from "./description.ts";
import type { ReplPresentationRole } from "./presentation-style.ts";

/** One logical line of formatted text. The runs concatenate to exactly `text`. */
export interface ReplMarkdownLine {
  readonly text: string;
  readonly runs: readonly ReplTokenRun[];
}

interface Part {
  readonly text: string;
  readonly token: ReplPresentationRole;
}

type Line = Part[];

/**
 * The lines one body is drawn as, with its ordinary text in `role`.
 *
 * Plain text comes back as one line per written line, each one run in `role`.
 */
export function markdownLines(
  source: string,
  role: ReplPresentationRole,
): readonly ReplMarkdownLine[] {
  const lines = blocks(Lexer.lex(inertCommandText(source)), role, true).map((parts) => {
    const runs = tokenRuns(
      parts.map((part) => ({ text: inertCommandText(part.text), token: part.token })),
    );
    return Object.freeze({ text: runs.map((run) => run.text).join(""), runs });
  });
  return Object.freeze(lines);
}

/**
 * Block tokens as lines, with the lines written between them.
 *
 * The rows between two blocks are the lines the source wrote there, spaces
 * included: the text after the earlier block's last line break and before the
 * next block. At the start and end of the outermost body every one of those
 * lines is a row, as splitting the text on its line breaks gives. A nested body
 * leaves its leading and trailing lines to the container holding it.
 */
function blocks(tokens: readonly Token[], role: ReplPresentationRole, outermost: boolean): Line[] {
  const lines: Line[] = [];
  let gap = "";
  let any = false;
  const between = (written: readonly string[]) => {
    for (const one of written) {
      lines.push(one.length === 0 ? [] : [{ text: one, token: role }]);
    }
  };
  for (const token of tokens) {
    if (token.type === "space") {
      gap += token.raw;
      continue;
    }
    const written = gap.split("\n");
    between(any ? written.slice(1, -1) : outermost ? written.slice(0, -1) : []);
    lines.push(...block(token, role));
    gap = token.raw.slice(withoutTrailingBreaks(token.raw).length);
    any = true;
  }
  if (outermost) {
    const written = gap.split("\n");
    between(any ? written.slice(1) : written);
  }
  return lines;
}

function block(token: Token, role: ReplPresentationRole): Line[] {
  switch (token.type) {
    case "heading":
      return inline(token.tokens ?? [], "source-heading");
    case "paragraph":
    case "text":
      return "tokens" in token && token.tokens !== undefined
        ? inline(token.tokens, role)
        : literal(token.raw, role);
    case "code":
      return code(token.raw, "codeBlockStyle" in token && token.codeBlockStyle === "indented");
    case "list":
      return list(itemsOf(token), role);
    case "blockquote":
      return blocks(token.tokens ?? [], role, false).map((one) => [
        { text: "│ ", token: "punctuation" },
        ...one,
      ]);
    case "hr":
      return literal(token.raw, "punctuation");
    case "checkbox":
      return [[{ text: token.raw, token: "punctuation" }]];
    default:
      return literal(token.raw, role);
  }
}

/**
 * Fenced or indented code, from its source span.
 *
 * The lexer's text strips the indentation a fence was written at, so the raw
 * lines are drawn instead: the fences as punctuation, every line between them
 * as code. An unterminated fence holds everything after its opening line.
 */
function code(raw: string, indented: boolean): Line[] {
  const written = withoutTrailingBreaks(raw).split("\n");
  if (indented) {
    return written.map((one) => [{ text: one, token: "markdown-code" }]);
  }
  const closed = written.length > 1 && closes(written[0], written[written.length - 1]);
  return written.map((one, at) => [
    {
      text: one,
      token: at === 0 || (closed && at === written.length - 1) ? "punctuation" : "markdown-code",
    },
  ]);
}

/**
 * Whether a line closes the fence this opening line began: the same character,
 * at least as many of it, and nothing after them but spaces. A shorter run or
 * the other character is payload.
 */
function closes(opening: string, line: string): boolean {
  const opened = /^ {0,3}(`{3,}|~{3,})/.exec(opening)?.[1];
  const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
  return (
    opened !== undefined &&
    closing !== undefined &&
    closing[0] === opened[0] &&
    closing.length >= opened.length
  );
}

interface Item {
  readonly raw: string;
  readonly tokens: readonly Token[];
}

function itemsOf(token: Token): readonly Item[] {
  const items: Item[] = [];
  for (const one of "items" in token && Array.isArray(token.items) ? token.items : []) {
    if (typeof one?.raw === "string" && Array.isArray(one.tokens)) {
      items.push({ raw: one.raw, tokens: one.tokens });
    }
  }
  return items;
}

/**
 * A list's items, each under its marker, with the item's further lines set in
 * under the marker's width. A bullet is drawn as `•`; an ordered item keeps the
 * number and delimiter it was written with.
 */
function list(items: readonly Item[], role: ReplPresentationRole): Line[] {
  const lines: Line[] = [];
  let pending = 0;
  for (const [at, item] of items.entries()) {
    for (let blank = at > 0 ? pending - 1 : 0; blank > 0; blank -= 1) {
      lines.push([]);
    }
    const written = MARKER.exec(item.raw)?.[1] ?? "-";
    const marker = /^\d/.test(written) ? `${written} ` : "• ";
    const body = blocks(item.tokens, role, false);
    for (const [offset, one] of (body.length === 0 ? [[]] : body).entries()) {
      if (offset > 0 && one.length === 0) {
        lines.push([]);
        continue;
      }
      lines.push([
        {
          text: offset === 0 ? marker : " ".repeat(marker.length),
          token: "punctuation",
        },
        ...one,
      ]);
    }
    pending = trailing(item.raw);
  }
  return lines;
}

const MARKER = /^\s*(\d{1,9}[.)]|[-+*])/;

/**
 * Inline tokens as lines, split where the text itself breaks.
 *
 * `base` is what plain text in this stretch is.
 */
function inline(tokens: readonly Token[], base: ReplPresentationRole): Line[] {
  const parts: Part[] = [];
  walk(tokens, base, parts);
  const lines: Line[] = [[]];
  for (const part of parts) {
    const pieces = part.text.split("\n");
    for (const [at, piece] of pieces.entries()) {
      if (at > 0) {
        lines.push([]);
      }
      lines[lines.length - 1].push({ text: piece, token: part.token });
    }
  }
  // A block's own final line break ends its last line; the blank rows after it
  // are counted from the raw text by whoever holds the block.
  if (lines.length > 1 && lines[lines.length - 1].every((part) => part.text.length === 0)) {
    lines.pop();
  }
  return lines;
}

function walk(tokens: readonly Token[], role: ReplPresentationRole, parts: Part[]): void {
  for (const token of tokens) {
    switch (token.type) {
      case "strong":
      case "em":
        walk(
          token.tokens ?? [],
          role === "source-heading"
            ? role
            : token.type === "strong"
              ? "markdown-strong"
              : "markdown-em",
          parts,
        );
        break;
      case "link":
        if ((token.tokens ?? []).length === 0 || token.text.length === 0) {
          parts.push({ text: token.raw, token: role });
        } else {
          walk(token.tokens ?? [], "markdown-link", parts);
        }
        break;
      case "codespan":
        parts.push({ text: codeSpan(token.raw), token: "markdown-code" });
        break;
      case "escape":
        parts.push({ text: token.text, token: role });
        break;
      case "text":
        if ("tokens" in token && token.tokens !== undefined && token.tokens.length > 0) {
          walk(token.tokens, role, parts);
        } else {
          parts.push({ text: token.raw, token: role });
        }
        break;
      default:
        parts.push({ text: token.raw, token: role });
    }
  }
}

/**
 * A code span's content from its own source, line breaks kept.
 *
 * The lexer's text turns a break inside a span into a space, which would join
 * two written lines into one.
 */
function codeSpan(raw: string): string {
  const fence = /^`+/.exec(raw)?.[0].length ?? 0;
  const inner = raw.slice(fence, raw.length - fence);
  return inner.length > 2 && inner.startsWith(" ") && inner.endsWith(" ") && inner.trim() !== ""
    ? inner.slice(1, -1)
    : inner;
}

function literal(raw: string, token: ReplPresentationRole): Line[] {
  return withoutTrailingBreaks(raw)
    .split("\n")
    .map((one) => [{ text: one, token }]);
}

function withoutTrailingBreaks(raw: string): string {
  return raw.replace(/\n+$/, "");
}

function trailing(raw: string): number {
  return raw.length - raw.replace(/\n+$/, "").length;
}
