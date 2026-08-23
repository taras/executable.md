/**
 * The invocation the engine hands a function component (spec §5.6).
 *
 * A component that names a durable operation after itself is making an authority
 * claim: the name decides which retained record a replay restores, so two sites
 * sharing one name each replay the other's work. Every channel a component could
 * *read* an identity from is replaceable — a Context is addressed by name, and a
 * contextual Api handler installed outside an invocation answers ahead of the
 * engine's own — so the engine hands it over instead.
 *
 * Handing over a plain `{ id }` is not enough either. `Component.importComponent`
 * is public: middleware may delegate an import, receive the registered
 * definition, and return a wrapper that calls the original with an object of its
 * own. A structural identity is one a wrapper can mint, and two sites given the
 * same minted value collapse into one durable name.
 *
 * So this is a capability rather than a value. It is minted by the engine for
 * one invocation and answers only inside it. Middleware may forward the genuine
 * issuance it was handed — that is ordinary delegation and stays supported — but
 * it cannot build one, and it cannot supply one invocation's issuance to
 * another.
 *
 * "Another" includes an ancestor that is still running. A component that
 * projects content keeps its own invocation open while its descendants expand,
 * so its issuance is live and unspent for the whole time a nested component
 * runs: live and unspent is not the same as current.
 *
 * "Another" also includes another registration. Middleware may keep the
 * implementation it was handed at a real `<Evaluate>` site and call it from an
 * invocation of something else — another element, or the same element under a
 * second attachment that registered the same name — handing over that
 * invocation's own genuine, live, unspent issuance. So an implementation that
 * names durable work states the **claim domain** it names in, and a domain is
 * one object, minted once, belonging to exactly the registration that supplied
 * the implementation. Two attachments registering `<Evaluate>` hold two
 * domains, and neither answers for the other.
 *
 * The domain is on nothing anyone can carry. It is not on the definition, which
 * a handler is given and may spread; it is not a value in the registry, which
 * travels through a public handler; and it is in no context. It lives behind a
 * private field on the registration record core built, so a handler holding
 * that record can pass the record on and can read nothing out of it. The engine
 * reads the domain of the registration its own resolution consulted, and
 * records it on the invocation it mints.
 *
 * As for nesting, what settles it is that a nested component is reachable
 * exactly one way — the enclosing invocation expanding its own content. So an invocation names
 * nothing while it is doing that, and an ancestor's issuance routed into
 * something inside its content is refused. The engine raises and lowers that
 * around the one place every projection funnels through, and it is state on the
 * issuance itself: nothing global tracks who is current, and two invocations
 * running concurrently shadow only themselves.
 */

import type { FunctionComponentDefinition, Registered } from "./types.ts";

/**
 * What a function component receives beside its props.
 *
 * Deliberately opaque: there is nothing on it to read. The identity lives behind
 * a private field, and only a trusted host takes it, through
 * `durableIdentityOf()` on the host entrypoint. A component that merely passes
 * this along needs nothing from it, and one that wants to forge one finds no
 * shape to copy.
 *
 * The brand is declared and never exported, so it names a type and nothing a
 * value can carry — the runtime test is the private field below, not this.
 */
declare const Invocation: unique symbol;

export interface ComponentInvocation {
  readonly [Invocation]?: never;
}

/**
 * Which implementation an invocation's identity is for.
 *
 * Minted by core for whoever registers a component that names durable work
 * after itself, closed over by that implementation, and attached to the
 * registration so the engine records it on the invocation it resolves. Object
 * identity is the whole of it: there is nothing to read, nothing to compare by
 * value, and nothing a look-alike can be built to match.
 */
let isClaim: (value: unknown) => boolean;

export class ComponentClaim {
  readonly #minted: boolean;

  constructor() {
    this.#minted = true;
    Object.freeze(this);
  }

  static {
    // A private field is the test, as everywhere else here: it appears in no
    // key list and no copy, so an object this file did not construct has none.
    isClaim = (value) =>
      typeof value === "object" && value !== null && #minted in value && value.#minted;
  }
}

/**
 * One registration, as core built it, carrying the domain it registered under.
 *
 * The record travels in the registry, which is a public answer: a handler may
 * hold this, merge it, and hand it back. What it cannot do is read the domain
 * off it or put that domain on a record of its own, because the field is
 * private and every record with one was constructed here.
 */
let claimOf: (record: unknown) => ComponentClaim | undefined;

class Registration implements Registered {
  readonly definition: FunctionComponentDefinition;
  readonly origin: string;
  readonly #claim: ComponentClaim | undefined;

  constructor(
    definition: FunctionComponentDefinition,
    origin: string,
    claim: ComponentClaim | undefined,
  ) {
    this.definition = definition;
    this.origin = origin;
    this.#claim = claim;
    Object.freeze(this);
  }

  static {
    claimOf = (record) =>
      typeof record === "object" && record !== null && #claim in record ? record.#claim : undefined;
  }
}

