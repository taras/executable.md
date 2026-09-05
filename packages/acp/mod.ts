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
// The embedded ACP adapters are deliberately absent from this entrypoint. They
// are a temporary arrangement with an exit gate (#636), and anything exported
// here is a stable contract somebody may depend on — removing it later would be
// a compatibility break earned by a workaround. A host reaches them through
// `@executablemd/acp/embedded-adapters`, which goes away with them.
export type {
  AcpMcpServer,
  AcpxProviderDependencies,
  AcpxSessionContext,
  AcpxSessionIdentity,
  AcpxSessionPlacement,
  AcpxSessionPolicy,
  SessionRouteContext,
} from "./src/provider.ts";
/** The agent ACPX selects when nothing else is configured. */
export { DEFAULT_AGENT_NAME } from "./src/acpx-runtime.ts";

/**
 * Native session launch: the adapters whose resume command shape this package
 * knows, and the two separate sets it is willing to use them for — handing a
 * session to a native UI, and attaching ACP to one a native process made.
 */
export {
  ADVERTISED_CLIENT_NATIVE_ATTACHMENT,
  ADVERTISED_NATIVE_LAUNCH,
  knownNativeAdapters,
  nativeAdapterFor,
} from "./src/native-launch.ts";
export { allocatesIdentity, bindsBuild } from "./src/native-launch.ts";
export type {
  BoundProviderReturnedAdapter,
  BuildBoundAdapter,
  ClientAllocatedAdapter,
  NativeAdapter,
  NativeBinding,
  ProviderReturnedAdapter,
} from "./src/native-launch.ts";

/**
 * ACPX's own runtime types.
 *
 * Re-exported because this is the package that pins the `acpx` version, and a
 * second place naming that module would be a second pin. A host substituting or
 * driving the runtime this provider is built on needs them; nothing here is a
 * capability.
 */
export type {
  AcpAgentRegistry,
  AcpPermissionDecision,
  AcpPermissionRequest,
  AcpRuntimeDoctorReport,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeMaterialization,
  AcpRuntimeOptions,
  AcpRuntimeTurn,
  AcpRuntimeTurnInput,
  AcpRuntimeTurnResult,
  AcpSessionRecord,
} from "./src/acpx-runtime.ts";

/**
 * ACPX's persistent session store, for a host arranging its own retention. The
 * provider takes one; this is how a host builds and reads the one it takes.
 */
export { createAcpxSessionStore, retainedSession } from "./src/session-store.ts";
export type { AcpxRetainedSession, AcpxSessionStore } from "./src/session-store.ts";

export {
  AcpxPartitionError,
  createPartitionedAcpxProvider,
  useAcpxProvider,
} from "./src/provider.ts";
export type { AcpxPartitionSelector } from "./src/provider.ts";
export type { AcpxProvider, ProbeCapableRuntime } from "./src/provider.ts";

// The construction route: how a logical session was first constructed, kept
// strictly and create-once beside the coordinator's own records. It is not an
// Agent Api, a component, or a source of launch authority — the coordinator
// remains the single live authority.
export {
  AgentSessionRouteError,
  createDenoSessionRouteStore,
  createMemorySessionRouteStore,
  hasDenoSessionRouteStore,
  parseAgentSessionRoute,
  routeKey,
  routeNamesKey,
  serializeAgentSessionRoute,
} from "./src/session-route.ts";
export type {
  AgentSessionRoute,
  AgentSessionRouteStore,
  AgentSessionRouteV1,
  AgentSessionRouteV2,
  AgentSessionRouteV3,
} from "./src/session-route.ts";
