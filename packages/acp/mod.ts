/**
 * @module
 * ACPX agent provider for Executable.md (specs/acp-client-spec.md).
 *
 * `createAcpxProvider()` returns an `AgentProviderFactory` that drives
 * coding agents over the Agent Client Protocol through the pinned `acpx`
 * runtime. Supply it directly to core's agent components through the
 * `rootProvider` option:
 * `installAgentComponents({ rootProvider: { factory: createAcpxProvider(), options } })`.
 */

export { createAcpxProvider, useAcpxProviderState } from "./src/provider.ts";
export { useSerialQueues } from "./src/serial-queue.ts";
export type { SerialQueues } from "./src/serial-queue.ts";
export type {
  AcpxProviderSeams,
  AcpxProviderState,
  ProbeCapableRuntime,
  SessionRoutingContext,
} from "./src/provider.ts";
/** The agent ACPX selects when nothing else is configured. */
export { DEFAULT_AGENT_NAME } from "acpx/runtime";
