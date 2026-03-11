/**
 * Eval environment — shared binding environment and scope contexts
 * for generator eval blocks (spec generator-eval-spec.md §3.1–3.2).
 *
 * - EvalEnv: mutable record of bindings shared across eval blocks within a component
 * - EvalEnvCtx: Effection context for the current component's binding environment
 * - EvalScopeCtx: Effection context for the current component's eval scope
 */

import { createContext } from "effection";
import type { EvalScope } from "@effectionx/scope-eval";

// ---------------------------------------------------------------------------
// Persist flag (spec §7.1)
// ---------------------------------------------------------------------------

/**
 * When set to true on the scope, the eval handler will run the compiled
 * block inside the EvalScope's persistent child scope. Set by the
 * persist modifier, read by evalFactory.
 */
export const PersistFlagCtx = createContext<boolean>("persistFlag");

// ---------------------------------------------------------------------------
// Binding environment (spec §3.2)
// ---------------------------------------------------------------------------

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

/**
 * Effection context holding the current component's binding environment.
 *
 * Set via `EvalEnvCtx.with()` in the expansion engine when a component
 * begins expansion. Handlers access it via `ephemeral(EvalEnvCtx.expect())`.
 */
export const EvalEnvCtx = createContext<EvalEnv>("evalEnv");

// ---------------------------------------------------------------------------
// Eval scope (spec §3.1)
// ---------------------------------------------------------------------------

/**
 * Effection context holding the current component's EvalScope.
 *
 * The EvalScope (from @effectionx/scope-eval) is created per component
 * and allows `persist` blocks to retain resources beyond block lifetime.
 * The scope is destroyed when component expansion completes.
 */
export const EvalScopeCtx = createContext<EvalScope>("evalScope");
