/**
 * The identity a trusted host's component names its durable work after
 * (architecture.md, *Capability-backed invocation identity*).
 *
 * A component that names a durable operation after its own invocation is making
 * an authority claim: the name decides which retained record a replay restores,
 * so two invocations arriving at one name each replay the other's work, and an
 * implementation running under somebody else's identity commits against its own
 * storage under their expansion. Code Rule 15 says such a decision never trusts
 * replaceable state, and every channel a component could *read* one from is
 * replaceable — a Context is addressed by name, a contextual Api answer is
 * composed by whoever installed a handler, and the registry is an answer a
 * handler may keep from one attachment and hand back inside another, record and
 * all.
 *
 * So nothing is read. The execution is *told*, before any installation runs,
 * which components name durable work; it mints one domain for each, builds the
 * implementation by handing that domain's **claimant** straight to the host's
 * factory, and registers what comes back. The domain exists only here, the
 * claimant exists only as the argument of that call, and neither is published,
 * named, or reachable from a document. An implementation from another execution
 * holds another execution's claimant, which answers for nothing here.
 *
 * A claimant answers only for the invocation the engine is running: the one the
 * engine minted for a component in this domain, still live, not expanding its
 * own content, running in the frame the engine invoked it in, and not already
 * answered. Everything else refuses.
 */

import { useScope } from "effection";
import type { Operation, Scope } from "effection";
import type { FunctionComponent, PropsSchema, ReturnsSchema } from "./types.ts";

/**
 * What a function component receives beside its props.
 *
 * Deliberately opaque: there is nothing on it to read. A component that merely
 * passes it along needs nothing from it, and one that wants to build one finds
 * no shape to copy. What it names is answered by a claimant, and only for the
 * execution that minted both.
 *
 * The brand is declared and never exported, so it names a type and nothing a
 * value can carry — the runtime test is the private field below, not this.
 */
declare const Invocation: unique symbol;

export interface ComponentInvocation {
  readonly [Invocation]?: never;
}

/** A durable identity that cannot be claimed here. */
export class ComponentInvocationError extends Error {
  override name = "ComponentInvocationError";
}

/**
 * What a trusted host's implementation is handed to name its durable work.
 *
 * Delivered, never published: it exists as the argument of one call, made by
 * the execution that minted it, to the factory that installation supplied.
 */
export interface IdentityClaimant {
  (invocation: ComponentInvocation): Operation<string>;
}

/**
 * A component whose implementation names durable work after its invocation.
 *
 * Declared to the execution rather than registered by the host, because what
 * may name durable work here has to be fixed before anything can observe or
 * replace it. The factory is called once, with this execution's claimant.
 */
export interface IdentityComponent {
  readonly name: string;
  readonly props: PropsSchema;
  readonly returns?: ReturnsSchema;
  readonly captures?: readonly string[];
  readonly origin: string;
  factory(claim: IdentityClaimant): FunctionComponent;
}

/** One execution's domain for one component name. Reachable from nowhere. */
export interface IdentityDomain {
  readonly component: string;
}

/**
 * What one execution knows about the components it gave identity to.
 *
 * Built by the execution from what installation declared, held by value, and
 * passed into core's own expansion beside the import authority — so no
 * document, component or middleware can reach it, replace it, or add to it.
 */
