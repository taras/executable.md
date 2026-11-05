import { fileURLToPath } from "node:url";
import type { Operation } from "effection";

export const props = { type: "object", properties: {}, additionalProperties: false };
export const returns = { type: "string" };

export default function* WorkflowSource(): Operation<string> {
  return fileURLToPath(new URL("../../../../", import.meta.url));
}
