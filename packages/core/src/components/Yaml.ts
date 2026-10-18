/**
 * `<Yaml>` — render a structured value as YAML text.
 *
 * `<Json>`'s sibling, and deliberately its exact shape: one supplied value to
 * one piece of text, written where the element is or captured by `as`, with no
 * option to choose. Rendering YAML is something a document asks for explicitly:
 * nothing turns a value into YAML because it was captured, selected or
 * displayed somewhere, and a selected binding stays data whatever renders it.
 *
 * ```md
 * <File path="package.json" yq="from_json | .scripts" as="scripts" />
 * <Yaml value={scripts} />
 * ```
 *
 * The operand is a **capture**, so the exact evaluation result arrives by
 * reference (§6.5), for the reason `<Json>`'s does: an ordinary prop would
 * cross the component JSON boundary first and rewrite the value before this
 * ever saw it.
 *
 * ## Shape is decided before the operand runs
 *
 * Content, then the syntactic presence of `value`, and only then the captured
 * operand. An operand expression can call a getter or a function the author
 * wrote, so a malformed invocation costs nothing — and a failure is atomic:
 * nothing is captured, nothing is rendered, and the diagnostic names `<Yaml>`
 * at the position it was written.
 *
 * ## One serialization, then one evaluation
 *
 * The value is serialized once, through the same call `<Json>` describes it
 * with (`json-serialization.ts`), and that text is handed to this execution's
 * own engine under the identity expression. So the two components cannot
 * disagree about what the value is, and `JSON.parse` of the one and a YAML
 * parse of the other produce the same value.
 *
 * What comes back is the vendor's complete YAML document: two-space
 * indentation, no document separators, scalars left quoted where their type
 * depends on it, and one terminating newline. It is returned exactly as the
 * engine produced it — appending a separator or a second newline would make the
 * text this renders something the vendor never wrote, and quoting is what keeps
 * the string `"false"` a string and a multiline string a block scalar that
 * parses back whole.
 */

import type { Operation } from "effection";
import { capture, hasCapture, hasContent } from "../component-api.ts";
import { printErrors } from "../component-failures.ts";
import { useValueQuery } from "../value-query.ts";
import { serializeJson } from "./json-serialization.ts";

export const props = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

/** An invocation `<Yaml>` cannot render, or a value it cannot turn into text. */
export class YamlRenderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "YamlRenderError";
  }
}

const CONTENT = "<Yaml> renders the value it is given, not content: write <Yaml value={…} />.";
const MISSING = "<Yaml> requires a `value` prop: write <Yaml value={…} />.";
const NO_TEXT = "<Yaml> serialization produced no JSON text for this value.";
const THREW = "<Yaml> serialization of this value failed.";

export default printErrors(function* Yaml(): Operation<string> {
  if (yield* hasContent()) {
    throw new YamlRenderError(CONTENT);
  }
  if (!(yield* hasCapture("value"))) {
    throw new YamlRenderError(MISSING);
  }

  const value = yield* capture("value");

  const serialized = serializeJson(value);
  if (serialized.kind === "threw") {
    throw new YamlRenderError(THREW, { cause: serialized.cause });
  }
  if (serialized.kind === "no-text") {
    throw new YamlRenderError(NO_TEXT);
  }

  const queries = yield* useValueQuery();
  return yield* queries.yaml(serialized.text);
});
