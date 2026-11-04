import { createHash } from "node:crypto";
import { z } from "zod";
import type { Operation } from "effection";

export const props = {
  type: "object",
  properties: { inputs: { type: "array", items: { type: "object" } } },
  required: ["inputs"],
  additionalProperties: false,
};
export const returns = { type: "array" };

export default function* Fingerprint(input: unknown): Operation<unknown> {
  const { inputs } = z
    .object({ inputs: z.array(z.object({ path: z.string(), content: z.string() })) })
    .parse(input);
  return inputs.map(({ path, content }) => ({
    path,
    characters: content.length,
    bytes: new TextEncoder().encode(content).length,
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
  }));
}
