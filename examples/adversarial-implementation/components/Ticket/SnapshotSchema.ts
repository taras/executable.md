import { z } from "zod";
import { snapshot } from "./text-storage.ts";
export const props = { type: "object", additionalProperties: false };
// A pure function component still requires the generator form.
// deno-lint-ignore require-yield
export default function* SnapshotSchema() {
  return z.toJSONSchema(snapshot, { target: "draft-7" });
}
