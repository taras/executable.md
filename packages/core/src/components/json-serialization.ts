/**
 * The one native serialization `<Json>` and `<Yaml>` both describe a value
 * through.
 *
 * Both components answer the same question about the operand they were handed —
 * what is this value's JSON text — and they must answer it the same way, from
 * one call. The operand can carry a getter, a `toJSON` hook or a `Proxy` the
 * document does not own, so serializing twice would run somebody else's code
 * twice and could produce two different readings of one value.
 *
 * So the call happens here, once, and what comes back is the outcome rather
 * than the text: the two ways it can fail are different facts about the value
 * and each caller says so in its own words. Returning something that is not a
 * string means the value has no JSON text at all — root `undefined`, a
 * function, a symbol — while a thrown exception means serialization started and
 * could not finish: a `bigint`, a cycle, or a hook that threw. The thrown value
 * travels exactly as it arrived so a caller can keep it as `cause`.
 *
 * Native `JSON.stringify` decides everything else — property enumeration,
 * nested `undefined`/function/symbol omission, non-finite numbers, `toJSON`,
 * supported built-ins. This normalizes none of it, and adds no trailing
 * newline.
 */

/** What the one serialization call produced. */
export type JsonSerialization =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "no-text" }
  | { readonly kind: "threw"; readonly cause: unknown };

/** Serialize one operand, exactly once, with two-space indentation. */
export function serializeJson(value: unknown): JsonSerialization {
  let text: unknown;
  try {
    text = JSON.stringify(value, null, 2);
  } catch (cause) {
    return { kind: "threw", cause };
  }
  return typeof text === "string" ? { kind: "text", text } : { kind: "no-text" };
}
