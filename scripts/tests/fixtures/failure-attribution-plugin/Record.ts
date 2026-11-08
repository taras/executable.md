import { readTextFile } from "@effectionx/fs";
import { z } from "zod";

export const props = { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false };
export default function* Record(value: unknown) {
  const { path } = z.object({ path: z.string() }).parse(value);
  return z.object({ token: z.number() }).parse(JSON.parse(yield* readTextFile(path)));
}
