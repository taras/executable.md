/**
 * Segment rendering — converts expanded segments to output string (spec §9).
 */

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
