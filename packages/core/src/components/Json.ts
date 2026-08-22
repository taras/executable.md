/**
 * `<Json>` — render a structured value as JSON text
 * (specs/executable-mdx-spec.md §6.12).
 *
 * `<Let>` introduces a value, this renders it, and `<Parse>` turns text back
 * into a validated value. The whole transformation is one supplied value to one
 * piece of JSON text at the position the element was written, so there is no
 * option to choose: no `indent`, no replacer, no sorting, and no trailing
 * newline. A file that needs one is written with one.
 *
 * The operand is a **capture**, so the exact evaluation result arrives by
 * reference (§6.5). An ordinary prop would cross the component JSON boundary
 * first, which would serialize and clone the value before this ever saw it —
 * and would reject or rewrite exactly the values whose diagnostics are defined
 * below.
 *
 * ## Shape is decided before the operand runs
 *
 * `as`, content, and a missing `value` are refused before `capture()`, because
 * an operand expression can call a getter, a function, or anything else the
 * author wrote. A malformed invocation therefore costs nothing, in the same way
 * `<File>`'s path arithmetic runs before its children do (§6.13).
 *
 * `capture()` stays outside the `try` below. An expression that throws before it
 * produces a value is that invocation's ordinary captured-expression failure,
 * not a serialization failure, and mislabelling it would send a reader looking
 * at the wrong half of the element.
 *
 * ## One call, and two ways it can fail
 *
 * `JSON.stringify` runs once. It is never called again to describe a failure,
 * because the value can carry a getter or a `toJSON` hook the document does not
 * own, and asking twice would run somebody else's code twice.
 *
 * Its two failures are different facts and stay separate. Returning something
 * that is not a string means the value has no JSON text at all — root
 * `undefined`, a function, a symbol — while a thrown exception means
 * serialization started and could not finish: a `bigint`, a cycle, or a hook
 * that threw. The thrown value is preserved as `cause` exactly as it arrived,
 * and neither the error nor the rejected value is interpolated into the
 * message.
 *
 * Native `JSON.stringify` decides everything else — property enumeration,
 * nested `undefined`/function/symbol omission, non-finite numbers, `toJSON`,
 * supported built-ins. This restates none of it and normalizes none of it.
 */

import type { Operation } from "effection";
import { capture, hasBinding, hasCapture, hasContent } from "../component-api.ts";
import { printErrors } from "../component-failures.ts";

export const props = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

/**
 * `value` is the engine's to hand over unresolved (§6.5).
 *
 * Exported rather than declared only where core registers this component, so
 * the same file means the same thing whichever tier supplies it: resolved as a
 * repository `.ts` file, it declares its own operand.
 */
export const captures = ["value"];

/** An invocation `<Json>` cannot render, or a value it cannot turn into text. */
export class JsonRenderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JsonRenderError";
  }
}

const BINDING = "<Json> renders JSON text and binds nothing, so `as` is not accepted.";
const CONTENT = "<Json> renders the value it is given, not content: write <Json value={…} />.";
const MISSING = "<Json> requires a `value` prop: write <Json value={…} />.";
const NO_TEXT = "<Json> serialization produced no JSON text for this value.";
const THREW = "<Json> serialization of this value failed.";

export default printErrors(function* Json(): Operation<string> {
  if (yield* hasBinding()) {
    throw new JsonRenderError(BINDING);
  }
  if (yield* hasContent()) {
    throw new JsonRenderError(CONTENT);
  }
  if (!(yield* hasCapture("value"))) {
    throw new JsonRenderError(MISSING);
  }

  const value = yield* capture("value");

  let text: unknown;
  try {
    text = JSON.stringify(value, null, 2);
  } catch (error) {
    throw new JsonRenderError(THREW, { cause: error });
  }
  if (typeof text !== "string") {
    throw new JsonRenderError(NO_TEXT);
  }
  return text;
});
