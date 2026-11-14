import { z } from "zod";
import { read } from "../Ticket/text-storage.ts";

export const props = {
  type: "object",
  properties: {
    repository: { type: "string" },
    paths: { type: "array", items: { type: "string" } },
    retained: { type: "array", items: { type: "object" } },
  },
  required: ["repository", "paths", "retained"],
  additionalProperties: false,
};

export default function* Inputs(input: unknown) {
  const { repository, paths, retained } = z
    .strictObject({
      repository: z.string(),
      paths: z.array(z.string()),
      retained: z.array(z.strictObject({ path: z.string(), content: z.string() })),
    })
    .parse(input);
  const captures = new Map(retained.map((entry) => [entry.path, entry]));
  for (const path of new Set(paths)) {
    if (!captures.has(path)) {
      captures.set(path, { path, content: yield* read(repository, path, 64_000) });
    }
  }
  return [...captures.values()];
}
