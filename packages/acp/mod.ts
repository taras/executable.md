/**
 * @module
 * ACPX agent provider for Executable.md (specs/acp-client-spec.md).
 *
 * `createAcpxProvider()` returns an `AgentProviderFactory` that drives
 * coding agents over the Agent Client Protocol through the pinned
 * `acpx` runtime. Register it with core's `registerAgentProvider` and
 * resolve it through the `AgentProviders` Api.
 */

export { createAcpxProvider } from "./src/provider.ts";
export type { AcpxProviderSeams, ProbeCapableRuntime } from "./src/provider.ts";
export { DEFAULT_AGENT_NAME } from "acpx/runtime";
