import { jsonBytes } from "./json-size.ts";
import { clear } from "./text-storage.ts";
import { fitsOutward } from "./outward-size.ts";
import { z } from "zod";
export const props = {
  type: "object",
  properties: { value: { type: "object" } },
  required: ["value"],
  additionalProperties: false,
};
export default function* Outward(value: unknown) {
  const incoming = z.object({ value: z.unknown() }).strict().parse(value).value;
  if (jsonBytes(incoming, 65_536) === undefined) {
    return {
      status: "hold",
      reason:
        "Outward capacity exceeded. Preserve the saved continuation and canonical receipts; do not repeat completed work.",
    };
  }
  const selected = z.record(z.string(), z.json()).parse(incoming);
  yield* clear(JSON.stringify(selected));
  if (!fitsOutward(selected)) {
    return {
      status: "hold",
      reason:
        "Outward capacity exceeded. Preserve the saved continuation and canonical receipts; do not repeat completed work.",
    };
  }
  return selected;
}
