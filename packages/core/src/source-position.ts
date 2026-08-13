/**
 * Where an authored durable operation was written, as journal data.
 *
 * A durable effect's identity is its `type` and `name` and nothing else, so a
 * position cannot travel in either without changing what a replay matches. It
 * travels beside them instead, under one stable namespaced field, and the
 * complete description crosses the journal's security filter like every other
 * part of the event (spec §10.1).
 *
 * The value is the position the scanner produced for that element, carried from
 * the authoring boundary. Nothing reconstructs one from an expansion id, a
 * formatted `path:line:column` name or the current source: a name is a name, and
 * a document that has been edited since would answer a different question.
 */

import type { Json, SourcePosition } from "./types.ts";

/** The description field an authored position occupies. */
export const SOURCE_POSITION_FIELD = "executablemd.source-position";

/**
 * The description fields a position contributes, or none when it has none.
 *
 * Spread into an effect description. An element scanned from a dynamic string
 * carries no position, and an absent field is how history says so.
 */
export function sourceDescription(
  position: Readonly<SourcePosition> | undefined,
): Record<string, Json> {
  if (position === undefined) {
    return {};
  }
  return {
    [SOURCE_POSITION_FIELD]: {
      ...(position.path === undefined ? {} : { path: position.path }),
      offset: position.offset,
      line: position.line,
      column: position.column,
    },
  };
}
