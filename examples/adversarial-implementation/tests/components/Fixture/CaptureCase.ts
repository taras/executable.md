import { Component } from "@executablemd/core/api";
import { env } from "@executablemd/runtime";
import { z } from "zod";
import { captureCase, ownCapture } from "./capture-state.ts";

export const props = {
  type: "object",
  properties: { scenario: { type: "string" }, fixture: { type: "object" } },
  required: ["scenario", "fixture"],
  additionalProperties: false,
};
export default function* CaptureCase(value: unknown) {
  const { scenario, fixture } = z
    .object({
      scenario: z.string(),
      fixture: z.object({
        root: z.string(),
        repository: z.string(),
        directory: z.string(),
      }),
    })
    .parse(value);
  const destination = yield* env("XMD_TEST_ARTIFACTS");
  if (!destination) {
    throw new Error("Fallback capture requires inherited XMD_TEST_ARTIFACTS");
  }
  const capture = yield* ownCapture(destination, scenario, {
    root: fixture.root,
    repository: fixture.repository,
    delivery: fixture.directory + "/delivery",
  });
  yield* captureCase.set(capture);
  try {
    const content = yield* Component.operations.content();
    yield* capture.write({ schema: "fallback-case-completed.v1" });
    if (capture.failure() !== undefined) {
      throw new Error("Fallback diagnostic capture failed: " + capture.failure());
    }
    return content;
  } catch (error) {
    yield* capture.write({ schema: "fallback-case-failed.v1", error: String(error) });
    throw error;
  }
}
