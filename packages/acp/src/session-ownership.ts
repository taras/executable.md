/**
 * Live ownership of one logical session
 * (specs/native-agent-session-launch-spec.md §Live ownership lease).
 *
 * The durable route decides which construction path a session took. This is
 * the other half: who may act on that session right now. A native coding-agent
 * UI and an ACP turn are both live owners, and neither can see the other from
 * its own side, so the answer comes from a lease the host installs rather than
 * from anything either owner observes.
 *
 * Both refusals are their own class because they are different facts. Busy
 * means someone owns the session and this caller may try again later.
 * Unavailable means nobody can answer the question on this host, which is a
 * reason to stop rather than a reason to retry.
 */

import { createHash } from "node:crypto";
import type { NativeSessionKey } from "./native-session-store.ts";

/** Another XMD owner holds this logical session right now. */
export class SessionBusy extends Error {
  override name = "SessionBusy";
}

/** This host installs no way to take exclusive live ownership of a session. */
export class SessionOwnershipUnavailable extends Error {
  override name = "SessionOwnershipUnavailable";
}

/**
 * The sidecar identity of one logical session.
 *
 * A digest of the natural key, so the coordination namespace holds no agent
 * name, session name, path or authored value — only a name every process
 * derives the same way.
 */
export function sessionLeaseKey(key: NativeSessionKey): string {
  return createHash("sha256")
    .update(JSON.stringify([key.provider, key.agent, key.sessionKey]))
    .digest("hex");
}
