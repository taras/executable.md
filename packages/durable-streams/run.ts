/**
 * durableRun — entry point for durable workflow execution.
 *
 * An Operation<T> that reads the event stream, builds the ReplayIndex,
 * sets DurableContext on the current scope, runs the workflow, and emits
 * a Close event when the workflow terminates.
 *
 * Because durableRun is an Operation, it inherits the caller's Effection
 * scope — including any middleware installed via Api.around(). This is
 * how divergence policy overrides work: the caller installs middleware
 * before yield*-ing into durableRun. See DEC-032.
 *
 * See integration doc §10, protocol spec §4.
 */

import { ensure, scoped, useScope } from "effection";
import type { Operation, Scope } from "effection";
import { DurableContext } from "./context.ts";
import {
  activeDurabilityFailure,
  appendDurableEvent,
  rememberDurabilityFailure,
} from "./durability.ts";
import { EarlyReturnDivergenceError, TerminalDivergenceError } from "./errors.ts";
import { ReplayGuard } from "./replay-guard.ts";
import { consumable, observeEvent } from "./retained.ts";
import { ReplayIndex } from "./replay-index.ts";
import { deserializeError, serializeError } from "./serialize.ts";
import type { DurableStream } from "./stream.ts";
import type { Close, DurableEvent, Json, Workflow, WorkflowValue } from "./types.ts";

function unalignedReplay(replayIndex: ReplayIndex, coroutineId: string) {
  return replayIndex.firstUnaligned(coroutineId);
}

/**
 * Run the ReplayGuard check phase over all Yield events.
 *
 * This is Phase 1 of replay guard validation — it runs before the workflow
 * starts, in generator context where I/O is allowed. Middleware uses this
 * phase to gather observations (hash files, check timestamps) and cache
 * results for the decide phase.
 *
 * The events come from the index rather than from the stream, so a guard reads
 * the same retained result the replay path will use. Handing over the stream's
 * own events instead would make validation and consumption two separate reads,
 * and a source that answered differently between them could have a guard
 * approve one result while execution used another.
 *
 * See replay-guard-spec.md §5.5.
 */
function* runCheckPhase(replayIndex: ReplayIndex, scope: Scope): Operation<void> {
  for (const event of replayIndex.retainedYields()) {
    // An isolated observation, not the retained event. Guards compose by
    // reading and passing along; what composition must not become is the power
    // to edit a history the execution already validated.
    const observed = observeEvent(event);
    if (observed.type === "yield") {
      yield* ReplayGuard.invoke(scope, "check", [observed]);
    }
  }
}

/**
 * Options for durableRun.
 */
export interface DurableRunOptions {
  /** The durable stream to read from and append to. */
  stream: DurableStream;
  /** Coroutine ID for the root workflow. Defaults to "root". */
  coroutineId?: string;
  /**
   * Hand this run's own root control to its caller, before anything runs.
   *
   * Absent — which is every ordinary caller — this run's cancellation
   * behaviour is exactly what it has always been: a halted root unwinds
   * without a terminal, because a generator's return cannot be observed by
   * the `catch` below. The control is how one trusted caller asks for the
   * other ending, and it is minted over *this* call's own context, replay
   * index and terminal state rather than looked up by name.
   */
  control?: (control: DurableRootControl) => void;
}

/**
 * One run's own authority to end its root as cancelled.
 *
 * It carries no stream, no append and no event: what a holder may do is ask,
 * and read back what actually settled. Whether the ask is accepted is this
 * run's decision and nobody else's — a root whose terminal append has already
 * begun keeps the terminal it was writing.
 */
/**
 * This root ending because a Stop owned it, rather than because of a fault.
 *
 * Never seen outside this module's own frames: the catch lets it past without
 * writing a terminal around it, and the cancellation finalizer records what
 * actually happened. It exists so an interrupted root stops *being* a
 * successful completion without a fault being invented to carry it out.
 *
 * The bypass is keyed to the exact object one run minted, never to this class:
 * which root was stopped is not something the type of an error can answer, and
 * a root that throws another root's interruption is an ordinary failure.
 */
