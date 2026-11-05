import { z } from "zod";
import { read } from "./text-storage.ts";
import { cwd } from "@executablemd/runtime";
export const props = {
  type: "object",
  properties: {
    path: { type: "string" },
    limit: { type: "integer", default: 8_388_608, minimum: 1, maximum: 8_388_608 },
  },
  required: ["path"],
  additionalProperties: false,
};
export default function* Read(value: unknown) {
  const selected = z
    .object({ path: z.string(), limit: z.number().int().positive().max(8_388_608) })
    .strict()
    .parse(value);
  return yield* read(yield* cwd(), selected.path, selected.limit);
}
