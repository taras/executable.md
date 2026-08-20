/**
 * @module
 * ACPX agent provider for Executable.md (specs/acp-client-spec.md).
 *
 * `createAcpxProvider()` returns an `AgentProviderFactory` that drives
 * coding agents over the Agent Client Protocol through the pinned `acpx`
 * runtime. Supply it directly to core's agent components through the
 * `rootProvider` option:
 * `installAgentComponents({ rootProvider: { factory: createAcpxProvider(), options } })`.
 *
 * A harness that needs several independent providers in sibling scopes uses
 * `useAcpxProvider()` instead, which is the same operations without the Agent
 * install. Everything else here — the permission bridge, session placement,
 * turn consumption, and the queues serializing them — is implementation.
 */

export { createAcpxProvider } from "./src/provider.ts";
export type { AcpxProviderDependencies, SessionRouteContext } from "./src/provider.ts";
/** The agent ACPX selects when nothing else is configured. */
export { DEFAULT_AGENT_NAME } from "acpx/runtime";

/**
 * Native session launch: the adapters whose resume command shape this package
 * knows, and the (empty by default) set it is willing to hand a session to.
 */
export {
  ADVERTISED_NATIVE_LAUNCH,
  knownNativeAdapters,
  nativeAdapterFor,
} from "./src/native-launch.ts";
export type { NativeAdapter } from "./src/native-launch.ts";

export {
  AcpxPartitionError,
  createPartitionedAcpxProvider,
  useAcpxProvider,
} from "./src/provider.ts";
export type { AcpxPartitionSelector } from "./src/provider.ts";
export type { AcpxProvider, ProbeCapableRuntime } from "./src/provider.ts";
