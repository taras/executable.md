import { API } from "@executablemd/runtime";
import { dirname } from "node:path";
import { z } from "zod";
import { createDirectory } from "./native-node.ts";

export const props = {
  type: "object",
  properties: { path: { type: "string", pattern: "^/" } },
  required: ["path"],
  additionalProperties: false,
};

export default function* ReserveDecision(value: unknown) {
  const { path } = z
    .object({ path: z.string().startsWith("/") })
    .strict()
    .parse(value);
  const parent = yield* API.Files.operations.ensureDirectory({ cwd: "/", path: dirname(path) });
  if (!parent.ok) {
    throw parent.error;
  }
  try {
    yield* createDirectory(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return false;
    }
    throw error;
  }
}
