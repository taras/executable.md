/**
 * Where one machine's agent-session ownership lives, and which hosts can own.
 *
 * Ownership records and lease sidecars have to be found by every XMD process on
 * the host, or they coordinate nothing: two processes resolving different roots
 * would each hold "the" session. So the location comes from the user's home
 * directory rather than from a working directory, a document, or anything a run
 * can vary.
 *
 * A host that cannot take a kernel-released advisory lock and durably replace a
 * record builds nothing here. That is deliberate: an advertised
 * session may be open in a native UI, and a host that cannot
 * answer who owns it refuses rather than guessing.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createDenoAgentSessionCoordinator,
  createDenoExecutableObserver,
} from "@executablemd/runtime";
import type { AgentSessionCoordinator, ExecutableObserver } from "@executablemd/runtime";
import {
  ADVERTISED_CLIENT_NATIVE_ATTACHMENT,
  ADVERTISED_NATIVE_LAUNCH,
  ADVERTISED_PROVIDER_NATIVE_CONTINUATION,
  createDenoSessionRouteStore,
  nativeCapabilityPolicy,
} from "@executablemd/acp";
import type {
  AgentSessionRouteStore,
  NativeCapabilityPolicy,
  NativeCapabilityHost,
} from "@executablemd/acp";

export function sessionCoordinatorRoot(): string {
  return join(homedir(), ".acpx", "xmd-native-sessions", "v1");
}

/**
 * Everything a trusted host states about machine-wide agent sessions.
 *
 * The capability sets are stated rather than inherited. They are separate
 * choices — handing a session to a native UI and later joining that same
 * conversation through ACP prove different things — and a profile whose session
 * authority differs from ordinary `xmd run` must not acquire either by
 * omission. The workflow Agent profile is exactly such a profile: its sessions
 * belong to a run, not to this machine.
 */
export interface MachineSessionAssembly {
  coordinator?: AgentSessionCoordinator;
  routeStore?: AgentSessionRouteStore;
  executableObserver?: ExecutableObserver;
  advertiseNativeLaunch: readonly string[];
  advertiseClientNativeAttachment: readonly string[];
  advertiseProviderNativeContinuation: readonly string[];
  /**
   * Which protocol shapes this host admits each capability on, and the machine
   * it admits them for.
   *
   * Beside the observer rather than derived from the names above, because the
   * names are a coarse selection: an adapter reaches the question through them
   * and is answered here. Absent admits nothing.
   */
  nativeCapabilityPolicy?: NativeCapabilityPolicy;
}

/** This host's session coordinator, or nothing when it cannot provide one. */
export function useSessionCoordinator(): AgentSessionCoordinator | undefined {
  return createDenoAgentSessionCoordinator(sessionCoordinatorRoot());
}

/**
 * Where this host keeps construction routes, beside its leases and ownership
 * records. One session names one lease, one ownership record and one route.
 */
export function useSessionRouteStore(): AgentSessionRouteStore | undefined {
  return createDenoSessionRouteStore(sessionCoordinatorRoot());
}

/**
 * How this host observes which build of an agent executable it would run.
 *
 * Built here, beside the coordinator, and handed straight to the provider. It
 * is not a contextual Api: executable validation decides which retained history
 * may be accepted, and a decision document middleware could replace could point
 * the observation at one binary while the run spawns another.
 */
export function useExecutableObserver(): ExecutableObserver | undefined {
  return createDenoExecutableObserver();
}

/**
 * The ordinary `xmd run` profile: this machine's sessions, and what its
 * adapters have been proved to do on it.
 *
 * `host` is passed in rather than read here, and read at the entrypoint rather
 * than anywhere below it. Which OS and architecture are underneath is exactly
 * the fact an admission is matched against, so a module that went and found it
 * for itself would be supplying the answer as well as the question — and a case
 * stating an exact machine could never contradict it.
 */
export function useMachineSessions(host: NativeCapabilityHost): MachineSessionAssembly {
  return {
    ...(useSessionCoordinator() === undefined ? {} : { coordinator: useSessionCoordinator() }),
    ...(useSessionRouteStore() === undefined ? {} : { routeStore: useSessionRouteStore() }),
    ...(useExecutableObserver() === undefined
      ? {}
      : { executableObserver: useExecutableObserver() }),
    advertiseNativeLaunch: ADVERTISED_NATIVE_LAUNCH,
    advertiseClientNativeAttachment: ADVERTISED_CLIENT_NATIVE_ATTACHMENT,
    advertiseProviderNativeContinuation: ADVERTISED_PROVIDER_NATIVE_CONTINUATION,
    nativeCapabilityPolicy: nativeCapabilityPolicy(host),
  };
}

/**
 * The same advertised names on a host that assembles none of the answers.
 *
 * Node and Bun run the same commands and offer the same agents, and none of
 * them can take a kernel-released advisory lock, keep durable routes, observe a
 * build, or say which builds this machine has proved. Keeping the names is what
 * makes the refusal say so: every advertised operation stops before provider
 * work rather than acting while a native UI may be in the conversation.
 */
export function unassembledMachineSessions(): MachineSessionAssembly {
  return {
    advertiseNativeLaunch: ADVERTISED_NATIVE_LAUNCH,
    advertiseClientNativeAttachment: ADVERTISED_CLIENT_NATIVE_ATTACHMENT,
    advertiseProviderNativeContinuation: ADVERTISED_PROVIDER_NATIVE_CONTINUATION,
  };
}
