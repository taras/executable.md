import { Component } from "@executablemd/core/api";
import { z } from "zod";
import { clear, describe, descriptor, read, same, unused, write } from "../Ticket/text-storage.ts";

export const props = {
  type: "object",
  properties: {
    repository: { type: "string" },
    directory: { type: "string" },
    mode: { enum: ["prepare", "check"], default: "prepare" },
  },
  required: ["repository", "directory"],
  additionalProperties: false,
};
const input = z
  .object({
    repository: z.string(),
    directory: z.string().startsWith("/"),
    mode: z.enum(["prepare", "check"]).default("prepare"),
  })
  .strict();
const limit = 256_000;

export default function* SubmissionGuide(value: unknown) {
  const { repository, directory, mode } = input.parse(value);
  const acquired = yield* Component.operations.tryContent();
  if (acquired.failure !== undefined) {
    throw acquired.failure;
  }
  const text = acquired.text;
  const expected = describe(directory + "/submission-guide.md", text);
  if (text.length > limit || expected.utf8Bytes > limit) {
    throw new Error("The submission guide exceeds 256000 characters or UTF-8 bytes.");
  }
  yield* clear(text);
  const receipt = directory + "/submission-guide.json";
  if (mode === "prepare") {
    if (!(yield* unused(repository, expected.path)) || !(yield* unused(repository, receipt))) {
      throw new Error("The submission guide is occupied or unavailable; preserve this attempt.");
    }
    yield* write(repository, expected.path, text);
    yield* write(repository, receipt, JSON.stringify(expected));
  }
  const recorded = descriptor.parse(JSON.parse(yield* read(repository, receipt, limit)));
  const retained = yield* read(repository, expected.path, limit);
  if (!same(expected, recorded) || !same(expected, describe(expected.path, retained))) {
    throw new Error(
      "The frozen submission guide changed; preserve the raw reply. No successor is admitted.",
    );
  }
  return expected;
}
