import { canonicalize } from "@executablemd/core";
import { z } from "zod";

export const props = {
  type: "object",
  properties: { original: { type: "object" }, recorded: { type: "object" } },
  required: ["original", "recorded"],
  additionalProperties: false,
};
export const returns = { type: "boolean" };
export default function* RecoveryCorrespondence(value: unknown) {
  const input = z.strictObject({ original: z.json(), recorded: z.json() }).parse(value);
  return (
    JSON.stringify(canonicalize(input.original)) === JSON.stringify(canonicalize(input.recorded))
  );
}
