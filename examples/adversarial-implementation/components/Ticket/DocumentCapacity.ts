import { Component } from "@executablemd/core/api";
import { z } from "zod";
import { jsonBytes } from "./json-size.ts";
import { snapshot, stateLimit, textLimit } from "./text-storage.ts";
export const props = {
  type: "object",
  properties: { directory: { type: "string" } },
  required: ["directory"],
  additionalProperties: false,
};
export default function* DocumentCapacity(value: unknown) {
  const { directory } = z.object({ directory: z.string() }).strict().parse(value);
  const scope = yield* Component.operations.env;
  const documents = z.record(z.string(), snapshot).parse(scope?.values.documents);
  const references = z.array(z.string()).parse(scope?.values.references);
  let bytes = jsonBytes(documents, stateLimit);
  if (bytes === undefined) {
    return false;
  }
  const seen = new Set(Object.keys(documents));
  for (const path of references) {
    if (seen.has(path)) {
      continue;
    }
    const entry = {
      [path]: {
        path,
        snapshot: directory + "/snapshots/" + "0".repeat(64) + ".txt",
        observation: "file",
        utf8Bytes: textLimit,
        sha256: "0".repeat(64),
      },
    };
    const added = jsonBytes(entry, stateLimit);
    if (added === undefined) {
      return false;
    }
    bytes += added - 2 + (seen.size === 0 ? 0 : 1);
    if (bytes > stateLimit) {
      return false;
    }
    seen.add(path);
  }
  return true;
}
