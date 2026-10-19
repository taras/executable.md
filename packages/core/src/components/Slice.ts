/**
 * `<Slice>` — show a window of completed rendered text
 * (specs/executable-mdx-spec.md §6.21).
 *
 * The content renders once, in full, and the window is taken from the string it
 * produced. Reaching the requested number of characters is not a reason to stop
 * the work behind them: this bounds what a reader is shown rather than what a
 * producer does, so a log the document asked for is still written whole and a
 * command it ran still finishes.
 *
 * Positions count Unicode code points rather than UTF-16 code units or bytes,
 * so an astral character is one position and a window can never land between
 * the two halves of one.
 *
 * A partial window carries a note saying which interval of which total it is,
 * because an excerpt that did not say so could not be told from the whole of a
 * shorter text — and an empty window could not be told from work that produced
 * nothing at all. The note is added after the selection and sits outside it, so
 * an outer `<Slice>` reads it as the ordinary text it is and may cut it.
 */

import type { Operation } from "effection";
import { content } from "../component-api.ts";
import type { Json } from "../types.ts";

export const props = {
  type: "object",
  properties: {
    offset: { type: "integer", default: 0 },
    length: { type: "integer", minimum: 1, default: 4096 },
  },
  additionalProperties: false,
};

/** What a partial window says about itself, in the document's own text. */
function note(start: number, end: number, total: number): string {
  return `Text excerpt: code points [${start}, ${end}) of ${total} (zero-based, end exclusive).`;
}

export default function* Slice(props: Record<string, Json>): Operation<string> {
  const offset = Number(props.offset);
  const length = Number(props.length);

  // Once, and completely. A negative offset is a position from the end, so the
  // total has to be known before any window can be resolved — and waiting for
  // the same completion when the offset is positive is what keeps one component
  // from answering two different questions depending on how it was written.
  const body = yield* content();

  const points = Array.from(body);
  const total = points.length;
  const from = offset < 0 ? total + offset : offset;
  const start = Math.min(Math.max(from, 0), total);
  const end = Math.min(total, start + length);

  // A window that omits nothing has nothing to report, so the body is handed
  // back exactly as it arrived rather than rebuilt out of its code points.
  if (start === 0 && end === total) {
    return body;
  }
  return `${note(start, end, total)}\n${points.slice(start, end).join("")}`;
}
