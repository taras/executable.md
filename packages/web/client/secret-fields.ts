import type { RJSFSchema, RJSFValidationError, UiSchema } from "@rjsf/utils";

export function secretPresentation(schema: RJSFSchema, supplied: UiSchema = {}): UiSchema {
  const ui = { ...supplied };
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    if (typeof property === "object" && property.writeOnly === true) {
      ui[name] = { ...ui[name], "ui:widget": "password" };
    }
  }
  return ui;
}

export function secretValidationErrors(
  schema: RJSFSchema,
  errors: RJSFValidationError[],
): RJSFValidationError[] {
  const marked = Object.entries(schema.properties ?? {})
    .filter(([, property]) => typeof property === "object" && property.writeOnly === true)
    .map(([name]) => name);
  return errors.map((error) =>
    marked.some((name) => error.property === `.${name}` || error.property?.startsWith(`.${name}.`))
      ? {
          ...error,
          params: {},
          message: "does not satisfy this field",
          stack: "Protected field does not satisfy its schema.",
        }
      : error,
  );
}
