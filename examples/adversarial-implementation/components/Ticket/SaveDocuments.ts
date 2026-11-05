import { z } from "zod";
import { describe, snapshot, stateLimit, write } from "./text-storage.ts";
import { jsonBytes } from "./json-size.ts";
export const props = {
  type: "object",
  properties: {
    repository: { type: "string" },
    path: { type: "string" },
    documents: { type: "object" },
  },
  required: ["repository", "path", "documents"],
  additionalProperties: false,
};
export default function* SaveDocuments(value: unknown) {
  const selected = z
    .object({ repository: z.string(), path: z.string(), documents: z.record(z.string(), snapshot) })
    .strict()
    .parse(value);
  if (jsonBytes(selected.documents, stateLimit) === undefined) {
    throw new Error("Captured document metadata capacity exceeded.");
  }
  const text = JSON.stringify(selected.documents);
  yield* write(selected.repository, selected.path, text);
  return describe(selected.path, text);
}
