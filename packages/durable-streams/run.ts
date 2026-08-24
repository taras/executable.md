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

import { scoped, useScope } from "effection";
import type { Operation, Scope } from "effection";
import { DurableContext } from "./context.ts";
import { activeDurabilityFailure, appendDurableEvent } from "./durability.ts";
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
  const { stream, coroutineId = "root" } = options;

  // Read all events and build replay index
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

  // ── REPLAY GUARD: Check phase ──
  // Run before the workflow starts. Middleware can yield* for I/O (hash
  // files, make network requests) to gather observations for the decide
  // phase. The check loop iterates all Yield events in journal order.
  // See replay-guard-spec.md §5.5.
  yield* runCheckPhase(replayIndex, scope);

  // ── REPLAY GUARD: Admit phase ──
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

  try {
    // Workflow<T> is structurally assignable to Operation<T>, so
    // yield* accepts it directly — no cast needed.
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
    yield* scoped(() => appendDurableEvent(ctx, closeEvent));

    return result;
  } catch (error) {
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
        { cause: primary },
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

    try {
      yield* scoped(() => appendDurableEvent(ctx, closeEvent));
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
