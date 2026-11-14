import { catalogSchema, outcomeSchema, reviewerSchema } from "../Delivery/records.ts";
import { isUsageLimit } from "../Delivery/usage-limit.ts";
import { z } from "zod";

export const props = {
  type: "object",
  properties: {
    solver: { type: "object" },
    catalog: { type: "object" },
    turn: { type: ["object", "null"] },
    quotaNotice: { type: "string" },
  },
  required: ["solver", "catalog", "turn"],
  additionalProperties: false,
};

export default function* CanReplace(input: unknown) {
  const { solver, catalog, turn, quotaNotice } = z
    .strictObject({
      solver: reviewerSchema,
      catalog: catalogSchema,
      turn: outcomeSchema.shape.turn,
      quotaNotice: z.string().min(1).optional(),
    })
    .parse(input);
  return (
    catalog.state !== "selected" ||
    (turn?.state === "failed" &&
      turn.terminal !== "cancelled" &&
      ((turn.stage === "session" && turn.configuration?.reason === "selector-unavailable") ||
        isUsageLimit(solver.provider, turn, quotaNotice)))
  );
}
