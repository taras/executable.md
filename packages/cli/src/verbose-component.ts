import { content } from "@executablemd/core";
import type { ComponentRegistration, Json } from "@executablemd/core";
import type { Operation } from "effection";

export const VERBOSE_ORIGIN = "@executablemd/cli";

export const props = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export function verboseComponentRegistration(verbose: boolean): ComponentRegistration {
  const show = function* Verbose(_props: Record<string, Json>): Operation<string> {
    if (!verbose) {
      return "";
    }
    return yield* content();
  };

  return {
    name: "Verbose",
    origin: VERBOSE_ORIGIN,
    props,
    fn: show,
    description:
      "Expand content only with --verbose. `<Verbose>Checking setup.</Verbose>` renders nothing otherwise.",
    as: "Optional. Captures the rendered verbose text, or an empty string when verbosity is off.",
  };
}
