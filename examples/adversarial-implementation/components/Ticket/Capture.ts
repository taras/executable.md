import { Component } from "@executablemd/core/api";
import type { Operation } from "effection";

export const props = { type: "object", properties: {}, additionalProperties: false };

export default function* Capture(): Operation<{
  status: string;
  output: string;
  failure: string | null;
}> {
  const outcome = yield* Component.operations.tryContent();
  const error = outcome.failure;
  let failure =
    error === undefined
      ? null
      : error instanceof Error
        ? (error.stack ?? error.message)
        : String(error);
  let cause = error instanceof Error ? error.cause : undefined;
  const seen = new Set<unknown>();
  while (cause instanceof Error && !seen.has(cause)) {
    seen.add(cause);
    failure += "\nCaused by:\n" + (cause.stack ?? cause.message);
    cause = cause.cause;
  }
  return {
    status: outcome.failure === undefined ? "completed" : "failed",
    output: outcome.text,
    failure,
  };
}
