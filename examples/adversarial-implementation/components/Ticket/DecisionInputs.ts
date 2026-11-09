import { z } from "zod";
import { describe, descriptor, readBounded, same, snapshot, textLimit } from "./text-storage.ts";

export const props = {
  type: "object",
  properties: { descriptors: { type: "object" }, documents: { type: "object" } },
  required: ["descriptors", "documents"],
  additionalProperties: false,
};

// A first resolution observes each decision input once: a recorded reference keeps
// its retained text, and a new reference must match its origin's current bytes.
export default function* DecisionInputs(value: unknown) {
  const { descriptors, documents } = z
    .object({
      descriptors: z.record(z.string(), descriptor),
      documents: z.record(z.string(), snapshot),
    })
    .strict()
    .parse(value);
  for (const entry of Object.values(descriptors)) {
    const retained = documents[entry.path];
    const current = retained ?? describe(entry.path, yield* readBounded(entry.path, textLimit));
    if (!same(entry, current)) {
      throw new Error(
        (retained === undefined
          ? "Decision input differs from its descriptor: "
          : "A recorded reference keeps its first text; give changed text a fresh reference: ") +
          entry.path,
      );
    }
  }
  return Object.keys(descriptors);
}
