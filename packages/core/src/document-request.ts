/**
 * The capability-backed request one document expansion is asked through.
 *
 * `Execution.document` used to hand middleware the props and take back whatever
 * `DocumentResult` it returned. That made every handler authoritative: one could
 * answer without delegating and its invented result *was* the document. Nothing
 * authored ran, no root import was recorded, and a workflow installation that
 * prepares its run inside this layer never ran either — the journal ended up
 * holding one `Close` and nothing else.
 *
 * Middleware is policy, so it gets a request. A handler may read the props,
 * narrow or replace them, install contextual behavior that surrounds authored
 * work, refuse by throwing, and delegate. What it cannot do is *produce* the
 * document: only canonical core runs it, and only the outcome core recorded is
 * published — whatever a handler returns is ignored, and a failure core raised
 * stays raised even if a handler catches it.
 */

import type { Operation } from "effection";
import type { Workflow } from "@executablemd/durable-streams";
import type { Json } from "./types.ts";

/** A protocol violation by whoever is composed around a document expansion. */
export class DocumentProtocolError extends Error {
  override name = "DocumentProtocolError";

  constructor(problem: string) {
    super(
      `Execution.document middleware ${problem}. A handler may inspect, transform, refuse ` +
        "or delegate a request; only canonical execution produces a document result.",
    );
  }
}

/**
 * What a document handler is given.
 *
 * Opaque on purpose: these two members are the whole of what a handler may do
 * with it, and neither reaches the outcome canonical core keeps.
 */
export interface DocumentRequest {
  /** The props as they stand, after every handler that has run so far. */
  readonly props: Record<string, Json>;
  /** The same expansion, asked with different props. Supersedes this one. */
  withProps(props: Record<string, Json>): DocumentRequest;
}

/** One expansion's private state. */
class Expansion<T> {
  generation = 0;
  consumed = false;
  outcome: T | undefined;
  /** A canonical failure, kept whether or not middleware caught it. */
  failure: { raised: unknown } | undefined;
  /**
   * What this expansion refused, and why — keyed by the object it raised.
   *
   * Created with the expansion and reachable only from it, so it is a private
   * fact this execution owns rather than a brand, a registry or a name anyone
   * could agree with. Lookup is by identity alone: `Map.prototype.get` compares
   * with SameValueZero and invokes no trap, so asking is not a call into the
   * value.
   *
   * The *reason* is kept beside the identity, and that is the load-bearing
   * part. Identity answers "did canonical core raise this?" — it does not
   * answer "is this still what canonical core raised". Public middleware can
   * catch the exact object, replace its members with throwing accessors, and
   * rethrow it, and the object is as much core's as it ever was. So what gets
   * published is rebuilt from the reason recorded here, and the object that
   * came back is never read.
   */
  readonly raised: Map<unknown, string> = new Map();

  /** Refuse for this reason, remembering both the reason and what carried it. */
  refuse(problem: string): DocumentProtocolError {
    const error = new DocumentProtocolError(problem);
    this.raised.set(error, problem);
    return error;
  }

  /**
   * A fresh refusal carrying what this expansion refused `value` for, if it did.
   *
   * Built from the recorded reason rather than from the object, so a member
   * somebody replaced in between cannot travel with it.
   */
  republish(value: unknown): DocumentProtocolError | undefined {
    const problem = this.raised.get(value);
    return problem === undefined ? undefined : new DocumentProtocolError(problem);
  }
}

class CanonicalDocumentRequest<T> implements DocumentRequest {
  readonly #expansion: Expansion<T>;
  readonly #generation: number;
  readonly props: Record<string, Json>;

  constructor(expansion: Expansion<T>, props: Record<string, Json>, generation: number) {
    this.#expansion = expansion;
    this.#generation = generation;
    this.props = props;
    Object.freeze(this);
  }

