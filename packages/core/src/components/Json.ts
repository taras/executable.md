/**
 * `<Json>` — render a structured value as JSON text
 * (specs/executable-mdx-spec.md §6.12).
 *
 * `<Let>` introduces a value, this renders it, and `<Parse>` turns text back
 * into a validated value. The whole transformation is one supplied value to one
 * piece of JSON text — written where the element is, or captured by `as` — so
 * there is no option to choose: no `indent`, no replacer, no sorting, and no
 * trailing newline. A file that needs one is written with one.
 *
 * The operand is a **capture**, so the exact evaluation result arrives by
 * reference (§6.5). An ordinary prop would cross the component JSON boundary
 * first, which would serialize and clone the value before this ever saw it —
 * and would reject or rewrite exactly the values whose diagnostics are defined
 * below.
 *
 * ## Shape is decided before the operand runs
 *
 * The engine validates `as` first and either refuses it or strips it, so a
 * malformed binding name never reaches here. What is left is checked in the
 * same spirit: content, then the syntactic presence of `value`, and only then
 * the captured operand and its serialization. An operand expression can call a
 * getter, a function, or anything else the author wrote, so a malformed
 * invocation costs nothing — the same way `<File>`'s path arithmetic runs
 * before its children do (§6.13).
 *
 * `capture()` stays outside the `try` below. An expression that throws before it
 * produces a value is that invocation's ordinary captured-expression failure,
 * not a serialization failure, and mislabelling it would send a reader looking
 * at the wrong half of the element.
 *
 * ## One call, and two ways it can fail
 *
 * The serialization is `json-serialization.ts`'s, which `<Yaml>` describes the
 * same value through: one call, never repeated to explain a failure, because
 * the value can carry a getter or a `toJSON` hook the document does not own.
 *
 * Its two failures are different facts and stay separate here. Returning
 * something that is not a string means the value has no JSON text at all —
 * root `undefined`, a function, a symbol — while a thrown exception means
 * serialization started and could not finish: a `bigint`, a cycle, or a hook
 * that threw. The thrown value is preserved as `cause` exactly as it arrived,
 * and neither the error nor the rejected value is interpolated into the
 * message.
 */

import type { Operation } from "effection";
import { capture, hasCapture, hasContent } from "../component-api.ts";
import { printErrors } from "../component-failures.ts";
import { serializeJson } from "./json-serialization.ts";

export const props = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

/** An invocation `<Json>` cannot render, or a value it cannot turn into text. */
export class JsonRenderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JsonRenderError";
  }
}

const CONTENT = "<Json> renders the value it is given, not content: write <Json value={…} />.";
const MISSING = "<Json> requires a `value` prop: write <Json value={…} />.";
const NO_TEXT = "<Json> serialization produced no JSON text for this value.";
const THREW = "<Json> serialization of this value failed.";

export default printErrors(function* Json(): Operation<string> {
  if (yield* hasContent()) {
    throw new JsonRenderError(CONTENT);
  }
  if (!(yield* hasCapture("value"))) {
    throw new JsonRenderError(MISSING);
  }

  const value = yield* capture("value");

  const serialized = serializeJson(value);
  if (serialized.kind === "threw") {
    throw new JsonRenderError(THREW, { cause: serialized.cause });
  }
  if (serialized.kind === "no-text") {
    throw new JsonRenderError(NO_TEXT);
  }
  return serialized.text;
});
