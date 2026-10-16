/**
 * The live execution that runs a trusted host's root evaluations.
 *
 * A generated root is evaluated *by* an execution rather than beside one. What
 * it needs to run at all — the captured documentation reference, the guarded
 * route canonical `<Syntax />` is entered through, the Agent providers and
 * launch coordinator a document installs, the journal this run writes — all
 * belong to one live execution and are reachable nowhere else. So the public
 * method is a mailbox: a caller puts a request on the queue this owner is
 * reading, and the work happens inside the document's own scope, where that
 * authority already is.
 *
 * Three things follow from that, and they are the whole of this module.
 *
 * ## A caller waits for readiness; it does not choose another scope
 *
 * The host handle exists before the document workflow has installed anything,
 * because canonical execution publishes the handle and then runs. A call that
 * arrives in between waits for this owner to be activated inside the document
 * scope, or is told the execution closed. It does not fall back to the caller's
 * scope: an evaluation run there would inherit whatever the caller installed
 * and reach none of the services the document's own root work reaches, which is
 * a different evaluation wearing the same name.
 *
 * ## One at a time, and busy lasts through cleanup
 *
 * One evaluation runs at a time and an overlapping call refuses rather than
 * queuing, for the reason a conversation refuses a second turn: there is one
 * next sequence, and two evaluations in flight have no single one. A cancelled
 * call stays busy until the work it started has finished unwinding — a second
 * admitted in between would start while the first was still inside a provider.
 *
 * ## Each evaluation owns its own durable sequence
 *
 * A response is not part of the document's continuation. It is explicit work a
 * host asked for, so it gets a sequence of its own on the same canonical
 * journal: its own coroutine, its own terminal, and a view of the journal that
 * holds its own events and no others. The main continuation gets the
 * complementary view, so neither consumes the other's history — a document
 * replaying its own work past a retained response would be reading somebody
 * else's record as its own.
 *
 * Addresses are allocated past every retained evaluation, which is what makes
 * reopening safe: a completed response is not run again because nothing asks
 * for its address, and an interrupted one is not continued because the next
 * call gets a fresh one. Both views append straight through to the journal, so
 * provenance, the secret gate and acknowledged append order are exactly what
 * they were.
 */

import { createQueue, Err, ensure, Ok, race, scoped, spawn, withResolvers } from "effection";
import type { Operation, Queue, Result } from "effection";
import { durableRun, preserveJournalProvenance, retainEvents } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream } from "@executablemd/durable-streams";

import type { GeneratedXmdRootRequest, GeneratedXmdRootResult } from "./generated-xmd.ts";

/** Why this execution could not take the root evaluation it was asked for. */
export class HostExecutionError extends Error {
  override name = "HostExecutionError";
}

/** One execution's bound root evaluator, as the owner and the handle hold it. */
export type BoundRootEvaluator = (
  request: GeneratedXmdRootRequest,
) => Operation<Result<GeneratedXmdRootResult>>;

/** What canonical execution hands its owner once both exist. */
export interface GeneratedRootInputs {
  /**
   * The journal this execution writes, already wrapped in whatever gate and
   * provenance the execution established.
   *
   * Each evaluation's view is derived from this exact stream rather than from
   * the backend, so a response crosses the same secret gate the document's own
   * work crosses and carries the same provenance witness.
   */
  readonly journal: DurableStream;
  /** The evaluator bound to this execution's captured authority. */
  readonly evaluator: BoundRootEvaluator;
}

