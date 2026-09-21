/**
 * Who settles a placement, and for how long.
 *
 * A configured `<Session>` asks its conversation to run under a model and an
 * effort level. That request reaches the provider sealed inside the opaque
 * placement, so no handler can read or edit it — but somebody has to be there
 * when the provider answers: to hear which exact conversation it resolved, to
 * ask that provider how *that* conversation is configured, and to be the one
 * thing that mints a configured use out of the pair.
 *
 * That somebody is this owner. One is created inside each installed provider's
 * own operation, as an ordinary closure. Nothing points back to it — no
 * context, no module table, no property on a session, no middleware value — and
 * the provider reaches it only through the coordinator delivered to its
 * factory. Two providers installed side by side own different ones, as do two
 * document runs, so neither can see, spend or complete the other's placements.
 *
 * ## Lifetime is the point
 *
 * A registration is a live provider saying "this is how I configure that exact
 * conversation". When the provider is dismantled the statement stops being
 * true, so the owner closes immediately after the provider's finalizers and
 * drops everything it held. A placement completed after that, or a
 * configuration asked for after that, refuses rather than reaching a provider
 * that is no longer there.
 *
 * ## What completion decides
 *
 * The provider resolves the conversation and says which kind it is. A fresh
 * placement has nothing to configure yet, so it is inert: its first consumer
 * constructs the conversation and performs the whole ordered sequence. An
 * established one already has a route and an identity, so it is configured
 * here, and the value sealed into the use is the canonical one the provider
 * verified — not the one that was asked for, which is how a provider that
 * quietly applied something else is caught rather than recorded.
 */

import type { Operation } from "effection";
import type { Session, SessionConfiguration } from "./agent-api.ts";
import { AgentSessionProtocolError, readPlacement } from "./session-request.ts";
import type { AgentSessionRequest } from "./session-request.ts";
import { issueSessionUse, readSessionUse } from "./session-use.ts";
import type { ReadSessionUse } from "./session-use.ts";

/**
 * Put one established conversation under `configuration`, and verify it.
 *
 * Answers with what the provider actually verified, which is what the use will
 * carry. A provider that applied something else describes it here rather than
 * leaving core to assume.
 */
export type ConfigureAgentSession = (
  configuration: SessionConfiguration,
) => Operation<SessionConfiguration>;

/** What the provider resolved, and whether it is a conversation yet. */
export type AgentSessionPlacementState =
  | { readonly kind: "fresh" }
  | { readonly kind: "established"; readonly configure: ConfigureAgentSession };

/** One placement, handed to the provider that is resolving it. */
export interface AgentSessionPlacement {
  /** The engine-derived identity, when an element opened this placement. */
  readonly sessionIdentity?: string;
  /** Settle this placement with the exact Session the provider resolved. */
  complete(session: Session, state: AgentSessionPlacementState): Operation<Session>;
}

/** What one installed provider's registrations belong to. */
export interface SessionPlacementOwner {
  /** Accept the exact live final request, once. */
  placement(request: AgentSessionRequest): AgentSessionPlacement;
  /**
   * What a routed value says its conversation runs under.
   *
   * This owner issued the use, so this owner is what can read it. A use another
   * provider installation minted is not this one's to act on, even inside the
   * same document — two providers are two authorities, and a conversation one
   * of them configured is one only it can describe.
   */
  read(routed: string | Session | undefined): ReadSessionUse | undefined;
  /** Drop everything, after the provider's own finalizers have run. */
  close(): void;
}

/**
 * Open one owner for the provider installation `generation` identifies.
 *
 * Created inside that installation's operation and closed by it. The generation
 * is what a use is issued against, so a use this owner minted is one only this
 * installation can read.
 */
