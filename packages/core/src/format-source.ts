import { Err, Ok, type Result } from "effection";
import { indentationEdits } from "./markdown.ts";
import type { SourceRange } from "./document-targets.ts";
import { scanSegments } from "./scanner.ts";
import type { ScanDiagnostic, SourceElement, SourceFence, UnfinishedConstruct } from "./scanner.ts";
import { envelopeBody } from "./source-inspection.ts";
import type { Segment } from "./types.ts";

function startOfLine(text: string, offset: number): number {
  return offset === 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1;
}

function applyEdits(text: string, edits: Uint32Array): string {
  const parts: string[] = [];
  let cursor = 0;
  for (let at = 0; at < edits.length; at += 3) {
    const start = edits[at]!;
    parts.push(text.slice(cursor, start), " ".repeat(edits[at + 2]!));
    cursor = start + edits[at + 1]!;
  }
  return parts.join("") + text.slice(cursor);
}

function scan(text: string, envelope: string) {
  const elements: SourceElement[] = [];
  const blocks: SourceRange[] = [];
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
    blocks,
  );
  const openExecutableFences = new Set(
    fences
      .filter(({ executable, end }) => executable && end === "unfinished")
      .map(({ marker }) => startOfLine(text, marker)),
  );
  return {
    headers: elements.map(({ opening }) => opening),
    blocks,
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

  const edits = indentationEdits(text, before.blocks, before.headers);
  if (edits.length === 0) {
    return Ok(source);
  }
  const formatted = applyEdits(text, edits);
  const after = scan(formatted, envelope);
  if (
    after.diagnostic !== undefined ||
    after.incomplete !== undefined ||
    JSON.stringify(withoutPositions(before.segments)) !==
      JSON.stringify(withoutPositions(after.segments)) ||
    indentationEdits(formatted, after.blocks, after.headers).length !== 0
  ) {
    return Ok(source);
  }
  return Ok(envelope + formatted);
}
