/**
 * Making `<WebForm>` resolvable.
 *
 * Registered rather than reserved: nothing about a schema-backed form is a
 * language or security invariant, so a repository that writes its own
 * `WebForm.md` or `WebForm.ts` outranks this one. What ships here is a default.
 */

import { registerComponents } from "@executablemd/core";
import type { Operation } from "effection";

import { WEB_FORM_PROPS, WEB_FORM_RETURNS, WebForm } from "./WebForm.ts";

export function* installWebComponents(): Operation<void> {
  yield* registerComponents([
    {
      name: "WebForm",
      origin: "@executablemd/web",
      fn: WebForm,
      props: WEB_FORM_PROPS,
      returns: WEB_FORM_RETURNS,
    },
  ]);
}
