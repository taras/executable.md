/**
 * The one Git-host middleware surface, and what a Git-host provider is.
 *
 * A **Git host** is an external service that owns remote Git repositories and
 * associated collaboration objects such as branches, pull requests and issues.
 * GitHub is one Git-host adapter. A Git host is distinct from the local Git
 * capability and from the trusted workflow host.
 *
 * There is exactly one contextual operation here, and it routes. Public
 * middleware receives one frozen, one-use request describing the complete
 * detached Git-host request; it may read it, refuse by throwing, install
 * narrower policy, or delegate that exact request onward. It receives no
 * credential, no capability, no answer operation and no phase evidence, and the
 * value it returns is ignored. Nothing a handler can hold or combine adds up to
 * completion authority — which is the whole reason there is one surface here
 * rather than two.
 *
 * A provider is provider-neutral by construction. It receives the frozen
 * normalized request and the evidence its phase is entitled to, and answers
 * with one of a closed set of shapes. Its credentials, transport and raw
 * responses stay inside its own closure.
 *
 * A Git host need not implement every effect kind. A plain Git server may
 * support `git-push` while supporting neither pull requests nor issues, and
 * says so by answering `observe()` with an `Err` named `GitHostProviderError`
 * before it performs any remote work. There is no capability discovery and no
 * negotiation: routing middleware selects among installed adapters, and an
 * unsupported kind is a refusal like any other.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation, Result } from "effection";
import { GitHostProviderError } from "./errors.ts";
import type {
  CompleteGitHostEffectRequest,
  GitHostCompletion,
  GitHostObservation,
} from "./records.ts";

/** The stable name every loaded copy composes through. */
export const GIT_HOST_API = "executablemd.workflow.git-host";

/** Which half of one reconciliation attempt is running. */
export type GitHostPhase = "observe" | "perform";

/**
 * What public routing middleware sees: one frozen, one-use routing request.
 *
 * It describes what is being asked of a Git host and where the request sits, so
 * a handler can route or refuse on the facts. It carries no evidence only the
 * provider is entitled to, and no member of it is a capability.
 */
export interface GitHostRoutingRequest {
  readonly intent: "route";
  readonly phase: GitHostPhase;
  readonly request: CompleteGitHostEffectRequest;
}

/**
 * What the selected provider's handler is told, once, by the invocation itself.
 *
 * Reached only through that handler's own continuation, so the phase — and, for
 * a perform, the proven absence it acts on — is never visible to the middleware
 * the request travelled through.
 */
export type GitHostPhaseDetails =
  | { readonly phase: "observe"; readonly request: CompleteGitHostEffectRequest }
  | {
      readonly phase: "perform";
      readonly request: CompleteGitHostEffectRequest;
      readonly observation: GitHostObservation;
    };

/**
 * One message on the Git-host operation.
 *
 * Public middleware only ever receives {@link GitHostRoutingRequest}. The two
 * private members are how the selected provider's handler speaks to the
 * invocation's own terminal through the continuation it captured, and they are
 * declared here only because they travel on the same operation. Constructing
 * one grants nothing: the terminal is reachable from that continuation alone.
 */
export type GitHostCall =
  | GitHostRoutingRequest
  | { readonly intent: "inspect"; readonly routing: GitHostRoutingRequest }
  | {
      readonly intent: "answer";
      readonly routing: GitHostRoutingRequest;
      readonly answer: unknown;
    };

/**
 * What a Git host can be asked, in the order the shared state machine asks it.
 *
 * `observe` always runs first and answers what is provably there. `perform` is
 * reached only from proven absence, and receives that observation as the
 * evidence it acts on.
 *
 * Both answer with Effection's `Result`. The success channel carries a closed
 * normalized shape; the failure channel carries a temporary unavailability, or
 * — from `observe` only — a refusal of an effect kind this host does not
 * support. Anything else it puts there is outside the vocabulary it agreed to
 * speak.
 */
export interface GitHostProvider {
  observe(request: CompleteGitHostEffectRequest): Operation<Result<GitHostObservation>>;
  perform(
    request: CompleteGitHostEffectRequest,
    observation: GitHostObservation,
  ): Operation<Result<GitHostCompletion>>;
}

export interface GitHostApi {
  /**
   * Route one Git-host request.
   *
   * The public call answers nothing: a return value is not evidence, and
   * `reconcileGitHostEffect()` ignores it.
   */
  route(call: GitHostCall): Operation<unknown>;
}

/**
 * The public Git-host surface. Its own default always refuses.
 *
 * Invoking this descriptor with a captured request outside a live invocation
 * reaches this default and completes nothing. A live attempt invokes its own
 * descriptor, which shares this stable name — and so this middleware chain —
 * while terminating in that invocation's private authoritative terminal.
 */
export const GitHost: Api<GitHostApi> = createApi<GitHostApi>(GIT_HOST_API, {
  // deno-lint-ignore require-yield
  *route(): Operation<unknown> {
    throw new GitHostProviderError(
      "no Git host provider accepted this request, and this surface completes nothing on its own",
    );
  },
});
