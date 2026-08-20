/**
 * The one Issue middleware surface, and what an Issue provider is.
 *
 * There is exactly one contextual operation here, and it routes. Public
 * middleware receives one frozen, one-use request describing the complete
 * detached Issue request, its canonical target and its resolved provider; it
 * may read it, refuse by throwing, suspend before delegating, install narrower
 * policy, or delegate that exact request onward. It receives no credential, no
 * capability, no answer operation and no phase evidence, and the value it
 * returns is ignored. Nothing a handler can hold or combine adds up to
 * completion authority — which is the whole reason there is one surface here
 * rather than two.
 *
 * ## Providers are selected by discriminator, not by search
 *
 * Several providers may be installed at once. Each registers for one
 * discriminator and answers only requests whose resolved provider is that
 * name; anything else it delegates untouched. There is no capability
 * discovery, no negotiation and no fallback: a request whose discriminator
 * nobody registered for reaches this surface's own default, which completes
 * nothing.
 *
 * That is what makes an explicit `provider` on an Issue context meaningful. It
 * does not ask for a preference among installed adapters — it names the only
 * adapter allowed to act, and a refusal from that adapter is the end of the
 * request rather than the start of a search for another one.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation, Result } from "effection";
import { IssueProviderError } from "./errors.ts";
import type { CompleteIssueRequest, IssueCompletion, IssueObservation } from "./records.ts";

/** The stable name every loaded copy composes through. */
export const ISSUE_API = "executablemd.workflow.issue";

/** Which half of one reconciliation attempt is running. */
export type IssuePhase = "observe" | "perform";

/**
 * What public routing middleware sees: one frozen, one-use routing request.
 *
 * It describes what is being asked, where it is being asked, and which provider
 * was selected, so a handler can route or refuse on the facts. It carries no
 * evidence only the provider is entitled to, and no member of it is a
 * capability.
 */
export interface IssueRoutingRequest {
  readonly intent: "route";
  readonly phase: IssuePhase;
  readonly request: CompleteIssueRequest;
}

/**
 * What the selected provider's handler is told, once, by the invocation itself.
 *
 * Reached only through that handler's own continuation, so the phase — and, for
 * a perform, the proven absence it acts on — is never visible to the middleware
 * the request travelled through.
 */
export type IssuePhaseDetails =
  | { readonly phase: "observe"; readonly request: CompleteIssueRequest }
  | {
      readonly phase: "perform";
      readonly request: CompleteIssueRequest;
      readonly observation: IssueObservation;
    };

/**
 * One message on the Issue operation.
 *
 * Public middleware only ever receives {@link IssueRoutingRequest}. The two
 * private members are how the selected provider's handler speaks to the
 * invocation's own terminal through the continuation it captured, and they are
 * declared here only because they travel on the same operation. Constructing
 * one grants nothing: the terminal is reachable from that continuation alone.
 */
export type IssueCall =
  | IssueRoutingRequest
  | { readonly intent: "inspect"; readonly routing: IssueRoutingRequest }
  | {
      readonly intent: "answer";
      readonly routing: IssueRoutingRequest;
      readonly answer: unknown;
    };

/**
 * What an Issue provider can be asked, in the order the state machine asks it.
 *
 * `observe` always runs first and answers what is provably there. `perform` is
 * reached only from proven absence, and receives that observation as the
 * evidence it acts on.
 *
 * Both answer with Effection's `Result`. The success channel carries a closed
 * normalized shape; the failure channel carries a temporary unavailability, or
 * — from `observe` only — a refusal of a target this provider will not act on.
 * Anything else it puts there is outside the vocabulary it agreed to speak.
 */
export interface IssueProvider {
  observe(request: CompleteIssueRequest): Operation<Result<IssueObservation>>;
  perform(
    request: CompleteIssueRequest,
    observation: IssueObservation,
  ): Operation<Result<IssueCompletion>>;
}

export interface IssueApi {
  /**
   * Route one Issue request.
   *
   * The public call answers nothing: a return value is not evidence, and
   * `reconcileIssueEffect()` ignores it.
   */
  route(call: IssueCall): Operation<unknown>;
}

/**
 * The public Issue surface. Its own default always refuses.
 *
 * Invoking this descriptor with a captured request outside a live invocation
 * reaches this default and completes nothing. A live attempt invokes its own
 * descriptor, which shares this stable name — and so this middleware chain —
 * while terminating in that invocation's private authoritative terminal.
 */
export const IssueRouting: Api<IssueApi> = createApi<IssueApi>(ISSUE_API, {
  // deno-lint-ignore require-yield
  *route(): Operation<unknown> {
    throw new IssueProviderError(
      "no issue provider accepted this request, and this surface completes nothing on its own",
    );
  },
});
