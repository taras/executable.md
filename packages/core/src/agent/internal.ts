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
import type { AgentPromptPublisher } from "./publication.ts";
import type { AgentPromptError } from "./errors.ts";
import type { Expansion } from "../expansion.ts";

/** `path:line:column`, `line:column`, or `unknown` — the durable effect key. */
export function formatLocation(metadata: Expansion): string {
  const position = metadata.position;
  if (!position) {
    return "unknown";
  }
  const at = `${position.line}:${position.column}`;
  return position.path ? `${position.path}:${at}` : at;
}

interface AgentInternalApi {
  /** Report a failed prompt to the per-execution collector. */
  recordPromptFailure(error: AgentPromptError, sequence: number): Operation<void>;
  /** Allocate the next prompt sequence number for this execution. */
  nextPromptSequence(): Operation<number>;
  /** Allocate the next per-location ordinal for durable prompt identity. */
  promptOrdinal(location: string): Operation<number>;
  /** Allocate the next per-location ordinal for durable launch identity. */
  launchOrdinal(location: string): Operation<number>;
  /** Default agent inherited by `<AgentProvider>`; undefined when unset. */
  defaultAgentName: string | undefined;
  /** Permission mode inherited by `<AgentProvider>`. */
  permissionMode: PermissionMode;
  /**
   * How long a prompt beneath an `<AgentProvider timeout>` may take, in
   * milliseconds; undefined when nothing declared one.
   *
   * The agent layer keeps its own default because the run's `Config.timeout`
   * is the deadline for the whole run, not a per-operation bound (§Config).
   */
  promptTimeout: number | undefined;
  /**
   * Whether a prompt that fails should end the document even though the
   * author did not ask for it (`installPromptFailurePolicy`).
   *
   * Consulted only by the registered `<Prompt>`, and only when the author
   * wrote no explicit `throwOnError`.
   */
  promptFailurePolicy(): Operation<boolean>;
  /**
   * Where a completed Prompt publishes, when a host installed a publisher.
   *
   * Undefined on an ordinary run, which publishes through the durable
   * machinery's own path. A host installs one through
   * `@executablemd/core/host`; there is no other way to name it.
   */
  promptPublisher: AgentPromptPublisher | undefined;
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
  // deno-lint-ignore require-yield
  *launchOrdinal(_location: string): Operation<number> {
    throw noExecution("launchOrdinal()");
  },
  defaultAgentName: undefined,
  permissionMode: "deny-all",
  promptTimeout: undefined,
  promptPublisher: undefined,
  // deno-lint-ignore require-yield
  *promptFailurePolicy(): Operation<boolean> {
    return false;
  },
});
