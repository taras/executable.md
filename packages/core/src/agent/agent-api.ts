/**
 * The Agent Api — Effection Api for stateful coding-agent sessions
 * (specs/acp-client-spec.md). Distinct from the stateless Sample Api.
 *
 * Providers install middleware for `agent`, `session`, `options`, `prompt`,
 * and `launch`; the base handlers fail until one is installed. A provider that
 * answers `prompt` does not thereby answer `launch` — native session launch
 * is its own capability and is installed on its own. `requestPermission` has a
 * working base implementation that denies every request; permission
 * policies layer on top of it.
 *
 * `prompt` returns `Operation<Stream<...>>`, not a bare `Stream`: a Stream
 * IS an Operation, so a Stream-typed handler result would be subscribed by
 * Api dispatch itself and hand callers a Subscription. The extra Operation
 * layer keeps the returned stream cold — dispatch returns it without
 * starting anything; subscribing resolves the agent and session and starts
 * the turn, and each subscription is an independent turn owned by the
 * subscribing scope.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation, Stream } from "effection";
import type { AgentSessionRequest } from "./session-request.ts";
import type { AgentLaunchRequest } from "./launch-request.ts";

/** The public agent value — an agent name resolvable by the provider. */
export type Agent = string;

/** A provider's confirmed identifier for the conversation a Session describes. */
export interface SessionIdentity {
  /** The provider's namespaced identity kind. */
  readonly kind: string;
  /** The exact opaque identifier confirmed for that kind. */
  readonly value: string;
}

export interface Session {
  sessionKey: string;
  cwd: string;
  agentSessionId?: string;
  /**
   * The confirmed conversation identity, when available.
   *
   * Each read observes the latest confirmation for this Session. The returned
   * frozen pair keeps that reading. Reading creates no conversation and
   * grants no right to act on one.
   */
  readonly identity?: SessionIdentity;
}

/**
 * Which model and effort level a conversation runs under.
 *
 * Both are exact provider IDs — whatever `Agent.options()` advertises for that
 * agent, spelled the way the provider spells it. Core translates neither and
 * substitutes neither: a value the provider does not advertise is refused
 * rather than resolved to a near one.
 *
 * An absent member is not a value. Omitting `model` leaves the conversation on
 * the model it is already using, and omitting `effort` leaves the effort level
 * alone, so a configuration with neither asks for nothing at all.
 */
export interface SessionConfiguration {
  readonly model?: string;
  readonly effort?: string;
}

/**
 * One choice an agent advertises, in the provider's own vocabulary.
 *
 * `id` is the exact value a `<Session>` writes. `name` is what the provider
 * calls it for a reader, and `description` is the provider's own longer text
 * when it supplies one. `group` is the heading the provider filed it under,
 * repeated on every member of that group, and `null` for a choice the provider
 * offered directly.
 */
export interface AgentOption {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly group: { readonly id: string; readonly name: string } | null;
}

/** What an agent currently uses for one setting, and what else it offers. */
export interface AgentOptionSet {
  readonly selected: string;
  readonly options: readonly AgentOption[];
}

/**
 * The model and effort choices one agent advertises right now.
 *
 * Effort choices belong to the selected model: an agent asked about another
 * model answers with that model's levels, which is why the two travel together.
 * A setting the agent does not offer at all is `null` rather than an empty set
 * — "no choices" and "choices, none of them yours" are different answers.
 */
export interface AgentOptions {
  readonly agent: string;
  readonly model: AgentOptionSet | null;
  readonly effort: AgentOptionSet | null;
}

/** Which model to read effort choices for, when not the current one. */
export interface AgentOptionsRequest {
  readonly model?: string;
}

export type ChildAnswerPromptEvent =
  | {
      readonly type: "question_answer_result";
      readonly questionId: string;
      readonly inputId: string;
      readonly result:
        | { readonly status: "accepted" | "stale" | "not-submitted" }
        | {
            readonly status: "invalid";
            readonly reason: "schema";
            readonly issues: readonly import("../validate.ts").NormalizedIssue[];
          }
        | { readonly status: "invalid"; readonly reason: "response-format" };
    }
  | {
      readonly type: "permission_decision_result";
      readonly permissionId: string;
      readonly inputId: string;
      readonly result:
        | { readonly status: "accepted" | "stale" | "not-submitted" }
        | { readonly status: "invalid"; readonly reason: "option-not-offered" | "response-format" };
    };

export type AgentPromptEvent =
  | ChildAnswerPromptEvent
  | { type: "started"; agent: Agent; session: Session }
  | { type: "text_delta"; text: string }
  | {
      type: "terminal";
      status: "completed" | "failed" | "cancelled";
      stopReason?: string;
      error?: Error;
    };

export interface PromptImage {
  readonly mediaType: "image/png";
  readonly data: string;
}

export interface PromptOptions {
  agent?: Agent;
  images?: readonly PromptImage[];
  /**
   * Which conversation this prompt belongs to.
   *
   * A name for the provider to resolve, or the exact `Session` a provider
   * issued. One `<Session>` that named a model or an effort level pins a
   * configured use of that session, which is a `Session` like any other — what
   * it runs under is read through the coordinator delivered to the installed
   * provider, never off the value.
   */
  session?: string | Session;
  timeout?: number;
}

/**
 * Which logical agent and session a native launch prepares. Mirrors
 * `PromptOptions` for `agent` and `session`; a launch is not bounded by a
 * turn timeout, because the person using the native UI decides when it ends.
 */
export interface LaunchOptions {
  agent?: Agent;
  session?: string | Session;
}

