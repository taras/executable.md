import { cwd } from "@executablemd/runtime";
import type { Operation } from "effection";

export const props = { type: "object", properties: {}, additionalProperties: false };
import type { GeneratedForms } from "./generated-metadata.ts";

export const generated: GeneratedForms = {
  "self-closing": { identity: "https://executable.md/components/cwd/read", effect: "read" },
};

export default function Cwd(): Operation<string> {
  return cwd();
}
