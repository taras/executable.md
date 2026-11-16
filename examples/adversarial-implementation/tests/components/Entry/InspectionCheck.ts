import { lift } from "effection";

export const props = {
  type: "object",
  properties: {
    repository: { type: "string", minLength: 1 },
    recipe: { type: "object" },
  },
  required: ["repository", "recipe"],
  additionalProperties: false,
};

// deno-lint-ignore require-yield
export default function* InspectionCheck() {
  return lift(() => true);
}
