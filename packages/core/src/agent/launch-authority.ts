/**
 * The authority that runs and retains one launch's phases
 * (architecture.md §Authoritative behavior).
 *
 * This is what public middleware never gets. It is delivered, never published:
 * core hands one of these to a provider factory as it installs it, and the
 * factory closes over it. There is no reader, no context holding one, and no
 * member of a request that carries one — an authority reachable by name would
 * be an authority every same-name context and every loaded copy could reach.
 *
 * What it owns is everything that decides whether a launch happened: which
 * request is live, whether this provider is the one installed for it, the order
 * of `prepared -> detached -> exited`, whether each returned record describes
 * the request that was routed, and the result the document settles on. A
 * provider supplies the work; it never supplies the verdict.
 */

import type { Operation } from "effection";
import type { SessionLaunchResult } from "./agent-api.ts";
import { AgentLaunchProtocolError } from "./launch-request.ts";
import type { AgentLaunchRequest, IssuedLaunch } from "./launch-request.ts";
import type { DetachedLaunchRecord, ExitedLaunchRecord, PreparedLaunchRecord } from "./launch.ts";

/**
 * The live work one provider offers for a launch.
 *
 * Each runs at most once, and only when its phase is absent from the journal.
 * A replay of a completed phase never reaches these at all.
 */
export interface AgentLaunchPhases {
  prepare(): Operation<PreparedLaunchRecord>;
  detach(prepared: PreparedLaunchRecord): Operation<DetachedLaunchRecord>;
  exit(prepared: PreparedLaunchRecord): Operation<ExitedLaunchRecord>;
}

export interface AgentProviderAuthority {
  /**
   * Perform the launch `request` names, using `phases` for the work.
   *
   * Validates the request and this provider's installation before any phase
   * runs, so a copied, superseded, foreign or already-performed request costs
   * nothing.
   */
  perform(request: AgentLaunchRequest, phases: AgentLaunchPhases): Operation<void>;
  /**
   * Retain a refusal for `request` and stop.
   *
   * The only record this can author is a prepared failure. A provider that
   * cannot start — no capability, a busy session, a session whose last owner
   * never proved it stopped — says so here, and nothing later is retained.
   */
  refuse(request: AgentLaunchRequest, preparation: PreparedLaunchRecord): Operation<void>;
}

/** How one launch retains its phases, supplied by the invocation that issued it. */
export interface LaunchRetention {
  prepared(live: () => Operation<PreparedLaunchRecord>): Operation<PreparedLaunchRecord>;
  detached(live: () => Operation<DetachedLaunchRecord>): Operation<DetachedLaunchRecord>;
  exited(live: () => Operation<ExitedLaunchRecord>): Operation<ExitedLaunchRecord>;
}

/** One launch, from the authority's side. */
export interface LiveLaunch {
  issued: IssuedLaunch;
  retention: LaunchRetention;
  /** What the retained records settled to, once every phase is accepted. */
  settled?: SessionLaunchResult;
  /** The retained preparation, so a refusal is reportable to the caller. */
  preparation?: PreparedLaunchRecord;
  /** The retained detach, so a handoff that stopped there says why. */
  detachment?: DetachedLaunchRecord;
  /** The retained exit, so how the native UI ended is the caller's answer. */
  exit?: ExitedLaunchRecord;
}

/**
 * Why a retained preparation cannot be the one that was asked for.
 *
 * The provider asserts the session facts, but the request is the document's.
 * A record that changed what was asked would make the journal describe a launch
 * nobody authored.
 */
function crossCheck(request: AgentLaunchRequest, record: PreparedLaunchRecord): string | undefined {
  if (record.instructions !== request.instructions) {
    return "instructions";
  }
  if (record.agent !== request.agent) {
    return "agent";
  }
  if (record.cwd !== request.cwd) {
    return "cwd";
  }
  if (record.permissionMode !== request.permissionMode) {
    return "permission mode";
  }
  if (record.additionalDirectories.length !== request.additionalDirectories.length) {
    return "additional directories";
  }
  for (const [index, directory] of record.additionalDirectories.entries()) {
    if (directory !== request.additionalDirectories[index]) {
      return "additional directories";
    }
  }
  if ((record.requestedModel ?? undefined) !== (request.model ?? undefined)) {
    return "requested model";
  }
  const requested =
    typeof request.session === "object" ? request.session.sessionKey : request.session;
  if (requested !== undefined && record.sessionKey !== requested && record.sessionKey.length > 0) {
    // A provider resolves a logical name to its own key, so only an explicit
    // `Session` value pins the key exactly.
    if (typeof request.session === "object") {
      return "session";
    }
  }
  // A client-allocated identity is only meaningful beside the build that
  // accepted it, so the two travel together or the record is not one this
  // authority will retain. The parser enforces the same pairing on the way back
  // in; this is the live half, before anything durable exists.
  if (record.identityProvenance === "client-allocated" && record.executableBinding === undefined) {
    return "executable binding";
  }
  if (record.identityProvenance === "provider-returned" && record.executableBinding !== undefined) {
    return "identity provenance";
  }
  return undefined;
}

/**
 * The one authority a document installation hands its providers.
 *
 * It resolves which launch a routed request belongs to rather than being told,
 * because being told is what a forged request would do.
 */
export function createLaunchAuthority(
  generation: object,
  live: () => readonly LiveLaunch[],
): AgentProviderAuthority {
  function locate(request: AgentLaunchRequest): LiveLaunch {
    const found = live().find((candidate) => candidate.issued.owns(request));
    if (!found) {
      throw new AgentLaunchProtocolError(
        "this is not a live launch request — a rebuilt or foreign value authorizes no launch",
      );
    }
    return found;
  }

  return {
    *perform(request, phases) {
      const launch = locate(request);
      launch.issued.admit(request, generation);

      const prepared = yield* launch.retention.prepared(() => phases.prepare());
      launch.preparation = prepared;
      if (prepared.failure) {
        // A refusal the provider retained through its own preparation. It stops
        // here exactly as `refuse()` would; nothing later is authored.
        return;
      }
      const mismatch = crossCheck(request, prepared);
      if (mismatch !== undefined) {
        throw new AgentLaunchProtocolError(
          `the provider prepared a session whose ${mismatch} is not what this launch asked for`,
        );
      }
      if (prepared.nativeSessionId.length === 0) {
        throw new AgentLaunchProtocolError(
          "the provider prepared a session but asserted no provider-native identity",
        );
      }

      const detached = yield* launch.retention.detached(() => phases.detach(prepared));
      launch.detachment = detached;
      if (detached.failure) {
        return;
      }

      const exited = yield* launch.retention.exited(() => phases.exit(prepared));
      launch.exit = exited;
      if (exited.failure) {
        return;
      }
      // The handoff itself completed; how the native UI then ended is a
      // separate fact, and one that is retained rather than settled. A launch
      // whose UI died is not a launch to run again.
      if (exited.signal !== undefined || exited.exitCode !== 0) {
        return;
      }

      launch.settled = {
        agent: prepared.agent,
        session: { sessionKey: prepared.sessionKey, cwd: prepared.cwd },
        nativeSessionId: prepared.nativeSessionId,
        launcher: prepared.launcher,
      };
    },

    *refuse(request, preparation) {
      const launch = locate(request);
      launch.issued.admit(request, generation);
      if (!preparation.failure) {
        throw new AgentLaunchProtocolError(
          "a refusal must carry the failure that stopped the launch",
        );
      }
      launch.preparation = yield* launch.retention.prepared(
        // deno-lint-ignore require-yield
        function* () {
          return preparation;
        },
      );
    },
  };
}
