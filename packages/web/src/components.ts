/**
 * Making `<WebForm>` resolvable.
 *
 * Registered rather than reserved: nothing about a schema-backed form is a
 * language or security invariant, so a repository that writes its own
 * `WebForm.md` or `WebForm.ts` outranks this one. What ships here is a default.
 *
 * The declaration is a value rather than an argument to the installer, so the
 * run profile `xmd syntax` describes and the one `xmd run` installs are the
 * same list. Installing the elicitation provider is a separate, operational
 * act — `installWebElicitation()` — and nothing about it is component metadata.
 */

import {
  contributeDocumentation,
  documented,
  packageDocumentation,
  registerComponents,
} from "@executablemd/core";
import type {
  ComponentRegistration,
  DocumentationContribution,
  DocumentationReader,
} from "@executablemd/core";
import type { Operation } from "effection";

import { WEB_FORM_PROPS, WEB_FORM_RETURNS, WebForm } from "./WebForm.ts";

export const WEB_ORIGIN = "@executablemd/web";

/** This package's long-form documentation, derived from its registrations. */
export function* webDocumentation(
  read?: DocumentationReader,
): Operation<DocumentationContribution> {
  return yield* packageDocumentation(
    new URL("./components.md", import.meta.url),
    { owner: WEB_ORIGIN, asset: "packages/web/src/components.md" },
    WEB_REGISTRATIONS.map((registration) => registration.name),
    read,
  );
}

export const WEB_REGISTRATIONS: readonly ComponentRegistration[] = [
  {
    name: "WebForm",
    origin: WEB_ORIGIN,
    fn: WebForm,
    props: WEB_FORM_PROPS,
    returns: WEB_FORM_RETURNS,
    ...documented({
      description:
        "Ask a person a question in a browser form. " +
        '`<WebForm schema={review} as="answer">…</WebForm>` builds the form from the ' +
        "schema and shows its content above it. `uiSchema` sets presentation options. " +
        "`<Elicit>` asks the same question without choosing the browser.",
      as: "Required. The validated response.",
      context: "The Markdown shown above the form.",
    }),
  },
];

/**
 * This package's vocabulary, as declarations and nothing else.
 *
 * Registrations and the documentation that describes them, installed together
 * so a scope that has one has the other. `xmd syntax` enters exactly this;
 * installing the elicitation provider stays a separate, operational act.
 */
export function* useWebComponents(): Operation<void> {
  yield* registerComponents(WEB_REGISTRATIONS);
  yield* contributeDocumentation(webDocumentation);
}

export function* installWebComponents(): Operation<void> {
  yield* useWebComponents();
}
