/**
 * @module
 * Schema-backed local web form input for executable.md documents.
 *
 * `installWebComponents()` makes `<WebForm>` resolvable for the installing scope
 * and its descendants. `liveForm()` is the same browser interaction without the
 * component around it, for #197's `<Elicit>` and anything else that needs a
 * person's answer rather than a form element.
 */

export { installWebComponents } from "./src/components.ts";
export { liveForm } from "./src/live-form.ts";
export type { LiveFormInput } from "./src/live-form.ts";
