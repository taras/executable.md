import { z } from "zod";
import { inspectionRecipe } from "./ProviderName.ts";

export const props = {
  type: "object",
  properties: { profile: { type: "object" } },
  required: ["profile"],
  additionalProperties: false,
};

const input = z.strictObject({
  profile: z.strictObject({ provider: z.string(), model: z.string(), effort: z.string() }),
});

// deno-lint-ignore require-yield
export default function* InspectionRecipe(value: unknown) {
  const { profile } = input.parse(value);
  return inspectionRecipe(profile.provider, profile.model, profile.effort);
}
