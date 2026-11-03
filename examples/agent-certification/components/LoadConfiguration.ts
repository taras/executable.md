import { readTextFile } from "@effectionx/fs";
import { configurationSchema } from "../report.ts";
import { cwd } from "@executablemd/runtime";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Json, PropsSchema } from "@executablemd/core";

export const props: PropsSchema = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
  additionalProperties: false,
};
export default function* LoadConfiguration(input: Record<string, Json>) {
  const source = yield* readTextFile(resolve(yield* cwd(), String(input.path)));
  const result = configurationSchema.safeParse(JSON.parse(source));
  if (!result.success) {
    throw new Error(
      "Invalid local agent configuration: use only command, optional model/effort, unique scenarios and expected capabilities.",
    );
  }
  return {
    configuration: result.data,
    fingerprint: createHash("sha256").update(source).digest("hex"),
  };
}