class RootInterrupted extends Error {
  override name = "RootInterrupted";

  constructor(coroutineId: string) {
    super(`Workflow ${coroutineId} was stopped`);
  }
}

/** Where this root stands, and what it will still answer for. */
type RootPhase = "open" | "claimed" | "appending" | "settled" | "ended";

export interface DurableRootControl {
  /**
   * Ask this root to end as cancelled, and say whether it will.
   *
   * Synchronous and decided here, because the question is whether this root is
   * still open: a decision made anywhere else would be made about a terminal
   * phase that may have moved while the answer travelled. Repeated asks are
   * the same ask.
   */
  requestInterruption(): boolean;
  /**
   * Which terminal this root actually retained, once one is acknowledged.
   *
   * `undefined` until an append has been acknowledged, so a caller cannot
   * mistake an attempt for a record.
   */
  settled(): "ok" | "err" | "cancelled" | undefined;
}

/**
 * Execute a durable workflow.
 *
 * 1. Reads all events from the stream and builds a ReplayIndex.
 * 2. Sets DurableContext on the current scope (inherited from caller).
 * 3. Runs the workflow — replayed effects resolve synchronously from
 *    the index; live effects execute and persist before resuming.
 * 4. On completion, appends a Close event to the stream.
 * 5. Before any Close, rejects durability failures and retained coroutine
 *    history the current definition did not align with.
 *
 * Returns the workflow's result value.
 *
 * Usage:
 *   // From async code (standalone):
 *   await run(() => durableRun(workflow, { stream }));
 *
 *   // From inside an Effection generator (inherits scope):
 *   const result = yield* durableRun(workflow, { stream });
 */
