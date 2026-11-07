import { z } from "zod";
import { envelope } from "./control.ts";
import { clear } from "./text-storage.ts";
export const props = {
  type: "object",
  properties: { value: { type: "object" } },
  required: ["value"],
  additionalProperties: false,
};
export default function* Envelope(value: unknown) {
  const selected = z.object({ value: envelope }).strict().parse(value).value;
  yield* clear(JSON.stringify(selected));
  return selected;
}
