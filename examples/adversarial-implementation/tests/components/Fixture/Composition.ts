import { Component } from "@executablemd/core/api";
import { useCompositionComponents } from "@executablemd/git";
import { useRunComposition } from "@executablemd/git/deno";
import { z } from "zod";

export const props = {
  type: "object",
  properties: { repository: { type: "string" }, directory: { type: "string" } },
  required: ["repository", "directory"],
  additionalProperties: false,
};

export default function* Composition(input: unknown) {
  const selected = z.strictObject({ repository: z.string(), directory: z.string() }).parse(input);
  yield* useCompositionComponents();
  yield* useRunComposition({ root: selected.directory, cwd: selected.repository });
  yield* Component.operations.content();
}
