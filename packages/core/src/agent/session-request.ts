/**
 * The opaque session-placement request (architecture.md §Capability-backed
 * execution).
 *
 * Which conversation a `<Session>` element *is* has to survive the public chain.
 * `Agent.session()` is compositional on purpose — a wrapper narrows it, a test
 * pins it, `<Session>` itself composes it — and every one of those handlers can
 * replace the arguments it routes. A durable identity carried there would be a
 * durable identity any middleware could rewrite, which is how two sibling
 * `<Session name="review">` sites become one retained mapping.
 *
 * So the two travel apart. The **authored name** stays on the public chain,
 * where it is descriptive and a handler may observe or change it. The
 * **engine-derived expansion identity** travels inside this request, reachable
 * only through the coordinator delivered to the installed provider. A handler
 * holds the request and can read the name; it cannot read, copy or forge the
 * identity, and a look-alike it builds carries none.
 *
 * A placement is bound to the element that opened it and is good for one use.
 * Both matter: a handler that kept the first `<Session>` element's placement
 * could otherwise route it for the second, and both sites would resolve to the
 * first element's identity — the collision engine identity exists to prevent.
 * `with({ name })` derives a sibling sharing that one issuance rather than
 * opening another, which is exactly what "middleware may alter the descriptive
 * name" means.
 *
 * What a configured `<Session>` asks of its conversation travels the same way.
 * It is sealed into the issuance before the request is routed, so a handler
 * holding the request can transfer the whole route — which is what routing is
 * for — and cannot read the settings, edit them, or attach them to a route of
 * its own. A structural copy, a descriptor clone, an object built on this
 * prototype and a request another loaded copy produced carry no issuance, so
 * they carry no settings either.
 */

import type { SessionConfiguration } from "./agent-api.ts";

/** What public session middleware is handed. The name, and nothing else. */
export interface AgentSessionRequest {
  /**
   * The authored `<Session name>`, when the document wrote one.
   *
   * Descriptive. It names nothing durable, and two sessions may share it.
   */
  readonly name?: string;
  /** Derive a request with a different descriptive name, same identity. */
  with(changes: { name?: string }): AgentSessionRequest;
}

/** Why a routed placement cannot act. Never carries the request itself. */
export class AgentSessionProtocolError extends Error {
  override name = "AgentSessionProtocolError";
}

/** What the engine settled about one `<Session>` element. */
export interface Placement {
  /**
   * The engine-derived expansion identity. Never authored, never routed.
   *
   * Absent for a placement core opened for a programmatic caller: there is no
   * element, so there is nothing durable to name.
   */
  readonly sessionIdentity?: string;
  /** What this placement asks its conversation to run under, when it asks. */
  readonly configuration?: SessionConfiguration;
}

/**
 * One `<Session>` element's issuance.
 *
 * Held by the invocation that opened it and reached only through the closure the
 * placement captures. Nothing on the public request points back here, because
 * everything a handler holds it can read.
 */
interface Issuance {
  /** The engine-derived expansion identity, when an element opened this. */
  readonly sessionIdentity?: string;
  /**
   * What the caller asked this conversation to run under.
   *
   * Sealed before the request is routed and frozen, so the value a provider is
   * eventually told is the value the document authored rather than one a
   * handler replaced on the way.
   */
  configuration?: SessionConfiguration;
  /**
   * True once what this placement asks has been settled, however it settled.
   *
   * An element settles it before the request is routed — to a configuration, or
   * to nothing at all — so by the time any handler holds the request there is
   * nothing left to say. That is what makes the sealing one-way rather than
   * merely first-come.
   */
  settled: boolean;
  /** False once the element it belongs to finished placing. */
  live: boolean;
  /** True once the coordinator read it; a second read refuses. */
  accepted: boolean;
}

/**
 * How this module reaches what a placement carries, without publishing the way.
 *
 * Assigned once from inside the class body, which is the only place a private
 * field can be named. A symbol would not do: `Object.getOwnPropertySymbols()`
 * returns one as readily as a string key, so a handler could read the issuance
 * off a real request and define it on a look-alike. A private field is not a
 * property — it appears in no key list, no descriptor and no copy.
 */
let issuanceOf: (routed: unknown) => Issuance | undefined;

/**
 * The one value this module will admit as a placement, and the only thing that
 * is one.
 *
 * Identity is the field itself. A structural look-alike, a descriptor-for-
 * descriptor clone, an object built on this prototype and a request another
 * loaded copy produced are none of them one.
 */
class SessionPlacement implements AgentSessionRequest {
  readonly #issuance: Issuance;
  readonly name?: string;

  constructor(issuance: Issuance, name: string | undefined) {
    this.#issuance = issuance;
    if (name !== undefined) {
      this.name = name;
    }
    Object.freeze(this);
  }

  static {
    // `#issuance in routed` is the unforgeable test: a private field can be
    // probed only from inside the class that declares it, and no object this
    // file did not construct has one. It answers rather than throws, so an
    // ordinary refusal does not have to be caught.
    issuanceOf = (routed) =>
      typeof routed === "object" && routed !== null && #issuance in routed
        ? routed.#issuance
        : undefined;
  }

