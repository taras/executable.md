/**
 * The expansion boundary an installed structural form is implemented across
 * (spec §6.1).
 *
 * Everything that crosses here is evaluated, validated and detached before
 * either public policy or the selected implementation sees it. A request states
 * what the author wrote — the selected name, where it came from, which form was
 * written, where it sits in the source, and the props that form declared — and
 * nothing else. Raw segments, the binding environment, the Effection scope,
 * durable context, the owning installation and any general expansion authority
 * stay behind the boundary.
 */

import type { Operation, Stream } from "effection";

import type { InvocationForm } from "./invocation-identity.ts";
import type { SourcePosition } from "./types.ts";

/**
 * The JSON one structural prop may be.
 *
 * Recursively immutable, because what a package receives is this execution's
 * own copy: an implementation that writes to a prop changes nothing a later
 * occurrence, a sibling region or the durable record will see.
 */
export type ExpansionJson =
  | null
  | boolean
  | number
  | string
  | readonly ExpansionJson[]
  | { readonly [name: string]: ExpansionJson };

/** What one occurrence of an installed structural form says. */
export interface ExpansionRequest {
  /** The declared name the document wrote. */
  readonly name: string;
  /** The origin its declaration reports. */
  readonly origin: string;
  /** Which of the declared forms was written here. */
  readonly form: InvocationForm;
  /** Where the occurrence sits, when the source says. */
  readonly position?: Readonly<SourcePosition>;
  /**
   * The props this occurrence declared, evaluated and schema-validated.
   *
   * A prop whose expression resolved to `undefined` is absent, exactly as it is
   * for an ordinary component (§6.5).
   */
  readonly props: Readonly<Record<string, ExpansionJson>>;
}

/**
 * One piece of a region's rendered output.
 *
 * `exact` is the existing fact about whether these bytes are a program's source
 * rather than prose, carried so a consumer groups and presents them the way
 * root output does.
 */
export interface ExpansionChunk {
  readonly text: string;
  readonly exact: boolean;
}

/**
 * One accepted direct child, and the output expanding it produces.
 *
 * `expand()` establishes the region's producer as a resource in the calling
 * structural handler's scope. The returned stream is backpressured per chunk:
 * the producer does not advance past a delivered chunk until the consumer
 * advances again, so a handler that stops consuming stops the work rather than
 * accumulating it. Leaving the handler's scope, cancelling, and failing each
 * unwind the region through ordinary structured teardown.
 *
 * Region output never travels through `DocumentOutput`, and nothing copies an
 * unconsumed region into the root.
 */
export interface ExpansionRegion extends ExpansionRequest {
  expand(): Operation<Stream<ExpansionChunk, void>>;
}

/**
 * How one installation expands the structural forms it declared.
 *
 * Bound and captured with its declarations, and reached only through canonical
 * core's private terminal.
 */
export type StructuralExpander = (
  request: ExpansionRequest,
  regions: readonly ExpansionRegion[],
) => Operation<void>;

/** A protocol violation by whoever is composed around a structural expansion. */
export class ExpansionProtocolError extends Error {
  override name = "ExpansionProtocolError";

  constructor(problem: string) {
    super(
      `Execution.expand middleware ${problem}. A handler may inspect, refuse or delegate a ` +
        "request; only canonical execution expands an installed structural form.",
    );
  }
}

/** One occurrence's private state. */
class Expansion {
  consumed = false;
  /** A canonical failure, kept whether or not middleware caught it. */
  failure: { raised: unknown } | undefined;
  /**
   * What this occurrence refused, and why — keyed by the object it raised.
   *
   * The reason is what gets republished. Identity answers where an object came
   * from; it does not answer whether the object still carries what core put in
   * it, and public middleware can catch the exact error and replace its members
   * before rethrowing.
   */
  readonly raised: Map<unknown, string> = new Map();

  refuse(problem: string): ExpansionProtocolError {
    const error = new ExpansionProtocolError(problem);
    this.raised.set(error, problem);
    return error;
  }

