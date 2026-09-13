/**
 * Segment rendering — converts expanded segments to output string (spec §9).
 *
 * What a rendered segment *is* — a program's approved source, or prose — is
 * decided here too, because two places now ask: the root, which hands the
 * Output Api one segment at a time, and a structural region, whose chunks cross
 * to the installation that declared it. One predicate and one grouping rule, so
 * the two cannot come to disagree about the same segment.
 */

import type { ExactSource } from "./output/exact-source.ts";
import type { Segment } from "./types.ts";

/**
 * Render an array of expanded segments into a markdown string.
 */
export function renderSegments(segments: Segment[]): string {
  return segments.map(renderSegment).join("");
}

/**
 * Render a single segment to its string representation.
 */
export function renderSegment(segment: Segment): string {
  switch (segment.type) {
    case "text":
      return segment.content;

    case "execOutput":
      return segment.result.stdout;

    case "error":
      return `<!-- ERROR: ${segment.message} -->`;

    case "component":
      // Unexpanded component (shouldn't appear after expansion)
      return `<!-- UNEXPANDED: <${segment.name} /> -->`;

    case "codeBlock":
      // Shouldn't appear after expansion (all executable blocks are processed)
      return `\`\`\`${segment.language}\n${segment.content}\n\`\`\``;

    default:
      return "";
  }
}

/**
 * Whether one expanded segment carries exact bytes rather than prose.
 *
 * Answered from the execution's own record and from nothing else: a field
 * planted on a segment is data that reached the engine from somewhere, and this
 * is a fact about what this execution produced.
 */
export function exactly(exact: ExactSource | undefined, segment: Segment): boolean {
  return exact !== undefined && exact.has(segment);
}

/** One rendered run of segments, and what it is. */
export interface Emission {
  readonly text: string;
  readonly exact: boolean;
}

/**
 * What a buffered region emits: consecutive segments of one exactness, joined.
 *
 * Buffering is what makes this necessary. A streaming root hands the Output Api
 * one segment at a time and each write says what it is; a region that rendered
 * as a whole would otherwise join a program's approved source to the prose
 * beside it and present the pair as one thing. Segments of the same kind still
 * travel together, so a region holding no exact bytes emits exactly once, as it
 * always has.
 */
export function emissions(
  record: ExactSource | undefined,
  segments: readonly Segment[],
): Emission[] {
  const runs: Emission[] = [];
  for (const segment of segments) {
    const text = renderSegment(segment);
    if (!text) {
      continue;
    }
    const exact = exactly(record, segment);
    const last = runs[runs.length - 1];
    if (last !== undefined && last.exact === exact) {
      runs[runs.length - 1] = { text: last.text + text, exact };
      continue;
    }
    runs.push({ text, exact });
  }
  return runs;
}
