import { Component } from "@executablemd/core/api";
import { z } from "zod";
import { clear, describe, snapshot } from "./text-storage.ts";

export const props = {
  type: "object",
  properties: { repository: { type: "string" }, document: { type: "object" } },
  required: ["repository", "document"],
  additionalProperties: false,
};
const input = z.object({ repository: z.string(), document: snapshot }).strict();

export default function* CheckText(value: unknown) {
  const { document } = input.parse(value);
  const acquired = yield* Component.operations.tryContent();
  if (acquired.failure !== undefined) {
    throw acquired.failure;
  }
  const content = acquired.text;
  yield* clear(content);
  const actual = describe(document.path, content);
  if (actual.utf8Bytes !== document.utf8Bytes || actual.sha256 !== document.sha256) {
    throw new Error(
      "Retained ticket text changed. Preserve its evidence; original-file fallback is refused.",
    );
  }
  return { path: document.path, content };
}
