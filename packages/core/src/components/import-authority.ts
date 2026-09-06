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
import type {
  FormSelections,
  InvocationIdentities,
  ProtectedBodies,
} from "../invocation-identity.ts";
import type { DeclaredImports, PrivateClosure } from "./declared-markdown.ts";
import type { ExactSource } from "../output/exact-source.ts";
import type { SyntaxReference } from "../syntax-reference.ts";
import type { CapturedProfile } from "../evaluation-profile.ts";

/** A definition an import may answer with. */
export type ImportedDefinition = ComponentDefinition | FunctionComponentDefinition;

/**
 * The authority one closed execution imports through.
 *
 * Held by canonical core and passed by value into core's own expansion, so no
 * document, component, or middleware can reach it, replace it, or add to it.
 */
export interface ImportAuthority {
  /**
   * Whether canonical execution answers for this name rather than the chain.
   *
   * Closing an import is a claim about *that name*, not about the execution
   * that made it. A workflow bundle closes every import because a workflow run
   * is a run of one pinned tree; a host declaring exact Markdown closes only
   * the names it declared, so an unrelated name resolves and composes exactly
   * as it does in an execution with no authority at all.
   */
  closes(name: string): boolean;
  /**
   * The definition this import may invoke, or the refusal saying why it may
   * invoke none. Asked only for a name `closes()` answered for.
   */
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
   * Which segments this execution produced as a program's source.
   *
   * Held by the execution and handed here by value, like everything else on
   * this object. It is on the private authority rather than in a context
   * because a context resolves by name, and a name is not a secret: a component
   * could build one, reach the record and answer that everything is exact.
   */
  readonly exact?: ExactSource;
  /**
   * What canonical resolution selected for each import, for the components
   * whose authored form selects an effect.
   *
   * Held by the execution and handed here by value, like the identities beside
   * it: an expansion reaching this object is core's own, and nothing a document,
   * a component or middleware can name reaches it.
   */
  readonly forms?: FormSelections;
  /**
   * What a document may write at the site being expanded.
   *
   * The execution builds one at its root from the selection inputs it captured,
   * and hands it here by value like everything else on this object — not through
   * a Context, because a context resolves by name and a name is not a secret, so
   * a document could build one and answer for the vocabulary it is shown.
   *
   * It is lexical. A trusted canonical evaluation boundary that has already
   * admitted the exact vocabulary a subtree may write replaces this member for
   * that subtree, and leaving the subtree restores the enclosing one. Nothing
   * else changes it: an ordinary component's body, the content a caller
   * projected and an imported definition each carry what the site carried.
   */
  readonly syntax?: SyntaxReference;
  /**
   * The maximum authority a generated fragment may be evaluated under.
   *
   * Stated by the trusted host at the installation boundary, before the root
   * import and before any document, component or middleware code exists, and
   * handed here by value like everything else on this object. It is on the
   * private authority rather than in a context for the reason the rest are, and
   * one more: `<Evaluate>` is a *public* component, so any author may write it,
   * and what keeps that from being a capability is that the ceiling it narrows
   * from was settled by somebody the document cannot reach.
   *
   * Absent for a host that offers no evaluation. That is not an unrestricted
   * evaluation — it is no evaluation, and `<Evaluate>` refuses.
   */
  readonly evaluation?: CapturedProfile;
  /**
   * The bodies this execution will enter for the components canonical core
   * protects.
   *
   * Held by the execution and handed here by value, like the identity domains
   * beside it. It is what makes a protected implementation reachable at all: an
   * implementation another loaded copy built is in that copy's table, and one
   * kept past this execution's teardown reaches a table that is gone.
   */
  readonly protectedBodies?: ProtectedBodies;
}

/** Why an answer is not the one canonical execution produced for this name. */
export type ImportRefusal = "unissued" | "another-name" | "changed";

/** How a provider states an identity for the answer it is returning. */
export type ClaimAnswer = (
  name: string,
  answer: ImportedDefinition,
  identity: ClaimedIdentity,
) => ImportedDefinition;

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

