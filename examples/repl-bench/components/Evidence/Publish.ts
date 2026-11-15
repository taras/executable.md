import type { Json, PropsSchema } from "@executablemd/core";
import { z } from "zod";
import { publishEvidence } from "../../lib/publication.ts";

export const props: PropsSchema = {
  type: "object",
  properties: {
    receipt: { type: "string", minLength: 1 },
    identity: { type: "string", pattern: "^[0-9a-f]{64}$" },
    receiptSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    number: { type: "integer", minimum: 1 },
  },
  required: ["receipt", "identity", "receiptSha256", "number"],
  additionalProperties: false,
};

export default function* Publish(input: Record<string, Json>) {
  return yield* publishEvidence(
    z.string().min(1).parse(input.receipt),
    z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .parse(input.identity),
    z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .parse(input.receiptSha256),
    z.number().int().positive().parse(input.number),
  );
}
