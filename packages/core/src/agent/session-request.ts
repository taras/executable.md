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
 * only through the authority delivered to the installed provider. A handler
 * holds the request and can read the name; it cannot read, copy or forge the
 * identity, and a look-alike it builds carries none.
 *
 * Unlike a launch, a placement is a lookup rather than an authoritative action:
 * asking twice answers twice and settles nothing. So there is no one-use rule
 * here and no superseding leaf — `with({ name })` derives a sibling carrying the
 * same identity, which is exactly what "middleware may alter the descriptive
 * name" means.
 */

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
interface Placement {
  /** The engine-derived expansion identity. Never authored, never routed. */
  readonly sessionIdentity: string;
}

/**
 * One `<Session>` element's issuance.
 *
 * Held by the invocation that opened it and reached only through the closure the
 * placement captures. Nothing on the public request points back here, because
 * everything a handler holds it can read.
 */
interface Issuance {
  /** The engine-derived expansion identity. Never authored, never routed. */
  readonly sessionIdentity: string;
  /** False once the element it belongs to finished placing. */
  live: boolean;
  /** True once the authority read it; a second read refuses. */
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
  close(): void;
}

/**
 * Open one placement for the element the engine is expanding.
 *
 * `sessionIdentity` comes from the `ComponentInvocation` the engine handed the
 * component, which is the one channel a document cannot reach.
 */
export function sessionPlacement(
  sessionIdentity: string,
  name: string | undefined,
): SessionPlacementIssuance {
  const issuance: Issuance = { sessionIdentity, live: true, accepted: false };
  return {
    request: new SessionPlacement(issuance, name),
    close(): void {
      issuance.live = false;
    },
  };
}

/** Whether `value` is a placement this module issued. */
export function isSessionRequest(value: unknown): value is AgentSessionRequest {
  return issuanceOf(value) !== undefined;
}

/**
 * The engine identity `routed` carries, for the holder of provider authority.
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
  return { sessionIdentity: issuance.sessionIdentity };
}
