/**
 * What the characters of one line *are*, for the two readings this screen shows
 * verbatim: executable Markdown source, and a parsed JSON value.
 *
 * Presentation only. Nothing here validates, evaluates, rejects or rewrites
 * anything: every run it returns concatenates back to exactly the line it was
 * given, so a draft part-way through a tag keeps every character the person
 * typed and an escape inside a string survives being coloured. A stretch this
 * cannot classify reads as ordinary source, which is what unclassified text
 * looks like everywhere else on this screen.
 *
 * It is pure and private to the REPL. No operation, no host Api, no state — a
 * line in, runs out — so what it answers cannot depend on anything but the line.
 *
 * ## Why one line at a time
 *
 * A cell is a row. The screen has already decided which rows a reading is drawn
 * in by the time these are built, so a classifier that carried state from one
 * row to the next would be answering about a document while the thing being
 * drawn is a row. An unterminated quote therefore ends with its line, which is
 * also what a person typing one wants to see.
 *
 * ## JSON is classified from JSON
 *
 * `jsonRuns` is for text this product produced by serializing a value it had
 * already parsed, or for a reading a caller knows is JSON. It is never a guess
 * about whether arbitrary provider or document output happens to look like
 * JSON: prose that begins with a brace is prose.
 */

import { tokenRuns } from "./description.ts";
import type { ReplTokenRun } from "./description.ts";
import type { ReplPresentationRole } from "./presentation-style.ts";

/** One stretch of a line, before the runs are joined. */
interface Part {
  readonly text: string;
  readonly token: ReplPresentationRole;
}

/** What a tag and an attribute may be called. */
const NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*/;

