/**
 * Whether a piece of text would read something.
 *
 * The two interpolation passes a text segment goes through are definitive on
 * what a reference is, so this asks them rather than guessing: `\{` is
 * protected exactly as expansion protects it, and what remains is matched by
 * the same shapes `interpolate()` and `interpolateEvalBindings()` consume.
 * Braces that neither pass would read — prose, a JSON sample, a CSS rule — are
 * left alone.
 *
 * Its own module because two decisions depend on it and they must agree on
 * *what a read is*. A fragment admission refuses source that reads a binding
 * through interpolation, because a fragment expands against the environment of
 * the document that admitted it. A streaming preview leaves such text out
 * rather than showing a person a brace the finished source will replace. Text
 * one of them called literal and the other called a read would be two readings
 * of one rule.
 *
 * What the two do with the answer differs, and that is not a disagreement. A
 * root admission does not consult this at all: a root has an environment of its
 * own, so interpolation there reads only what the root bound and anything else
 * stays as written. The preview still treats such text as a read, because
 * whether it will change when evaluated is exactly its question.
 */

const ESCAPED_BRACE_PLACEHOLDER = "";
const FRONTMATTER_REFERENCE = /\{(meta|props)\.[^}]+\}/;
const BINDING_REFERENCE = /\{[a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)*\}/;

export function readsBinding(content: string): boolean {
  const protectedEscapes = content.replaceAll("\\{", ESCAPED_BRACE_PLACEHOLDER);
  return FRONTMATTER_REFERENCE.test(protectedEscapes) || BINDING_REFERENCE.test(protectedEscapes);
}
