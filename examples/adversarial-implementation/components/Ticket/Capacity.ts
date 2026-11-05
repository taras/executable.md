import { Component } from "@executablemd/core/api";
import { z } from "zod";
import { jsonBytes } from "./json-size.ts";
export const props = {
  type: "object",
  properties: {
    name: { type: "string" },
    limit: { type: "integer", minimum: 1, default: 1_048_576 },
  },
  required: ["name"],
  additionalProperties: false,
};
export default function* Capacity(value: unknown) {
  const selected = z
    .object({ name: z.string(), limit: z.number().int().positive() })
    .strict()
    .parse(value);
  const scope = yield* Component.operations.env;
  return jsonBytes(scope?.values[selected.name], selected.limit) !== undefined;
}