  withProps(props: Record<string, Json>): DocumentRequest {
    this.#expansion.generation += 1;
    return new CanonicalDocumentRequest(this.#expansion, props, this.#expansion.generation);
  }

  /**
   * Take this request's props on behalf of `expansion`, once.
   *
   * The expected expansion is supplied by the caller rather than read off the
   * request: a request another invocation issued is also canonical, and
   * accepting it would let one execution's terminal answer for another's.
   * Everything is checked before anything is written, so a rejected delegation
   * consumes neither and both remain usable.
   */
  static claim<T>(request: unknown, expansion: Expansion<T>): Record<string, Json> {
    CanonicalDocumentRequest.verify(request, expansion);
    // Detached before acceptance is recorded, so a refusal here leaves the
    // expansion exactly as it was and the same request may be delegated again.
    const props = detachProps(request.props, expansion);
    // Verified again on the far side of detachment, because detachment runs
    // caller-controlled code: a getter, an `ownKeys` trap or an iterator can
    // call `withProps()` and return normally, and the request that was current
    // when the first check passed is superseded by the time the copy exists.
    // Accepting it here would run the document on props the handler had already
    // replaced. Nothing has been recorded yet, so this refusal consumes neither
    // the superseded request nor the one that replaced it.
    CanonicalDocumentRequest.verify(request, expansion);
    expansion.consumed = true;
    return props;
  }

  /** Whether this request is still the one this expansion may be asked through. */
  static verify<T>(
    request: unknown,
    expansion: Expansion<T>,
  ): asserts request is CanonicalDocumentRequest<T> {
    if (!CanonicalDocumentRequest.own<T>(request)) {
      throw expansion.refuse("delegated a request canonical execution did not issue");
    }
    if (request.#expansion !== expansion) {
      throw expansion.refuse("delegated a request another expansion issued");
    }
    if (expansion.consumed) {
      throw expansion.refuse("delegated a document request more than once");
    }
    if (request.#generation !== expansion.generation) {
      throw expansion.refuse("delegated a request that a later withProps() superseded");
    }
  }

  /** Whether this class built `value`, answered without trusting it. */
  static own<T>(value: unknown): value is CanonicalDocumentRequest<T> {
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

/**
 * What canonical execution produced for one expansion.
 *
 * Reported rather than raised. A handler that throws after delegating must not
 * be able to bury what the document already decided, so this says what happened
 * and canonical core ranks it against the later failure itself.
 */
export type DocumentSettlement<T> =
  /** Canonical execution ran and produced this exact outcome. */
  | { readonly status: "produced"; readonly outcome: T }
  /** Canonical execution raised this exact failure. Not middleware's to rescue. */
  | { readonly status: "raised"; readonly raised: unknown }
  /** The terminal was never reached, so no document exists. */
  | { readonly status: "absent"; readonly refusal: DocumentProtocolError };

/**
 * A frozen structural copy of the props a handler delegated.
 *
 * A handler may build props of its own through `withProps()`, delegate them, and
 * still hold every container it built. Copying at acceptance is what stops it
 * from editing the document's inputs afterwards: validation, expansion and
 * output all read this copy, and nothing a caller still owns reaches them.
 *
 * Anything that is not JSON — and any object that resists being read — is
 * refused. The refusal is built here rather than rethrown, so neither a hostile
 * trap's message nor the value that produced it reaches the caller.
 */
function detachProps<T>(props: unknown, expansion: Expansion<T>): Record<string, Json> {
  let detached: Json;
  try {
    detached = detachValue(props);
  } catch {
    throw expansion.refuse("delegated props that could not be detached");
  }
  if (detached === null || typeof detached !== "object" || Array.isArray(detached)) {
    throw expansion.refuse("delegated props that are not a JSON object");
  }
  return detached;
}

function detachValue(value: unknown): Json {
  if (value === null) {
    return null;
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    // Neither survives a journal round trip, so neither is a document input.
    if (!Number.isFinite(value)) {
      throw new DocumentProtocolError("delegated a number JSON cannot carry");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new DocumentProtocolError("delegated a value that is not JSON");
  }
  if (Array.isArray(value)) {
    const copy: Json[] = [];
    for (const element of value) {
      copy.push(detachValue(element));
    }
    Object.freeze(copy);
    return copy;
  }
  const copy: Record<string, Json> = {};
  for (const [key, member] of Object.entries(value)) {
    // Defined rather than assigned: on some runtimes assigning "__proto__"
    // rewrites the prototype instead of adding the member the props carried.
    Object.defineProperty(copy, key, {
      value: detachValue(member),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  Object.freeze(copy);
  return copy;
}

/** One expansion's request, and what canonical core reads back from it. */
export interface IssuedDocument<T> {
  readonly request: DocumentRequest;
  /** Run the canonical document for this request, once, and keep its outcome. */
  claim(request: unknown): Operation<void>;
  /**
   * What canonical execution settled to.
   *
   * Readable whether or not the public chain returned normally: a middleware
   * throw must not prevent the canonical outcome from being reconciled.
   */
  settlement(): DocumentSettlement<T>;
  /**
   * A fresh, safe refusal carrying what this expansion refused `value` for.
   *
   * `undefined` when this expansion did not raise it. Identity is the only
   * question canonical core can ask that tells it anything trustworthy —
   * `instanceof`, a shape, a name and a successful property read all describe
   * how a value behaves when asked, and a value may behave differently the next
   * time. But identity answers only where the object came *from*. What it
   * carries now is a separate question, and the answer is: don't ask. The
   * refusal handed back here is built from the reason canonical core recorded
   * when it refused, and the object that came back is never read.
   */
  republish(value: unknown): DocumentProtocolError | undefined;
}

/**
 * Issue one document expansion.
 *
 * `run` is canonical core's own expansion. It is reached only through `claim`,
 * so a handler that does not delegate never runs it — and the outcome it
 * produced is the only one `settle()` will hand back.
 */
export function issueDocument<T>(
  props: Record<string, Json>,
  run: (props: Record<string, Json>) => Operation<T>,
): IssuedDocument<T> {
  const expansion = new Expansion<T>();
  return {
    request: new CanonicalDocumentRequest(expansion, props, expansion.generation),
    *claim(request: unknown): Operation<void> {
      const claimed = CanonicalDocumentRequest.claim(request, expansion);
      try {
        expansion.outcome = yield* run(claimed);
      } catch (error) {
        // Kept whether or not a handler catches what propagates: a failure
        // canonical execution raised is not middleware's to rescue.
        expansion.failure = { raised: error };
        throw error;
      }
    },
    republish(value: unknown): DocumentProtocolError | undefined {
      return expansion.republish(value);
    },
    settlement(): DocumentSettlement<T> {
      const failure = expansion.failure;
      if (failure !== undefined) {
        return { status: "raised", raised: failure.raised };
      }
      if (!expansion.consumed) {
        return {
          status: "absent",
          refusal: expansion.refuse("returned without delegating the document request"),
        };
      }
      const outcome = expansion.outcome;
      if (outcome === undefined) {
        return {
          status: "raised",
          raised: expansion.refuse("returned before the document produced a result"),
        };
      }
      return { status: "produced", outcome };
    },
  };
}

/**
 * What a trusted host prepares inside the durable root.
 *
 * Captured by canonical core before any installation runs, and invoked after
 * retained-history admission and before any public document policy or the root
 * import — so what it records precedes everything a handler could observe or
 * refuse.
 *
 * A `Workflow` rather than a plain `Operation`: preparation runs inside the
 * durable root, and what it prepares is meant to be journaled. A durable
 * effect it completes is retained like any other, so a resumed run restores it
 * instead of performing it again.
 */
export type DurablePreparation = () => Workflow<void>;
