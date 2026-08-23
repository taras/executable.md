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
 * "Another" also includes another component. Middleware may keep the
 * implementation it was handed at a real `<Evaluate>` site and call it from an
 * invocation of something else, handing over that element's own genuine, live,
 * unspent issuance — so an implementation that names durable work states the
 * **claim domain** it names in, and a domain answers for one component.
 *
 * Which component is decided once, by core, where the implementation is
 * registered: `registerComponents` binds the domain to that name, and a domain
 * offered for a second name is refused there. Nothing carries it afterwards —
 * it is on no definition, in no registry entry and in no context, so there is
 * nothing for middleware to read, copy or plant. What the engine records on an
 * invocation is the name it resolved, which is the authored element's own.
 *
 * As for nesting, what settles it is that a nested component is reachable
 * exactly one way — the enclosing invocation expanding its own content. So an invocation names
 * nothing while it is doing that, and an ancestor's issuance routed into
 * something inside its content is refused. The engine raises and lowers that
 * around the one place every projection funnels through, and it is state on the
 * issuance itself: nothing global tracks who is current, and two invocations
 * running concurrently shadow only themselves.
 */

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
let boundComponent: (value: unknown) => { component: string | undefined } | undefined;
let bind: (claim: ComponentClaim, component: string) => string | undefined;

export class ComponentClaim {
  /** The component this domain answers for, once core has registered it. */
  #component: string | undefined;

  static {
    // A private field is the test, as everywhere else here: it appears in no
    // key list and no copy, so an object this file did not construct has none.
    boundComponent = (value) =>
      typeof value === "object" && value !== null && #component in value
        ? { component: value.#component }
        : undefined;
    bind = (claim, component) => {
      const bound = claim.#component;
      if (bound !== undefined && bound !== component) {
        return bound;
      }
      claim.#component = component;
      return undefined;
    };
  }
}

/**
 * Bind one domain to the component it answers for. Only registration calls it.
 *
 * Answers with the name it is already bound to when that is a different one,
 * because a domain that answered for two components would be exactly the
 * borrowed authority it exists to prevent.
 */
export function bindClaimComponent(claim: ComponentClaim, component: string): string | undefined {
  return bind(claim, component);
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
export function durableIdentityOf(invocation: ComponentInvocation, claim: ComponentClaim): string {
  const domain = boundComponent(claim);
  if (domain === undefined) {
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
  if (domain.component === undefined) {
    throw new ComponentInvocationError(
      "this claim domain is registered for no component, so it names nothing anywhere",
    );
  }
  if (domain.component !== issuance.component) {
    throw new ComponentInvocationError(
      `this is an invocation of <${issuance.component} />, and this durable identity is ` +
        `claimed for <${domain.component} /> — an implementation kept from one component's ` +
        "site names no durable identity at another's",
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
