/**
 * Documentation failure marker (spec §6.9).
 *
 * Error policy is contextual middleware on `Component.operations.raise`:
 * suppressed documentation installs a throwing implementation, output
 * regions install a collecting one that shadows it. DocumentationError is
 * the internal throwable those middlewares use — generic error handling in
 * the engine rethrows it instead of converting it into an ErrorSegment, so
 * documentation fail-fast is never swallowed.
 */

import type { ErrorSegment } from "./types.ts";

export class DocumentationError extends Error {
  readonly segment: ErrorSegment;

  constructor(segment: ErrorSegment) {
    super(segment.message);
    this.name = "DocumentationError";
    this.segment = segment;
  }
}
