/**
 * Eval binding interpolation (spec §6.6).
 *
 * Substitutes bare `{name}` references in content with values from the
 * eval binding environment (`env.values`). This runs in the expansion
 * engine for both code block content and text segments.
 *
 * Bare references use JavaScript identifier syntax:
 *   /\{([a-zA-Z_$][a-zA-Z0-9_$]*)\}/g
 *
 * Namespaced references (`{meta.title}`, `{props.name}`) contain a `.`
 * and are excluded — they are handled by the existing interpolation pass.
 *
 * If `env.values` has no key matching the reference, it is left verbatim.
 * Non-string values are converted via `String()`.
 *
 * Escaped braces (`\{name}`) are preserved as literal `{name}` in the
 * output — the backslash is consumed. This is consistent with
 * `interpolate()` which handles `\{meta.key}` the same way.
 */

const BARE_BINDING_RE = /\{([a-zA-Z_$][a-zA-Z0-9_$]*)\}/g;

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

  // Run interpolation on the protected content
  const interpolated = escaped.replace(
    BARE_BINDING_RE,
    (match, key: string) => key in bindings ? String(bindings[key]) : match,
  );

  // Restore escaped braces: placeholder → literal {
  return interpolated.replaceAll(ESCAPED_BRACE_PLACEHOLDER, "{");
}