/** The live owner of one execution's explicit root evaluations. */
export interface GeneratedRootOwner {
  /**
   * The operation a trusted host handle exposes.
   *
   * It closes over the queue and the owner's state, and over nothing a caller
   * could read: no evaluator, no journal, no route and no reference.
   */
  readonly evaluate: BoundRootEvaluator;
  /** Hand over the inputs, once, from inside the execution that holds them. */
  supply(inputs: GeneratedRootInputs): void;
  /**
   * Close with the canonical invocation, however that invocation ends.
   *
   * Registered in the invocation's own scope rather than the document's,
   * because the handle — and the bound operation on it — exist before the
   * document body does and outlive every way the body can fail to start. A
   * public `Execution.document` handler that refuses before delegating, a root
   * import that fails, a completed document that replays without entering its
   * body: each ends the invocation without ever activating the runner, and the
   * operation a host is already holding must then refuse rather than wait for
   * a readiness nothing is left to announce.
   *
   * Closing a handle is therefore not something activating it first makes
   * possible. {@link GeneratedRootOwner.activate} registers its own closure as
   * well, inside the scope that owns the worker, and that is what keeps the
   * stronger guarantee an active runner carries: it closes only after its work
   * and every cleanup that work registered have joined.
   */
  attend(): Operation<void>;
  /**
   * Begin admitting work, in the document's own scope.
   *
   * Called from the canonical document workflow, after `Execution.document` has
   * installed the document's runtime services and before authored root work, so
   * an evaluation reaches what a document's own elements reach.
   */
  activate(): Operation<void>;
  /**
   * The authoritative failure one of this execution's evaluations raised, if
   * any, as the execution's own completion policy reads it.
   *
   * A failure of the *run* is this execution's outcome as well as the call's,
   * and this is how it becomes one. It is **not** raised into the document's
   * scope: the same failure would then be both the answer a caller is waiting
   * for and the thing tearing down the path that answer travels, and which of
   * the two arrived first would decide whether the caller was handed the
   * failure or merely told the execution had ended. So the caller is answered
   * and the completion is failed, and a host that catches the answer still
   * cannot read a successful main result.
   */
  completion(): Error | undefined;
}

/** What one caller asked this execution to evaluate. */
interface RootJob {
  readonly request: GeneratedXmdRootRequest;
  readonly answer: Resolvers<Settled>;
  readonly cancelled: Resolvers<void>;
  readonly joined: Resolvers<void>;
}

/**
 * What an evaluation settled to, as the worker reports it.
 *
 * Two arms rather than one, because the two failures are different things for a
 * caller to be holding. The request's own failure is a value; a failure of the
 * *run* keeps the identity and classification it already has, so it is carried
 * here unchanged and raised again in the caller's frame rather than described.
 */
type Settled = { readonly value: Result<GeneratedXmdRootResult> } | { readonly raised: unknown };

