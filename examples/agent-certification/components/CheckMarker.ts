import { Qualification } from "../state.ts";
import { recordMarker } from "../report.ts";
import { z } from "zod";
import type { Json, PropsSchema } from "@executablemd/core";
const inputSchema = z.strictObject({
  scenario: z.enum(["continuity", "separation"]),
  reply: z.string(),
});
export const props: PropsSchema = {
  type: "object",
  properties: { scenario: { enum: ["continuity", "separation"] }, reply: { type: "string" } },
  required: ["scenario", "reply"],
  additionalProperties: false,
};
export default function* CheckMarker(input: Record<string, Json>) {
  const { scenario, reply } = inputSchema.parse(input);
  const state = yield* Qualification.expect();
  recordMarker(
    state.report,
    scenario,
    state.marker,
    reply,
    state.report.capabilities.completion.observations.completed,
  );
  return "";
}
