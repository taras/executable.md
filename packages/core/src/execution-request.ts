/**
 * The capability-backed request one document execution is asked through.
 *
 * `Execution.execute` used to hand middleware the finished `DocumentExecution`
 * and take back whatever it returned. That made every handler authoritative by
 * construction: one could answer without delegating and its invented completion
 * *was* the execution, and one could wrap the returned handle and rewrite what
 * the document had already settled.
 *
 * Middleware is policy, so it gets a request rather than the execution. A
 * handler may read the options, narrow or replace them, register an additive
 * completion failure, refuse by throwing, install contextual behavior the
 * document will inherit, and delegate. What it cannot do is *complete* the
 * execution: the only thing that runs a document is canonical core, reached
 * after the middleware chain unwinds, and it runs the options the terminal
 * recorded.
 *
 * The capability is the request itself. It carries a private reference to one
 * invocation and may be consumed exactly once, so a reconstructed look-alike, a
 * stale request left over from `withOptions()`, a second delegation and a
 * replayed request are all refusals rather than second executions.
 */

import type { ExecuteOptions } from "./execute.ts";

/**
 * A protocol violation by whoever is composed around an execution.
 *
 * Fresh and cause-free every time. What went wrong is the shape of the call,
 * not anything a caller supplied, and attaching their value would carry it into
 * logs and rendered output.
 */
export class ExecutionProtocolError extends Error {
  override name = "ExecutionProtocolError";

  constructor(problem: string) {
    super(
      `Execution middleware ${problem}. A handler may inspect, transform, refuse or ` +
        "delegate a request; only canonical execution completes one.",
    );
  }
}

/** An additive completion policy: it may fail a success, never rescue a failure. */
export type CompletionFailure = () => Error | undefined;

/**
 * What a handler is given.
 *
 * Opaque on purpose: the members below are the whole of what a handler may do
 * with it, and none of them reaches the admissions the invocation captured.
 */
export interface ExecutionRequest {
  /** The options as they stand, after every handler that has run so far. */
  readonly options: ExecuteOptions;
  /** The same invocation, asked with different options. Supersedes this one. */
  withOptions(options: ExecuteOptions): ExecutionRequest;
  /** Register a completion policy. Additive: it can fail a success, not rescue one. */
  addCompletionFailure(failure: CompletionFailure): void;
}

/**
 * One execution's private state.
 *
 * `generation` is what makes a superseded request stale: `withOptions()` mints
 * the next generation, and only the newest may be consumed. Without it a
 * handler could transform the options and then delegate the request it started
 * from, running the document under options a later handler believed it had
 * replaced.
 */
class Invocation {
  generation = 0;
  consumed = false;
  settled: ExecuteOptions | undefined;
  readonly completions: CompletionFailure[] = [];
}

class CanonicalRequest implements ExecutionRequest {
  readonly #invocation: Invocation;
  readonly #generation: number;
  readonly options: ExecuteOptions;

  constructor(invocation: Invocation, options: ExecuteOptions, generation: number) {
    this.#invocation = invocation;
    this.#generation = generation;
    this.options = options;
    Object.freeze(this);
  }

  withOptions(options: ExecuteOptions): ExecutionRequest {
    this.#invocation.generation += 1;
    return new CanonicalRequest(this.#invocation, options, this.#invocation.generation);
  }

  addCompletionFailure(failure: CompletionFailure): void {
    this.#invocation.completions.push(failure);
  }

  /**
   * Take this request's options, once, on behalf of the invocation that minted
   * it.
   *
   * A private field rather than a shared registry: reading it off a value this
   * class did not construct throws, which is exactly the answer a reconstructed
   * look-alike deserves, and it keeps the check out of any module-scoped state.
   */
  /**
   * Take this request's options on behalf of `invocation`, once.
   *
   * The expected invocation is supplied by the caller rather than read off the
   * request, which is the whole point: a request another invocation issued is
   * *also* a canonical request, and accepting it would let one execution's
   * terminal settle another's.
   *
   * Every check runs before anything is written, so a rejected delegation
   * consumes neither invocation and both remain usable afterwards.
   */
  static consume(request: unknown, invocation: Invocation): void {
    // `#invocation in request` recognizes a value this class constructed
    // without reading anything off it and without a registry to consult. It is
    // also total: `in` on a primitive, on null, or on a proxy whose traps throw
    // is guarded here, so nothing native or planted escapes.
    if (!isCanonical(request)) {
      throw new ExecutionProtocolError("delegated a request canonical execution did not issue");
    }
    if (request.#invocation !== invocation) {
      throw new ExecutionProtocolError("delegated a request another execution issued");
    }
    if (invocation.consumed) {
      throw new ExecutionProtocolError("delegated an execution request more than once");
    }
    if (request.#generation !== invocation.generation) {
      throw new ExecutionProtocolError("delegated a request that a later withOptions() superseded");
    }
    invocation.consumed = true;
    invocation.settled = request.options;
  }

  /** Whether this class built `value`, answered without trusting it. */
  static own(value: unknown): value is CanonicalRequest {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    try {
      return #invocation in value;
    } catch {
      // A revoked proxy, or one whose `has` trap refuses. Not one of ours.
      return false;
    }
  }
}

function isCanonical(value: unknown): value is CanonicalRequest {
  return CanonicalRequest.own(value);
}

/** One execution's request and what the invocation reads back from it. */
export interface IssuedExecution {
  readonly request: ExecutionRequest;
  /**
   * Settle this invocation on `request`, or refuse it.
   *
   * Called only by the invocation's own private terminal — the default handler
   * of the same-name Api instance canonical core built for this call.
   */
  consume(request: unknown): void;
  /** The options the terminal recorded, or a refusal when it was never reached. */
  settle(): ExecuteOptions;
  /** Every completion policy registered, in registration order. */
  completions(): readonly CompletionFailure[];
}

export function issueExecution(options: ExecuteOptions): IssuedExecution {
  const invocation = new Invocation();
  return {
    request: new CanonicalRequest(invocation, options, invocation.generation),
    consume(request: unknown): void {
      CanonicalRequest.consume(request, invocation);
    },
    settle(): ExecuteOptions {
      const settled = invocation.settled;
      if (!invocation.consumed || settled === undefined) {
        throw new ExecutionProtocolError("returned without delegating the execution request");
      }
      return settled;
    },
    completions(): readonly CompletionFailure[] {
      return Object.freeze([...invocation.completions]);
    },
  };
}
