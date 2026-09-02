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
 * So the record is kept beside the segments rather than on them, keyed by the
 * identity of the objects canonical expansion marked. A segment scanned from a
 * document, parsed from a journal, or built by a handler is simply not in it —
 * where a field could be supplied, membership cannot be.
 *
 * ## It is passed, never published
 *
 * The record belongs to one execution, which creates it and hands it down by
 * value on the private `ExpansionAuthority` canonical core already carries its
 * import authority on. It is deliberately not in a context: an Effection
 * context resolves by *name*, and a name is not a secret — anything that can
 * run code can build a context with the same one and reach whatever is stored
 * under it. A component doing that to this record could replace its `has` and
 * have its own prose published as source.
 *
 * There is no module-scoped table either, so nothing outlives the run that made
 * it, and no brand on the segments, because a property is exactly what an
 * untrusted object can carry.
 */

import type { Segment } from "../types.ts";

/** The segments one execution produced from exact-source components. */
export type ExactSource = WeakSet<Segment>;

/** A record for one execution, created where that execution begins. */
export function createExactSource(): ExactSource {
  return new WeakSet<Segment>();
}

/**
 * Record that canonical expansion produced these segments as source.
 *
 * An expansion with no record — anything running outside an execution that made
 * one — marks nothing, and nothing is published as source. That is the safe
 * answer rather than a lost one.
 */
export function markExactSource(
  exact: ExactSource | undefined,
  segments: readonly Segment[],
): void {
  if (exact === undefined) {
    return;
  }
  for (const segment of segments) {
    if (segment.type === "text") {
      exact.add(segment);
    }
  }
}

/** Whether this exact segment object is one canonical expansion marked. */
export function isExactSource(exact: ExactSource | undefined, segment: Segment): boolean {
  return exact !== undefined && exact.has(segment);
}
