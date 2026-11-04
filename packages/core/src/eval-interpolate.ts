import type { InputValues, ProtectedInput } from "./secrets/inputs.ts";
/**
 * Eval binding interpolation (spec §6.6).
 *
 * Substitutes `{name}` and `{name.path.chain}` references in content
 * with values from the eval binding environment (`env.values`). This
 * runs in the expansion engine for both executable block content and text
 * segments. When the environment contains the `props` root, dotted paths
 * such as `{props.release.version}` are handled by the same traversal.
 *
 * References use JavaScript identifier syntax with optional dot paths:
 *   /\{([a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)*)\}/g
 *
 * The first segment of a dotted path must be a key in `env.values`.
 * Subsequent segments traverse nested properties. If any intermediate
 * value is null/undefined, the reference is left verbatim.
 *
 * Text `{meta.key}` references are consumed by the `interpolate()` pass
 * before this function runs. Text `{props.key}` uses the same current
 * `env.values.props` binding as this function. Executable block content has
 * no text pass, so `{props.key}` reaches this function directly.
 *
 * If `env.values` has no key matching the root reference, it is left
 * verbatim. Non-string values are converted via `String()`.
 *
 * Escaped braces (`\{name}`) are preserved as literal `{name}` in the
 * output — the backslash is consumed. This is consistent with
 * `interpolate()` which handles `\{meta.key}` the same way.
 */

const BARE_BINDING_RE = /\{([a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)*)\}/g;

/**
 * Unicode private-use placeholder for escaped opening braces.
 * Used to protect `\{` from interpolation, then restored as `{`.
 */
const ESCAPED_BRACE_PLACEHOLDER = "\uE000";

/**
 * Replace bare `{name}` references with values from the binding environment.
 * Respects `\{` escaping — `\{name}` is left as literal `{name}`.
 *
 * @param content - The content to interpolate
 * @param bindings - The current eval binding environment (env.values)
 * @returns Content with resolved bindings substituted
 */
export function interpolateEvalBindings(
  content: string,
  bindings: Record<string, unknown>,
  owner?: InputValues,
  parts?: (string | ProtectedInput)[],
): string {
  const escaped = content.replaceAll("\\{", ESCAPED_BRACE_PLACEHOLDER);

  // Supports dotted paths: {pr.meta.number} traverses bindings.pr.meta.number
  let end = 0;
  const interpolated = escaped.replace(BARE_BINDING_RE, (match, key: string, offset: number) => {
    const emit = (text: string, leaf?: object) => {
      if (parts !== undefined) {
        parts.push(escaped.slice(end, offset).replaceAll(ESCAPED_BRACE_PLACEHOLDER, "{"));
        parts.push(leaf ?? text);
        end = offset + match.length;
      }
      return text;
    };
    const path = key.split(".");
    let value: unknown = bindings;
    for (const [index, name] of path.entries()) {
      if (value === null || typeof value !== "object" || (index === 0 && !(name in value))) {
        return emit(match);
      }
      value = Reflect.get(value, name);
    }
    if (owner?.contains(value)) {
      const safe = owner.display(value);
      if (!safe.ok) {
        throw safe.error;
      }
      const text = typeof safe.value === "string" ? safe.value : JSON.stringify(safe.value);
      if (parts !== undefined) {
        if (value === null || typeof value !== "object" || typeof safe.value !== "string") {
          throw new Error("Pass a protected field directly to built-in exec.");
        }
        return emit(text, value);
      }
      return text;
    }
    return emit(String(value));
  });
  if (parts !== undefined) {
    parts.push(escaped.slice(end).replaceAll(ESCAPED_BRACE_PLACEHOLDER, "{"));
  }

  return interpolated.replaceAll(ESCAPED_BRACE_PLACEHOLDER, "{");
}
