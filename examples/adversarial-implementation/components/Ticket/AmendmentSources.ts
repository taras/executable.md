import { z } from "zod";
import { amendment } from "./control.ts";
import { confirmSources } from "./admission.ts";

export const props = {
  type: "object",
  properties: { amendment: { type: "object" } },
  required: ["amendment"],
  additionalProperties: false,
};

export default function* AmendmentSources(value: unknown) {
  const selected = z.object({ amendment }).strict().parse(value).amendment;
  yield* confirmSources(selected.workflow);
  return { root: selected.workflow.root, files: selected.workflow.files.length };
}
