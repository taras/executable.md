/**
 * `<Parse>` — bind content as a validated JSON value
 * (specs/executable-mdx-spec.md §6.12).
 *
 * The schema compiles before the content expands, so a schema that cannot be
 * used fails before the document does any work whose output it would judge.
 * What survives is exactly what the content said: parsing and validation add
 * nothing and remove nothing.
 */

import type { Operation } from "effection";
import { useContent } from "../content-context.ts";
import type { Json } from "../types.ts";
import {
  ParseValidationError,
  compileParseSchema,
  parseText,
  validateParsed,
} from "./parse-schema.ts";

export const props = {
  type: "object",
  properties: {
    // Either captured JSON text or an already structured schema value; both
    // normalize through the same compiler.
    schema: {},
  },
  required: ["schema"],
  additionalProperties: false,
};

/**
 * Any JSON value, because content may legitimately be an object, an array, a
 * scalar, or `null`. The caller's `schema` prop is the real contract, checked
 * inside this component by an Ajv that cannot transform what it validates.
 */
export const returns = {};

export default function* (props: Record<string, Json>): Operation<Json> {
  const validate = compileParseSchema("Parse", props.schema);

  const text = yield* useContent();

  const parsed = parseText(text);
  if (!parsed.ok) {
    throw new ParseValidationError("Parse", [parsed.issue]);
  }

  const issues = validateParsed(validate, parsed.value);
  if (issues.length > 0) {
    throw new ParseValidationError("Parse", issues);
  }

  return parsed.value;
}
