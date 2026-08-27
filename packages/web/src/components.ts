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

import { documented, registerComponents } from "@executablemd/core";
import type { ComponentRegistration } from "@executablemd/core";
import type { Operation } from "effection";

import { WEB_FORM_PROPS, WEB_FORM_RETURNS, WebForm } from "./WebForm.ts";

export const WEB_ORIGIN = "@executablemd/web";

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

export function* installWebComponents(): Operation<void> {
  yield* registerComponents(WEB_REGISTRATIONS);
}
