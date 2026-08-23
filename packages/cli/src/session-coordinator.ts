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
import { createDenoSessionRouteStore } from "@executablemd/acp";
import type { AgentSessionRouteStore } from "@executablemd/acp";

export function sessionCoordinatorRoot(): string {
  return join(homedir(), ".acpx", "xmd-native-sessions", "v1");
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
 * How this host observes the build behind an agent's executable.
 *
 * Built here, from the real process environment, because a resolver a document
 * could replace is a resolver that can point the observation at one binary
 * while the run spawns another.
 */
export function useExecutableObserver(): ExecutableObserver | undefined {
  return createDenoExecutableObserver();
}
