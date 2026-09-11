/**
 * The ordinary Markdown a presentation rendered, projected into `@bomb.sh/tty`
 * operations.
 *
 * The projection is deliberately narrow. It understands paragraphs, inline
 * emphasis and fenced code and refuses everything else, because a projector
 * that quietly degraded an unsupported token into plain text would let a
 * uniform-plain-text rendering pass the structured-content oracle. The three
 * shapes it does understand become three independently recognizable things in
 * the operation tree — a paragraph container, an emphasis attribute on a text
 * operation, and a code container holding one code text operation — so no
 * single mistake can satisfy all three at once.
 *
 * Nothing here formats for a terminal. The Markdown arrives exactly as the
 * document emitted it, and `@bomb.sh/tty` alone decides what bytes a frame
 * becomes.
 */

import { marked } from "marked";
import { close, open, text } from "@bomb.sh/tty";
import type { Op } from "@bomb.sh/tty";

/**
 * The italic attribute bit, which `@bomb.sh/tty` 0.9.0 emits as `SGR 3`.
 *
 * Named for the Markdown it carries rather than for the escape it produces:
 * what this proof asserts is that emphasis survived as an attribute, and the
 * byte sequence behind it belongs to tty.
 */
export const EMPHASIS_ATTRIBUTE = 4;

/** An inline run of one paragraph: its text, and whether Markdown emphasized it. */
export interface InlineRun {
  readonly content: string;
  readonly emphasis: boolean;
}

export type Block =
  | { readonly kind: "paragraph"; readonly runs: readonly InlineRun[] }
  | { readonly kind: "code"; readonly language: string; readonly content: string };

/** A token this projector does not understand, named where it was found. */
export class UnsupportedMarkdownError extends Error {
  readonly token: string;

  constructor(token: string) {
    super(`the proof projector does not render Markdown token "${token}"`);
    this.name = "UnsupportedMarkdownError";
    this.token = token;
  }
}

function tokenType(token: unknown): string {
  if (typeof token !== "object" || token === null || !("type" in token)) {
    return "unknown";
  }
  const type = token.type;
  return typeof type === "string" ? type : "unknown";
}

function tokenText(token: unknown): string {
  if (typeof token === "object" && token !== null && "text" in token) {
    const value = token.text;
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

function tokenLanguage(token: unknown): string {
  if (typeof token === "object" && token !== null && "lang" in token) {
    const value = token.lang;
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

function childTokens(token: unknown): unknown[] {
  if (typeof token === "object" && token !== null && "tokens" in token) {
    const value = token.tokens;
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function inlineRuns(tokens: readonly unknown[]): InlineRun[] {
  const runs: InlineRun[] = [];
  for (const token of tokens) {
    const type = tokenType(token);
    if (type === "text") {
      runs.push({ content: tokenText(token), emphasis: false });
      continue;
    }
    if (type === "em") {
      // Emphasis nests its own text token; the proof payloads never nest
      // further, and anything that did would arrive here as an unsupported
      // token rather than as silently flattened prose.
      for (const child of childTokens(token)) {
        if (tokenType(child) !== "text") {
          throw new UnsupportedMarkdownError(tokenType(child));
        }
        runs.push({ content: tokenText(child), emphasis: true });
      }
      continue;
    }
    throw new UnsupportedMarkdownError(type);
  }
  return runs;
}

/**
 * The blocks one presentation's Markdown contains.
 *
 * Blank space between blocks is Markdown's own separator rather than content,
 * so it is dropped; every other token this does not understand stops the
 * projection.
 */
export function lexProofMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  for (const token of marked.lexer(source)) {
    const type = tokenType(token);
    if (type === "space") {
      continue;
    }
    if (type === "paragraph") {
      blocks.push({ kind: "paragraph", runs: inlineRuns(childTokens(token)) });
      continue;
    }
    if (type === "code") {
      blocks.push({ kind: "code", language: tokenLanguage(token), content: tokenText(token) });
      continue;
    }
    throw new UnsupportedMarkdownError(type);
  }
  return blocks;
}

/** The container id of one entry, which every frame reuses for that entry. */
export function entryContainerId(entryId: string): string {
  return `entry/${entryId}`;
}

/**
 * The operations one entry contributes to a frame.
 *
 * Container ids are derived from the entry's own stable id, so the same entry
 * occupies the same container across every frame it appears in and a
 * replacement cannot arrive as a new element.
 */
export function entryOperations(entryId: string, blocks: readonly Block[]): Op[] {
  const container = entryContainerId(entryId);
  const ops: Op[] = [open(container, { layout: { direction: "ttb" } })];
  blocks.forEach((block, index) => {
    if (block.kind === "paragraph") {
      ops.push(open(`${container}/paragraph/${index}`, { layout: { direction: "ltr" } }));
      for (const run of block.runs) {
        ops.push(text(run.content, run.emphasis ? { attrs: EMPHASIS_ATTRIBUTE } : {}));
      }
      ops.push(close());
      return;
    }
    ops.push(open(`${container}/code/${index}`, { layout: { direction: "ttb" } }));
    ops.push(text(block.content));
    ops.push(close());
  });
  ops.push(close());
  return ops;
}

/** How many terminal rows an entry's blocks occupy. */
export function blockRows(blocks: readonly Block[]): number {
  return blocks.reduce(
    (rows, block) => rows + (block.kind === "paragraph" ? 1 : block.content.split("\n").length),
    0,
  );
}

/** What a container id says the element is. */
export type OperationRole = "viewport" | "entry" | "paragraph" | "code";

export type OperationDescription =
  | { readonly kind: "open"; readonly id: string; readonly role: OperationRole }
  | { readonly kind: "text"; readonly content: string; readonly attrs: number }
  | { readonly kind: "close" };

function roleOf(id: string): OperationRole {
  const segments = id.split("/");
  if (segments.length >= 4 && segments[2] === "paragraph") {
    return "paragraph";
  }
  if (segments.length >= 4 && segments[2] === "code") {
    return "code";
  }
  if (segments[0] === "entry") {
    return "entry";
  }
  return "viewport";
}

/**
 * The evidence form of an operation tree, read back off the operations
 * themselves rather than recorded alongside them.
 *
 * Describing the real `Op` objects is what makes this evidence: a description
 * assembled in parallel with the tree could agree with an intention the tree
 * never carried.
 */
export function describeOperations(ops: readonly Op[]): OperationDescription[] {
  return ops.map((op) => {
    if ("id" in op) {
      return { kind: "open", id: op.id, role: roleOf(op.id) };
    }
    if ("content" in op) {
      return { kind: "text", content: op.content, attrs: op.attrs ?? 0 };
    }
    return { kind: "close" };
  });
}

/** The descriptions belonging to one entry's container, including its own open/close. */
export function entrySlice(
  descriptions: readonly OperationDescription[],
  entryId: string,
): OperationDescription[] {
  const container = entryContainerId(entryId);
  const start = descriptions.findIndex(
    (description) => description.kind === "open" && description.id === container,
  );
  if (start === -1) {
    return [];
  }
  let depth = 0;
  for (let index = start; index < descriptions.length; index++) {
    const description = descriptions[index];
    if (description.kind === "open") {
      depth++;
    }
    if (description.kind === "close") {
      depth--;
      if (depth === 0) {
        return descriptions.slice(start, index + 1);
      }
    }
  }
  return descriptions.slice(start);
}
