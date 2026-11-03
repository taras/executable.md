import { content } from "@executablemd/core";
import type { Json, PropsSchema } from "@executablemd/core";
import { readTextFile, writeTextFile } from "@effectionx/fs";
import { Qualification, privateStateSchema } from "../state.ts";
import { observeQualification, joinQualification } from "../observe.ts";
export const props: PropsSchema = {
  type: "object",
  properties: { input: { type: "string" }, output: { type: "string" } },
  required: ["input", "output"],
  additionalProperties: false,
};
export default function* ResumeStage(input: Record<string, Json>) {
  const state = privateStateSchema.parse(JSON.parse(yield* readTextFile(String(input.input))));
  yield* Qualification.set(state);
  yield* observeQualification(state.report, (event) => {
    if (event.type === "started") {
      state.turn.accepted = true;
      state.turn.identity = event.session.agentSessionId;
    } else if (event.type === "terminal") {
      state.turn.completed = event.status === "completed";
    }
  });
  let failure: unknown;
  try {
    yield* joinQualification(state.report, () => content());
  } catch (error) {
    failure = error;
  }
  yield* writeTextFile(String(input.output), JSON.stringify(state));
  if (failure !== undefined) {
    throw new Error("Resume scenario failed");
  }
  return "";
}
