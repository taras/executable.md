/**
 * What canonical execution keeps of the component definitions it produced.
 *
 * Two closed executions need the same guarantee: the definition a document
 * expands is the one canonical execution selected, whatever the public
 * `Component.importComponent` chain did to the answer on its way back. A
 * workflow closed over a component bundle needs it, and so does a generated
 * fragment closed over an allowlist of pinned observation identities.
 *
 * The mechanism is one table. A witness is issued where the answer is produced
 * and verified where it is invoked, so the three ways a handler can decide an
 * import — answering without delegating, replacing what came back, and changing
 * it afterwards — are one question: is this the answer canonical execution
 * produced for this name, still describing what core produced?
 *
 * What comes back is core's own copy, never the object that travelled through
 * the chain. So verification decides whether an import is *refused*, and
 * nothing a handler still holds decides what is *invoked*.
 */

import type { ComponentDefinition, FunctionComponentDefinition } from "../types.ts";
import type { FormSelections, InvocationIdentities } from "../invocation-identity.ts";
import type { DeclaredImports, PrivateClosure } from "./declared-markdown.ts";

/** A definition an import may answer with. */
export type ImportedDefinition = ComponentDefinition | FunctionComponentDefinition;

/**
 * The authority one closed execution imports through.
 *
 * Held by canonical core and passed by value into core's own expansion, so no
 * document, component, or middleware can reach it, replace it, or add to it.
 */
export interface ImportAuthority {
  /** The definition this import may invoke, or the refusal saying why it may invoke none. */
  authorize(name: string, answer: ImportedDefinition): ImportedDefinition;
}

/**
 * What core's own expansion is given, beside the segments.
 *
 * Two things travel here, and both for the same reason: they decide what a
 * document may invoke and what it may name, and a decision like that never
 * reads replaceable state. This object is built by the execution, held by
 * value, and passed into core's own expansion — no document, component or
 * middleware can reach it, replace it, or add to it.
 */
export interface ExpansionAuthority {
  /** What a closed execution may invoke for a name. Absent for an open one. */
  readonly imports?: ImportAuthority;
  /**
   * The exact Markdown this execution declares, and the register one private
   * import is offered through.
   *
   * Held by the execution and handed here by value, like everything else on
   * this object: an expansion reaching it is core's own, and nothing a
   * document, a component or middleware can name reaches it.
   */
  readonly declared?: DeclaredImports;
  /**
   * The private names the segments being expanded may write, when they are a
   * declaration's own body.
   *
   * This is the one member that changes as expansion descends. A declared
   * component's body carries its closure; everything else — the caller, the
   * content the caller projected, an imported component, a sibling invocation —
   * carries whatever it carried, which for an ordinary document is nothing.
   */
  readonly privates?: PrivateClosure;
  /** The domains this execution minted, for the components it gave one. */
  readonly identities?: InvocationIdentities;
  /**
   * What canonical resolution selected for each import, for the components
   * whose authored form selects an effect.
   *
   * Held by the execution and handed here by value, like the identities beside
   * it: an expansion reaching this object is core's own, and nothing a document,
   * a component or middleware can name reaches it.
   */
  readonly forms?: FormSelections;
}

/** Why an answer is not the one canonical execution produced for this name. */
export type ImportRefusal = "unissued" | "another-name" | "changed";

/** What canonical execution kept of one definition it produced. */
interface Witness {
  readonly name: string;
  /**
   * Core's own copy of its own answer, taken before the public chain could see
   * the definition and reachable from nowhere but here.
   *
   * This is what gets invoked. Verification below decides whether the answer
   * that came back still describes it, but what a component expands is never
   * the object middleware was holding.
   */
  readonly canonical: ImportedDefinition | undefined;
}

/**
 * Core's own copy of one definition.
 *
 * A structured clone of the data, with the implementation carried across by
 * reference so a function component is invoked as exactly the function core
 * selected. Definitions core produces hold parsed JSON and scanned segments,
 * both of which clone; anything that does not is a value core did not build, so
 * the copy is absent and authorization fails closed.
 */
export function retain(definition: ImportedDefinition): ImportedDefinition | undefined {
  try {
    if (definition.kind === "function") {
      // Cloned without the implementation, because a function is not
      // structured-cloneable and must not be copied anyway: `<Test>` is
      // recognized by the identity of the function core registered.
      const { fn, ...data } = definition;
      return { ...structuredClone(data), fn };
    }
    return structuredClone(definition);
  } catch {
    return undefined;
  }
}

/**
 * Whether `answer` still describes `canonical`, reading data and nothing else.
 *
 * Deliberately not a serialization. `JSON.stringify()` consults `toJSON()` and
 * invokes getters, so a definition can be mutated and then made to describe
 * itself as it was — a masking `toJSON()`, or an accessor that answers once for
 * the check and differently for the read. So this compares own property
 * descriptors: a member that computes its value is not a member core wrote, and
 * a definition holding one is refused rather than read twice.
 *
 * A function is compared by identity, and a prototype other than the one core's
 * copy carries is a different object however its members read.
 */