  /**
   * Derive a request with a different descriptive name.
   *
   * The derivative shares this issuance rather than opening one: a handler
   * renaming a placement is still routing the same element's placement, and
   * deriving must not manufacture a second use of it.
   */
  with(changes: { name?: string }): AgentSessionRequest {
    return new SessionPlacement(
      this.#issuance,
      changes.name === undefined ? this.name : changes.name,
    );
  }
}

/**
 * What one `<Session>` element holds while it places its session.
 *
 * `close()` ends it. Everything the issuance produced — the request and every
 * `with()` derivative — stops authorizing anything at that moment, which is what
 * stops a handler keeping the first element's placement and routing it for the
 * second. Both would otherwise resolve to the first element's identity, which is
 * exactly the collision engine identity exists to prevent.
 */
export interface SessionPlacementIssuance {
  readonly request: AgentSessionRequest;
  /**
   * Say what this placement asks its conversation to run under, or that it asks
   * nothing.
   *
   * The opener's alone, and called before the request is routed. It settles the
   * question either way and cannot be called again, so a handler that later
   * holds the request has nothing left to overwrite and no unconfigured
   * placement left to attach settings to. The value is copied and frozen, so
   * whoever supplied it cannot edit what the provider is eventually told.
   */
  configure(configuration: SessionConfiguration | undefined): void;
  close(): void;
}

/**
 * Open one placement for the element the engine is expanding.
 *
 * `sessionIdentity` comes from the `ComponentInvocation` the engine handed the
 * component, which is the one channel a document cannot reach.
 */
export function sessionPlacement(
  sessionIdentity: string | undefined,
  name: string | undefined,
): SessionPlacementIssuance {
  const issuance: Issuance = {
    ...(sessionIdentity === undefined ? {} : { sessionIdentity }),
    settled: false,
    live: true,
    accepted: false,
  };
  return {
    request: new SessionPlacement(issuance, name),
    configure(configuration: SessionConfiguration | undefined): void {
      settle(issuance, configuration);
    },
    close(): void {
      issuance.live = false;
    },
  };
}

/**
 * Seal `configuration` into the issuance `routed` belongs to.
 *
 * Core's own, for the element that already opened a placement and is only now
 * saying what it asks of the conversation. A value that is not a live placement
 * refuses rather than silently asking for nothing.
 */
export function configurePlacement(routed: unknown, configuration: SessionConfiguration): void {
  const issuance = issuanceOf(routed);
  if (issuance === undefined || !issuance.live) {
    throw new AgentSessionProtocolError(
      "this is not a live session placement, so there is nothing here to configure",
    );
  }
  settle(issuance, configuration);
}

/**
 * Settle what one placement asks, once.
 *
 * Whoever opened the placement says this before routing it, and nothing says it
 * afterwards. A second attempt is refused rather than merged or ignored: a
 * placement whose settings could still change after a handler saw it is a
 * placement whose settings a handler can choose.
 */
function settle(issuance: Issuance, configuration: SessionConfiguration | undefined): void {
  if (issuance.settled) {
    throw new AgentSessionProtocolError(
      "this session placement already says what it asks of its conversation — what a " +
        "<Session> authored is settled before the placement is routed, so nothing that " +
        "receives the placement afterwards can add to it or replace it",
    );
  }
  issuance.settled = true;
  if (configuration !== undefined) {
    issuance.configuration = frozenConfiguration(configuration);
  }
}

/** A copy of what was asked, frozen, carrying only the two settings. */
function frozenConfiguration(configuration: SessionConfiguration): SessionConfiguration {
  return Object.freeze({
    ...(configuration.model === undefined ? {} : { model: configuration.model }),
    ...(configuration.effort === undefined ? {} : { effort: configuration.effort }),
  });
}

/** Whether `value` is a placement this module issued. */
export function isSessionRequest(value: unknown): value is AgentSessionRequest {
  return issuanceOf(value) !== undefined;
}

/**
 * The engine identity `routed` carries, for the holder of launch coordination.
 *
 * One use, and only while the element that opened it is still placing. A
 * placement a handler saved from an earlier `<Session>` is not live; one it
 * routed twice is already accepted; and either way the answer is a refusal
 * rather than the first element's identity a second time.
 */
export function readPlacement(routed: unknown): Placement {
  const issuance = issuanceOf(routed);
  if (issuance === undefined) {
    throw new AgentSessionProtocolError(
      "this is not a live session placement, so it names no session identity",
    );
  }
  if (!issuance.live) {
    throw new AgentSessionProtocolError(
      "this session placement belongs to an element that has already placed its session — a " +
        "placement kept from an earlier <Session> names no session here",
    );
  }
  if (issuance.accepted) {
    throw new AgentSessionProtocolError(
      "this session placement has already been used, and one element places one session",
    );
  }
  issuance.accepted = true;
  return {
    ...(issuance.sessionIdentity === undefined
      ? {}
      : { sessionIdentity: issuance.sessionIdentity }),
    ...(issuance.configuration === undefined ? {} : { configuration: issuance.configuration }),
  };
}
