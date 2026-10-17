/**
 * Who settles a session setup, and for how long.
 *
 * A configured `<Session>` asks its conversation to run under a model and an
 * effort level. That request reaches the provider sealed inside the opaque
 * session request, so no handler can read or edit it — but somebody has to be there
 * when the provider answers: to hear which exact conversation it resolved, to
 * ask that provider how *that* conversation is configured, and to be the one
 * thing that mints a configured use out of the pair.
 *
 * That somebody is this owner. One is created inside each installed provider's
 * own operation, as an ordinary closure. Nothing points back to it — no
 * context, no module table, no property on a session, no middleware value — and
 * the provider reaches it only through the coordinator delivered to its
 * factory. Two providers installed side by side own different ones, as do two
 * document runs, so neither can see, spend or finish the other's setups.
 *
 * ## Lifetime is the point
 *
 * A registration is a live provider saying "this is how I configure that exact
 * conversation". When the provider is dismantled the statement stops being
 * true, so the owner closes immediately after the provider's finalizers and
 * drops everything it held. A setup finished after that, or a
 * configuration asked for after that, refuses rather than reaching a provider
 * that is no longer there.
 *
 * ## What finishing decides
 *
 * The provider resolves the conversation and says which kind it is. A new
 * session has nothing to configure yet, so it is inert: its first consumer
 * creates the conversation and performs the whole ordered sequence. An
 * existing one already has a route and an identity, so it is configured
 * here, and the value sealed into the use is the canonical one the provider
 * verified — not the one that was asked for, which is how a provider that
 * quietly applied something else is caught rather than recorded.
 */

import { Ok } from "effection";
import type { Operation, Result } from "effection";
import type { Session, SessionConfiguration } from "./agent-api.ts";
import type { ProviderSessionConfiguration } from "./provider-configuration.ts";
import { AgentSessionProtocolError, consumeSessionRequest } from "./session-request.ts";
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

export type { ProviderSessionConfiguration } from "./provider-configuration.ts";

/** What the provider resolved, and whether it is a conversation yet. */
export type AgentSessionSetupState =
  | { readonly kind: "new" }
  | { readonly kind: "existing"; readonly configure: ConfigureAgentSession };

/** One session setup, handed to the provider that is resolving it. */
export interface AgentSessionSetup {
  /** The engine-derived identity, when an element opened this request. */
  readonly sessionIdentity?: string;
  /**
   * Authorize provider work; a retained conversation requires its configuration.
   *
   * Asked before the provider reattaches, creates or prompts anything, and
   * answered from what the conversation this request belongs to already holds.
   * A retained conversation is continued only under the configuration it was
   * created with, so this is where a difference is refused — after `finish`
   * would be after the reattachment it was supposed to prevent.
   *
   * `provider` and `agentCommand` are the compatibility facts the conversation
   * already compares. `configuration` is what this provider is about to
   * construct under: required for a retained conversation, and omitted by an
   * ordinary setup, which saves none and keeps its existing behavior.
   *
   * One attempt belongs to one setup. A refusal, a cancellation or a closure
   * leaves that setup unable to retry or to finish; a later explicit action
   * gets a setup of its own. An `Ok` authorizes provider work and asserts
   * nothing about native creation.
   */
  activate(
    provider: string,
    agentCommand: string,
    configuration?: ProviderSessionConfiguration,
  ): Operation<Result<void>>;
  /** Settle this setup with the exact Session the provider resolved. */
  finish(session: Session, state: AgentSessionSetupState): Operation<Session>;
}

