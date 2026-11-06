import { observeProgram, programEntry, workflowRoot } from "./admission.ts";

export const props = { type: "object", properties: {}, additionalProperties: false };

export default function* AmendmentProgram() {
  return { root: workflowRoot, entry: programEntry, files: yield* observeProgram() };
}
