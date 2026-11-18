import { API } from "@executablemd/runtime";
import { z } from "zod";

export const props = {
  type: "object",
  properties: { paths: { type: "array", items: { type: "string", pattern: "^/" } } },
  required: ["paths"],
  additionalProperties: false,
};

export default function* Unstarted(value: unknown) {
  const selected = z
    .object({ paths: z.array(z.string().startsWith("/")) })
    .strict()
    .parse(value);
  try {
    for (const path of selected.paths) {
      if ((yield* API.Fs.operations.lstat(path)).exists) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
