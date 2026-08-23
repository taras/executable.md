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
 * So this is a capability rather than a value. It is minted by the engine, alive
 * only while the invocation it belongs to is running, and its authoritative read
 * is one-use. Middleware may forward the genuine issuance it was handed — that
 * is ordinary delegation and stays supported — but it cannot build one, and it
 * cannot take one site's issuance and spend it at another: the first is already
 * used, and a finished site's is no longer live.
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
  live: boolean;
  spent: boolean;
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
  /** End the issuance. Nothing it produced authorizes anything afterwards. */
  close(): void;
}

/** Mint one invocation identity. Only the engine calls this. */
export function issueInvocation(id: string): IssuedInvocation {
  const issuance: Issuance = { id, live: true, spent: false };
  return {
    invocation: new EngineInvocation(issuance),
    close(): void {
      issuance.live = false;
    },
  };
}

/**
 * The durable identity this invocation names, for a trusted host.
 *
 * One use. A second read, an issuance whose invocation has finished, and
 * anything this module did not mint are each refused rather than answered —
 * answering would hand a caller an identity that is not its own.
 */
export function durableIdentityOf(invocation: ComponentInvocation): string {
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
  if (issuance.spent) {
    throw new ComponentInvocationError(
      "this invocation's durable identity has already been taken, and one invocation names one " +
        "durable operation",
    );
  }
  issuance.spent = true;
  return issuance.id;
}
