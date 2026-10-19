/**
 * `<Yaml>` — render a structured value as YAML text
 * (specs/executable-mdx-spec.md §6.23).
 *
 * `<Json>`'s sibling, for the other spelling of the same value:
 *
 * ```xmd
 * <Yaml value={scripts} />
 * ```
 *
 * One supplied value becomes one piece of YAML — written where the element is,
 * or captured by `as`. The text is the query package's own rendering, returned
 * exactly as it produced it, including the newline it ends with: a reader
 * comparing this against `yq`'s output elsewhere is looking at the same
 * renderer.
 *
 * The operand is a **capture**, for the reason `<Json>`'s is (§6.5): an
 * ordinary prop would cross the component JSON boundary first and serialize the
 * value before this ever saw it, which would decide the diagnostics below
 * somewhere else.
 *
 * ## Shape is decided before the operand runs
 *
 * Content, then the syntactic presence of `value`, and only then the captured
 * operand — so a malformed invocation costs nothing. `capture()` stays outside
 * the `try`, because an expression that throws before it produces a value is
 * that invocation's ordinary captured-expression failure rather than a
 * rendering failure.
 *
 * ## One serialization, then one rendering
 *
 * `JSON.stringify` runs once, and its failures stay the two different facts
 * they are: no JSON text at all for a value that has none, and a thrown
 * exception for a serialization that started and could not finish. A value
 * carrying a getter or a `toJSON` hook belongs to the document, and asking it
 * twice would run somebody else's code twice.
 *
 * What the renderer does with the serialized value — key order, scalar quoting,
 * block style, how `null` and `false` are written — is the package's, and this
 * restates none of it. The value a selection bound stays data; rendering it
 * here does not change it.
 */

import type { Operation } from "effection";
import { capture, hasCapture, hasContent } from "../component-api.ts";
import { printErrors } from "../component-failures.ts";
import { yaml } from "./query-engine.ts";

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
const RENDER = "<Yaml> could not render this value as YAML.";

export default printErrors(function* Yaml(): Operation<string> {
  if (yield* hasContent()) {
    throw new YamlRenderError(CONTENT);
  }
  if (!(yield* hasCapture("value"))) {
    throw new YamlRenderError(MISSING);
  }

  const value = yield* capture("value");

  let json: unknown;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new YamlRenderError(THREW, { cause: error });
  }
  if (typeof json !== "string") {
    throw new YamlRenderError(NO_TEXT);
  }

  try {
    return yield* yaml(json);
  } catch (error) {
    throw new YamlRenderError(RENDER, { cause: error });
  }
});
