import { cwd, parseFilesFailure } from "@executablemd/runtime";
import { printErrors } from "../component-failures.ts";
import { copyFile } from "../files.ts";
import type { FormDeclaration } from "../invocation-identity.ts";
import { reason } from "./fs-error-phrases.ts";

export const props = {
  type: "object",
  properties: {
    source: { type: "string", minLength: 1 },
    destination: { type: "string", minLength: 1 },
  },
  required: ["source", "destination"],
  additionalProperties: false,
};

export const form: FormDeclaration = {
  forms: "self-closing",
  refuse: () => new Error("<File.Copy> requires a self-closing invocation."),
  fn: printErrors(function* (props) {
    const result = yield* copyFile({
      cwd: yield* cwd(),
      source: String(props.source),
      destination: String(props.destination),
    });
    if (!result.ok) {
      throw new Error(`Cannot copy file: ${reason(parseFilesFailure(result.error)?.reason)}.`);
    }
    return "";
  }),
};
