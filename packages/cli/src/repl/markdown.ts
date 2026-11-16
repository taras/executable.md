/**
 * Markdown somebody wrote, as the logical lines and styled runs this screen
 * draws it with.
 *
 * Shared by the two readings that show written prose: a Sidekick conversation
 * body and an entry's rendered Output. Display only. The string passed in is
 * the one every journal, save and raw read keeps; nothing here reaches back
 * into it.
 *
 * The Lezer Markdown grammar, with GFM tables, task lists and autolinks, reads
 * the body into a syntax tree whose every node is a span of the body. A line is
 * drawn from those spans: delimiters are left out, headings, emphasis, list
 * markers, link labels and code become styled runs, and everything else is the
 * text as written. So no character appears that the body did not hold, and a
 * delimiter that never closed, raw HTML, a component-like tag, an image or a
 * table is drawn as the text it is. A link shows its label; its target is never
 * drawn, opened or written to the terminal as anything. A reference link is a
 * link only where the body defines its label.
 *
 * Fenced code keeps every payload line as written, indentation and blank lines
 * included. Controls are made inert before the grammar reads the text, so a
 * carriage return cannot become a line break. Line breaks are the body's own:
 * one written line is one logical line, and wrapping stays with the measured
 * fitting every reading already uses.
 *
 * The grammar does work proportional to the body. A reading that prepares the
 * same body every frame holds its lines in a {@link ReplMarkdownStore} instead.
 */

import { Autolink, parser, Table, TaskList } from "@lezer/markdown";
import { inertCommandText } from "./command-output.ts";
import { tokenRuns } from "./description.ts";
import type { ReplTokenRun } from "./description.ts";
import type { ReplPresentationRole } from "./presentation-style.ts";

/** One logical line of formatted text. The runs concatenate to exactly `text`. */
export interface ReplMarkdownLine {
  readonly text: string;
  readonly runs: readonly ReplTokenRun[];
}

/**
 * The formatted lines one preparation owner is holding on to.
 *
 * A frame formats the same bodies as the frame before it unless one of them
 * changed: a Draft keystroke changes none, and a streamed delta changes one.
 * This answers a body asked for before with the lines it was formatted into,
 * compared by exact text and role, and keeps only what the owner's latest
 * preparation asked for — so a body that changed, closed or went out of view is
 * dropped at the next {@link settle}, and nothing outlives the owner.
 */
export interface ReplMarkdownStore {
  /** This body's lines, formatted once while the owner keeps asking for it. */
  lines(source: string, role: ReplPresentationRole): readonly ReplMarkdownLine[];
  /** Keep only the bodies asked for since the last settle. */
  settle(): void;
}

export function createMarkdownStore(): ReplMarkdownStore {
  let held = new Map<string, readonly ReplMarkdownLine[]>();
  let asked = new Map<string, readonly ReplMarkdownLine[]>();
  return {
    lines(source, role) {
      const key = `${role}\u0000${source}`;
      const found = asked.get(key) ?? held.get(key) ?? markdownLines(source, role);
      asked.set(key, found);
      return found;
    },
    settle() {
      held = asked;
      asked = new Map();
    },
  };
}

/**
 * The lines one body is drawn as, with its ordinary text in `role`.
 *
 * Plain text comes back as one line per written line, each one run in `role`.
 */
export function markdownLines(
  source: string,
  role: ReplPresentationRole,
): readonly ReplMarkdownLine[] {
  const text = inertCommandText(source);
  const top = MARKDOWN.parse(text).topNode;
  const reading: Reading = { text, role, defined: definedLabels(text, top) };
  return Object.freeze(
    blockLines(reading, blocksOf(reading, childrenOf(top)), [], true, 0, text.length).map(
      (parts) => {
        const runs = tokenRuns(parts);
        return Object.freeze({ text: runs.map((run) => run.text).join(""), runs });
      },
    ),
  );
}

const MARKDOWN = parser.configure([Table, TaskList, Autolink]);

type SyntaxNode = ReturnType<typeof MARKDOWN.parse>["topNode"];

interface Reading {
  readonly text: string;
  readonly role: ReplPresentationRole;
  /** Every reference label the body defines, normalized. */
  readonly defined: ReadonlySet<string>;
}