/** What one installed provider's registrations belong to. */
export interface SessionSetupOwner {
  /** Accept the exact live final request, once. */
  setup(request: AgentSessionRequest): AgentSessionSetup;
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
export function createSessionSetupOwner(): SessionSetupOwner {
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
    setup(request: AgentSessionRequest): AgentSessionSetup {
      if (!live) {
        throw new AgentSessionProtocolError(
          "this agent provider installation has been dismantled, so a session request routed to it " +
            "reaches nothing that could resolve or configure a conversation",
        );
      }
      // One use of the request, checked here: a request kept from an earlier
      // element, routed twice, or built to look like one names no session.
      const requested = consumeSessionRequest(request);
      let settled = false;
      // One attempt, and whether it succeeded, kept apart. A setup that tried
      // and failed is not a setup that has not tried: it can neither try again
      // nor settle, which is what makes a refused activation final for this
      // handle rather than something a provider could retry past.
      let attempted = false;
      let activated = false;

      /** Why this setup can do nothing more, or nothing at all. */
      function unusable(because: string): AgentSessionProtocolError | undefined {
        if (!live) {
          return new AgentSessionProtocolError(
            `this agent provider installation has been dismantled, so ${because}`,
          );
        }
        if (!requested.live()) {
          return new AgentSessionProtocolError(
            "the element that opened this session request has already finished with its " +
              `session, so ${because}`,
          );
        }
        return undefined;
      }

      /**
       * What settling this setup produces, before anybody is told it did.
       *
       * Separated from `finish` only so the one value it answers with is the
       * one value recorded as this request's own: three outcomes written
       * inline were three places to forget.
       */
      function* settlement(session: Session, state: AgentSessionSetupState): Operation<Session> {
        const asked = requested.configuration;
        if (asked === undefined) {
          // Nothing was asked, so nothing is applied and nothing is minted:
          // the conversation the provider resolved is the answer.
          return session;
        }
        if (state.kind === "new") {
          // A conversation that does not exist yet has nothing to put under
          // anything. The use carries what was asked, and the first consumer
          // applies it.
          return issueSessionUse(session, asked, authority);
        }
        const verified = yield* state.configure(asked);
        return issueSessionUse(session, sealed(asked, verified), authority);
      }

      return {
        ...(requested.sessionIdentity === undefined
          ? {}
          : { sessionIdentity: requested.sessionIdentity }),
        *activate(
          provider: string,
          agentCommand: string,
          configuration?: ProviderSessionConfiguration,
        ): Operation<Result<void>> {
          const refusal = unusable(
            "there is nothing here that could authorize work against a conversation",
          );
          if (refusal !== undefined) {
            throw refusal;
          }
          if (attempted) {
            throw new AgentSessionProtocolError(
              "this session setup has already been activated once, and one setup authorizes one " +
                "attempt — a later explicit action asks for a setup of its own",
            );
          }
          // Marked before anything suspends. A cancellation inside the
          // acknowledgement below unwinds through here, and an attempt that
          // cancelling could reopen is not one attempt.
          attempted = true;
          const admit = requested.admit;
          if (admit === undefined) {
            // An ordinary session request. There is no retained conversation to
            // hold this to, so nothing is saved and nothing is compared — and
            // the provider is authorized exactly as it was before any of this
            // existed.
            activated = true;
            return Ok(undefined);
          }
          const judged = yield* admit(provider, agentCommand, configuration);
          if (!judged.ok) {
            // Left unactivated deliberately. The conversation refused what this
            // provider was about to construct under, so this setup settles
            // nothing: the refusal is the provider's answer, and there is no
            // second chance on this handle to reach `finish` with.
            return judged;
          }
          activated = true;
          return Ok(undefined);
        },
        *finish(session: Session, state: AgentSessionSetupState): Operation<Session> {
          const refusal = unusable(
            "the conversation it just resolved cannot be registered or configured",
          );
          if (refusal !== undefined) {
            throw refusal;
          }
          if (!activated) {
            throw new AgentSessionProtocolError(
              "this session setup has not been activated, so the work that resolved this " +
                "conversation was never authorized — a session setup is activated before the " +
                "provider reattaches, creates or prompts anything",
            );
          }
          if (settled) {
            throw new AgentSessionProtocolError(
              "this session setup has already been settled, and one setup settles one " +
                "conversation",
            );
          }
          settled = true;
          if (state.kind === "existing") {
            register(session, state.configure);
          }
          const resolved = yield* settlement(session, state);
          // Written here, after everything that could still refuse: a setup
          // that raised while applying what was asked settled nothing, and the
          // request it belonged to must not claim a session it never got. What
          // the opener will compare its answer against is this exact value —
          // the authentic use included, because that is what a turn runs in.
          requested.finished(resolved);
          return resolved;
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
