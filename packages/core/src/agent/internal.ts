/**
 * Private agent-component state. Deliberately NOT exported from the
 * package: the per-execution prompt bookkeeping and the seeded provider
 * configuration are internal to the components — the public AgentApi
 * stays exactly the specified four operations.
 *
 * The configuration values are seeded by `installAgentComponents()` and
 * read back by `<AgentProvider>`; this Api is the seeding mechanism, not
 * a public way to override them.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";
import type { PermissionMode } from "./agent-api.ts";
import type { AgentPromptError } from "./errors.ts";

interface AgentInternalApi {
  /** Report a failed prompt to the per-execution collector. */
  recordPromptFailure(error: AgentPromptError, sequence: number): Operation<void>;
  /** Allocate the next prompt sequence number for this execution. */
  nextPromptSequence(): Operation<number>;
  /** Allocate the next per-location ordinal for durable prompt identity. */
  promptOrdinal(location: string): Operation<number>;
  /** Default agent inherited by `<AgentProvider>`; undefined when unset. */
  defaultAgentName: string | undefined;
  /** Permission mode inherited by `<AgentProvider>`. */
  permissionMode: PermissionMode;
}

function noExecution(operation: string): Error {
  return new Error(
    `${operation} requires an active agent execution — install the agent ` +
      `components with installAgentComponents() before executing documents`,
  );
}

export const AgentInternal: Api<AgentInternalApi> = createApi<AgentInternalApi>("agent.internal", {
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
  defaultAgentName: undefined,
  permissionMode: "deny-all",
});