interface Part {
  readonly text: string;
  readonly token: ReplPresentationRole;
}

type Line = Part[];

interface Span {
  readonly from: number;
  readonly to: number;
}

interface Style extends Span {
  readonly role: ReplPresentationRole;
  /** How deeply nested; the deepest style over a character decides it. */
  readonly depth: number;
}

type Block =
  | {
      readonly kind: "inline";
      readonly from: number;
      readonly to: number;
      /** Where its drawn text ends: a setext heading's underline is not drawn. */
      readonly until: number;
      readonly base: ReplPresentationRole;
      readonly styles: readonly Style[];
      readonly hidden: readonly Span[];
    }
  | { readonly kind: "code"; readonly from: number; readonly to: number; readonly fenced: boolean }
  | {
      readonly kind: "literal";
      readonly from: number;
      readonly to: number;
      readonly token: ReplPresentationRole;
    }
  | {
      readonly kind: "list";
      readonly from: number;
      readonly to: number;
      readonly items: readonly SyntaxNode[];
    }
  | {
      readonly kind: "quote";
      readonly from: number;
      readonly to: number;
      readonly children: readonly SyntaxNode[];
    };

/**
 * A container a line is written inside, and what it takes from the line's start.
 *
 * A quote takes its `>`. A list item's first line starts after its marker, and
 * each further line gives up as many leading spaces as that marker's column.
 */
type Container =
  | { readonly kind: "quote" }
  | {
      readonly kind: "item";
      readonly from: number;
      readonly content: number;
      readonly indent: number;
    };

function childrenOf(node: SyntaxNode): SyntaxNode[] {
  const children: SyntaxNode[] = [];
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    children.push(child);
  }
  return children;
}

function normalized(label: string): string {
  return label.slice(1, -1).trim().replace(/\s+/g, " ").toLowerCase();
}

function definedLabels(text: string, top: SyntaxNode): ReadonlySet<string> {
  const defined = new Set<string>();
  if (!text.includes("]:")) {
    return defined;
  }
  top.cursor().iterate((ref) => {
    if (ref.name === "LinkReference") {
      const label = ref.node.getChild("LinkLabel");
      if (label !== null) {
        defined.add(normalized(text.slice(label.from, label.to)));
      }
      return false;
    }
    return undefined;
  });
  return defined;
}

function blocksOf(reading: Reading, nodes: readonly SyntaxNode[]): Block[] {
  const blocks: Block[] = [];
  for (const node of nodes) {
    const { name, from, to } = node;
    if (name === "Paragraph" || name === "Task") {
      blocks.push(inline(reading, node, reading.role));
    } else if (/^(ATX|Setext)Heading\d$/.test(name)) {
      blocks.push(inline(reading, node, "source-heading"));
    } else if (name === "FencedCode" || name === "CodeBlock") {
      blocks.push({ kind: "code", from, to, fenced: name === "FencedCode" });
    } else if (name === "BulletList" || name === "OrderedList") {
      blocks.push({ kind: "list", from, to, items: node.getChildren("ListItem") });
    } else if (name === "Blockquote") {
      blocks.push({ kind: "quote", from, to, children: childrenOf(node) });
    } else if (name === "HorizontalRule") {
      blocks.push({ kind: "literal", from, to, token: "punctuation" });
    } else if (name !== "ListMark" && name !== "QuoteMark") {
      // HTML, a table, a reference definition: drawn as written.
      blocks.push({ kind: "literal", from, to, token: reading.role });
    }
  }
  return blocks;
}

