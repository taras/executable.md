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
 * provider-returned session may be open in a native UI, and a host that cannot
 * answer who owns it refuses rather than guessing.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createDenoAgentSessionCoordinator } from "@executablemd/runtime";
import type { AgentSessionCoordinator } from "@executablemd/runtime";

export function sessionCoordinatorRoot(): string {
  return join(homedir(), ".acpx", "xmd-native-sessions", "v1");
}

/** This host's session coordinator, or nothing when it cannot provide one. */
export function useSessionCoordinator(): AgentSessionCoordinator | undefined {
  return createDenoAgentSessionCoordinator(sessionCoordinatorRoot());
}
