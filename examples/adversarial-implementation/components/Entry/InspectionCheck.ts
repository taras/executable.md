import { z } from "zod";
import { inspectionRecipeSchema } from "../Phase/ProviderName.ts";
import { props, checkInspection } from "./Admission.ts";

const input = z.strictObject({ repository: z.string().min(1), recipe: inspectionRecipeSchema });
export { props };

// deno-lint-ignore require-yield
export default function* InspectionCheck(value: unknown) {
  const { repository, recipe } = input.parse(value);
  return () => checkInspection(repository, recipe);
}
