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

import type { ComponentDefinition, FunctionComponentDefinition, SourcePosition } from "../types.ts";
import type { Operation } from "effection";
import type { ComponentInvocation } from "../invocation-identity.ts";
import type {
  FormSelections,
  InvocationIdentities,
  ProtectedBodies,
} from "../invocation-identity.ts";
import type { DeclaredImports, PrivateClosure } from "./declared-markdown.ts";
import type { ExactSource } from "../output/exact-source.ts";
import type { SyntaxReference } from "../syntax-reference.ts";
import type { CapturedProfile } from "../evaluation-profile.ts";
import type { StructuralCatalog } from "../execution-declarations.ts";
import type { StructuralExpander } from "../expansion-request.ts";

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
  /**
   * The structural syntax this execution installs, and how each installation
   * expands the forms it declared.
   *
   * Held by the execution and handed here by value, like everything else on
   * this object: an expansion reaching it is core's own, so nothing a document,
   * a component or middleware can name decides that a name is installed syntax
   * or substitutes an implementation for the one the host selected. The
   * expanders are indexed by the owner an admitted declaration names.
   */
  readonly structural?: StructuralCatalog;
  readonly expanders?: readonly (StructuralExpander | undefined)[];
  /** The generated import's form check and result collection, around either body kind. */
  readonly invoke?: (
    fn: unknown,
    invocation: ComponentInvocation,
    body: Operation<unknown>,
  ) => Operation<unknown>;
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
 * `origin` is canonical execution's to fix, not the provider's: each provider
 * installation carries its origin into every request it opens, so one provider
 * cannot state an identity under another's name.
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

/**
 * One identified answer: what a provider stated, and what core kept of it.
 *
 * The two travel together because a caller needs both and must not obtain them
 * separately. The definition is core's own copy, taken when the claim was
 * recorded; it is what the caller keeps, and it is why nothing downstream ever
 * reads the object the public chain returned a second time.
 */
export interface IdentifiedAnswer {
  readonly identity: AnswerIdentity;
  readonly definition: ImportedDefinition;
}

/** One claim this owner recorded, with core's own copy of what was claimed. */
interface Claim {
  readonly name: string;
  readonly identity: AnswerIdentity;
  /** Which provider installation stated it, so a second cannot overwrite. */
  readonly installation: object;
  /**
   * The exact resolution this was an answer to.
   *
   * The window *object*, not a number describing one. Provenance is a question
   * about which import a statement answered, and a caller asking it presents
   * the window it is holding — so the comparison is between two references to
   * one thing rather than between a record and whatever the owner's mutable
   * current state happens to say. A number would have to be trusted against
   * that mutable state; an object cannot be forged into being the one the
   * caller opened.
   */
  readonly window: ResolutionWindow;
  readonly canonical: ImportedDefinition | undefined;
}

/** A provider request used after its execution ended. */
export const REVOKED_ANSWER_AUTHORITY =
  "the execution that installed this answer provider has ended, so nothing it states identifies " +
  "an implementation here";

/** A claim stated outside the handler invocation it would have been an answer to. */
export const SETTLED_CLAIM =
  "this resolution has settled, so a claim stated now identifies nothing. An answer is " +
  "identified by the handler invocation the import asked, while that invocation is still " +
  "deciding; a handler that has returned, or one recording after the fact, is not supplying it.";

/** A second, different statement from one installation about one resolution. */
export const SPENT_OPPORTUNITY =
  "this provider already stated which implementation answers this import, and one import is one " +
  "implementation. The next resolution offers a fresh request; this one is decided.";

/**
 * One open resolution, and the only way to end it.
 *
 * Handed to canonical execution rather than published: the window belongs to
 * the import that opened it, and closing somebody else's would settle a
 * decision still being made. It is also the value a caller presents to
 * `identify`, so what proves an answer belongs to this import is holding the
 * object rather than describing it.
 */
export interface ResolutionWindow {
  /** The component this resolution is deciding. */
  readonly name: string;
  /** Which resolution this is, for a reader following two of them. */
  readonly occurrence: number;
  /** Stop admitting claims for this resolution. Idempotent. */
  close(): void;
}

/**
 * What one handler invocation may state about the import it was asked.
 *
 * Minted per invocation, and closed the moment that invocation returns, throws
 * or is cancelled. This is the authority a provider actually claims through:
 * the installation gives a provider the right to *be asked*, and the request
 * gives it the right to answer this one asking. Separating them is what makes a
 * claim provable — a stable installation handle can only say "some provider",
 * while a request says "this handler, deciding this import, right now".
 *
 * There is no `name` parameter on `claim`. The name is fixed when the request
 * is minted, from what the chain asked, so a handler cannot state an answer for
 * a component it was not asked about.
 */
export interface ComponentAnswerRequest {
  /** The component this invocation was asked to resolve. */
  readonly name: string;
  /** Where the element that asked was written, when the chain knew. */
  readonly position?: Readonly<SourcePosition>;
  /** State which implementation answers this import, as this provider. */
  claim(answer: ImportedDefinition, identity: ClaimedIdentity): ImportedDefinition;
}

