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
import { captureErrors } from "../component-failures.ts";
import { content } from "../component-api.ts";
import type { Json } from "../types.ts";
import {
  ParseValidationError,
  compileParseSchema,
  parseIssue,
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
 *
 * The `$schema` marker is what says "a schema, taken as written". A `returns`
 * object carrying neither `type` nor `$schema` is the concise shorthand for an
 * object's properties (§5.1.1), so a bare `{}` would declare an object with no
 * properties — the opposite of any value.
 */
export const returns = { $schema: "http://json-schema.org/draft-07/schema#" };

export default captureErrors(function* (props: Record<string, Json>): Operation<Json> {
  const validate = yield* compileParseSchema("Parse", props.schema);

  const text = yield* content();

  const parsed = parseText(text);
  if (!parsed.ok) {
    throw new ParseValidationError("Parse", [parseIssue(parsed.error)]);
  }

  const issues = validateParsed(validate, parsed.value);
  if (issues.length > 0) {
    throw new ParseValidationError("Parse", issues);
  }

  return parsed.value;
});
