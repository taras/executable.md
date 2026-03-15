/**
 * Eval binding interpolation (spec §2).
 *
 * Substitutes bare `{name}` references in code block content with values
 * from the eval binding environment (`env.values`). This runs in the
 * expansion engine before the modifier chain executes.
 *
 * Bare references use JavaScript identifier syntax:
 *   /\{([a-zA-Z_$][a-zA-Z0-9_$]*)\}/g
 *
 * Namespaced references (`{meta.title}`, `{props.name}`) contain a `.`
 * and are excluded — they are handled by the existing interpolation pass.
 *
 * If `env.values` has no key matching the reference, it is left verbatim.
 * Non-string values are converted via `String()`.
 */

const BARE_BINDING_RE = /\{([a-zA-Z_$][a-zA-Z0-9_$]*)\}/g;

/**
 * Replace bare `{name}` references with values from the binding environment.
 *
 * @param content - The code block content to interpolate
 * @param bindings - The current eval binding environment (env.values)
 * @returns Content with resolved bindings substituted
 */
export function interpolateEvalBindings(
  content: string,
  bindings: Record<string, unknown>,
): string {
  return content.replace(
    BARE_BINDING_RE,
    (match, key: string) => key in bindings ? String(bindings[key]) : match,
  );
}
