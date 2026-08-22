/**
 * ACPX's persistent session store, and the one question a host asks it.
 *
 * A host arranging its own session retention needs two things from ACPX that
 * are not the provider: a store rooted where that host keeps state, and a way to
 * ask what the store already holds for a key. `ensureSession()` answers neither
 * — it creates the session it is asked about — so this is where the read lives.
 *
 * Published from this package because this package is the one that names ACPX. A
 * host reaching `acpx/runtime` itself would be a second place the runtime
 * version is pinned.
 */

import { until } from "effection";
import type { Operation } from "effection";
import { createRuntimeStore } from "acpx/runtime";
import type { AcpSessionStore } from "acpx/runtime";

/** Where ACPX keeps the sessions one host owns. */
export type AcpxSessionStore = AcpSessionStore;

export function createAcpxSessionStore(stateDir: string): AcpxSessionStore {
  return createRuntimeStore({ stateDir });
}

/** What a store still holds for one session key. */
export interface AcpxRetainedSession {
  readonly agentCommand: string;
  /** The provider-native session identity, when the adapter asserted one. */
  readonly agentSessionId?: string;
}

/** The session this store retains under `sessionKey`, creating nothing. */
export function* retainedSession(
  store: AcpxSessionStore,
  sessionKey: string,
): Operation<AcpxRetainedSession | undefined> {
  const record = yield* until(store.load(sessionKey));
  if (!record) {
    return undefined;
  }
  const retained: AcpxRetainedSession = { agentCommand: record.agentCommand };
  return record.agentSessionId === undefined
    ? retained
    : { ...retained, agentSessionId: record.agentSessionId };
}