export function createSessionPlacementOwner(): SessionPlacementOwner {
  /**
   * What this owner's uses are issued against, and nothing else's.
   *
   * Not the document's generation: a document may install two providers, and a
   * use one of them minted describes a conversation only that provider knows
   * how to configure. Keying on the owner is what makes reading one another's
   * uses impossible rather than merely unlikely.
   */
  const authority = {};
  /**
   * How each exact Session this provider issued is configured.
   *
   * Identity, not shape: a rebuilt look-alike describes the same conversation
   * and was registered by nobody. Weak, because a released conversation should
   * leave nothing here.
   */
  let registrations = new WeakMap<Session, ConfigureAgentSession>();
  let live = true;

  function register(session: Session, configure: ConfigureAgentSession): void {
    const known = registrations.get(session);
    if (known === undefined) {
      registrations.set(session, configure);
      return;
    }
    if (known !== configure) {
      // One conversation, one way to configure it. Two different operations for
      // the same Session means two answers to the same question, and choosing
      // between them is not this owner's to do.
      throw new AgentSessionProtocolError(
        "this provider registered one conversation with two different ways of configuring it, " +
          "so there is no single answer to what putting it under a model and an effort level " +
          "does",
      );
    }
  }

  return {
    placement(request: AgentSessionRequest): AgentSessionPlacement {
      if (!live) {
        throw new AgentSessionProtocolError(
          "this agent provider installation has been dismantled, so a placement routed to it " +
            "reaches nothing that could resolve or configure a conversation",
        );
      }
      // One use of the placement, checked here: a request kept from an earlier
      // element, routed twice, or built to look like one names no session.
      const placed = readPlacement(request);
      let settled = false;

      return {
        ...(placed.sessionIdentity === undefined
          ? {}
          : { sessionIdentity: placed.sessionIdentity }),
        *complete(session: Session, state: AgentSessionPlacementState): Operation<Session> {
          if (!live) {
            throw new AgentSessionProtocolError(
              "this agent provider installation has been dismantled, so the conversation it " +
                "just resolved cannot be registered or configured",
            );
          }
          if (settled) {
            throw new AgentSessionProtocolError(
              "this session placement has already been settled, and one placement settles one " +
                "conversation",
            );
          }
          settled = true;
          if (state.kind === "established") {
            register(session, state.configure);
          }
          const asked = placed.configuration;
          if (asked === undefined) {
            // Nothing was asked, so nothing is applied and nothing is minted:
            // the conversation the provider resolved is the answer.
            return session;
          }
          if (state.kind === "fresh") {
            // A conversation that does not exist yet has nothing to put under
            // anything. The use carries what was asked, and the first consumer
            // applies it.
            return issueSessionUse(session, asked, authority);
          }
          const verified = yield* state.configure(asked);
          return issueSessionUse(session, sealed(asked, verified), authority);
        },
      };
    },
    read(routed) {
      if (!live) {
        // A use is a live provider saying what one of its conversations runs
        // under. Once that provider is gone the statement is not false, it is
        // unanswerable — so this refuses rather than reporting settings nothing
        // could still be honouring.
        throw new AgentSessionProtocolError(
          "this agent provider installation has been dismantled, so what its sessions were " +
            "running under is no longer something it can answer for",
        );
      }
      return readSessionUse(routed, authority);
    },
    close(): void {
      live = false;
      // Dropped rather than left to the collector: what this owner knew about
      // configuring conversations stops existing when the provider does.
      registrations = new WeakMap<Session, ConfigureAgentSession>();
    },
  };
}

/**
 * The canonical value a provider verified, checked against what was asked.
 *
 * Exactly the members that were asked for, and exactly those values. A provider
 * that answered with something else put the conversation somewhere the document
 * did not ask for, and a use carrying that value would describe a conversation
 * nobody chose.
 */
function sealed(
  asked: SessionConfiguration,
  verified: SessionConfiguration | undefined,
): SessionConfiguration {
  if (typeof verified !== "object" || verified === null) {
    throw new AgentSessionProtocolError(
      "this agent provider did not say what it put the conversation under, so there is " +
        "nothing to record that the turn ran under",
    );
  }
  for (const setting of ["model", "effort"] as const) {
    const wanted = asked[setting];
    const got = verified[setting];
    if (wanted === undefined) {
      if (got !== undefined) {
        throw new AgentSessionProtocolError(
          `this agent provider reported a ${setting} for a conversation that asked for none, ` +
            `so what it is running under is not what was asked`,
        );
      }
      continue;
    }
    if (got !== wanted) {
      throw new AgentSessionProtocolError(
        `this agent provider reported the ${setting} "${String(got)}" for a conversation asked ` +
          `to run under "${wanted}", so it is not running under what was asked`,
      );
    }
  }
  return Object.freeze({
    ...(asked.model === undefined ? {} : { model: asked.model }),
    ...(asked.effort === undefined ? {} : { effort: asked.effort }),
  });
}
