import { z } from "zod";
import { classify } from "./admission.ts";

export const props = {
  type: "object",
  properties: { directory: { type: "string" }, present: { type: "boolean" } },
  required: ["directory", "present"],
  additionalProperties: false,
};

export default function* AmendmentState(value: unknown) {
  const { directory, present } = z
    .object({ directory: z.string().startsWith("/"), present: z.boolean() })
    .strict()
    .parse(value);
  return yield* classify(directory, present);
}
