/**
 * Canonical expansion observation (spec §5.7).
 *
 * One executable element, surrounded from before its resolution through its
 * owned cleanup and the acceptance of what it produced. Core issues a request,
 * the public `Component.expand` chain composes around it, and exactly one
 * delegation of that exact request runs the work.
 *
 * Observation only. What middleware returns is ignored, what it catches it does
 * not rescue, and the outgoing result stays private until canonical acceptance
 * has reconciled it — so an observer learns what happened and decides nothing
 * about it. The authority is the same one `bound-exec.ts` keeps: a private
 * brand nothing outside can forge, a claim that can be spent once, and a
 * settlement readable whether or not the chain returned normally.
 */

import { createQueue, ensure, Err, Ok } from "effection";
import type { Operation, Queue, Stream } from "effection";
import { expandThroughTerminal } from "./component-api.ts";
import type { ComponentExpansionPhase, ComponentExpansionRequest } from "./component-api.ts";
import type { Expansion } from "./expansion.ts";

/** What an observer did that canonical expansion cannot act on. */
export class ComponentExpansionProtocolError extends Error {
  override name = "ComponentExpansionProtocolError";
  constructor(problem: string) {
    super(
      `Component.expand middleware ${problem}. A handler may observe, refuse or delegate an ` +
        "expansion; only canonical execution runs one.",
    );
  }
}

/**
 * The latest phase, then what happens next, per subscriber.
 *
 * Latest rather than every earlier phase: an observer that arrives while an
 * element is already active wants to know that it is active, not to be walked
 * through a history it missed. One queue per subscription, filled
 * synchronously, so a reader that is slow or never reads at all delays nothing —
 * execution never waits for an observer, and cancelling a subscription neither
 * starts nor stops the work it was watching.
 */
interface PhasePublication {
  readonly phases: Stream<ComponentExpansionPhase, void>;
  /** Publish one non-terminal phase. */
  publish(phase: ComponentExpansionPhase): void;
  /** Publish the one terminal phase and close every subscription with void. */
  finish(phase: ComponentExpansionPhase): void;
}

function createPhasePublication(): PhasePublication {
  const subscribers = new Set<Queue<ComponentExpansionPhase, void>>();
  let latest: ComponentExpansionPhase | undefined;
  let closed = false;

  const deliver = (phase: ComponentExpansionPhase): void => {
    latest = phase;
    for (const queue of subscribers) {
      queue.add(phase);
    }
  };

  return {
    phases: {
      *[Symbol.iterator]() {
        const queue = createQueue<ComponentExpansionPhase, void>();
        // Registered with its latest observation in one step, so nothing can
        // land between reading the latest phase and being told the next one.
        if (latest !== undefined) {
          queue.add(latest);
        }
        if (closed) {
          queue.close();
          return queue;
        }
        subscribers.add(queue);
        yield* ensure(() => {
          subscribers.delete(queue);
        });
        return queue;
      },
    },
    publish(phase: ComponentExpansionPhase): void {
      if (!closed) {
        deliver(phase);
      }
    },
    finish(phase: ComponentExpansionPhase): void {
      if (closed) {
        return;
      }
      deliver(phase);
      closed = true;
      for (const queue of subscribers) {
        queue.close();
      }
      subscribers.clear();
    },
  };
}

/** What canonical expansion kept about one element while it ran. */
interface ExpansionWork {
  consumed: boolean;
  /** The canonical failure, kept whether or not a handler caught it. */
  failure?: { readonly raised: unknown };
  /** Whether the delegated work ran to its own completion. */
  ran: boolean;
}

/**
 * One element's request, branded so nothing outside this module can build one.
 *
 * The brand is what makes delegation exact: a copy carrying the same members is
 * not this request, and a handler holding one from a sibling expansion cannot
 * spend it here.
 */
class CanonicalExpansionRequest implements ComponentExpansionRequest {
  readonly #work: ExpansionWork;
  readonly expansion: Expansion;
  readonly phases: Stream<ComponentExpansionPhase, void>;

  constructor(work: ExpansionWork, expansion: Expansion, publication: PhasePublication) {
    this.#work = work;
    this.expansion = expansion;
    this.phases = publication.phases;
    Object.freeze(this);
  }

