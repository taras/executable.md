/**
 * `<Verbose>` — the run profile's component for content only a verbose run
 * shows.
 *
 * The declaration is static because verbosity is not a property of the
 * declaration. It is a property of the scope the element expands in: the
 * command line seeds `Config.verbose` for the run, a component may install a
 * nearer value for its own content, and this generator asks that question at
 * the invocation, every time. A registration built around the host's boolean
 * would answer it once, at assembly, where no element has been written yet.
 *
 * Reading precedes expansion. A false answer returns the empty string without
 * calling `content()`, so nothing inside a skipped body runs, fails, or is
 * observed.
 */

import { content, packageDocumentation, verbose } from "@executablemd/core";
import type { ComponentRegistration, DocumentationContribution, Json } from "@executablemd/core";
import type { Operation } from "effection";

export const VERBOSE_ORIGIN = "@executablemd/cli";

export const props = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

function* Verbose(_props: Record<string, Json>): Operation<string> {
  if (!(yield* verbose)) {
    return "";
  }
  return yield* content();
}

/** This command's long-form documentation, derived from what it registers. */
export function* cliDocumentation(): Operation<DocumentationContribution> {
  return yield* packageDocumentation(
    new URL("./components.md", import.meta.url),
    { owner: VERBOSE_ORIGIN, asset: "packages/cli/src/components.md" },
    [VERBOSE_REGISTRATION.name],
  );
}

/** The one declaration the run profile registers and `xmd syntax` describes. */
export const VERBOSE_REGISTRATION: ComponentRegistration = {
  name: "Verbose",
  origin: VERBOSE_ORIGIN,
  props,
  fn: Verbose,
  description:
    "Expand content when run verbosity is enabled. `--verbose` enables it for the run; a component may override verbosity for its content.",
  as: "Optional. Captures the rendered verbose text, or an empty string when verbosity is off.",
};
