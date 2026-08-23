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
 * How this module reaches what a placement carries, without publishing the way.
 *
 * Assigned once from inside the class body, which is the only place a private
 * field can be named. A symbol would not do: `Object.getOwnPropertySymbols()`
 * returns one as readily as a string key, so a handler could read the placement
 * off a real request and define it on a look-alike. A private field is not a
 * property — it appears in no key list, no descriptor and no copy.
 */
let readIdentity: (routed: unknown) => string | undefined;

/**
 * The one value this module will admit as a placement, and the only thing that
 * is one.
 *
 * Identity is the field itself. A structural look-alike, a descriptor-for-
 * descriptor clone, an object built on this prototype and a request another
 * loaded copy produced are none of them one.
 */
class SessionPlacement implements AgentSessionRequest {
  readonly #sessionIdentity: string;
  readonly name?: string;

  constructor(sessionIdentity: string, name: string | undefined) {
    this.#sessionIdentity = sessionIdentity;
    if (name !== undefined) {
      this.name = name;
    }
    Object.freeze(this);
  }

  static {
    // `#sessionIdentity in routed` is the unforgeable test: a private field can
    // be probed only from inside the class that declares it, and no object this
    // file did not construct has one. It answers rather than throws, so an
    // ordinary refusal does not have to be caught.
    readIdentity = (routed) =>
      typeof routed === "object" && routed !== null && #sessionIdentity in routed
        ? routed.#sessionIdentity
        : undefined;
  }

  /** Derive a request with a different descriptive name, same identity. */
  with(changes: { name?: string }): AgentSessionRequest {
    return new SessionPlacement(
      this.#sessionIdentity,
      changes.name === undefined ? this.name : changes.name,
    );
  }
}

/**
 * Issue one placement request for the element the engine is expanding.
 *
 * `sessionIdentity` comes from the `ComponentInvocation` the engine handed the
 * component, which is the one channel a document cannot reach.
 */
export function sessionPlacement(
  sessionIdentity: string,
  name: string | undefined,
): AgentSessionRequest {
  return new SessionPlacement(sessionIdentity, name);
}

/** Whether `value` is a placement this module issued. */
export function isSessionRequest(value: unknown): value is AgentSessionRequest {
  return readIdentity(value) !== undefined;
}

/**
 * The engine identity `routed` carries, for the holder of provider authority.
 *
 * The only way in. A handler holding the same request reads its descriptive
 * name and reaches no further, because there is nothing on the object to reach.
 */
export function readPlacement(routed: unknown): Placement {
  const sessionIdentity = readIdentity(routed);
  if (sessionIdentity === undefined || sessionIdentity === "") {
    throw new AgentSessionProtocolError(
      "this is not a live session placement, so it names no session identity",
    );
  }
  return { sessionIdentity };
}
