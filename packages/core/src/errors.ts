import type { ErrorSegment } from "./types.ts";

/**
 * Thrown by suppressed-documentation raise middleware (spec §6.9). Generic
 * catches in the engine rethrow it instead of converting it into an
 * ErrorSegment, so documentation fail-fast is never swallowed.
 */
export class DocumentationError extends Error {
  readonly segment: ErrorSegment;

  constructor(segment: ErrorSegment) {
    super(segment.message);
    this.name = "DocumentationError";
    this.segment = segment;
  }
}