  republish(value: unknown): ExpansionProtocolError | undefined {
    const problem = this.raised.get(value);
    return problem === undefined ? undefined : new ExpansionProtocolError(problem);
  }
}

/** The facts one occurrence publishes, already evaluated and detached. */
export interface ExpansionFacts {
  readonly name: string;
  readonly origin: string;
  readonly form: InvocationForm;
  readonly position?: Readonly<SourcePosition>;
  readonly props: Readonly<Record<string, ExpansionJson>>;
}

class CanonicalExpansionRequest implements ExpansionRequest {
  readonly #expansion: Expansion;
  readonly name: string;
  readonly origin: string;
  readonly form: InvocationForm;
  readonly position?: Readonly<SourcePosition>;
  readonly props: Readonly<Record<string, ExpansionJson>>;

  constructor(expansion: Expansion, facts: ExpansionFacts) {
    this.#expansion = expansion;
    this.name = facts.name;
    this.origin = facts.origin;
    this.form = facts.form;
    if (facts.position !== undefined) {
      this.position = facts.position;
    }
    this.props = facts.props;
    Object.freeze(this);
  }

  /**
   * Accept this request on behalf of `expansion`, once.
   *
   * The expected occurrence is supplied by the caller rather than read off the
   * request: a request another occurrence issued is also canonical, and
   * accepting it would let one parent's terminal answer for another's.
   */
  static claim(request: unknown, expansion: Expansion): void {
    CanonicalExpansionRequest.verify(request, expansion);
    expansion.consumed = true;
  }

  static verify(
    request: unknown,
    expansion: Expansion,
  ): asserts request is CanonicalExpansionRequest {
    if (!CanonicalExpansionRequest.own(request)) {
      throw expansion.refuse("delegated a request canonical execution did not issue");
    }
    if (request.#expansion !== expansion) {
      throw expansion.refuse("delegated a request another expansion issued");
    }
    if (expansion.consumed) {
      throw expansion.refuse("delegated an expansion request more than once");
    }
  }

  /** Whether this class built `value`, answered without trusting it. */
  static own(value: unknown): value is CanonicalExpansionRequest {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    try {
      return #expansion in value;
    } catch {
      return false;
    }
  }
}

/** What canonical expansion settled to for one occurrence. */
export type ExpansionSettlement =
  /** The selected implementation ran and returned. */
  | { readonly status: "expanded" }
  /** Canonical expansion raised this exact failure. Not middleware's to rescue. */
  | { readonly status: "raised"; readonly raised: unknown }
  /** The terminal was never reached, so nothing expanded. */
  | { readonly status: "absent"; readonly refusal: ExpansionProtocolError };

/** One occurrence's request, and what canonical core reads back from it. */
export interface IssuedExpansion {
  readonly request: ExpansionRequest;
  /** Run the captured owner's implementation for this request, once. */
  claim(request: unknown): Operation<void>;
  settlement(): ExpansionSettlement;
  republish(value: unknown): ExpansionProtocolError | undefined;
}

/**
 * Issue one structural expansion.
 *
 * `run` is the captured owner's bound implementation. It is reached only
 * through `claim`, so a handler that does not delegate never runs it, and no
 * handler can substitute an implementation for the one the host selected.
 */
export function issueExpansion(facts: ExpansionFacts, run: () => Operation<void>): IssuedExpansion {
  const expansion = new Expansion();
  return {
    request: new CanonicalExpansionRequest(expansion, facts),
    *claim(request: unknown): Operation<void> {
      CanonicalExpansionRequest.claim(request, expansion);
      try {
        yield* run();
      } catch (error) {
        expansion.failure = { raised: error };
        throw error;
      }
    },
    republish(value: unknown): ExpansionProtocolError | undefined {
      return expansion.republish(value);
    },
    settlement(): ExpansionSettlement {
      const failure = expansion.failure;
      if (failure !== undefined) {
        return { status: "raised", raised: failure.raised };
      }
      if (!expansion.consumed) {
        return {
          status: "absent",
          refusal: expansion.refuse("returned without delegating the expansion request"),
        };
      }
      return { status: "expanded" };
    },
  };
}
