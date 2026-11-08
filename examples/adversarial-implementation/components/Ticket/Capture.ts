import { Component } from "@executablemd/core/api";
import type { Operation } from "effection";

export const props = { type: "object", properties: {}, additionalProperties: false };

// A defined stack does not portably contain the message: Bun can report a
// subclass's stack without it, so the message is kept explicitly.
function formatError(error: Error): string {
  const stack = error.stack;
  if (stack === undefined || stack === "") {
    return error.message;
  }
  return stack.includes(error.message) ? stack : `${error.message}\n${stack}`;
}

export default function* Capture(): Operation<{
  status: string;
  output: string;
  failure: string | null;
}> {
  const outcome = yield* Component.operations.tryContent();
  const error = outcome.failure;
  let failure =
    error === undefined ? null : error instanceof Error ? formatError(error) : String(error);
  let cause = error instanceof Error ? error.cause : undefined;
  const seen = new Set<unknown>();
  while (cause instanceof Error && !seen.has(cause)) {
    seen.add(cause);
    failure += "\nCaused by:\n" + formatError(cause);
    cause = cause.cause;
  }
  return {
    status: outcome.failure === undefined ? "completed" : "failed",
    output: outcome.text,
    failure,
  };
}
