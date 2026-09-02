/**
 * Which rendered segments carry a program's source rather than prose.
 *
 * Exact presentation is a *provenance*, not a property. The question it answers
 * is "did canonical execution produce these bytes by expanding a declared
 * Markdown component the trusted host said renders source?" — and no object can
 * answer that about itself. A definition claiming the disposition, a segment
 * arriving already marked, a frontmatter key, a prop: each is data that reached
 * the engine from somewhere, and any of them would let ordinary
 * `Component.importComponent` middleware publish unpresented bytes by writing a
 * field.
 *
 * So the record lives here, keyed by the identity of the segment objects the
 * engine marked, and it is written only where canonical expansion has already
 * decided the provenance. It is deliberately not a field on `Segment`: a field
 * can be supplied, and this cannot — a segment scanned from a document, parsed
 * from a journal, or built by a handler is simply not in this set.
 */

import type { Segment } from "../types.ts";

/**
 * The segments this engine produced from exact-source components.
 *
 * Weak, so a segment is remembered exactly as long as something still holds it,
 * and identity-keyed, so two segments with identical content are two different
 * answers. Module-level because the producer and the emission loop are the same
 * loaded copy of core; nothing crosses a copy boundary, and nothing a document
 * or a package can reach ever writes to it.
 */
const EXACT = new WeakSet<Segment>();

/** Record that canonical expansion produced these segments as source. */
export function markExactSource(segments: readonly Segment[]): void {
  for (const segment of segments) {
    if (segment.type === "text") {
      EXACT.add(segment);
    }
  }
}

/** Whether this exact segment object is one canonical expansion marked. */
export function isExactSource(segment: Segment): boolean {
  return EXACT.has(segment);
}
