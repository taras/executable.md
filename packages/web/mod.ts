/**
 * @module
 * Schema-backed local web form input for executable.md documents.
 *
 * `installWebComponents()` makes `<WebForm>` resolvable for the installing scope
 * and its descendants. `installWebElicitation()` answers that scope's
 * elicitations with the same form, which is how `<Elicit>` reaches a person
 * under the CLI. `liveForm()` is the browser interaction on its own, for a host
 * that wants an answer without either component.
 */

export { installWebComponents } from "./src/components.ts";
export { installWebElicitation } from "./src/elicitation.ts";
export { liveForm } from "./src/live-form.ts";
export type { LiveFormInput } from "./src/live-form.ts";
