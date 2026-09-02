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
 * identity of the objects canonical expansion marked, and written only where
 * that expansion has already decided the provenance. A segment scanned from a
 * document, parsed from a journal, or built by a handler is simply not in it —
 * where a field could be supplied, membership cannot be.
 *
 * It belongs to the run that made it. The table is created inside the execution
 * that owns it and handed down through context, so what one document decided is
 * reclaimed with it and answers nothing during the next.
 */

import { createContext } from "effection";
import type { Context, Operation } from "effection";

import type { Segment } from "../types.ts";

/** The segments one execution produced from exact-source components. */
export type ExactSource = WeakSet<Segment>;

/**
 * Where this execution keeps that record.
 *
 * Module-private: it is exported for the two core modules that produce and
 * consume the mark, and reaches neither public package entrypoint, so nothing a
 * document or a package can load is able to read or replace it.
 */
export const ExactSource: Context<ExactSource | undefined> = createContext<ExactSource | undefined>(
  "xmd.exact-source",
  undefined,
);

/** Install this execution's own record, and hand it back. */
export function* useExactSource(): Operation<ExactSource> {
  const exact: ExactSource = new WeakSet();
  yield* ExactSource.set(exact);
  return exact;
}

/**
 * Record that canonical expansion produced these segments as source.
 *
 * With no run installed there is nothing to record into, and nothing is
 * published as source — which is the safe answer rather than a lost one.
 */
export function* markExactSource(segments: readonly Segment[]): Operation<void> {
  const exact = yield* ExactSource.get();
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