/** A heading, as the source writes one. */
const HEADING = /^(\s*)(#{1,6}(?:\s.*)?)$/;

/**
 * One line of executable Markdown source, as the roles its characters carry.
 *
 * A heading is the whole line, because that is what a heading is. Everything
 * else is read as text with tags and references in it: a `<` that no name
 * follows is a less-than sign, which is why the opening delimiter is recognized
 * together with the name after it rather than on its own.
 */
export function sourceRuns(line: string): readonly ReplTokenRun[] {
  const heading = HEADING.exec(line);
  if (heading !== null) {
    return tokenRuns([
      { text: heading[1], token: "source" },
      { text: heading[2], token: "source-heading" },
    ]);
  }
  const parts: Part[] = [];
  let at = 0;
  let tag = false;
  while (at < line.length) {
    if (tag) {
      const stepped = withinTag(line, at, parts);
      at = stepped.at;
      tag = stepped.tag;
      continue;
    }
    const rest = line.slice(at);
    const opened = /^<\/?[A-Za-z_]/.test(rest);
    if (opened) {
      const delimiter = rest.startsWith("</") ? "</" : "<";
      parts.push({ text: delimiter, token: "xmd-delimiter" });
      at += delimiter.length;
      const name = NAME.exec(line.slice(at));
      if (name !== null) {
        parts.push({ text: name[0], token: "xmd-tag" });
        at += name[0].length;
      }
      tag = true;
      continue;
    }
    if (rest.startsWith("{")) {
      at = reference(line, at, parts);
      continue;
    }
    const next = nextOf(line, at + 1, ["<", "{"]);
    parts.push({ text: line.slice(at, next), token: "source" });
    at = next;
  }
  return tokenRuns(parts);
}

/** One step inside a tag: where the next one starts, and whether the tag is still open. */
function withinTag(line: string, at: number, parts: Part[]): { at: number; tag: boolean } {
  const rest = line.slice(at);
  if (rest.startsWith("/>")) {
    parts.push({ text: "/>", token: "xmd-delimiter" });
    return { at: at + 2, tag: false };
  }
  if (rest.startsWith(">")) {
    parts.push({ text: ">", token: "xmd-delimiter" });
    return { at: at + 1, tag: false };
  }
  if (rest.startsWith('"') || rest.startsWith("'")) {
    const quote = rest[0];
    let end = at + 1;
    while (end < line.length && line[end] !== quote) {
      end += 1;
    }
    // An unterminated quote ends with the line. A draft is edited one keystroke
    // at a time, and `as="ans` is a thing a person is in the middle of typing.
    const closed = end < line.length ? end + 1 : line.length;
    parts.push({ text: line.slice(at, closed), token: "xmd-value" });
    return { at: closed, tag: true };
  }
  if (rest.startsWith("{")) {
    return { at: reference(line, at, parts), tag: true };
  }
  if (rest.startsWith("=")) {
    parts.push({ text: "=", token: "punctuation" });
    return { at: at + 1, tag: true };
  }
  const name = NAME.exec(rest);
  if (name !== null) {
    parts.push({ text: name[0], token: "xmd-attribute" });
    return { at: at + name[0].length, tag: true };
  }
  parts.push({ text: line[at], token: "source" });
  return { at: at + 1, tag: true };
}

/**
 * One reference, from its opening brace to the brace that closes it.
 *
 * Every brace is a brace and everything between them is what the reference
 * names, at whatever depth: an expression's own braces are part of the
 * expression, and a classifier that tried to tell a reference's outermost pair
 * from the ones inside it would be parsing the expression language.
 */
function reference(line: string, at: number, parts: Part[]): number {
  let depth = 0;
  let end = at;
  while (end < line.length) {
    const character = line[end];
    if (character === "{") {
      depth += 1;
      parts.push({ text: "{", token: "reference-brace" });
      end += 1;
      continue;
    }
    if (character === "}") {
      depth -= 1;
      parts.push({ text: "}", token: "reference-brace" });
      end += 1;
      if (depth <= 0) {
        return end;
      }
      continue;
    }
    const next = Math.max(nextOf(line, end, ["{", "}"]), end + 1);
    parts.push({ text: line.slice(end, next), token: "reference-content" });
    end = next;
  }
  return end;
}

/** Where the first of these characters is from `from`, or the end of the line. */
function nextOf(line: string, from: number, characters: readonly string[]): number {
  let found = line.length;
  for (const character of characters) {
    const at = line.indexOf(character, from);
    if (at >= 0 && at < found) {
      found = at;
    }
  }
  return found;
}

const NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/;
const SPACING = /^[ \t]+/;

/**
 * One line of a JSON value, as the roles its characters carry.
 *
 * A key is a string with a colon after it, which is the only thing that tells
 * the two apart in a serialized object. Escapes are stepped over rather than
 * decoded: what this screen shows is the serialized text, and a backslash is
 * one of its characters.
 */
export function jsonRuns(line: string): readonly ReplTokenRun[] {
  const parts: Part[] = [];
  let at = 0;
  while (at < line.length) {
    const rest = line.slice(at);
    const spacing = SPACING.exec(rest);
    if (spacing !== null) {
      parts.push({ text: spacing[0], token: "source" });
      at += spacing[0].length;
      continue;
    }
    if (rest.startsWith('"')) {
      const end = endOfString(line, at);
      const quoted = line.slice(at, end);
      parts.push({
        text: quoted,
        token: /^\s*:/.test(line.slice(end)) ? "xmd-attribute" : "json-string",
      });
      at = end;
      continue;
    }
    if ("{}[],:".includes(rest[0])) {
      parts.push({ text: rest[0], token: "punctuation" });
      at += 1;
      continue;
    }
    if (rest.startsWith("true") || rest.startsWith("false")) {
      const literal = rest.startsWith("true") ? "true" : "false";
      parts.push({ text: literal, token: "reference-brace" });
      at += literal.length;
      continue;
    }
    if (rest.startsWith("null")) {
      parts.push({ text: "null", token: "json-null" });
      at += 4;
      continue;
    }
    const number = NUMBER.exec(rest);
    if (number !== null) {
      parts.push({ text: number[0], token: "json-number" });
      at += number[0].length;
      continue;
    }
    parts.push({ text: rest[0], token: "source" });
    at += 1;
  }
  return tokenRuns(parts);
}

/** Where one serialized string ends, its closing quote included. */
function endOfString(line: string, at: number): number {
  let end = at + 1;
  while (end < line.length) {
    if (line[end] === "\\") {
      end += 2;
      continue;
    }
    if (line[end] === '"') {
      return end + 1;
    }
    end += 1;
  }
  return line.length;
}
