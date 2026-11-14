import type { Operation } from "effection";
import { z } from "zod";
import { inspectionRecipe } from "../Phase/ProviderName.ts";
import { admit } from "./Admission.ts";

export const props = {
  type: "object",
  properties: {
    repository: { type: "string", minLength: 1 },
    model: { type: "string", minLength: 1 },
    effort: { type: "string", minLength: 1 },
  },
  required: ["repository", "model", "effort"],
  additionalProperties: false,
};

const input = z.strictObject({
  repository: z.string().min(1),
  model: z.string().min(1),
  effort: z.string().min(1),
});

export default function* CodexAdmission(value: unknown): Operation<boolean> {
  const { repository, model, effort } = input.parse(value);
  const recipe = inspectionRecipe("codex", model, effort);
  if (recipe === null) {
    throw new Error("The retained Codex admission requires its original inspection policy.");
  }
  return yield* admit(repository, recipe);
}
