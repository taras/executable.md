/**
 * Private agent-vocabulary state. Deliberately NOT exported from the
 * package: default-agent inheritance, permission-mode state, and the
 * per-execution prompt bookkeeping are internal to the vocabulary — the
 * public AgentApi stays exactly the specified four operations.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";
import type { PermissionMode } from "./agent-api.ts";
import type { AgentPromptError } from "./errors.ts";

interface AgentInternalApi {
  /** Inherited default agent for `<AgentProvider>` option resolution. */
  defaultAgentName: string | undefined;
  /** Inherited permission mode for `<AgentProvider>` option resolution. */
  permissionMode: PermissionMode;
  /** Report a failed prompt to the per-execution collector. */
  recordPromptFailure(error: AgentPromptError, sequence: number): Operation<void>;
  /** Allocate the next prompt sequence number for this execution. */
  nextPromptSequence(): Operation<number>;
  /** Allocate the next per-location ordinal for durable prompt identity. */
  promptOrdinal(location: string): Operation<number>;
}

function noExecution(operation: string): Error {
  return new Error(
    `${operation} requires an active agent execution — install the agent ` +
      `vocabulary with installAgentVocabulary() before executing documents`,
  );
}

export const AgentInternal: Api<AgentInternalApi> = createApi<AgentInternalApi>("agent.internal", {
  defaultAgentName: undefined,
  permissionMode: "deny-all",
  // deno-lint-ignore require-yield
  *recordPromptFailure(_error: AgentPromptError, _sequence: number): Operation<void> {
    throw noExecution("recordPromptFailure()");
  },
  // deno-lint-ignore require-yield
  *nextPromptSequence(): Operation<number> {
    throw noExecution("nextPromptSequence()");
  },
  // deno-lint-ignore require-yield
  *promptOrdinal(_location: string): Operation<number> {
    throw noExecution("promptOrdinal()");
  },
});
