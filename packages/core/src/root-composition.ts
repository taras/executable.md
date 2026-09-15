/**
 * How one root document becomes the body an execution runs (spec §5.4).
 *
 * The root is read, parsed and projected to its target exactly as it always
 * was. What this module adds is the one place that asks the {@link Document}
 * and {@link RootMetadata} APIs what the run should use instead, so execution,
 * `inspectDocument` and document validation compose a root the same way rather
 * than three times.
 *
 * ## The envelope, and the placeholder inside it
 *
 * `Document`'s terminal answers with `"<Document />"`. A Plugin's middleware
 * wraps that text, so what comes back is an *envelope*: trusted Markdown with
 * the placeholder wherever the original document belongs. The envelope is
 * scanned once, and each placeholder is replaced by the root's already-parsed
 * segments — the same objects, with the offsets, lines and paths they were
 * authored at, so an element's source position and its expansion identity are
 * what they would have been with no Plugin at all.
 *
 * Splicing rather than nesting is what keeps the rest of the root's contract
 * intact. A placeholder written at the envelope's top level leaves the root's
 * own `<Output>` a direct top-level child and its `<Return>` in the value
 * body's flow, which a wrapper element would not.
 *
 * A middleware may call `next()` more than once, and nothing here caches or
 * counts: two placeholders splice the root's segments twice. They are the same
 * segments at the same authored positions, so an element that names durable
 * work after its own expansion is written twice under one identity — which the
 * identity boundary refuses, loudly, rather than this module pre-empting a
 * composition a Plugin may have good reason to write.
 *
 * ## An authored `<Document />` is an ordinary element
 *
 * Only the envelope is scanned here. The root's segments are spliced in as
 * parsed values and are never walked for placeholders, so a document that
 * writes `<Document />` resolves that name the way it resolves any other and
 * cannot reach this projection.
 */

import { scoped } from "effection";
import type { Operation } from "effection";

import { DOCUMENT_PLACEHOLDER, RootMetadata, document, rootMetadata } from "./plugin-apis.ts";
import { scanSegments } from "./scanner.ts";
import type { ComponentDefinition, Segment } from "./types.ts";

/** The name the placeholder is written as, and the element it is scanned into. */
const PLACEHOLDER = "Document";

/**
 * The identity the envelope's own elements report.
 *
 * Deliberate and fixed, the way `<eval>` is for an inline root: the wrapper came
 * from a Plugin rather than from a file, and a source position reading
 * `(<document>:2:1)` says so.
 */
export const ENVELOPE_PATH = "<document>";

/** The root's metadata, composed, detached and frozen. */
function* composedMetadata(
  meta: Record<string, unknown>,
): Operation<Readonly<Record<string, unknown>>> {
  return yield* scoped(function* () {
    // The execution's own answer, installed nearest so a Plugin's ordinary
    // middleware wraps it and reads the root's real metadata through `next()`.
    yield* RootMetadata.around({ metadata: () => ({ ...meta }) }, { at: "min" });
    return yield* rootMetadata;
  });
}

/** Replace every placeholder in the envelope with the root's own segments. */
function splice(segments: Segment[], body: Segment[]): Segment[] {
  const composed: Segment[] = [];
  for (const segment of segments) {
    if (segment.type !== "component") {
      composed.push(segment);
      continue;
    }
    if (segment.name === PLACEHOLDER) {
      composed.push(...body);
      continue;
    }
    if (segment.children.length === 0) {
      composed.push(segment);
      continue;
    }
    composed.push({ ...segment, children: splice(segment.children, body) });
  }
  return composed;
}

/**
 * The definition an execution, an inspection or a validation runs against.
 *
 * With no Plugin middleware the envelope is exactly the placeholder, and the
 * definition comes back with the body it was parsed with — the same array, so
 * there is nothing for a no-Plugin run to observe.
 */
export function* composeRootDefinition(
  definition: ComponentDefinition,
): Operation<ComponentDefinition> {
  const meta = yield* composedMetadata(definition.meta);
  const envelope = yield* document;
  if (envelope === DOCUMENT_PLACEHOLDER) {
    return { ...definition, meta };
  }
  return {
    ...definition,
    meta,
    bodySegments: splice(
      scanSegments(envelope, { path: ENVELOPE_PATH, baseOffset: 0, baseLine: 1 }),
      definition.bodySegments,
    ),
  };
}