/**
 * Whether `answer` still describes what core produced, reading it defensively.
 *
 * Shared, because two authorities ask it: the execution-wide one below, and the
 * per-occurrence one a private import is authorized through. Reading the answer
 * runs whatever it is made of — a proxy's traps, an exotic object's own
 * machinery — so a value that refuses to be compared is a value that failed the
 * comparison.
 */
export function stillDescribes(canonical: unknown, answer: unknown): boolean {
  return read(() => describesSame(canonical, answer)) === true;
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
/**
 * A provider's stable statement about the implementation it supplied.
 *
 * `origin` is canonical execution's to fix, not the provider's: a claimant is
 * minted per provider installation and carries that installation's origin, so
 * one provider cannot state an identity under another's name.
 */
export interface AnswerIdentity {
  readonly origin: string;
  readonly key: string;
  readonly revision: string;
}

/** What a provider states, minus the part it does not get to choose. */
export interface ClaimedIdentity {
  readonly key: string;
  readonly revision: string;
}

/** One claim this owner recorded, with core's own copy of what was claimed. */
interface Claim {
  readonly name: string;
  readonly identity: AnswerIdentity;
  /** Which claimant stated it, so a second provider cannot overwrite. */
  readonly claimant: object;
  readonly canonical: ImportedDefinition | undefined;
}

/** A claimant used after the execution that minted it ended. */
export const REVOKED_CLAIMANT =
  "the execution that minted this identity claimant has ended, so nothing it states identifies " +
  "an implementation here";

/** An identity a provider stated in a shape this execution cannot record. */
export class AnswerIdentityError extends Error {
  override name = "AnswerIdentityError";
}

/** The retained spelling of one identity, for a reader. */
export function identityRecord(identity: AnswerIdentity): string {
  return `${identity.origin}#${identity.key}@${identity.revision}`;
}

export class CanonicalImports {
  readonly #issued = new WeakMap<object, Witness>();
  /**
   * The identities providers stated, in the same owner that holds issuance.
   *
   * One owner rather than two registries: retention, exact-object lookup, the
   * `stillDescribes` comparison and the lifecycle are one question asked about
   * one table, and a parallel WeakMap would be a second place for an answer to
   * be authorized from.
   */
  readonly #claims = new WeakMap<object, Claim>();
  /**
   * Whether this owner identifies anything yet.
   *
   * Starts inactive. Canonical execution registers teardown, then activates,
   * then mints claimants — so a failure between construction and activation
   * cannot leave a live claimant with no teardown behind it.
   */
  #active = false;

  /** Begin identifying. Called after teardown is registered. */
  activate(): void {
    this.#active = true;
  }

  /** Stop. Called at teardown, on completion, failure or cancellation. */
  revoke(): void {
    this.#active = false;
  }

  get identifying(): boolean {
    return this.#active;
  }

  /**
   * A claimant for one provider installation, fixed to that origin.
   *
   * The claimant is an ordinary closure. A separately loaded copy of core
   * receives this object and can state identities with it; what it cannot do is
   * state one under an origin canonical execution did not give it, or reach the
   * table any other way — there is no shared symbol, module registry or context
   * name behind this.
   */
  claimant(origin: string): { claim: ClaimAnswer } {
    const token = Object.freeze({});
    const owner = this;
    return {
      claim(name: string, answer: ImportedDefinition, stated: ClaimedIdentity): ImportedDefinition {
        return owner.#record(token, origin, name, answer, stated);
      },
    };
  }

  #record(
    claimant: object,
    origin: string,
    name: string,
    answer: ImportedDefinition,
    stated: ClaimedIdentity,
  ): ImportedDefinition {
    if (!this.#active) {
      throw new AnswerIdentityError(REVOKED_CLAIMANT);
    }
    const identity = complete(origin, stated);
    const held =
      typeof answer === "object" && answer !== null ? this.#claims.get(answer) : undefined;
    if (held !== undefined) {
      // Restating exactly what is already there is what a provider installed
      // twice does, and it is not a conflict. Anything else is two providers
      // disagreeing about one object, and the first statement stands: a later
      // claim that overwrote it would let a second provider rename the first's
      // implementation.
      if (
        held.claimant !== claimant ||
        held.name !== name ||
        held.identity.origin !== identity.origin ||
        held.identity.key !== identity.key ||
        held.identity.revision !== identity.revision
      ) {
        throw new AnswerIdentityError(
          "this answer already carries an identity, and a second claim does not replace it. One " +
            "implementation states what it is once.",
        );
      }
      return answer;
    }
    // Copied on the way in, so a later edit of the claimed object is visible as
    // the change it is.
    this.#claims.set(answer, {
      name,
      identity,
      claimant,
      canonical: retain(answer),
    });
    return answer;
  }

  /**
   * The identity stated for this exact answer, under this exact name.
   *
   * Read after the whole public chain has returned, so what is asked about is
   * the final answer rather than an intermediate one. Nothing here refuses: an
   * unidentified answer is an ordinary answer, and whether that is enough is
   * the caller's question.
   */
  identify(name: string, answer: unknown): AnswerIdentity | undefined {
    if (!this.#active || typeof answer !== "object" || answer === null) {
      return undefined;
    }
    const claim = this.#claims.get(answer);
    if (claim === undefined || claim.name !== name) {
      return undefined;
    }
    // A claimed object the chain went on to edit is not the thing that was
    // claimed. Reading it runs whatever it is made of, and a value that refuses
    // to be compared has failed the comparison.
    if (claim.canonical === undefined || !stillDescribes(claim.canonical, answer)) {
      return undefined;
    }
    return claim.identity;
  }

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
 * The identity as this owner records it, or the reason it cannot.
 *
 * Three non-empty strings, checked here rather than trusted: what a
 * continuation is compared against must be a value a reader can look at and say
 * which part moved, and a partial identity would compare equal to a different
 * partial one. `origin` is canonical execution's, so only the two the provider
 * states are read off its object.
 */