/**
 * A native UI that was prepared, handed the terminal, and exited normally.
 *
 * Nonzero exit, a signal, cancellation, detach failure, process creation
 * failure, an unsupported provider, and preparation refusal all fail the
 * operation instead of producing one of these.
 *
 * `launcher` is the provider's stable adapter identity — `claude`, `codex` —
 * never an executable path. `nativeSessionId` is the identity the provider
 * asserted, never one XMD inferred from an ACP string.
 */
export interface SessionLaunchResult {
  agent: Agent;
  session: Session;
  nativeSessionId: string;
  launcher: string;
}

export type PermissionMode = "approve-all" | "approve-reads" | "deny-all";

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface PermissionRequest {
  session: Session;
  toolCall: {
    toolCallId: string;
    title?: string;
    kind?: string;
    rawInput?: unknown;
  };
  options: readonly PermissionOption[];
}

export type PermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

export interface AgentApi {
  agent(name?: string): Operation<Agent>;
  /**
   * Resolve the session this element names.
   *
   * `name` is descriptive and compositional: a handler may observe it, change
   * it, or supply one. A `<Session>` element routes an opaque request instead,
   * which reads as its name to every handler and carries the engine-derived
   * identity where only the installed provider's coordinator can reach it — a
   * durable identity on this chain would be one any middleware could rewrite.
   *
   * What a conversation runs under is not here. Model and effort are settings a
   * `<Session>` supplies, not inputs a handler composes: routing them as a
   * second argument would make them a value every handler could edit, and the
   * conversation would run under the last thing anybody wrote. A handler
   * selects, reroutes or refuses whole sessions, and the provider that issued
   * one owns applying what the document asked of it.
   */
  session(name?: string | AgentSessionRequest): Operation<Session>;
  /**
   * What model and effort choices `agent` advertises.
   *
   * Inspection, not configuration: it reads what the agent offers and returns
   * normalized, provider-ordered choices. `request.model` asks about a model
   * other than the current one, because effort choices belong to a model.
   */
  options(agent?: string, request?: AgentOptionsRequest): Operation<AgentOptions>;
  /**
   * Obtain a cold agent reply stream.
   *
   * Ordinary document calls compose routing through the installed provider
   * chain. A canonical held-conversation call uses outer max prompt middleware
   * for content and transparent stream composition, then a turn-local min
   * terminal bound to its captured provider, selected agent and exact checked
   * Session. Ancestor min routing and default handlers are not dispatched in
   * held mode.
   *
   * In held mode, forward checked options unchanged. The terminal visibly
   * refuses a changed or missing selected agent, exact Session or timeout
   * before native prompt work; it never silently repairs routing or falls back
   * to an ordinary provider terminal. An originally absent timeout remains
   * absent.
   *
   * Select per-turn content inside the returned stream's subscription and
   * delegate once. Wrappers may observe incoming events and own cleanup while
   * forwarding events, order and returned text unchanged.
   *
   * Core fixes final composed input and acknowledges matching feedback intent
   * before native prompt subscription. Canonical completion requires the actual
   * provider outcome, publication and joined cleanup. Middleware answers and
   * stream.done alone establish no canonical completion or retry authority.
   * Constructing the stream starts no native turn.
   */
  prompt(content: string, options?: PromptOptions): Operation<Stream<AgentPromptEvent, string>>;
  /**
   * Route one launch request.
   *
   * This answers nothing. A return value is not evidence a launch happened, and
   * the invocation that issued the request ignores whatever comes back: the
   * only thing that settles a launch is what it retained. Middleware may
   * inspect the request, narrow it with `with()`, refuse by throwing, or
   * delegate it onward.
   */
  launch(request: AgentLaunchRequest): Operation<void>;
  requestPermission(request: PermissionRequest): Operation<PermissionOutcome>;
}

/**
 * The deny decision: `reject_once`, then `reject_always`, otherwise
 * cancellation. Shared by the base handler and every scoped policy, so a
 * policy that cannot approve denies exactly as the base would.
 */
export function denyPermission(request: PermissionRequest): PermissionOutcome {
  const rejection =
    request.options.find((option) => option.kind === "reject_once") ??
    request.options.find((option) => option.kind === "reject_always");
  if (rejection) {
    return { outcome: "selected", optionId: rejection.optionId };
  }
  return { outcome: "cancelled" };
}

function noProvider(operation: string): Error {
  return new Error(
    `Agent.${operation} has no provider — install one with ` +
      `installAgentComponents({ rootProvider: { factory, options } })`,
  );
}

/** The stable name every loaded copy composes through. */
export const AGENT_API = "Agent";

export const Agent: Api<AgentApi> = createApi<AgentApi>(AGENT_API, {
  // deno-lint-ignore require-yield
  *agent(_name?: string): Operation<Agent> {
    throw noProvider("agent()");
  },
  // deno-lint-ignore require-yield
  *session(_name?: string | AgentSessionRequest): Operation<Session> {
    throw noProvider("session()");
  },
  // deno-lint-ignore require-yield
  *options(_agent?: string, _request?: AgentOptionsRequest): Operation<AgentOptions> {
    throw noProvider("options()");
  },
  // deno-lint-ignore require-yield
  *prompt(_content: string, _options?: PromptOptions): Operation<Stream<AgentPromptEvent, string>> {
    return {
      *[Symbol.iterator]() {
        throw noProvider("prompt()");
      },
    };
  },
  // deno-lint-ignore require-yield
  *launch(_request: AgentLaunchRequest): Operation<void> {
    throw noProvider("launch()");
  },
  // deno-lint-ignore require-yield
  *requestPermission(request: PermissionRequest): Operation<PermissionOutcome> {
    return denyPermission(request);
  },
});
