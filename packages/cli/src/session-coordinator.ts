/**
 * Where one machine's agent-session coordination state lives.
 *
 * Route claims and lease sidecars have to be found by every XMD process on the
 * host, or they coordinate nothing: two processes resolving different roots
 * would each hold "the" lease for the same session. So the location is derived
 * from the user's home directory rather than from a working directory, a
 * document, or anything a run can vary.
 *
 * It sits beside the ACPX state root and is versioned separately, so clearing
 * one never silently clears the other.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { installDenoSessionLease } from "@executablemd/runtime";
import type { Operation } from "effection";

export function sessionCoordinatorRoot(): string {
  return join(homedir(), ".acpx", "xmd-native-sessions", "v1");
}

/**
 * Install this host's exclusive live ownership of agent sessions.
 *
 * Called by the entrypoints that can offer it, and by nothing else: a host
 * with no kernel-released advisory lock installs nothing, so every
 * client-native path refuses rather than acting without knowing whether a
 * native UI is already in the session.
 */
export function* useSessionCoordination(): Operation<void> {
  yield* installDenoSessionLease(sessionCoordinatorRoot());
}
