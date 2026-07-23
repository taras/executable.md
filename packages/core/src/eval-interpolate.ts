/**
 * Eval binding interpolation (spec §6.6).
 *
 * Substitutes `{name}` and `{name.path.chain}` references in content
 * with values from the eval binding environment (`env.values`). This
 * runs in the expansion engine for both code block content and text
 * segments.
 *
 * References use JavaScript identifier syntax with optional dot paths:
 *   /\{([a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)*)\}/g
 *
 * The first segment of a dotted path must be a key in `env.values`.
 * Subsequent segments traverse nested properties. If any intermediate
 * value is null/undefined, the reference is left verbatim.
 *
 * No collision with `{meta.key}` / `{props.key}`: those are consumed
 * by the `interpolate()` pass which runs first. By the time this
 * function runs, namespaced references are already resolved.
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
): string {
  // Protect escaped braces: \{ → placeholder
  const escaped = content.replaceAll("\\{", ESCAPED_BRACE_PLACEHOLDER);

  // Run interpolation on the protected content.
  // Supports dotted paths: {pr.meta.number} traverses bindings.pr.meta.number
  const interpolated = escaped.replace(BARE_BINDING_RE, (match, key: string) => {
    const parts = key.split(".");
    if (!(parts[0] in bindings)) {
      return match;
    }

    let value: unknown = bindings;
    for (let i = 0; i < parts.length; i++) {
      if (value == null || typeof value !== "object") {
        return match;
      }
      const obj = value as Record<string, unknown>;
      if (i < parts.length - 1 && !(parts[i] in obj)) {
        return match;
      }
      value = obj[parts[i]];
    }

    return String(value);
  });

  // Restore escaped braces: placeholder → literal {
  return interpolated.replaceAll(ESCAPED_BRACE_PLACEHOLDER, "{");
}
