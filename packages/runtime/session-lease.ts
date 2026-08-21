/**
 * Exclusive live ownership of one logical agent session
 * (specs/native-agent-session-launch-spec.md §Live ownership lease).
 *
 * A durable route decides which construction path a session took. This decides
 * who may act on it *now*, across processes — because a native coding-agent UI
 * and an ACP turn are both live owners, and two of them working the same
 * conversation is not a state either can detect from its own side.
 *
 * Acquisition never waits. A native UI may stay open for hours, and a second
 * `xmd` that queued behind it would hold the user's terminal while offering no
 * way to reach the owner it is waiting for. Refusing says so immediately and
 * leaves the command runnable again once the owner exits.
 *
 * The capability is contextual because it is host arrangement, not provider
 * behavior: a host that can take a kernel-released advisory lock installs one,
 * and a host that cannot installs nothing rather than emulating one. Emulation
 * by pid, timestamp, heartbeat or stale-file timeout admits two owners
 * whenever a process is paused or a pid is reused, which is the one outcome
 * this exists to prevent.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";

/**
 * What asking for a lease answered.
 *
 * `acquired` is held for the asking scope and released when it closes.
 * `busy` means another owner holds it now. `unavailable` means this host
 * installs no implementation at all, which is a different fact: the caller
 * cannot know whether anyone owns the session, so it must not act.
 */
export type SessionLeaseOutcome = "acquired" | "busy" | "unavailable";

export interface SessionLeaseApi {
  /**
   * Try once for exclusive ownership of `key`, without waiting.
   *
   * A successful acquisition lasts for the calling scope; there is no release
   * operation, because a lease released by anything other than scope teardown
   * could outlive the work it protects.
   */
  acquire(key: string): Operation<SessionLeaseOutcome>;
}

export const SessionLease: Api<SessionLeaseApi> = createApi<SessionLeaseApi>(
  "runtime.session.lease",
  {
    // A host that installs nothing cannot answer the question, and answering
    // "nobody owns this" on its behalf is how two owners happen.
    // deno-lint-ignore require-yield
    *acquire(): Operation<SessionLeaseOutcome> {
      return "unavailable";
    },
  },
);
