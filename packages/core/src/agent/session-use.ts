/**
 * One authentic use of a conversation (architecture.md §Capability-backed
 * execution).
 *
 * A `<Session>` that names a model or an effort level is saying what one
 * conversation runs under. That fact has to reach the provider with the
 * operation — a provider that remembered it between operations would apply the
 * last thing anybody asked for rather than what this operation asked — and it
 * has to be unforgeable on the way, because every value that travels the public
 * Agent chain is a value middleware can rebuild.
 *
 * So a use is issued, not constructed. Core resolves the exact `Session` the
 * provider returned and wraps it: the result *is* that session — same
 * `sessionKey`, same `cwd`, same asserted identity — so every consumer written
 * against `string | Session` keeps working and nothing new appears in the
 * public signatures. What the wrapper adds is a claim anyone can see and an
 * authority nobody can copy.
 *
 * The claim is a symbol-keyed marker, deliberately visible and deliberately
 * copied by a spread. The authority is a private field, which appears in no key
 * list, no descriptor and no copy. A value carrying the claim without the
 * authority is therefore not an ordinary session that happens to look like one:
 * it is something that presented itself as a configured use and cannot be, and
 * it is refused rather than quietly run unconfigured.
 *
 * Authority belongs to the installation that issued it. A use from another
 * document installation, or from a second loaded copy of this package, carries
 * a field this one cannot read — so it is refused for the same reason a
 * structural copy is.
 */

import type { Session, SessionConfiguration } from "./agent-api.ts";

/**
 * What a configured use claims to be.
 *
 * Exported so a reader can recognize the shape; holding it grants nothing,
 * because the claim is not the authority.
 */
export const CONFIGURED_SESSION: unique symbol = Symbol.for(
  "executablemd.agent.session.configured",
);

/**
 * One use of a conversation: the exact session, and what it runs under.
 *
 * It is a `Session`. The configuration is not a member of it — reading one is
 * `sessionConfiguration()`, and only the installation that issued this value
 * can answer.
 */
export interface AgentSessionUse extends Session {
  readonly [CONFIGURED_SESSION]: true;
}

/** The exact session a routed value names, and what it runs under. */
export interface ReadSessionUse {
  /** The value the provider issued — identity, not a copy of it. */
  readonly session: Session;
  /** Present only for a use this installation issued. */
  readonly configuration?: SessionConfiguration;
}

/** Why a routed value that claims to be a configured use is not one. */
export class AgentSessionUseError extends Error {
  override name = "AgentSessionUseError";
}

/** What one issued use authorizes, and who issued it. */
interface Authority {
  readonly generation: object;
  /** The exact value the provider issued, which is what identity is. */
  readonly session: Session;
  readonly configuration: SessionConfiguration;
}

/**
 * How this module reaches what a use carries, without publishing the way.
 *
 * Assigned once from inside the class body, which is the only place a private
 * field can be named. A symbol would not do: `Object.getOwnPropertySymbols()`
 * returns one as readily as a string key, so a handler could read the authority
 * off a real use and define it on a look-alike. A private field is not a
 * property — it appears in no key list, no descriptor and no copy.
 */
let authorityOf: (routed: unknown) => Authority | undefined;

/**
 * The one value this module will admit as a configured use.
 *
 * It extends nothing and copies everything the provider's `Session` carried, so
 * it is that session by every public measure. `agentSessionId` is copied as it
 * stood when the use was issued; a provider that asserts one later updates its
 * own object, which is why an operation resolves the session it was handed
 * rather than reading identity off this copy.
 */
class ConfiguredSession implements AgentSessionUse {
  readonly #authority: Authority;
  readonly sessionKey: string;
  readonly cwd: string;
  readonly agentSessionId?: string;
  readonly [CONFIGURED_SESSION] = true as const;

  constructor(session: Session, authority: Authority) {
    this.#authority = authority;
    this.sessionKey = session.sessionKey;
    this.cwd = session.cwd;
    if (session.agentSessionId !== undefined) {
      this.agentSessionId = session.agentSessionId;
    }
    Object.freeze(this);
  }

  static {
    // `#authority in routed` is the unforgeable test: a private field can be
    // probed only from inside the class that declares it, and no object this
    // file did not construct has one. It answers rather than throws, so an
    // ordinary refusal does not have to be caught.
    authorityOf = (routed) =>
      typeof routed === "object" && routed !== null && #authority in routed
        ? routed.#authority
        : undefined;
  }
}