function describesSame(canonical: unknown, answer: unknown): boolean {
  if (typeof canonical === "function" || typeof answer === "function") {
    return canonical === answer;
  }
  if (canonical === null || typeof canonical !== "object") {
    return Object.is(canonical, answer);
  }
  if (answer === null || typeof answer !== "object") {
    return false;
  }
  if (Array.isArray(canonical) !== Array.isArray(answer)) {
    return false;
  }
  if (Object.getPrototypeOf(canonical) !== Object.getPrototypeOf(answer)) {
    return false;
  }
  const keys = Reflect.ownKeys(canonical);
  if (keys.length !== Reflect.ownKeys(answer).length) {
    return false;
  }
  for (const key of keys) {
    const described = Object.getOwnPropertyDescriptor(answer, key);
    if (described === undefined || !("value" in described)) {
      return false;
    }
    const own = Object.getOwnPropertyDescriptor(canonical, key);
    if (own === undefined || !describesSame(own.value, described.value)) {
      return false;
    }
  }
  return true;
}

/** One read of a value the chain controls: its answer, or nothing. */
function read<T>(inspect: () => T): T | undefined {
  try {
    return inspect();
  } catch {
    return undefined;
  }
}

/**
 * The definitions canonical execution produced, and what they were when it
 * produced them.
 *
 * Weak, and keyed by the object itself: an answer that reaches the call site is
 * authorized because it *is* the object the terminal minted, not because it
 * resembles one.
 */
export class CanonicalImports {
  readonly #issued = new WeakMap<object, Witness>();

  /**
   * Record that canonical execution produced this answer for this name, and
   * keep core's own copy of it.
   *
   * The copy is taken here, before the definition is handed to the public
   * chain, so it is a copy of what core decided rather than of whatever the
   * chain gave back.
   */
  issue(name: string, definition: ImportedDefinition): ImportedDefinition {
    this.#issued.set(definition, { name, canonical: retain(definition) });
    return definition;
  }

  /**
   * Core's own copy of the definition this import may invoke.
   *
   * Verified at the call site, after the public chain has returned and before
   * anything is expanded or called. Each closed execution words its own
   * refusal, so `refuse` builds the error this authority throws.
   */
  authorize(
    name: string,
    answer: ImportedDefinition,
    refuse: (refusal: ImportRefusal) => Error,
  ): ImportedDefinition {
    const witness =
      typeof answer === "object" && answer !== null ? this.#issued.get(answer) : undefined;
    if (witness === undefined) {
      throw refuse("unissued");
    }
    if (witness.name !== name) {
      throw refuse("another-name");
    }
    const { canonical } = witness;
    // Reading the answer runs whatever it is made of — a proxy's traps, an
    // exotic object's own machinery — so a value that refuses to be compared is
    // a value that failed the comparison.
    if (canonical === undefined || read(() => describesSame(canonical, answer)) !== true) {
      throw refuse("changed");
    }
    return canonical;
  }
}

/**
 * How one closed tier words a refusal of an answer it did not produce.
 *
 * The tiers share retention because an execution has one answer per import, and
 * word their own refusals because "a workflow bundle" and "the Markdown this
 * host declared" are different things for a reader to be told about.
 */
export interface ImportTier {
  /** Whether this tier is the one that answers for `name`. */
  claims(name: string): boolean;
  /** The error this tier throws when the answer is not the one core produced. */
  refuse(refusal: ImportRefusal): Error;
}

/**
 * The authority one closed execution imports through, however many tiers close
 * it.
 *
 * One `CanonicalImports` for the whole execution: a witness is issued where the
 * answer is produced and verified where it is invoked, so which tier produced
 * an answer decides only how a refusal reads, never whether one is authorized.
 */
export class ExecutionImports implements ImportAuthority {
  readonly #imports = new CanonicalImports();
  readonly #tiers: readonly ImportTier[];

  constructor(tiers: readonly ImportTier[]) {
    this.#tiers = tiers;
  }

  /** Record that canonical execution produced this answer for this name. */
  issue(name: string, definition: ImportedDefinition): ImportedDefinition {
    return this.#imports.issue(name, definition);
  }

  /** Core's own copy of the definition this import may invoke. */
  authorize(name: string, answer: ImportedDefinition): ImportedDefinition {
    const tier = this.#tiers.find((candidate) => candidate.claims(name)) ?? this.#tiers[0];
    return this.#imports.authorize(name, answer, (refusal) => {
      if (tier === undefined) {
        return new Error("this execution authorizes no import");
      }
      return tier.refuse(refusal);
    });
  }
}
