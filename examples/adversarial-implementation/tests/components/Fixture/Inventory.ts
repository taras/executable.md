import { each } from "effection";
import { readTextFile, walk } from "@effectionx/fs";
import { z } from "zod";
import { describe } from "../../../components/Ticket/text-storage.ts";

export const props = {
  type: "object",
  properties: { directory: { type: "string" }, exclude: { type: "array", default: [] } },
  required: ["directory"],
  additionalProperties: false,
};

/** Record the UTF-8 length and SHA-256 of every file beneath `directory`. */
export default function* Inventory(value: unknown) {
  const { directory, exclude } = z
    .object({ directory: z.string().startsWith("/"), exclude: z.array(z.string()) })
    .strict()
    .parse(value);
  const files: Record<string, string> = {};
  for (const entry of yield* each(walk(directory, { includeDirs: false }))) {
    if (!exclude.some((suffix) => entry.path.endsWith(suffix))) {
      const facts = describe(entry.path, yield* readTextFile(entry.path));
      files[entry.path] = facts.utf8Bytes + ":" + facts.sha256;
    }
    yield* each.next();
  }
  return files;
}
