import { catalogSchema, outcomeSchema, reviewerSchema } from "../Delivery/records.ts";
import { isFableUsageLimit } from "../Delivery/ReviewState.ts";
import { z } from "zod";

export const props = {
  type: "object",
  properties: {
    solver: { type: "object" },
    catalog: { type: "object" },
    turn: { type: ["object", "null"] },
  },
  required: ["solver", "catalog", "turn"],
  additionalProperties: false,
};

export default function* CanReplace(input: unknown) {
  const { solver, catalog, turn } = z
    .strictObject({
      solver: reviewerSchema,
      catalog: catalogSchema,
      turn: outcomeSchema.shape.turn,
    })
    .parse(input);
  return (
    catalog.state !== "selected" ||
    (turn?.state === "failed" &&
      turn.terminal !== "cancelled" &&
      ((turn.stage === "session" && turn.configuration?.reason === "selector-unavailable") ||
        isFableUsageLimit({ reviewer: solver, catalog, turn }, catalog.choices)))
  );
}