/** One minted request, and the caller's own handle for ending it. */
export interface OpenAnswerRequest {
  readonly request: ComponentAnswerRequest;
  /**
   * End it, synchronously.
   *
   * Called from the `finally` of the invocation that opened it, so it runs
   * whether the handler returned, threw or was cancelled. Nothing yields here:
   * a lease that needed a suspension point to close would still be open across
   * one.
   */
  close(): void;
}

/**
 * One provider installation's private authority.
 *
 * Holding this is the right to be asked, fixed to one origin. It is not the
 * right to answer: every statement goes through a request this mints for one
 * invocation, so a retained installation handle can open a *new* request but
 * cannot revive a settled one or reach another provider's.
 */
export interface ProviderInstallation {
  /** Begin one handler invocation's request for one asked name. */
  open(name: string, position?: Readonly<SourcePosition>): OpenAnswerRequest;
}

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
   * then creates provider installations — so a failure between construction
   * and activation cannot leave live answer authority with no teardown behind
   * it.
   */
  #active = false;
  /**
   * The one resolution a claim may be stated during, when one is open.
   *
   * A provider installation outlives every resolution it takes part in, while a
   * fresh request belongs to one handler invocation. Canonical execution asks
   * the chain for one name, reads the answer, and closes the occurrence. A
   * claim arriving outside that window is a losing or delayed handler recording
   * into a decision already made, which is exactly what an admission must not
   * acquire afterwards.
   *
   * So the window carries both terms. The occurrence keeps a claim from
   * belonging to a resolution other than the live one, and the name keeps a
   * handler settled for one name from recording under it while a different
   * name is being resolved.
   */
  #window: ResolutionWindow | undefined;
  /** How many resolutions this owner has opened, so each one is its own. */
  #occurrences = 0;
  /**
   * The resolution each installation last stated an answer for.
   *
   * Secondary. What proves a statement belongs to an import is the request's
   * captured window, not this; this only keeps one provider from naming two
   * different implementations for one import, where only one of them could be
   * what it resolved to.
   *
   * Keyed by the installation's own frozen token and holding the window object,
   * so an installation stays reusable: it answers several admitted names and
   * the same name resolved more than once, because each of those is a different
   * window. Spending the installation itself would break a valid multi-name
   * provider, which the contract does not ask a host to split up.
   */
  readonly #spent = new WeakMap<object, ResolutionWindow>();

  /** Begin identifying. Called after teardown is registered. */
  activate(): void {
    this.#active = true;
  }

  /** Stop. Called at teardown, on completion, failure or cancellation. */
  revoke(): void {
    this.#active = false;
    this.#window = undefined;
  }

  get identifying(): boolean {
    return this.#active;
  }

  /**
   * Open the claim window for one resolution of one name.
   *
   * Canonical execution calls this immediately before asking the ordinary chain
   * and closes it in a `finally`, so the window ends the same way whether the
   * resolution answered, fell back, failed or was cancelled. Nothing else opens
   * one: there is no path from a document, a component or a provider to this
   * method.
   */
  beginResolution(name: string): ResolutionWindow {
    if (!this.#active) {
      throw new AnswerIdentityError(REVOKED_ANSWER_AUTHORITY);
    }
    this.#occurrences += 1;
    const occurrence = this.#occurrences;
    const owner = this;
    const window: ResolutionWindow = {
      name,
      occurrence,
      close(): void {
        // Only this window is closed. A nested resolution that already replaced
        // it has its own close, and clearing another one here would settle a
        // decision still being made. Compared by identity, so no bookkeeping
        // value has to be trusted to say which window this is.
        if (owner.#window === window) {
          owner.#window = undefined;
        }
      },
    };
    this.#window = window;
    return window;
  }

  /**
   * One provider installation's authority, fixed to that origin.
   *
   * Holding this is the right to be *asked*. It states nothing on its own:
   * every answer goes through a request this mints for one handler invocation,
   * so a retained installation handle can be asked again — which a multi-name
   * provider needs — and can never revive a settled request or reach another
   * provider's.
   *
   * Ordinary closures throughout. A separately loaded copy of core receives
   * this object and can answer with it; what it cannot do is state an origin
   * canonical execution did not give it, or reach the table any other way —
   * there is no shared symbol, module registry or context name behind this.
   */
  provider(origin: string): ProviderInstallation {
    const installation = Object.freeze({});
    const owner = this;
    return {
      open(name: string, position?: Readonly<SourcePosition>): OpenAnswerRequest {
        // Captured by identity, here, at the moment this invocation begins. A
        // request minted while resolution N is open answers resolution N or
        // nothing: it holds the object, so it cannot be made to describe
        // whichever window is open later.
        const opened = owner.#window;
        let live = true;
        const request: ComponentAnswerRequest = Object.freeze({
          name,
          // Copied, like everything else a provider is shown. The scanner's
          // position is the engine's own mutable object, and handing it over
          // would let a provider edit what a *later* reader of that element
          // sees — a diagnostic seam turned into a write.
          ...(position === undefined ? {} : { position: capturePosition(position) }),
          claim(answer: ImportedDefinition, stated: ClaimedIdentity): ImportedDefinition {
            return owner.#record(
              installation,
              origin,
              { name, window: opened, live: () => live },
              answer,
              stated,
            );
          },
        });
        return Object.freeze({
          request,
          close(): void {
            live = false;
          },
        });
      },
    };
  }

  #record(
    installation: object,
    origin: string,
    asked: { name: string; window: ResolutionWindow | undefined; live: () => boolean },
    answer: ImportedDefinition,
    stated: ClaimedIdentity,
  ): ImportedDefinition {
    if (!this.#active) {
      throw new AnswerIdentityError(REVOKED_ANSWER_AUTHORITY);
    }
    // Four questions, and each of them is about the invocation rather than
    // about the provider: is this handler still deciding; is the resolution it
    // was asked in the one still open, by identity; and is the name it was
    // asked the name that resolution is deciding. A stable installation handle
    // answers none of them, which is why it does not claim.
    const open = asked.window;
    if (!asked.live() || open === undefined || open !== this.#window || open.name !== asked.name) {
      throw new AnswerIdentityError(SETTLED_CLAIM);
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
        held.installation !== installation ||
        held.window !== open ||
        held.name !== asked.name ||
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
    // Secondary, and about the provider rather than the invocation: naming a
    // *different* implementation for an import this provider already answered
    // is two answers where only one could be what it resolved to.
    if (this.#spent.get(installation) === open) {
      throw new AnswerIdentityError(SPENT_OPPORTUNITY);
    }
    // Copied on the way in, so a later edit of the claimed object is visible as
    // the change it is.
    this.#claims.set(answer, {
      name: asked.name,
      identity,
      installation,
      window: open,
      canonical: retain(answer),
    });
    // Spent for this window and no other: the next import is a different
    // window, which is what lets one installation answer several admitted
    // names and the same name resolved twice.
    this.#spent.set(installation, open);
    return answer;
  }

  /**
   * The identity stated for this exact answer, and core's own copy of it.
   *
   * Read after the whole public chain has returned, so what is asked about is
   * the final answer rather than an intermediate one. Nothing here refuses: an
   * unidentified answer is an ordinary answer, and whether that is enough is
   * the caller's question.
   *
   * Both halves come back together, and the copy is the one taken when the
   * claim was recorded rather than one made now. Answering with the identity
   * alone would leave the caller holding the chain's object and needing to copy
   * it itself — one more read of a value the chain controls, after the read
   * this one checked. An alternating proxy or an accessor that answers twice
   * would pass the check and hand the second answer to the copy. So the check
   * and the thing kept are one result of one call, and the object that
   * travelled through the chain is never read again.
   */
  identify(resolution: ResolutionWindow, answer: unknown): IdentifiedAnswer | undefined {
    if (!this.#active || typeof answer !== "object" || answer === null) {
      return undefined;
    }
    const claim = this.#claims.get(answer);
    if (claim === undefined) {
      return undefined;
    }
    // The caller presents the resolution it opened, and the claim has to be an
    // answer to *that* one, by object identity and under the name it decides.
    // Nothing here consults the owner's current window: provenance read out of
    // mutable state would be a claim about whenever the question was asked
    // rather than about which import the statement answered.
    if (claim.window !== resolution || claim.name !== resolution.name) {
      return undefined;
    }
    // A claimed object the chain went on to edit is not the thing that was
    // claimed. Reading it runs whatever it is made of, and a value that refuses
    // to be compared has failed the comparison.
    if (claim.canonical === undefined || !stillDescribes(claim.canonical, answer)) {
      return undefined;
    }
    return Object.freeze({ identity: claim.identity, definition: claim.canonical });
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
 * One authored position, copied and frozen for a provider to read.
 *
 * The scanner's object belongs to the engine and is read again after any
 * handler has seen it, so it crosses this boundary by value like every other
 * thing a provider is shown. Four members, written out: a spread would carry
 * whatever a future member turned out to be, and this is a surface a host's
 * code holds.
 */
function capturePosition(position: Readonly<SourcePosition>): Readonly<SourcePosition> {
  return Object.freeze({
    ...(position.path === undefined ? {} : { path: position.path }),
    offset: position.offset,
    line: position.line,
    column: position.column,
  });
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
  readonly #imports: CanonicalImports;
  readonly #tiers: readonly ImportTier[];

  /**
   * The owner is handed in rather than made here, because it outlives this
   * object at both ends. Canonical execution constructs it before any
   * installation runs — inactive, with its teardown already registered — so a
   * provider can state identities during profile capture, long before the tiers
   * this authority is built from exist.
   */
  constructor(tiers: readonly ImportTier[], imports: CanonicalImports) {
    this.#tiers = tiers;
    this.#imports = imports;
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