export interface InvocationIdentities {
  /** The domain this execution minted for `name`, if it minted one. */
  domainFor(name: string): IdentityDomain | undefined;
  /** Answer for nothing, from here on. Called when the execution is torn down. */
  revoke(): void;
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

interface Issuance {
  readonly id: string;
  /** The component this is an invocation of, as the engine resolved it. */
  readonly component: string;
  /** The domain this execution gave that component, when it gave one. */
  readonly domain: IdentityDomain | undefined;
  /** The frame the engine invoked the implementation in. */
  readonly frame: Scope;
  live: boolean;
  spent: boolean;
  projecting: number;
}

let stateOf: (value: unknown) => Issuance | undefined;

/**
 * The one value core will admit as an invocation, and the only thing that is
 * one.
 *
 * Identity is the private field: a structural look-alike, a descriptor-for-
 * descriptor clone, and an object built on this prototype are none of them one.
 */
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

/** Mint one invocation identity. Only the engine calls this. */
export function issueInvocation(
  id: string,
  component: string,
  domain: IdentityDomain | undefined,
  frame: Scope,
): IssuedInvocation {
  const issuance: Issuance = {
    id,
    component,
    domain,
    frame,
    live: true,
    spent: false,
    projecting: 0,
  };
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

/** One domain, and the claimant that is the only way to spend it. */
interface Minted {
  readonly domain: IdentityDomain;
  readonly claim: IdentityClaimant;
  /** Answer nothing until the registration this belongs to has committed. */
  activate(): void;
  revoke(): void;
}

function mintDomain(component: string): Minted {
  let active = false;
  const domain: IdentityDomain = Object.freeze({ component });
  return {
    domain,
    activate: () => {
      active = true;
    },
    revoke: () => {
      active = false;
    },
    *claim(invocation: ComponentInvocation): Operation<string> {
      const issuance = stateOf(invocation);
      if (issuance === undefined) {
        throw new ComponentInvocationError(
          "this is not an invocation the engine issued, so it names no durable identity",
        );
      }
      if (!active) {
        throw new ComponentInvocationError(
          `the execution that gave <${component} /> its durable identity is not running this — ` +
            "an implementation kept from another execution names nothing here",
        );
      }
      if (issuance.domain !== domain) {
        throw new ComponentInvocationError(
          `this is an invocation of <${issuance.component} />, and this claimant answers for ` +
            `<${component} /> as this execution installed it — an implementation kept from one ` +
            "installation names no durable identity at another's",
        );
      }
      if (!issuance.live) {
        throw new ComponentInvocationError(
          "this invocation has finished — an issuance kept from another element names no " +
            "durable identity here",
        );
      }
      if (issuance.projecting > 0) {
        throw new ComponentInvocationError(
          "this invocation is expanding its own content and names nothing while it does — an " +
            "ancestor still running names no durable identity for what is inside it",
        );
      }
      if (issuance.frame !== (yield* useScope())) {
        throw new ComponentInvocationError(
          "this issuance belongs to another invocation of the same component — one that is " +
            "running right now, in a frame of its own, and it names nothing here",
        );
      }
      if (issuance.spent) {
        throw new ComponentInvocationError(
          "this invocation's durable identity has already been taken, and one invocation names " +
            "one durable operation",
        );
      }
      issuance.spent = true;
      return issuance.id;
    },
  };
}

/** One built implementation, ready for core's own registration path. */
export interface IdentityRegistration {
  readonly name: string;
  readonly origin: string;
  readonly props: PropsSchema;
  readonly returns?: ReturnsSchema;
  readonly captures?: readonly string[];
  readonly fn: FunctionComponent;
}

/** Every domain one execution minted, and how the engine reaches them. */
export interface IdentityInstallation {
  readonly identities: InvocationIdentities;
  /** The registrations to make, already built from their factories. */
  readonly registrations: readonly IdentityRegistration[];
  /** Called once the registrations have been validated and committed. */
  activate(): void;
}

/**
 * Mint this execution's domains and build the implementations from them.
 *
 * The factory is called here, with a claimant that answers only for this
 * execution's own invocations of that component. Nothing is registered yet:
 * the caller registers what comes back, and activates only once that batch has
 * been validated and committed, so a refused registration leaves a claimant
 * that answers for nothing.
 */
export function installIdentities(components: readonly IdentityComponent[]): IdentityInstallation {
  const minted = new Map<string, Minted>();
  const registrations: IdentityRegistration[] = [];
  for (const component of components) {
    if (minted.has(component.name)) {
      throw new ComponentInvocationError(
        `this execution was given two identity components called "${component.name}", and one ` +
          "component names its durable work in one domain",
      );
    }
    const domain = mintDomain(component.name);
    minted.set(component.name, domain);
    registrations.push({
      name: component.name,
      origin: component.origin,
      props: component.props,
      ...(component.returns === undefined ? {} : { returns: component.returns }),
      ...(component.captures === undefined ? {} : { captures: component.captures }),
      fn: component.factory(domain.claim),
    });
  }
  return {
    identities: {
      domainFor: (name) => minted.get(name)?.domain,
      revoke: () => {
        for (const domain of minted.values()) {
          domain.revoke();
        }
      },
    },
    registrations,
    activate: () => {
      for (const domain of minted.values()) {
        domain.activate();
      }
    },
  };
}
