import { Err, Ok } from "effection";
import type { Result } from "effection";
import { isJsonObject, parseJson } from "../json.ts";
import { walkSchema } from "../schema-walk.ts";
import { ParseSchemaError } from "../components/parse-schema.ts";
import type { Json, JsonObject } from "../types.ts";

export const INPUT_REPLACEMENT = "[redacted]";

export function secretInputFields(schema: JsonObject): readonly string[] {
  const accepted = new Map<JsonObject, string>();
  const properties = schema.properties;
  if (schema.type === "object" && isJsonObject(properties)) {
    for (const [name, property] of Object.entries(properties)) {
      if (isJsonObject(property) && property.type === "string" && property.writeOnly === true) {
        accepted.set(property, name);
      }
    }
  }
  let referenced = false;
  walkSchema(schema, {
    subschema(value, path) {
      if (value.$ref !== undefined) {
        referenced = true;
      }
      if (value.writeOnly === true && !accepted.has(value)) {
        throw new ParseSchemaError(
          `Elicit writeOnly: true requires a top-level string property; unsupported marking at ${path}.`,
        );
      }
    },
    declaredName() {},
  });
  if (accepted.size > 0 && referenced) {
    throw new ParseSchemaError("Elicit writeOnly: true does not support referenced declarations.");
  }
  return Object.freeze([...accepted.values()]);
}

export function projectElicitationAnswer(schema: JsonObject, answer: unknown): Result<Json> {
  try {
    const fields = secretInputFields(schema);
    if (fields.length === 0) {
      return Ok(parseJson(answer));
    }
    if (answer === null || typeof answer !== "object" || Array.isArray(answer)) {
      return Ok(INPUT_REPLACEMENT);
    }
    const entries = Object.entries(answer).map(([name, value]) => [
      name,
      fields.includes(name) ? INPUT_REPLACEMENT : value,
    ]);
    return Ok(parseJson(Object.fromEntries(entries)));
  } catch {
    return Err(
      new Error("The elicitation answer cannot be safely projected; its value is withheld."),
    );
  }
}