  /** The work `request` speaks for, once, or the refusal saying why it speaks for none. */
  static claim(request: unknown): ExpansionWork {
    if (!CanonicalExpansionRequest.own(request)) {
      throw new ComponentExpansionProtocolError(
        "delegated a request canonical execution did not issue",
      );
    }
    const work = request.#work;
    if (work.consumed) {
      throw new ComponentExpansionProtocolError("delegated one expansion more than once");
    }
    work.consumed = true;
    return work;
  }

  /** Whether this class built `value`, answered without trusting it. */
  static own(value: unknown): value is CanonicalExpansionRequest {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    try {
      return #work in value;
    } catch {
      return false;
    }
  }
}

/**
 * What one element's observers are told, handed to the paths that run its body.
 *
 * Publication and nothing else: a path that takes it can say the work started
 * and that it ended, and cannot read an outcome, decide one or reach the
 * request it belongs to.
 */
export interface ObservedExpansion {
  /** Accepted work is starting. */
  active(): void;
  /** The body's own work ended, and why, before its owned cleanup. */
  settled(reason: "returned" | "failed" | "cancelled"): void;
}

/** What canonical expansion produced for one element. */
export type ExpansionSettlement =
  /** The delegated work ran and settled on its own terms. */
  | { readonly status: "ran" }
  /** Canonical expansion raised this exact failure. Not middleware's to rescue. */
  | { readonly status: "raised"; readonly raised: unknown }
  /** The terminal was never reached, so no work ran. */
  | { readonly status: "absent"; readonly refusal: ComponentExpansionProtocolError };

/** One element's issued request, and what canonical core reads back from it. */
export interface IssuedExpansion {
  readonly request: ComponentExpansionRequest;
  /** Publish `enter`, `active` and `exit` as the work reaches them. */
  publish(phase: ComponentExpansionPhase): void;
  /**
   * Publish the one terminal phase and close every subscription.
   *
   * Called after the whole dispatch has unwound and canonical acceptance is
   * reconciled, which is why it is not the terminal's own business: middleware
   * cleanup runs outside the terminal, and a completion published before it
   * would say the element had finished while its observers were still running.
   */
  finish(phase: ComponentExpansionPhase): void;
  /**
   * What canonical expansion settled to.
   *
   * Readable whether or not the public chain returned normally, so a handler
   * that catches what canonical expansion raised cannot turn it into silence.
   */
  settlement(): ExpansionSettlement;
}

/** Issue one element's expansion, retaining what canonical core reads back. */
export function issueComponentExpansion(expansion: Expansion): IssuedExpansion {
  const work: ExpansionWork = { consumed: false, ran: false };
  const publication = createPhasePublication();
  return {
    request: new CanonicalExpansionRequest(work, expansion, publication),
    publish(phase: ComponentExpansionPhase): void {
      publication.publish(phase);
    },
    finish(phase: ComponentExpansionPhase): void {
      publication.finish(phase);
    },
    settlement(): ExpansionSettlement {
      const failure = work.failure;
      if (failure !== undefined) {
        return { status: "raised", raised: failure.raised };
      }
      if (!work.consumed) {
        return {
          status: "absent",
          refusal: new ComponentExpansionProtocolError("returned without delegating the expansion"),
        };
      }
      if (!work.ran) {
        return {
          status: "raised",
          raised: new ComponentExpansionProtocolError("returned before the expansion settled"),
        };
      }
      return { status: "ran" };
    },
  };
}

/**
 * Run the canonical work for one issued request, once.
 *
 * Canonical core's terminal calls this with whatever middleware delegated, so a
 * rewritten, copied or fabricated request runs nothing rather than running
 * something else. `run` is canonical core's own continuation: it is reached only
 * from here, so a handler that does not delegate never reaches it.
 */
export function* claimComponentExpansion(
  request: unknown,
  run: () => Operation<void>,
): Operation<void> {
  const work = CanonicalExpansionRequest.claim(request);
  try {
    yield* run();
  } catch (error) {
    // Kept whether or not a handler catches what propagates: a failure
    // canonical expansion raised is not middleware's to rescue.
    work.failure = { raised: error };
    throw error;
  }
  work.ran = true;
}