/** A paragraph, heading or task: its span less the delimiters, styled. */
function inline(reading: Reading, node: SyntaxNode, base: ReplPresentationRole): Block {
  const { text } = reading;
  const hidden: Span[] = [];
  const styles: Style[] = [];
  const style = (span: Span, role: ReplPresentationRole, depth: number) => {
    styles.push({ from: span.from, to: span.to, role, depth });
  };
  const walk = (nodes: readonly SyntaxNode[], depth: number) => {
    for (const one of nodes) {
      switch (one.name) {
        case "HeaderMark":
          if (!node.name.startsWith("Setext")) {
            hidden.push(headerMark(reading.text, node, one));
          }
          break;
        case "Emphasis":
        case "StrongEmphasis":
          // Emphasis inside a heading is the heading.
          if (base !== "source-heading") {
            style(one, one.name === "Emphasis" ? "markdown-em" : "markdown-strong", depth + 1);
          }
          walk(childrenOf(one), depth + 1);
          break;
        case "Link":
          if (linked(reading, one)) {
            style(one, "markdown-link", depth + 1);
            hidden.push(...one.getChildren("URL"));
            walk(childrenOf(one), depth + 1);
          }
          break;
        case "Autolink":
          style(one, "markdown-link", depth + 1);
          hidden.push(...one.getChildren("LinkMark"));
          break;
        case "URL":
          // A bare address the GFM autolink grammar recognized.
          style(one, "markdown-link", depth + 1);
          break;
        case "InlineCode":
          hidden.push(...codeSpanDelimiters(text, one));
          style(one, "markdown-code", depth + 1);
          break;
        case "Escape":
          hidden.push({ from: one.from, to: one.from + 1 });
          break;
        case "TaskMarker":
          // The checkbox and the space after it, on its item's first line.
          style(
            { from: one.from, to: text[one.to] === " " ? one.to + 1 : one.to },
            "punctuation",
            depth + 1,
          );
          break;
        case "EmphasisMark":
        case "LinkMark":
        case "LinkLabel":
        case "LinkTitle":
          hidden.push(one);
          break;
        case "Image":
        case "HTMLTag":
        case "Entity":
        case "HardBreak":
        case "Comment":
        case "ProcessingInstruction":
          break;
        default:
          walk(childrenOf(one), depth);
      }
    }
  };
  walk(childrenOf(node), 0);
  // A setext heading ends where its underline line begins.
  const underline = node.name.startsWith("Setext") ? node.getChild("HeaderMark") : null;
  const until = underline === null ? node.to : lineStart(text, underline.from);
  return { kind: "inline", from: node.from, to: node.to, until, base, styles, hidden };
}

/**
 * Whether a link is drawn as one: an inline link with a label, or a reference
 * whose label this body defines. Anything else is the text it was written as.
 * Inside a drawn link, the target, its title and the reference label are
 * hidden with the brackets.
 */
function linked(reading: Reading, link: SyntaxNode): boolean {
  const marks = link.getChildren("LinkMark");
  const close = marks[1];
  if (close === undefined || close.from === link.from + 1) {
    return false;
  }
  if (link.getChild("URL") !== null) {
    return true;
  }
  const label = link.getChild("LinkLabel");
  const written =
    label === null || label.to - label.from === 2
      ? reading.text.slice(link.from, close.to)
      : reading.text.slice(label.from, label.to);
  return reading.defined.has(normalized(written));
}

/** What an ATX heading's `#` marks take, with the spacing between them and its text. */
function headerMark(text: string, heading: SyntaxNode, mark: SyntaxNode): Span {
  let from = mark.from;
  let to = mark.to;
  if (mark.from === heading.from) {
    while (text[to] === " " || text[to] === "\t") {
      to += 1;
    }
  } else {
    while (from > heading.from && (text[from - 1] === " " || text[from - 1] === "\t")) {
      from -= 1;
    }
  }
  return { from, to };
}

