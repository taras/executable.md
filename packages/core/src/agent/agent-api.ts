/**
 * The Agent Api — Effection Api for stateful coding-agent sessions
 * (specs/acp-client-spec.md). Distinct from the stateless Sample Api.
 *
 * Providers install middleware for `agent`, `session`, and `prompt`; the
 * base handlers fail until one is installed. `requestPermission` has a
 * working base implementation that denies every request — permission
 * policies (`<ApproveAll>`, `<AskPermission>`, CLI modes, eval-block
 * middleware) layer on top of it.
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

/** The public agent value — an agent name resolvable by the provider. */
export type Agent = string;

export interface Session {
  sessionKey: string;
  cwd: string;
  agentSessionId?: string;
}

export type AgentPromptEvent =
  | { type: "started"; agent: Agent; session: Session }
  | { type: "text_delta"; text: string }
  | {
      type: "terminal";
      status: "completed" | "failed" | "cancelled";
      stopReason?: string;
      error?: Error;
    };

export interface PromptOptions {
  agent?: Agent;
  session?: string | Session;
  timeout?: number;
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
  session(name?: string): Operation<Session>;
  prompt(content: string, options?: PromptOptions): Operation<Stream<AgentPromptEvent, string>>;
  requestPermission(request: PermissionRequest): Operation<PermissionOutcome>;
}

function noProvider(operation: string): Error {
  return new Error(
    `Agent.${operation} has no provider — install one with <AgentProvider>, ` +
      `registerAgentProvider(...) plus a provider factory, or the CLI's --agent-provider`,
  );
}

export const Agent: Api<AgentApi> = createApi<AgentApi>("Agent", {
  // deno-lint-ignore require-yield
  *agent(_name?: string): Operation<Agent> {
    throw noProvider("agent()");
  },
  // deno-lint-ignore require-yield
  *session(_name?: string): Operation<Session> {
    throw noProvider("session()");
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
  *requestPermission(request: PermissionRequest): Operation<PermissionOutcome> {
    const rejection =
      request.options.find((option) => option.kind === "reject_once") ??
      request.options.find((option) => option.kind === "reject_always");
    if (rejection) {
      return { outcome: "selected", optionId: rejection.optionId };
    }
    return { outcome: "cancelled" };
  },
});
