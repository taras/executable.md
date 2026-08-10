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
  static consume(request: ExecutionRequest): void {
    // `#invocation in request` recognizes a value this class constructed
    // without reading anything off it and without a registry to consult. A
    // look-alike rebuilt from the public shape simply is not one.
    //
    // The request's own invocation is the authority, so nothing per-call has to
    // live at module scope — which is what keeps two concurrent executions from
    // consuming each other's requests.
    if (!(#invocation in request)) {
      throw new ExecutionProtocolError("delegated a request canonical execution did not issue");
    }
    const invocation = request.#invocation;
    if (invocation.consumed) {
      throw new ExecutionProtocolError("delegated an execution request more than once");
    }
    if (request.#generation !== invocation.generation) {
      throw new ExecutionProtocolError("delegated a request that a later withOptions() superseded");
    }
    invocation.consumed = true;
    invocation.settled = request.options;
  }
}

/** One execution's request and what the invocation reads back from it. */
export interface IssuedExecution {
  readonly request: ExecutionRequest;
  /** The options the terminal recorded, or a refusal when it was never reached. */
  settle(): ExecuteOptions;
  /** Every completion policy registered, in registration order. */
  completions(): readonly CompletionFailure[];
}

export function issueExecution(options: ExecuteOptions): IssuedExecution {
  const invocation = new Invocation();
  return {
    request: new CanonicalRequest(invocation, options, invocation.generation),
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

/**
 * Consume a request on behalf of canonical execution's terminal handler.
 *
 * The terminal is one object built at module evaluation while an invocation is
 * per call, so it cannot close over the invocation — it reads the one the
 * request carries instead.
 */
export function consumeAtTerminal(request: ExecutionRequest): void {
  CanonicalRequest.consume(request);
}