/** A code span's backticks, and the one space each side CommonMark strips. */
function codeSpanDelimiters(text: string, span: SyntaxNode): Span[] {
  const ticks = /^`+/.exec(text.slice(span.from, span.to))?.[0].length ?? 0;
  let inner = span.from + ticks;
  let end = span.to - ticks;
  const content = text.slice(inner, end);
  if (
    content.length > 2 &&
    content.startsWith(" ") &&
    content.endsWith(" ") &&
    content.trim() !== ""
  ) {
    inner += 1;
    end -= 1;
  }
  return [
    { from: span.from, to: inner },
    { from: end, to: span.to },
  ];
}

/**
 * Blocks as lines, with the lines written between them.
 *
 * The rows between two blocks are the lines the source wrote there: as written
 * at the outermost level, spaces included, and blank where a container's own
 * prefix is all a line holds. At the start and end of the outermost body every
 * one of those lines is a row, as splitting the text on its line breaks gives.
 * A nested body leaves its leading and trailing lines to its container.
 */
function blockLines(
  reading: Reading,
  blocks: readonly Block[],
  containers: readonly Container[],
  outermost: boolean,
  from: number,
  to: number,
): Line[] {
  const { text, role } = reading;
  const lines: Line[] = [];
  const between = (start: number, end: number, keep: "between" | "leading" | "trailing") => {
    const written = text.slice(start, end).split("\n");
    const first = keep === "leading" ? 0 : 1;
    const last = keep === "trailing" ? written.length : written.length - 1;
    let at = start;
    for (const [index, one] of written.entries()) {
      if (index >= first && index < last) {
        if (outermost) {
          lines.push(one.length === 0 ? [] : [{ text: one, token: role }]);
        } else {
          const rest = text.slice(contentStart(text, at, containers), at + one.length);
          lines.push(rest.trim() === "" ? [] : [{ text: rest, token: role }]);
        }
      }
      at += one.length + 1;
    }
  };
  let previous: number | undefined;
  for (const block of blocks) {
    const start = lineStart(text, block.from);
    if (previous !== undefined) {
      between(previous, start, "between");
    } else if (outermost) {
      between(from, start, "leading");
    }
    lines.push(...blockOf(reading, block, containers));
    previous = withoutTrailingBreaks(text, block.to);
  }
  if (outermost) {
    between(previous ?? from, to, previous === undefined ? "leading" : "trailing");
    if (previous === undefined) {
      // A body with no block at all: its last written line too.
      const written = text.slice(from, to).split("\n");
      const last = written[written.length - 1];
      lines.push(last.length === 0 ? [] : [{ text: last, token: role }]);
    }
  }
  return lines;
}

function blockOf(reading: Reading, block: Block, containers: readonly Container[]): Line[] {
  switch (block.kind) {
    case "inline":
      return inlineLines(reading, block, containers);
    case "code":
      return codeLines(reading.text, block, containers);
    case "literal":
      return writtenLines(reading.text, block, containers).map((one) => [
        { text: one, token: block.token },
      ]);
    case "quote":
      return blockLines(
        reading,
        blocksOf(reading, block.children),
        [...containers, { kind: "quote" }],
        false,
        block.from,
        block.to,
      ).map((one) => [{ text: "│ ", token: "punctuation" }, ...one]);
    case "list":
      return listLines(reading, block.items, containers);
  }
}

/** The text of each source line a block spans, inside its containers. */
function writtenLines(text: string, span: Span, containers: readonly Container[]): string[] {
  const end = withoutTrailingBreaks(text, span.to);
  const lines: string[] = [];
  for (let at = lineStart(text, span.from); ; ) {
    const next = text.indexOf("\n", at);
    const lineEnd = next < 0 || next > end ? end : next;
    lines.push(text.slice(contentStart(text, at, containers), lineEnd));
    if (next < 0 || next >= end) {
      return lines;
    }
    at = next + 1;
  }
}

/**
 * Fenced or indented code, from its source lines.
 *
 * The fences are punctuation and every line between them is code. A line closes
 * the fence only with the opener's character, at least as many of it and
 * nothing after them but spaces; an unterminated fence holds everything after
 * its opening line.
 */
function codeLines(
  text: string,
  block: { readonly from: number; readonly to: number; readonly fenced: boolean },
  containers: readonly Container[],
): Line[] {
  const written = writtenLines(text, block, containers);
  if (!block.fenced) {
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

/**
 * A list's items, each under its marker, with an item's further lines set in
 * under the marker's width. A bullet is drawn as `•`; an ordered item keeps the
 * number and delimiter it was written with.
 */
function listLines(
  reading: Reading,
  items: readonly SyntaxNode[],
  containers: readonly Container[],
): Line[] {
  const { text } = reading;
  const lines: Line[] = [];
  let previous: number | undefined;
  for (const item of items) {
    if (previous !== undefined) {
      const blank = text.slice(previous, lineStart(text, item.from)).split("\n").length - 2;
      for (let at = 0; at < blank; at += 1) {
        lines.push([]);
      }
    }
    const match = MARKER.exec(text.slice(item.from));
    const written = match?.[1] ?? "-";
    const marker = /^\d/.test(written) ? `${written} ` : "• ";
    const width = match?.[0].length ?? 2;
    const own: Container = {
      kind: "item",
      from: item.from,
      content: item.from + width,
      indent: item.from - contentStart(text, lineStart(text, item.from), containers) + width,
    };
    const body = blockLines(
      reading,
      blocksOf(reading, childrenOf(item)),
      [...containers, own],
      false,
      item.from,
      item.to,
    );
    for (const [offset, one] of (body.length === 0 ? [[]] : body).entries()) {
      if (offset > 0 && one.length === 0) {
        lines.push([]);
        continue;
      }
      lines.push([
        { text: offset === 0 ? marker : " ".repeat(marker.length), token: "punctuation" },
        ...one,
      ]);
    }
    previous = withoutTrailingBreaks(text, item.to);
  }
  return lines;
}

const MARKER = /^\s*(\d{1,9}[.)]|[-+*])( {1,4}(?! )| ?)/;

/** Where a source line's own text starts, once its containers' prefixes are taken. */
function contentStart(text: string, start: number, containers: readonly Container[]): number {
  const next = text.indexOf("\n", start);
  const lineEnd = next < 0 ? text.length : next;
  let at = start;
  for (const container of containers) {
    if (container.kind === "quote") {
      at += /^ {0,3}> ?/.exec(text.slice(at, lineEnd))?.[0].length ?? 0;
    } else if (container.from >= at && container.from <= lineEnd) {
      at = Math.min(container.content, lineEnd);
    } else {
      let spaces = 0;
      while (spaces < container.indent && text[at + spaces] === " ") {
        spaces += 1;
      }
      at += spaces;
    }
  }
  return Math.min(at, lineEnd);
}

/**
 * A paragraph, heading or task line by line: what the line holds after its
 * containers' prefixes, less the hidden delimiters, in the roles its styles
 * give it. The whitespace a line was written with at its start stays.
 */
function inlineLines(
  reading: Reading,
  block: Extract<Block, { kind: "inline" }>,
  containers: readonly Container[],
): Line[] {
  const { text } = reading;
  const begin = lineStart(text, block.from);
  const end = withoutTrailingBreaks(text, block.until);
  const hidden = new Uint8Array(end - begin);
  for (const one of block.hidden) {
    hidden.fill(1, Math.max(one.from, begin) - begin, Math.max(0, Math.min(one.to, end) - begin));
  }
  const depth = new Int16Array(end - begin).fill(-1);
  const roles = new Array<ReplPresentationRole>(end - begin).fill(block.base);
  for (const one of block.styles) {
    for (let at = Math.max(one.from, begin); at < Math.min(one.to, end); at += 1) {
      if (one.depth >= depth[at - begin]) {
        depth[at - begin] = one.depth;
        roles[at - begin] = one.role;
      }
    }
  }
  const lines: Line[] = [];
  for (let start = begin; start < end || lines.length === 0; ) {
    const next = text.indexOf("\n", start);
    const lineEnd = next < 0 || next > end ? end : next;
    const line: Line = [];
    let at = contentStart(text, start, containers);
    while (at < lineEnd && (text[at] === " " || text[at] === "\t")) {
      push(line, text[at], block.base);
      at += 1;
    }
    for (; at < lineEnd; at += 1) {
      if (hidden[at - begin] !== 1) {
        push(line, text[at], roles[at - begin]);
      }
    }
    lines.push(line);
    if (next < 0 || next >= end) {
      break;
    }
    start = next + 1;
  }
  return lines;
}

function push(line: Line, character: string, token: ReplPresentationRole): void {
  const last = line[line.length - 1];
  if (last !== undefined && last.token === token) {
    line[line.length - 1] = { text: last.text + character, token };
  } else {
    line.push({ text: character, token });
  }
}

function lineStart(text: string, at: number): number {
  return text.lastIndexOf("\n", at - 1) + 1;
}

function withoutTrailingBreaks(text: string, to: number): number {
  let end = to;
  while (end > 0 && text[end - 1] === "\n") {
    end -= 1;
  }
  return end;
}