/** Build one registration record. Only `registerComponents` calls this. */
export function registration(
  definition: FunctionComponentDefinition,
  origin: string,
  claim: ComponentClaim | undefined,
): Registered {
  return new Registration(definition, origin, claim);
}

/** The domain this registration registered under, for the engine. */
export function claimOfRegistration(record: Registered | undefined): ComponentClaim | undefined {
  return record === undefined ? undefined : claimOf(record);
}

/** Mint one claim domain. A trusted host does this once, where it registers. */
export function componentClaim(): ComponentClaim {
  return new ComponentClaim();
}

/** A durable identity that cannot be issued, or one spent twice. */
export class ComponentInvocationError extends Error {
  override name = "ComponentInvocationError";
}

/**
 * How this module reads what an issuance carries, without publishing the way.
 *
 * Assigned from inside the class body, the only place a private field can be
 * named. A symbol would not do: `Object.getOwnPropertySymbols()` returns one as
 * readily as a string key, so a wrapper could read the identity off a genuine
 * issuance and define it on a look-alike.
 */
let stateOf: (value: unknown) => Issuance | undefined;

interface Issuance {
  readonly id: string;
  /** The component this is an invocation of, as the engine resolved it. */
  readonly component: string;
  /** The domain of the registration that supplied it, when one did. */
  readonly claim: ComponentClaim | undefined;
  live: boolean;
  spent: boolean;
  /** How many projections of this invocation's own content are in flight. */
  projecting: number;
}

class EngineInvocation implements ComponentInvocation {
  declare readonly [Invocation]?: never;
  readonly #issuance: Issuance;

  constructor(issuance: Issuance) {
    this.#issuance = issuance;
    Object.freeze(this);
  }

  static {
    stateOf = (value) =>
      typeof value === "object" && value !== null && #issuance in value
        ? value.#issuance
        : undefined;
  }
}

/** What the engine holds for one invocation: the value, and the end of it. */
export interface IssuedInvocation {
  readonly invocation: ComponentInvocation;
  /**
   * Enter one projection of this invocation's own content; the answer ends it.
   *
   * Nothing names this invocation in between, because everything running in
   * there belongs to somebody else.
   */
  projecting(): () => void;
  /** End the issuance. Nothing it produced authorizes anything afterwards. */
  close(): void;
}

/** Mint one invocation identity. Only the engine calls this. */
export function issueInvocation(
  id: string,
  component: string,
  claim: ComponentClaim | undefined,
): IssuedInvocation {
  const issuance: Issuance = { id, component, claim, live: true, spent: false, projecting: 0 };
  return {
    invocation: new EngineInvocation(issuance),
    projecting(): () => void {
      issuance.projecting += 1;
      let released = false;
      // Counted, because one invocation may have more than one projection in
      // flight, and idempotent, because a release that ran twice would lower
      // somebody else's.
      return () => {
        if (!released) {
          released = true;
          issuance.projecting -= 1;
        }
      };
    },
    close(): void {
      issuance.live = false;
    },
  };
}

/**
 * The durable identity of the invocation this is being claimed inside, for a
 * trusted host.
 *
 * One use, from that invocation and no other, in the domain that invocation
 * resolved to. Anything this module did not mint, an issuance belonging to an
 * invocation of another component, one whose invocation has finished, one
 * whose invocation is busy expanding its own content, and a second read of a
 * genuine one are each refused rather than answered — answering would hand a caller an
 * identity that is not its own, and a durable operation named after somebody
 * else's invocation admits and replays under their retained history.
 */
export function durableIdentityOf(invocation: ComponentInvocation, claim: ComponentClaim): string {
  if (!isClaim(claim)) {
    throw new ComponentInvocationError(
      "a durable identity is claimed in a domain core minted, and this is not one",
    );
  }
  const issuance = stateOf(invocation);
  if (issuance === undefined) {
    throw new ComponentInvocationError(
      "this is not an invocation the engine issued, so it names no durable identity",
    );
  }
  if (!issuance.live) {
    throw new ComponentInvocationError(
      "this invocation has finished — an issuance kept from another element names no durable " +
        "identity here",
    );
  }
  if (issuance.claim === undefined) {
    throw new ComponentInvocationError(
      `<${issuance.component} /> resolved to no registration holding a claim domain, so ` +
        "nothing here names a durable identity",
    );
  }
  if (issuance.claim !== claim) {
    throw new ComponentInvocationError(
      `this is an invocation of <${issuance.component} /> as another registration supplied it — ` +
        "an implementation kept from one registration names no durable identity at another's, " +
        "even under the same component name",
    );
  }
  if (issuance.projecting > 0) {
    throw new ComponentInvocationError(
      "this invocation is expanding its own content and names nothing while it does — an " +
        "ancestor still running names no durable identity for what is inside it",
    );
  }
  if (issuance.spent) {
    throw new ComponentInvocationError(
      "this invocation's durable identity has already been taken, and one invocation names one " +
        "durable operation",
    );
  }
  issuance.spent = true;
  return issuance.id;
}
