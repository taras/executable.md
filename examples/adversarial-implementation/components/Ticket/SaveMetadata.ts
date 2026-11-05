import { Component } from "@executablemd/core/api";
import { z } from "zod";
import { jsonBytes } from "./json-size.ts";
import { describe, stateLimit, write } from "./text-storage.ts";

export const props = {
  type: "object",
  properties: {
    name: { type: "string" },
    repository: { type: "string" },
    path: { type: "string" },
  },
  required: ["name", "repository", "path"],
  additionalProperties: false,
};
export default function* SaveMetadata(value: unknown) {
  const selected = z
    .object({ name: z.string(), repository: z.string(), path: z.string() })
    .strict()
    .parse(value);
  const scope = yield* Component.operations.env;
  const metadata = scope?.values[selected.name];
  if (jsonBytes(metadata, stateLimit) === undefined) {
    throw new Error(
      "Ticket receipt metadata exceeds capacity; preserve the original role receipts.",
    );
  }
  const text = JSON.stringify(metadata);
  yield* write(selected.repository, selected.path, text);
  return describe(selected.path, text);
}
