import { Qualification } from "../state.ts";
import type { Json, PropsSchema } from "@executablemd/core";
export const props: PropsSchema = {
  type: "object",
  properties: { stage: { enum: ["seed", "recall"] } },
  required: ["stage"],
  additionalProperties: false,
};
export default function* Marker(input: Record<string, Json>) {
  const state = yield* Qualification.expect();
  state.turn = { accepted: false, completed: false };
  return input.stage === "seed"
    ? `Remember this private marker for this conversation: ${state.marker}. Reply only READY. Use no tools.`
    : "Return the private marker from this conversation, or UNKNOWN if none was supplied. Return only that value. Use no tools.";
}