interface Resolvers<T> {
  readonly operation: Operation<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

/** What the owner and the handle share. */
interface State {
  /** False once this execution has stopped admitting evaluations. */
  open: boolean;
  /** True while one evaluation is in flight, and through its cleanup. */
  busy: boolean;
}

/** The namespace every explicit root evaluation's own sequence sits in. */
const SEQUENCE = "generated_root";

/** The coroutine one evaluation owns, counting from one. */
function sequenceName(order: number): string {
  return `${SEQUENCE}:${order}`;
}

/**
 * Which evaluation a retained coroutine belongs to, or nothing at all.
 *
 * The suffix is matched as well as the prefix, so an evaluation's own children
 * belong to it rather than to the document. A coroutine id that refuses to be
 * read belongs to neither: it is left in the document's view, where the
 * execution's existing root-history admission already has one fixed diagnostic
 * for a record it cannot read.
 */
function sequenceOrder(event: DurableEvent): number | undefined {
  let id: unknown;
  try {
    id = event.coroutineId;
  } catch {
    return undefined;
  }
  if (typeof id !== "string") {
    return undefined;
  }
  const match = /^generated_root:([1-9][0-9]*)(?:\..*)?$/.exec(id);
  return match === null ? undefined : Number(match[1]);
}

/**
 * One evaluation's own events, and nothing else's.
 *
 * Retained before the partition is applied, for the reason the document's
 * history is: every phase of a replay reads one event once, and asking the
 * backend's own object which coroutine it belongs to would be a read the index
 * is about to make again.
 */
function evaluationJournal(journal: DurableStream, order: number): DurableStream {
  const view: DurableStream = {
    *readAll(): Operation<DurableEvent[]> {
      const events = retainEvents(yield* journal.readAll());
      return events.filter((event) => sequenceOrder(event) === order);
    },
    append: (event: DurableEvent) => journal.append(event),
  };
  return preserveJournalProvenance(journal, view);
}

/**
 * Whether this retained event belongs to an explicit root evaluation.
 *
 * The document's continuation drops these from the history it reads, so a
 * retained response is not history the document has to align with: its events
 * belong to a coroutine the document never had, and a `Close` it left behind
 * would otherwise be read as this run having recorded a completion.
 *
 * Asked of a **retained** event, on the snapshot the execution's admission gate
 * has already detached, because every phase of a replay must read one event
 * once: asking the backend's own object here would be a second read of a
 * coroutine the index is about to read again, and a source that answered
 * differently between the two would decide one thing for the partition and
 * another for the replay.
 */
export function isGeneratedRootEvent(event: DurableEvent): boolean {
  return sequenceOrder(event) !== undefined;
}

/** The address past every evaluation this history already holds. */
function nextOrder(events: readonly DurableEvent[]): number {
  let highest = 0;
  for (const event of events) {
    highest = Math.max(highest, sequenceOrder(event) ?? 0);
  }
  return highest + 1;
}

const CLOSED =
  "this document execution has finished, so it evaluates no generated root — a handle kept " +
  "past the execution that produced it names no live execution, and evaluating a root is not " +
  "something a completed document is reopened for";

const BUSY =
  "this execution is already evaluating a generated root, and one execution evaluates one at a " +
  "time — a second is refused rather than queued behind it";

const INTERRUPTED =
  "this execution closed while it was evaluating a generated root, so the evaluation did not " +
  "finish. Its work has joined and whatever it had already recorded stays retained";

/**
 * Create the owner of one execution's explicit root evaluations.
 *
 * Nothing is read, installed or allocated here. The owner exists before the
 * document workflow does, because canonical execution publishes its handle
 * first; what it can actually do begins at {@link GeneratedRootOwner.activate}.
 */
export function createGeneratedRootOwner(): GeneratedRootOwner {
  const jobs = createQueue<RootJob, never>();
  const state: State = { open: true, busy: false };
  // The first authoritative failure, and only the first: later ones are
  // consequences of it, and a completion names one outcome.
  let fatal: Error | undefined;
  const closed = withResolvers<void>();
  const ready = withResolvers<Result<void>>();
  let announced = false;
  const announce = (outcome: Result<void>): void => {
    if (!announced) {
      announced = true;
      ready.resolve(outcome);
    }
  };
  let inputs: GeneratedRootInputs | undefined;

  /**
   * Stop admitting evaluations and release everyone waiting on readiness.
   *
   * Idempotent, because two scopes register it for two different reasons: the
   * invocation's, which ends however the execution ends, and the activated
   * runner's, which ends only once its work has joined. Whichever closes first
   * is the one that decides, and the other finds it already closed.
   */
  function close(): void {
    state.open = false;
    closed.resolve();
    announce(Err(new HostExecutionError(CLOSED)));
  }

  function admit(): Result<void> {
    if (!state.open) {
      return Err(new HostExecutionError(CLOSED));
    }
    if (state.busy) {
      return Err(new HostExecutionError(BUSY));
    }
    state.busy = true;
    return Ok(undefined);
  }

  function evaluate(request: GeneratedXmdRootRequest): Operation<Result<GeneratedXmdRootResult>> {
    return scoped(function* () {
      // Before readiness, so two calls that arrive while the runner is still
      // starting are one admitted call and one refusal rather than two waiters.
      // Waiting for the runner is not queuing behind admitted work.
      const admitted = admit();
      if (!admitted.ok) {
        return admitted;
      }
      const answer = withResolvers<Settled>();
      const cancelled = withResolvers<void>();
      const joined = withResolvers<void>();
      let answered = false;
      let sent = false;
      // Registered before the request is sent, so a caller halted between the
      // two leaves no evaluation running that nothing is waiting for.
      yield* ensure(function* () {
        try {
          if (!sent) {
            return;
          }
          if (!answered) {
            cancelled.resolve();
          }
          // Asking is not stopping. This call does not finish until the work it
          // started has finished unwinding — every cleanup an admitted element
          // registered included — so a caller whose halt has returned knows
          // that work is over. The execution closing ends the wait too, because
          // then there is nothing left to do the joining.
          yield* race([joined.operation, closed.operation]);
        } finally {
          state.busy = false;
        }
      });
      const started = yield* ready.operation;
      if (!started.ok) {
        return started;
      }
      jobs.add({ request, answer, cancelled, joined });
      sent = true;
      // Raced against the execution closing, because a halted worker answers
      // nobody: the work it was doing has joined by the time this resolves, and
      // a caller left waiting on an answer that can no longer arrive would wait
      // for as long as it held the handle.
      const settled = yield* race([
        answer.operation,
        (function* (): Operation<Settled> {
          yield* closed.operation;
          return { value: Err(new HostExecutionError(INTERRUPTED)) };
        })(),
      ]);
      answered = true;
      if ("raised" in settled) {
        throw settled.raised;
      }
      return settled.value;
    });
  }

  return {
    evaluate,
    completion: () => fatal,
    supply(supplied: GeneratedRootInputs): void {
      inputs = supplied;
    },
    *attend(): Operation<void> {
      yield* ensure(close);
    },
    *activate(): Operation<void> {
      // Registered before the worker exists, so closing stops admission and
      // releases every waiter however this execution ends — including a failure
      // partway through its own assembly. Registered here as well as on the
      // invocation because cleanups registered later unwind first: this one
      // runs after the worker has been halted and joined, which is the
      // guarantee an active runner's closure carries and the invocation's
      // cannot.
      yield* ensure(close);
      const supplied = inputs;
      if (supplied === undefined) {
        // Core's own mistake rather than a caller's: the document workflow
        // reached activation before the execution handed its evaluator over.
        announce(Err(new HostExecutionError(CLOSED)));
        return;
      }
      // Allocated on the first call rather than here, and read from the
      // journal this execution writes: every address this run allocates is past
      // every evaluation the history already holds, so a completed response is
      // never asked for again and an interrupted one is never continued.
      //
      // The read is the first call's rather than activation's because an
      // execution that never evaluates a root must read its journal exactly as
      // many times as it always did — the retained history is read once, by the
      // durable run that replays it.
      //
      // Claimed and advanced together, so the address a call consumed is not
      // handed to the next one whether that call finished, failed or was
      // cancelled. A read that fails leaves nothing claimed, and the next call
      // reads the history again rather than guessing where it stopped.
      let order: number | undefined;
      const address = function* (): Operation<number> {
        const claimed = order ?? nextOrder(retainEvents(yield* supplied.journal.readAll()));
        order = claimed + 1;
        return claimed;
      };
      yield* spawn(function* () {
        while (true) {
          const next = yield* jobs.next();
          if (next.done) {
            return;
          }
          // Remembered rather than raised, and the loop goes on serving. What
          // the failure decides is this execution's completion; what it must
          // not decide is whether the caller it belongs to was still reachable
          // when it happened.
          fatal ??= yield* perform(supplied, next.value, address);
        }
      });
      announce(Ok(undefined));
    },
  };
}

/**
 * Run one evaluation, and let the caller cancel it.
 *
 * The work runs in a task of its own so that cancelling the call cancels the
 * work: its appends stop where they stopped, the terminal it would have written
 * is not written, and the next call is new work on a new address rather than
 * that one resumed.
 */
function perform(
  inputs: GeneratedRootInputs,
  job: RootJob,
  address: RootAddress,
): Operation<Error | undefined> {
  return scoped(function* () {
    // Registered *before* the work is spawned, which is what makes it the last
    // thing to unwind: cleanups registered later run first, so the evaluation —
    // and every cleanup its elements registered — has finished by the time this
    // reports the work joined.
    yield* ensure(() => {
      job.joined.resolve();
    });
    const work = yield* spawn(() => attempt(inputs, job, address));
    const outcome = yield* race([
      (function* (): Operation<Performed> {
        return { kind: "finished", raised: yield* work };
      })(),
      (function* (): Operation<Performed> {
        yield* job.cancelled.operation;
        return { kind: "cancelled" };
      })(),
    ]);
    if (outcome.kind === "finished") {
      return outcome.raised;
    }
    // Giving up on the answer is not stopping the work on its own: the task is
    // its own, and halting it is what leaves its sequence unfinished. Observed,
    // because a halt nobody waited for is work still unwinding while the next
    // call starts.
    yield* work.halt();
    return undefined;
  });
}

/**
 * The next sequence this evaluation runs on, claimed when the work begins.
 *
 * An operation rather than a number, because claiming it reads the journal this
 * execution writes, and that read can fail the way any other read of it can.
 * Performed inside the admitted job so that a failure to find the address is
 * answered and retained exactly like a failure to use it.
 */
type RootAddress = () => Operation<number>;

/** How performing one evaluation ended, and what it left for the completion. */
type Performed =
  | { readonly kind: "finished"; readonly raised: Error | undefined }
  | { readonly kind: "cancelled" };

/**
 * One evaluation, on its own durable sequence.
 *
 * An authoritative failure is handed to the caller and returned to the worker,
 * so the host holds the same object with the same classification and the
 * execution's completion is failed with it. A caller that catches it cannot
 * leave the run looking successful.
 */
function* attempt(
  inputs: GeneratedRootInputs,
  job: RootJob,
  address: RootAddress,
): Operation<Error | undefined> {
  try {
    // Inside the try, because finding the next address reads this execution's
    // journal: a read that fails is this caller's failure to be handed and this
    // execution's outcome, not an availability answer about a run that is still
    // open.
    job.answer.resolve({ value: yield* sequence(inputs, job.request, yield* address()) });
    return undefined;
  } catch (error) {
    // The caller is handed the same object with the same classification, and
    // the execution's completion is failed with it. Neither describes the
    // other: a host holding this is holding the failure itself, and the run it
    // came out of cannot report success.
    job.answer.resolve({ raised: error });
    return error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * The evaluation's own durable run, over its own view of the journal.
 *
 * Scoped, because `durableRun` installs its context on the scope it is called
 * in: a context set on the worker's own scope would outlive this evaluation and
 * the next one would append into it. The terminal records that the sequence
 * finished and carries no rendering — what the root produced is the caller's
 * answer, and a response's text is not a fact the document's history keeps.
 */
function sequence(
  inputs: GeneratedRootInputs,
  request: GeneratedXmdRootRequest,
  order: number,
): Operation<Result<GeneratedXmdRootResult>> {
  return scoped(function* () {
    const settled: { outcome?: Result<GeneratedXmdRootResult> } = {};
    const coroutineId = sequenceName(order);
    yield* durableRun(
      function* (): Operation<void> {
        settled.outcome = yield* inputs.evaluator(request);
      },
      { stream: evaluationJournal(inputs.journal, order), coroutineId },
    );
    const outcome = settled.outcome;
    if (outcome === undefined) {
      throw new HostExecutionError(
        `the generated root on sequence "${coroutineId}" recorded no outcome`,
      );
    }
    return outcome;
  });
}
