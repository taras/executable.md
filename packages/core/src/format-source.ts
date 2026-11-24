import { Err, Ok, type Result } from "effection";
import { scanSegments } from "./scanner.ts";
import type { ScanDiagnostic, SourceElement, SourceFence, UnfinishedConstruct } from "./scanner.ts";
import { envelopeBody } from "./source-inspection.ts";
import type { Segment } from "./types.ts";

function afterLine(text: string, offset: number): number {
  const newline = text.indexOf("\n", offset);
  return newline === -1 ? text.length : newline + 1;
}

function startOfLine(text: string, offset: number): number {
  return offset === 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1;
}

function proposeIndentation(text: string, elements: SourceElement[]): string {
  const depthChanges = new Map<number, number>();
  const headerLines = new Set<number>();
  for (const { opening, closing } of elements) {
    const bodyStart = afterLine(text, opening.end);
    for (
      let line = afterLine(text, opening.start);
      line < opening.end;
      line = afterLine(text, line)
    ) {
      headerLines.add(line);
    }
    if (closing === undefined) {
      continue;
    }
    const beforeTag = text.slice(startOfLine(text, opening.start), opening.start);
    const afterTag = text.slice(opening.end, bodyStart);
    if (!/^[ \t]*$/.test(beforeTag) || !/^[ \t]*\n$/.test(afterTag)) {
      continue;
    }
    const closeLine = startOfLine(text, closing.start);
    const beforeClose = text.slice(closeLine, closing.start);
    const bodyEnd = /^[ \t]*$/.test(beforeClose) ? closeLine : afterLine(text, closing.end);
    if (bodyStart < bodyEnd) {
      depthChanges.set(bodyStart, (depthChanges.get(bodyStart) ?? 0) + 1);
      depthChanges.set(bodyEnd, (depthChanges.get(bodyEnd) ?? 0) - 1);
    }
  }
  let depth = 0;
  const lines = [];
  for (let start = 0; start < text.length; ) {
    depth += depthChanges.get(start) ?? 0;
    const end = afterLine(text, start);
    const line = text.slice(start, end);
    const prefix = "  ".repeat(depth);
    if (headerLines.has(start)) {
      lines.push(line);
    } else if (line === prefix + "\n" || line === prefix + "\r\n") {
      lines.push(line.slice(prefix.length));
    } else {
      lines.push(
        line.startsWith(prefix) || line === "\n" || line === "\r\n" ? line : prefix + line,
      );
    }
    start = end;
  }
  return lines.join("");
}

function scan(text: string, envelope: string) {
  const elements: SourceElement[] = [];
  const unfinished: UnfinishedConstruct[] = [];
  const diagnostics: ScanDiagnostic[] = [];
  const fences: SourceFence[] = [];
  const segments = scanSegments(
    text,
    {
      baseOffset: envelope.length,
      baseLine: envelope.split("\n").length,
      baseColumn: envelope.length - envelope.lastIndexOf("\n"),
    },
    undefined,
    elements,
    unfinished,
    0,
    0,
    diagnostics,
    fences,
  );
  const openExecutableFences = new Set(
    fences
      .filter(({ executable, end }) => executable && end === "unfinished")
      .map(({ marker }) => startOfLine(text, marker)),
  );
  return {
    elements,
    segments,
    diagnostic: diagnostics[0],
    incomplete: unfinished.find(
      ({ name, start }) => name !== undefined || openExecutableFences.has(startOfLine(text, start)),
    ),
  };
}

function withoutPositions(segments: Segment[]): unknown[] {
  return segments.map((segment) => {
    if (segment.type === "component") {
      const { position: _position, children, ...fields } = segment;
      return { ...fields, children: withoutPositions(children) };
    }
    if (segment.type === "codeBlock") {
      const { position: _position, ...fields } = segment;
      return fields;
    }
    return segment;
  });
}

/** Format a document using the same Markdown boundaries as execution. */
export function formatSource(source: string): Result<string> {
  const body = envelopeBody(source);
  const envelope = source.slice(0, body);
  const text = source.slice(body);
  const before = scan(text, envelope);
  if (before.diagnostic !== undefined) {
    return Err(new Error(before.diagnostic.message));
  }
  if (before.incomplete !== undefined) {
    const { name, start } = before.incomplete;
    const offset = body + start;
    const line = source.slice(0, offset).split("\n").length;
    const column = offset - source.lastIndexOf("\n", offset - 1);
    const construct = name === undefined ? "executable fence" : `XMD element <${name}>`;
    return Err(new Error(`Incomplete ${construct} at ${line}:${column}`));
  }

  const formatted = proposeIndentation(text, before.elements);
  if (formatted === text) {
    return Ok(source);
  }
  const after = scan(formatted, envelope);
  if (
    after.diagnostic !== undefined ||
    after.incomplete !== undefined ||
    JSON.stringify(withoutPositions(before.segments)) !==
      JSON.stringify(withoutPositions(after.segments)) ||
    proposeIndentation(formatted, after.elements) !== formatted
  ) {
    return Ok(source);
  }
  return Ok(envelope + formatted);
}