function complete(origin: string, stated: ClaimedIdentity): AnswerIdentity {
  const { key, revision } = stated;
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    typeof revision !== "string" ||
    revision.length === 0
  ) {
    throw new AnswerIdentityError(
      "an identity states a non-empty key and revision. A continuation is compared against both " +
        "and the origin canonical execution fixed, so a partial one would compare equal to a " +
        "different partial one.",
    );
  }
  return Object.freeze({ origin, key, revision });
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
  /**
   * Whether this tier closes every import in the execution, or only the names
   * it claims.
   *
   * A workflow bundle closes the execution: a run is a run *of* that pinned
   * tree, and a name resolving outside it is the thing the bundle exists to
   * prevent. Exact declared Markdown closes only what it declares: the host
   * claimed those names and nothing else, so closing an unrelated import would
   * take away a supported way to decide what a name means without any
   * declaration having said anything about it.
   */
  readonly closesExecution: boolean;
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

  /** Whether canonical execution answers for this name rather than the chain. */
  closes(name: string): boolean {
    return this.#answering(name) !== undefined;
  }

  /** Core's own copy of the definition this import may invoke. */
  authorize(name: string, answer: ImportedDefinition): ImportedDefinition {
    const tier = this.#answering(name);
    return this.#imports.authorize(name, answer, (refusal) => {
      if (tier === undefined) {
        return new Error("this execution authorizes no import of this name");
      }
      return tier.refuse(refusal);
    });
  }

  /**
   * The tier this name is closed by, if any.
   *
   * A tier that claims the name answers for it; otherwise a tier that closes
   * the whole execution does, which is what keeps a bundled run's every import
   * — and every refusal's wording — exactly what it was.
   */
  #answering(name: string): ImportTier | undefined {
    return (
      this.#tiers.find((candidate) => candidate.claims(name)) ??
      this.#tiers.find((candidate) => candidate.closesExecution)
    );
  }
}