/** Whether `value` presents itself as a configured use, authentic or not. */
export function claimsConfiguration(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return CONFIGURED_SESSION in value;
}

/** Whether `value` is a use this build issued. */
export function isSessionUse(value: unknown): value is AgentSessionUse {
  return authorityOf(value) !== undefined;
}

/**
 * The exact `Session` a routed value names.
 *
 * For a use, the value the provider issued — identity, not the wrapper a
 * document was handed. For an ordinary session, itself. For a name, nothing.
 */
export function sessionOf(value: string | Session | undefined): Session | undefined {
  const authority = authorityOf(value);
  if (authority !== undefined) {
    return authority.session;
  }
  return typeof value === "object" && value !== null ? value : undefined;
}

/**
 * What a routed value says its conversation runs under.
 *
 * Nothing for a name or an ordinary session. The frozen configuration for a use
 * this build issued. A refusal for a value that claims to be one and is not:
 * reading such a value as an ordinary session would run the conversation under
 * settings nobody chose, which is the failure this whole shape exists to
 * prevent. Whether a use belongs to *this* installation is a further question,
 * and it is answered where the operation acts — through the coordinator core
 * delivers to the installed provider.
 */
export function configurationOf(
  value: string | Session | undefined,
): SessionConfiguration | undefined {
  const authority = authorityOf(value);
  if (authority !== undefined) {
    return authority.configuration;
  }
  if (claimsConfiguration(value)) {
    throw new AgentSessionUseError(
      "this is not a configured session this build issued — a rebuilt, copied or foreign " +
        "value carries no configuration, and an operation will not proceed as though it did",
    );
  }
  return undefined;
}

/**
 * Issue one use of `session` for `generation`'s document installation.
 *
 * The configuration is copied and frozen here, so the value the provider is
 * handed cannot be edited afterwards by whoever supplied it.
 */
export function issueSessionUse(
  session: Session,
  configuration: SessionConfiguration,
  generation: object,
): AgentSessionUse {
  const copied: SessionConfiguration = Object.freeze({
    ...(configuration.model === undefined ? {} : { model: configuration.model }),
    ...(configuration.effort === undefined ? {} : { effort: configuration.effort }),
  });
  return new ConfiguredSession(session, { generation, session, configuration: copied });
}

/**
 * What `routed` says its conversation runs under, for `generation`.
 *
 * Three answers, and each is a different thing to have been handed:
 *
 * - nothing, for a name or an ordinary `Session` — an unconfigured operation,
 *   which reads and writes no configuration at all;
 * - the frozen configuration, for a use this installation issued;
 * - a refusal, for a value that claims to be a configured use and is not one —
 *   a spread, a descriptor-for-descriptor copy, the real session paired with
 *   different settings, a use from another installation or another loaded copy.
 *
 * The third is the whole reason this is a function rather than a member. A
 * configuration read off the value itself would be one any handler could
 * rewrite, and the operation would carry on under settings the document never
 * authored.
 */
export function readSessionUse(routed: unknown, generation: object): ReadSessionUse | undefined {
  const authority = authorityOf(routed);
  if (authority === undefined) {
    if (claimsConfiguration(routed)) {
      throw new AgentSessionUseError(
        "this is not a configured session this run issued — a rebuilt, copied or foreign " +
          "value carries no configuration, and an operation will not proceed as though it did",
      );
    }
    // An ordinary session, or a name. The value itself is the identity — a
    // copy of it would be a value the provider never issued — and nothing here
    // says anything about what it runs under.
    return isSession(routed) ? { session: routed } : undefined;
  }
  if (authority.generation !== generation) {
    throw new AgentSessionUseError(
      "this configured session belongs to a different agent provider installation, so what " +
        "it says its conversation runs under is not this run's to act on",
    );
  }
  // The value the provider issued, so a provider comparing by identity meets
  // the object it kept rather than the wrapper a document was handed.
  return { session: authority.session, configuration: authority.configuration };
}

/** Whether `value` is shaped like a session a provider issued. */
function isSession(value: unknown): value is Session {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("sessionKey" in value) || !("cwd" in value)) {
    return false;
  }
  const { sessionKey, cwd } = value;
  return typeof sessionKey === "string" && typeof cwd === "string";
}
