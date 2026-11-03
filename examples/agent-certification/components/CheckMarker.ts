import { Qualification } from "../state.ts";
import { recordMarker } from "../report.ts";
import { z } from "zod";
import type { Json, PropsSchema } from "@executablemd/core";
const inputSchema = z.strictObject({
  scenario: z.enum(["seed", "continuity", "separation", "reconnect", "resume"]),
  reply: z.string(),
});
export const props: PropsSchema = {
  type: "object",
  properties: {
    scenario: { enum: ["seed", "continuity", "separation", "reconnect", "resume"] },
    reply: { type: "string" },
  },
  required: ["scenario", "reply"],
  additionalProperties: false,
};
export default function* CheckMarker(input: Record<string, Json>) {
  const { scenario, reply } = inputSchema.parse(input);
  const state = yield* Qualification.expect();
  const accepted = state.turn.accepted && state.turn.completed;
  if (scenario === "seed") {
    state.seedAccepted = accepted;
    if (accepted) {
      state.identity = state.turn.identity;
    }
  } else {
    recordMarker(
      state.report,
      scenario,
      state.marker,
      reply,
      accepted && (scenario === "separation" || state.turn.identity === state.identity),
    );
  }
  return "";
}
