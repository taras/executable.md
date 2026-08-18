/**
 * Selecting a forge provider, and what a forge provider is.
 *
 * The contextual surface here chooses *which* provider a live external effect
 * routes to. It is not completion authority: a handler installed around it may
 * observe the selection, narrow it or refuse it, and none of those can make a
 * durable effect succeed. What completes a phase is the execution-owned
 * capability the selection leads to, which this API cannot reach.
 *
 * A provider is provider-neutral by construction. It receives the frozen
 * normalized request and the evidence its phase is entitled to, and it answers
 * with one of a closed set of shapes. Its credentials, its transport and its
 * raw responses stay inside its own closure: nothing it holds is named here,
 * and nothing it returns reaches the journal unparsed.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation, Result } from "effection";
import type { CompleteForgeEffectRequest, ForgeCompletion, ForgeObservation } from "./records.ts";

/**
 * What a forge can be asked, in the order the shared state machine asks it.
 *
 * `observe` always runs first and answers what is provably there. `perform` is
 * reached only from proven absence, and receives that observation as the
 * evidence it acts on.
 *
 * Both answer with Effection's `Result`. The success channel carries a closed
 * normalized shape; the failure channel carries a {@link
 * ForgeUnavailableError} and nothing else, because "I could not tell" is the
 * only answer that is neither an outcome nor a fault.
 */
export interface ForgeProvider {
  observe(request: CompleteForgeEffectRequest): Operation<Result<ForgeObservation>>;
  perform(
    request: CompleteForgeEffectRequest,
    observation: ForgeObservation,
  ): Operation<Result<ForgeCompletion>>;
}

export interface ForgeApi {
  readonly provider: object | undefined;
}

/** Selects a forge provider without carrying live-effect authority. */
export const Forge: Api<ForgeApi> = createApi<ForgeApi>("executablemd.workflow.forge", {
  provider: undefined,
});
