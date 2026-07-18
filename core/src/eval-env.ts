/**
 * Eval environment — shared binding environment for generator eval blocks
 * (spec generator-eval-spec.md §3.2).
 *
 * The current environment and eval scope are delivered contextually via the
 * Component Api (`Component.operations.env()` / `Component.operations.evalScope()`),
 * installed as scope-local middleware by the expansion engine.
 */

/**
 * Shared binding environment for eval blocks within a single component.
 *
 * Created fresh at the start of component expansion. Each eval block
 * reads bindings from `values` (via env preamble) and writes new
 * bindings back (via env-write transforms).
 */
export interface EvalEnv {
  values: Record<string, unknown>;
}
