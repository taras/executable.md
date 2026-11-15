import type { Json, PropsSchema } from "@executablemd/core";
import { z } from "zod";
import { preparePublication } from "../../lib/publication.ts";

export const props: PropsSchema = {
  type: "object",
  properties: {
    receipt: { type: "string", minLength: 1 },
    mode: { enum: ["dry-run", "publish"] },
  },
  required: ["receipt", "mode"],
  additionalProperties: false,
};

export default function* Prepare(input: Record<string, Json>) {
  const mode = z.enum(["dry-run", "publish"]).parse(input.mode);
  return yield* preparePublication(z.string().min(1).parse(input.receipt), mode);
}
