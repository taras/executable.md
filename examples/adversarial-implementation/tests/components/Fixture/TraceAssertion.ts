import { Component } from "@executablemd/core/api";
import { z } from "zod";
import { captureCase, sourcePath, sourceHash, tagged } from "./capture-state.ts";

export const props = {
  type: "object",
  properties: {
    line: { type: "integer" },
    element: { type: "string" },
    overlap: { type: "object" },
  },
  required: ["line", "element"],
  additionalProperties: false,
};
export default function* TraceAssertion(value: unknown) {
  const { line, element, overlap } = z
    .object({ line: z.number().int(), element: z.string(), overlap: z.unknown().optional() })
    .parse(value);
  const capture = yield* captureCase.expect();
  if (overlap !== undefined) {
    yield* capture.overlap(overlap);
  }
  let actual: unknown;
  let expected: unknown;
  let before = false;
  function record(phase: string) {
    return capture.write({
      schema: "fallback-assertion-trace.v1",
      phase,
      source: { path: sourcePath, sha256: sourceHash, line, element },
      actual: tagged(actual),
      expected: tagged(expected),
    });
  }
  yield* Component.around({
    *capture([name], next) {
      const operand = yield* next(name);
      if (name === "actual") {
        actual = operand;
      }
      if (name === "expected") {
        expected = operand;
        yield* record("before");
        before = true;
      }
      return operand;
    },
  });
  try {
    const text = yield* Component.operations.content();
    yield* record("passed");
    return text;
  } catch (error) {
    if (!before) {
      yield* record("before");
    }
    yield* record("failed");
    yield* capture.snapshot("assertion-failed");
    throw error;
  }
}