/**
 * One failure as an observation: what it is called and what it said, detached.
 *
 * A new Error every time, never the one canonical execution is holding. An
 * observer learns the selected name and message, and the explanatory Errors
 * behind them, and reaches no canonical identity, no resource an error happens
 * to carry and nothing `instanceof` would recognize — so catching an
 * observation cannot be mistaken for catching the failure, and a reporter that
 * serializes one carries away no live object.
 *
 * Depth is bounded because a cause chain is somebody else's data structure and
 * may be cyclic.
 */
export function reported(raised: unknown, depth = 0): Error {
  if (!(raised instanceof Error)) {
    return Object.freeze(new Error(String(raised)));
  }
  const explained = depth >= REPORTED_DEPTH ? undefined : explanatory(raised, depth);
  const detached =
    raised instanceof AggregateError
      ? new AggregateError(explained?.members ?? [], raised.message)
      : new Error(raised.message);
  detached.name = raised.name;
  if (explained?.cause !== undefined) {
    detached.cause = explained.cause;
  }
  return Object.freeze(detached);
}

/** How far a detached report follows somebody else's cause chain. */
const REPORTED_DEPTH = 8;

function explanatory(
  raised: Error,
  depth: number,
): { readonly cause: Error | undefined; readonly members: Error[] } {
  return {
    cause: raised.cause instanceof Error ? reported(raised.cause, depth + 1) : undefined,
    members:
      raised instanceof AggregateError && Array.isArray(raised.errors)
        ? raised.errors.map((member) => reported(member, depth + 1))
        : [],
  };
}

/**
 * Surround one element's work with its canonical observation.
 *
 * Every path that expands something an author wrote goes through here, so the
 * sequence a reader sees, the authority a handler has and the reconciliation
 * between the two are decided once rather than per call site.
 *
 * What the work produces is returned untouched. The observation says what
 * happened and nothing more: it cannot read the value, and a handler cannot
 * replace it, rescue a failure or complete the element early.
 */
export function* observeExpansion<T>(
  expansion: Expansion,
  work: (observed: ObservedExpansion) => Operation<T>,
): Operation<T> {
  const issued = issueComponentExpansion(expansion);
  let produced: { readonly value: T } | undefined;
  let terminated = false;
  const terminate = (phase: ComponentExpansionPhase): void => {
    if (!terminated) {
      terminated = true;
      issued.finish(phase);
    }
  };
  issued.publish({ phase: "enter" });
  // Said once however many body paths an element has: a second ACTIVE would
  // be the same observation twice, and a reader counting changes would see a
  // step that did not happen.
  let active = false;
  const observed: ObservedExpansion = {
    active: () => {
      if (!active) {
        active = true;
        issued.publish({ phase: "active" });
      }
    },
    settled: (reason) => issued.publish({ phase: "exit", reason }),
  };

  let chainFailure: unknown;
  let chainFailed = false;
  try {
    try {
      yield* expandThroughTerminal(issued.request, (delegated) =>
        claimComponentExpansion(delegated, function* () {
          produced = { value: yield* work(observed) };
        }),
      );
    } catch (error) {
      chainFailure = error;
      chainFailed = true;
    }
    // Reconciled after the whole dispatch has unwound, middleware cleanup
    // included. A handler may refuse the work or fail a success; what it
    // cannot do is rescue what canonical expansion raised, which is read back
    // from the terminal rather than from whether the chain returned normally.
    const settlement = issued.settlement();
    if (settlement.status === "raised") {
      terminate({ phase: "complete", result: Err(reported(settlement.raised)) });
      throw settlement.raised;
    }
    if (settlement.status === "absent") {
      const refusal = chainFailed ? chainFailure : settlement.refusal;
      terminate({ phase: "complete", result: Err(reported(refusal)) });
      throw refusal;
    }
    if (chainFailed) {
      terminate({ phase: "complete", result: Err(reported(chainFailure)) });
      throw chainFailure;
    }
    if (produced === undefined) {
      const missing = new ComponentExpansionProtocolError("returned before the expansion settled");
      terminate({ phase: "complete", result: Err(reported(missing)) });
      throw missing;
    }
    terminate({ phase: "complete", result: Ok(undefined) });
    return produced.value;
  } finally {
    // Nothing terminal was published, so this element unwound without
    // completing: a clean cancellation, told after it has finished unwinding.
    terminate({ phase: "cancelled" });
  }
}
