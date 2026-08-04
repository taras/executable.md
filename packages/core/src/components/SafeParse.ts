/**
 * `<SafeParse>` — bind content as a result a document can inspect
 * (specs/executable-mdx-spec.md §6.12).
 *
 * Same compiler and same ordering as `<Parse>`; the difference is what happens
 * to a failure. Malformed JSON and a rejected instance become a value the
 * document can read, so a corrective prompt can be written in Markdown rather
 * than hidden in the component. Nothing else is caught: an unusable schema and
 * a failing child still fail the document.
 */

import type { Operation } from "effection";
import { printErrors } from "../component-failures.ts";
import { content } from "../component-api.ts";
import type { Json } from "../types.ts";
import {
  compileParseSchema,
  issuesAsJson,
  parseIssue,
  parseText,
  validateParsed,
} from "./parse-schema.ts";

export const props = {
  type: "object",
  properties: {
    schema: {},
  },
  required: ["schema"],
  additionalProperties: false,
};

const ISSUE = {
  type: "object",
  properties: {
    instancePath: { type: "string" },
    schemaPath: { type: "string" },
    keyword: { type: "string" },
    params: {},
    message: { type: "string" },
  },
  required: ["instancePath", "schemaPath", "keyword", "params", "message"],
  additionalProperties: false,
};

/**
 * The stable union a document reads. `value` is unconstrained because content
 * may validly be `null`, and a failed result keeps the rendered text exactly as
 * it arrived so a repair prompt can quote it.
 */
export const returns = {
  $schema: "http://json-schema.org/draft-07/schema#",
  oneOf: [
    {
      type: "object",
      properties: { ok: { const: true }, value: {} },
      required: ["ok", "value"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        ok: { const: false },
        input: { type: "string" },
        errors: { type: "array", items: ISSUE },
      },
      required: ["ok", "input", "errors"],
      additionalProperties: false,
    },
  ],
};

export default printErrors(function* (props: Record<string, Json>): Operation<Json> {
  const validate = yield* compileParseSchema("SafeParse", props.schema);

  const text = yield* content();

  const parsed = parseText(text);
  if (!parsed.ok) {
    return { ok: false, input: text, errors: issuesAsJson([parseIssue(parsed.error)]) };
  }

  const issues = validateParsed(validate, parsed.value);
  if (issues.length > 0) {
    return { ok: false, input: text, errors: issuesAsJson(issues) };
  }

  return { ok: true, value: parsed.value };
});
