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

import { createContext, useScope } from "effection";
import type { Context, Operation } from "effection";

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
 * after itself and closed over by that implementation. Registering it records
 * the component name and the registrant's own scope; from then on it answers
 * only for that name, and only from inside that scope.
 */
let registrationOf: (value: unknown) => { registration: Registration | undefined } | undefined;
let bind: (claim: ComponentClaim, registration: Registration) => boolean;

export class ComponentClaim {
  /** Set once, where the implementation is registered. */
  #registration: Registration | undefined;

  static {
    // A private field is the test, as everywhere else here: it appears in no
    // key list and no copy, so an object this file did not construct has none.
    registrationOf = (value) =>
      typeof value === "object" && value !== null && #registration in value
        ? { registration: value.#registration }
        : undefined;
    bind = (claim, registration) => {
      if (claim.#registration !== undefined) {
        return false;
      }
      claim.#registration = registration;
      return true;
    };
  }
}

/** Where one registration happened, as core saw it. */
interface Registration {
  /** The component name it registered under. */
  readonly component: string;
  /**
   * A context nothing else can address, set on the registrant's own scope.
   *
   * Built here under a name made for this registration alone and kept in the
   * claim, so a scope answers it only when the registrant's scope is above it,
   * and nobody who cannot name the context can plant an answer. Containment is
   * the whole test, and containment is structure: no handler can move one
   * attachment's invocation inside another attachment's registration.
   */
  readonly probe: Context<object | undefined>;
  /** What that scope holds, so an absent answer is not an answer. */
  readonly token: object;
}

/** Mint one claim domain. A trusted host does this once, where it registers. */
export function componentClaim(): ComponentClaim {
  return new ComponentClaim();
}

/**
 * Register one domain: this component name, and this scope.
 *
 * Called by `registerComponents` and nowhere else. The probe context is built
 * here, under a name made for this registration alone and kept in the claim, so
 * the only way to answer it is to be running inside the scope it was set on.
 * Answers false for a domain that is already registered, because a domain
 * belongs to one registration.
 */
export function* registerClaim(claim: ComponentClaim, component: string): Operation<boolean> {
  const scope = yield* useScope();
  const probe: Context<object | undefined> = createContext<object | undefined>(
    `xmd.registration.${crypto.randomUUID()}`,
    undefined,
  );
  const token = Object.freeze({});
  if (!bind(claim, { component, probe, token })) {
    return false;
  }
  scope.set(probe, token);
  return true;
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
export function issueInvocation(id: string, component: string): IssuedInvocation {
  const issuance: Issuance = { id, component, live: true, spent: false, projecting: 0 };
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
export function* durableIdentityOf(
  invocation: ComponentInvocation,
  claim: ComponentClaim,
): Operation<string> {
  const domain = registrationOf(claim);
  if (domain === undefined) {
    throw new ComponentInvocationError(
      "a durable identity is claimed in a domain core minted, and this is not one",
    );
  }
  const registration = domain.registration;
  if (registration === undefined) {
    throw new ComponentInvocationError(
      "this claim domain was never registered, so it names nothing anywhere",
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
  if (registration.component !== issuance.component) {
    throw new ComponentInvocationError(
      `this is an invocation of <${issuance.component} />, and this domain was registered for ` +
        `<${registration.component} /> — an implementation kept from one component's site names ` +
        "no durable identity at another's",
    );
  }
  if ((yield* useScope()).get(registration.probe) !== registration.token) {
    throw new ComponentInvocationError(
      `this <${issuance.component} /> is running outside the registration this domain belongs ` +
        "to — an implementation kept from one registration names no durable identity under " +
        "another's, whatever a registry answered here",
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
