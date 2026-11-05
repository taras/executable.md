import { Component } from "@executablemd/core/api";
import { z } from "zod";
import { clear, describe, textLimit, unused, write } from "./text-storage.ts";

export const props = {
  type: "object",
  properties: {
    repository: { type: "string" },
    directory: { type: "string" },
    path: { type: "string" },
    content: { type: "string" },
  },
  required: ["repository", "directory", "path"],
  additionalProperties: false,
};
const input = z
  .object({
    repository: z.string(),
    directory: z.string().startsWith("/"),
    path: z.string(),
    content: z.string().optional(),
  })
  .strict();

export default function* Snapshot(value: unknown) {
  const selected = input.parse(value);
  let text = selected.content;
  if (text === undefined) {
    const acquired = yield* Component.operations.tryContent();
    if (acquired.failure !== undefined) {
      throw acquired.failure;
    }
    text = acquired.text;
  }
  if (text.length > textLimit) {
    throw new Error("Ticket text capacity exceeded.");
  }
  const buffer = new Uint8Array(textLimit + 1);
  const encoded = new TextEncoder().encodeInto(text, buffer);
  if (encoded.read !== text.length || encoded.written > textLimit) {
    throw new Error("Ticket text capacity exceeded.");
  }
  if (
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      buffer.subarray(0, encoded.written),
    ) !== text
  ) {
    throw new Error("Ticket text is not valid UTF-8.");
  }
  const facts = describe(selected.path, text);
  if (facts.utf8Bytes > textLimit) {
    throw new Error("Ticket text capacity exceeded.");
  }
  const saved = {
    ...facts,
    observation: selected.content === undefined ? "file" : "supplied",
    snapshot:
      selected.directory + "/snapshots/" + describe(selected.path, selected.path).sha256 + ".txt",
  };
  yield* clear(JSON.stringify(saved));
  if (!(yield* unused(selected.repository, saved.snapshot))) {
    throw new Error(
      "Snapshot target already exists or is unavailable; preserve the original observation.",
    );
  }
  yield* write(selected.repository, saved.snapshot, text);
  return saved;
}