export function* durableRun<T extends WorkflowValue>(
  workflow: () => Workflow<T> | Operation<T>,
  options: DurableRunOptions,
): Operation<T> {
  const { stream, coroutineId = "root", control } = options;
  // This root's own terminal phase, read and written only here.
  //
  // `open` is the only phase a cancellation may claim, and claiming is
  // exclusive: once a Stop holds the open root, the ordinary paths may no
  // longer acknowledge an ok or err terminal as though no claim existed, and
  // once an append has begun the record being written is the one this root
  // ends with. `ended` is where a root stops answering at all — a request
  // after its owner has gone is refused rather than accepted into nothing.
  let phase: RootPhase = "open";
  let retained: "ok" | "err" | "cancelled" | undefined;
  // This run's own leaving, minted only if this run is actually stopped.
  //
  // The bypass below is keyed to this exact object rather than to the class:
  // an interruption is a fact about *one* invocation, and a root that merely
  // happens to throw somebody else's — a stopped root's error carried into a
  // later workflow, say — was not itself stopped. Classifying by type would
  // let that root leave with no terminal at all, having asked for nothing.
  let interruption: RootInterrupted | undefined;
  // Read through a call rather than directly: the control below moves this
  // while the workflow is suspended, which narrowing by assignment cannot see.
  const phaseNow = (): RootPhase => phase;

  const events = yield* stream.readAll();
  const replayIndex = new ReplayIndex(events);

  // Inherit the caller's scope — middleware (e.g., Divergence, ReplayGuard)
  // is already installed by the caller before yield*-ing into durableRun.
  const scope = yield* useScope();

  const ctx = {
    replayIndex,
    stream,
    coroutineId,
    childCounter: 0,
    durability: {},
  };
  scope.set(DurableContext, ctx);

  // Run before the workflow starts. Middleware can yield* for I/O (hash
  // files, make network requests) to gather observations for the decide
  // phase. The check loop iterates all Yield events in journal order.
  // See replay-guard-spec.md §5.5.
  yield* runCheckPhase(replayIndex, scope);

  // The retained history has been offered in full and nothing has been reused
  // yet. A guard that requires something of the history as a whole — that an
  // event it validates is present, and present once — refuses here, before the
  // recorded terminal result below can answer for history nobody validated.
  yield* ReplayGuard.invoke(scope, "admit", [
    {
      coroutineId,
      yields: replayIndex.retainedYields().flatMap((event) => {
        const observed = observeEvent(event);
        return observed.type === "yield" ? [observed] : [];
      }),
      terminal: replayIndex.hasClose(coroutineId),
    },
  ]);

  // If the root coroutine already has a Close event in the journal,
  // the workflow completed in a previous run. Return the stored result
  // directly without re-running the workflow.
  if (replayIndex.hasClose(coroutineId)) {
    const closeEvent = replayIndex.getClose(coroutineId)!;
    if (closeEvent.result.status === "ok") {
      // A fresh consumer copy, exactly as a replayed Yield's result is. The
      // retained settlement is frozen so policy cannot rewrite it; what a
      // caller receives from a completed run is ordinary data it may hold and
      // change, and changing it cannot reach the next replay.
      const settled = consumable(closeEvent.result);
      return (settled.status === "ok" ? settled.value : undefined) as T;
    } else if (closeEvent.result.status === "err") {
      throw deserializeError(closeEvent.result.error);
    } else {
      throw new Error("Workflow was cancelled");
    }
  }
  replayIndex.claim(coroutineId);

  // Retirement, registered first so it unwinds last: whatever ends this root —
  // its own terminal, an ordinary halt, a failure — it stops answering
  // requests afterwards. What it retained stays readable; what it will no
  // longer do is accept a new claim on an owner that has gone.
  yield* ensure(() => {
    if (phaseNow() !== "settled") {
      phase = "ended";
    }
  });

  // The other ending, and only where it was asked for. Registered after the
  // retirement above so it runs before it, and before the workflow so it
  // unwinds after everything the workflow owns. Inert unless this root
  // accepted a claim while it was still open: an ordinary halt reaches here
  // unclaimed and appends nothing, which is what every caller without a
  // control has always seen.
  /**
   * End this root as stopped: the refusals its ordinary terminals make, then
   * the one close the protocol already has.
   *
   * Called from the finalizer when the root is unwound, and directly from the
   * return path when the workflow finished after the request was accepted —
   * that frame leaves by throwing, and an append started while an error is
   * already unwinding does not reliably finish.
   */
  function* settleStopped(): Operation<void> {
    // A sticky durability failure is already this root's outcome, and
    // retained history the definition did not align with is divergence rather
    // than a stopped run: neither is papered over with a cancelled close, and
    // neither is swallowed — whoever asked this root to stop has to learn
    // which failure ended it.
    const durabilityFailure = activeDurabilityFailure(ctx);
    if (durabilityFailure !== undefined) {
      phase = "ended";
      throw durabilityFailure;
    }
    const unconsumed = unalignedReplay(replayIndex, coroutineId);
    if (unconsumed !== undefined) {
      phase = "ended";
      const failure = new TerminalDivergenceError(
        unconsumed.coroutineId,
        unconsumed.cursor,
        unconsumed.totalYields,
        {
          message: `Divergence: workflow ${coroutineId} was stopped before retained history was exhausted`,
          unconsumed: unconsumed.entry,
        },
      );
      // Remembered in the shared state before it is thrown, as a cancelled
      // child's divergence is: this is the failure this run ended on, so every
      // later append through the same context has to be refused by it rather
      // than writing into a history that has already diverged.
      rememberDurabilityFailure(ctx, failure);
      throw failure;
    }
    phase = "appending";
    const closeEvent: Close = {
      type: "close",
      coroutineId,
      result: { status: "cancelled" },
    };
    yield* scoped(() => appendDurableEvent(ctx, closeEvent));
    phase = "settled";
    retained = "cancelled";
  }

  yield* ensure(function* () {
    if (phaseNow() !== "claimed") {
      return;
    }
    yield* settleStopped();
  });

  if (control !== undefined) {
    control({
      requestInterruption(): boolean {
        if (phaseNow() === "claimed") {
          // The same ask, answered the same way.
          return true;
        }
        if (phaseNow() !== "open") {
          return false;
        }
        phase = "claimed";
        return true;
      },
      settled: () => retained,
    });
  }

  try {
    const result: T = yield* workflow();

    const durabilityFailure = activeDurabilityFailure(ctx);
    if (durabilityFailure) {
      throw durabilityFailure;
    }

    const unconsumed = unalignedReplay(replayIndex, coroutineId);
    if (unconsumed) {
      throw new EarlyReturnDivergenceError(
        unconsumed.coroutineId,
        unconsumed.cursor,
        unconsumed.totalYields,
        unconsumed.entry,
      );
    }

    const closeEvent: Close = {
      type: "close",
      coroutineId,
      result: { status: "ok", value: result as Json },
    };

    // The append's ordered turn is a resource of the scope it runs in, and
    // this frame survives a rejected close: the catch below appends the
    // compensating Close(err) from the same scope, so a turn still held here
    // would make that append wait forever. A boundary around the attempt
    // returns the turn as part of the outcome.
    //
    // A Stop accepted while this root was open owns its ending, and the
    // workflow returning afterwards does not undo that. This root was
    // interrupted, so it does not complete successfully for anybody: no ok
    // close is acknowledged, no value is published, and the cancellation
    // finalizer is what settles it. Leaving as `RootInterrupted` is how the
    // caller learns that, and the catch below lets it past untouched so no
    // compensating error close is written around it.
    if (phaseNow() === "claimed") {
      yield* settleStopped();
      interruption = new RootInterrupted(coroutineId);
      throw interruption;
    }
    // The phase moves first, so a cancellation asked for from here on joins
    // this ending rather than cancelling the write and compensating over a
    // backend that may already hold it.
    phase = "appending";
    yield* scoped(() => appendDurableEvent(ctx, closeEvent));
    phase = "settled";
    retained = "ok";

    return result;
  } catch (error) {
    // A root a Stop already owns leaves as itself. The finalizer is what
    // settles it, and a terminal written around that would be this run
    // recording two endings. By identity, and only this run's own: an
    // interruption some other root minted is an ordinary failure here, and it
    // gets the ordinary error close every other failure gets.
    if (interruption !== undefined && Object.is(error, interruption)) {
      throw error;
    }
    const primary = error instanceof Error ? error : new Error(String(error));
    const durabilityFailure = activeDurabilityFailure(ctx, primary);
    if (durabilityFailure) {
      throw durabilityFailure;
    }
    const unconsumed = unalignedReplay(replayIndex, coroutineId);
    if (unconsumed) {
      throw new TerminalDivergenceError(
        unconsumed.coroutineId,
        unconsumed.cursor,
        unconsumed.totalYields,
        { cause: primary, unconsumed: unconsumed.entry },
      );
    }

    const closeEvent: Close = {
      type: "close",
      coroutineId,
      result: {
        status: "err",
        error: serializeError(primary),
      },
    };

    // The same claim rule as the ordinary return: a Stop that holds this open
    // root is its ending, and this failure does not acknowledge one around it.
    if (phaseNow() === "claimed") {
      throw primary;
    }
    try {
      phase = "appending";
      yield* scoped(() => appendDurableEvent(ctx, closeEvent));
      phase = "settled";
      retained = "err";
    } catch (closeError) {
      const closeDurabilityFailure = activeDurabilityFailure(ctx, closeError);
      if (closeDurabilityFailure) {
        throw closeDurabilityFailure;
      }
      const closeFailure = closeError instanceof Error ? closeError : new Error(String(closeError));
      throw new AggregateError(
        [primary, closeFailure],
        "Workflow failed and Close append also failed",
      );
    }

    throw primary;
  }
}
