/**
 * @module
 * Schema-backed local web form input for executable.md documents.
 *
 * `installWebComponents()` makes `<WebForm>` resolvable for the installing scope
 * and its descendants. `installWebElicitation()` answers that scope's
 * elicitations with the same form, which is how `<Elicit>` reaches a person
 * under the CLI. `liveForm()` is the browser interaction on its own, for a host
 * that wants an answer without either component.
 *
 * `FormOpener` is how any of them asks for the URL to be opened. A host composes
 * around it to say where that act belongs — a profile that refuses the document a
 * command still opens its own form — and a failed open is a warning: the URL is
 * printed first and the form keeps waiting either way.
 */

export { installWebComponents, WEB_REGISTRATIONS } from "./src/components.ts";
export { installWebElicitation } from "./src/elicitation.ts";
export { liveForm } from "./src/live-form.ts";
export type { LiveFormInput } from "./src/live-form.ts";
export { FormOpener } from "./src/opener.ts";
export type { FormOpenerApi } from "./src/opener.ts";
