/**
 * Structured concurrency combinators for durable workflows.
 *
 * durableSpawn, durableAll, durableRace — each wraps child workflows
 * with DurableContext (coroutine IDs, Close events) so that structured
 * concurrency is fully journaled and replayable.
 *
 * Each combinator returns Workflow<T> (not Operation<T>) so it can be
 * used directly inside a Workflow via yield*. Internally, the infrastructure
 * effects (useScope, spawn, all, race) are wrapped with ephemeral() —
 * these are durable-safe operations that set up scope/context and don't
 * need journaling. See DEC-034.
 *
 * Child workflows must be Workflow<T> — bare Operations are rejected at
 * compile time. Use ephemeral() to explicitly opt in to non-durable
 * children.
 *
 * See protocol spec §7 (structured concurrency), §10 (race semantics).
 */

import { all as effectionAll, ensure, race as effectionRace, suspend, useScope } from "effection";
import type { Operation, Task } from "effection";
import { DurableContext } from "./context.ts";
import {
  activeDurabilityFailure,
  appendDurableEvent,
  rememberDurabilityFailure,
} from "./durability.ts";
import { ephemeral } from "./ephemeral.ts";
import { EarlyReturnDivergenceError, TerminalDivergenceError } from "./errors.ts";
import { deserializeError, serializeError } from "./serialize.ts";
import type { Cancellation, Close, DurableEffect, Json, Workflow, WorkflowValue } from "./types.ts";

/**
 * Run a child workflow within a spawned scope, setting up its own
 * DurableContext and emitting a Close event when it terminates.
 *
 * This is the core building block for all structured concurrency combinators.
 *
 * It:
 *  1. Checks if the child already completed (has Close event) — short-circuits
 *  2. Sets DurableContext on the child's scope with the child's coroutineId
 *  3. Runs the child workflow (its DurableEffects use the child's coroutineId)
 *  4. Appends Close(ok|err) when the child terminates
 *
 * IMPORTANT: This must be called inside a spawn() so it gets its own scope.
 * The caller is responsible for spawn().
 */
/**
 * What a spawned region does with a retained `Close(cancelled)`.
 *
 * The two answers are not preferences; they follow from who is going to cancel
 * the child on this run.
 *
 * - `"combinator-cancels"` — `durableRace` and `durableAll`. A retained
 *   cancelled child is a race loser or a fail-fast sibling, and the same
 *   combinator will cancel it again, so the child reproduces the original run
 *   by suspending until it does.
 * - `"resume"` — `durableSpawn`. The caller owns the task, and a retained
 *   cancelled child under a parent that never completed means the *run* was
 *   interrupted, not that a combinator chose against this child. Nothing will
 *   cancel it a second time, so suspending would hang the resumed run forever.
 *   It continues its own retained history instead and finishes the work it had
 *   left, writing the Close its second life actually reached.
 *
 * The policy belongs to the combinator, not to its caller: it is fixed at each
 * call site below and there is no way to ask for another one.
 */
type CancelledChildPolicy = "combinator-cancels" | "resume";

/**
 * Whether the caller deliberately stopped the child this run (DEC-040).
 *
 * Written by the task `durableSpawn` hands out — the only place a deliberate
 * halt can be observed — and read once, when the cancelled Close is built. A
 * combinator supplies none: a child it cancels stopped because a scope came
 * down, which is what `"unwound"` means.
 */
interface CancellationEvidence {
  deliberate: boolean;
}

/** How a cancelled child's stop is recorded. */
function cancellationOf(evidence: CancellationEvidence | undefined): Cancellation {
  return evidence?.deliberate === true ? "caller" : "unwound";
}

/**
 * Why a retained cancelled child stopped.
 *
 * Absent is `"caller"`: a record written before this evidence existed says
 * nothing, and reviving work nobody asked to be redone is the worse mistake.
 */
function retainedCancellation(close: Close): Cancellation {
  if (close.result.status !== "cancelled") {
    return "caller";
  }
  return close.result.cancellation === "unwound" ? "unwound" : "caller";
}

function* runDurableChild<T extends WorkflowValue>(
  childWorkflow: () => Workflow<T>,
  childId: string,
  parentCtx: DurableContext,
  cancelledPolicy: CancelledChildPolicy = "combinator-cancels",
  evidence?: CancellationEvidence,
): Operation<T> {
  const { replayIndex, stream } = parentCtx;
  replayIndex.claim(childId);
  // Set when this run continued a retained cancelled child, so its teardown
  // writes the Close it reached rather than leaving the stale cancelled one.
  let resumedFromCancelled = false;

  // Short-circuit: child already completed in a previous run.
  // NOTE: Replay guard validation is not bypassed here — the check phase
  // (runCheckPhase in durableRun) already iterated ALL Yield events
  // (including this child's) before any workflow code runs. Guards have
  // already had a chance to veto stale data. This fast-path only skips
  // re-running the child's generator, not the guard validation.
  if (replayIndex.hasClose(childId)) {
    const closeEvent = replayIndex.getClose(childId)!;
    if (closeEvent.result.status === "ok") {
      return closeEvent.result.value as T;
    } else if (closeEvent.result.status === "err") {
      throw deserializeError(closeEvent.result.error);
    } else if (
      cancelledPolicy === "combinator-cancels" ||
      retainedCancellation(closeEvent) === "caller"
    ) {
      // Either a combinator's child — a race loser, or a sibling `all`
      // cancelled when another failed — or a spawned child its own caller
      // deliberately halted. Both are reproduced the same way: block until the
      // thing that stopped it last time stops it again. A combinator cancels it
      // as it did before; a caller reaches the same `halt()` its deterministic
      // control flow reached before. In the live run neither child threw, it
      // simply stopped. The Close(cancelled) event already exists, so the
      // teardown below skips re-emitting it.
      yield* suspend();
      // unreachable — suspend blocks until cancelled
      return undefined as T;
    } else {
      // A spawned region whose run was interrupted — involuntarily, which is
      // what `"unwound"` records. Nobody is going to cancel this child a second
      // time, so suspending would hang the resumed run.
      // Forget the retained close — its yields stay replayable, so the child
      // continues its own history — and fall through to run the rest.
      resumedFromCancelled = true;
      replayIndex.reopen(childId);
    }
  }

  // Set child's DurableContext on this scope
  const scope = yield* useScope();
  parentCtx.durability ??= {};
  const childCtx: DurableContext = {
    replayIndex,
    stream,
    coroutineId: childId,
    childCounter: 0,
    durability: parentCtx.durability,
  };
  scope.set(DurableContext, childCtx);

  let closeEvent: Close | undefined;
  let suppressClose = false;

  yield* ensure(function* () {
    if (suppressClose || activeDurabilityFailure(childCtx)) {
      return;
    }

    // closeEvent still undefined means the child was cancelled before the
    // normal-return or catch path ran.
    if (!closeEvent) {
      const unaligned = replayIndex.firstUnaligned(childId);
      if (unaligned) {
        const failure = new TerminalDivergenceError(
          unaligned.coroutineId,
          unaligned.cursor,
          unaligned.totalYields,
          {
            message: `Divergence: coroutine ${childId} was cancelled before retained history was exhausted`,
            unconsumed: unaligned.entry,
          },
        );
        rememberDurabilityFailure(childCtx, failure);
        throw failure;
      }
      closeEvent = {
        type: "close",
        coroutineId: childId,
        result: { status: "cancelled", cancellation: cancellationOf(evidence) },
      };
    }

    // Don't re-emit a Close event if one already exists in the journal
    // (e.g., a cancelled child being replayed via suspend()). A child that
    // resumed from a retained cancelled Close is the exception: the record it
    // reached this time is the one that describes the work that actually ran.
    if (resumedFromCancelled || !replayIndex.hasClose(childId)) {
      yield* appendDurableEvent(childCtx, closeEvent);
    }
  });

  try {
    // Run the child workflow. DurableEffects inside the child read
    // DurableContext from the scope, so they'll use childId.
    const result: T = yield* childWorkflow();

    const durabilityFailure = activeDurabilityFailure(childCtx);
    if (durabilityFailure) {
      suppressClose = true;
      throw durabilityFailure;
    }

    const unaligned = replayIndex.firstUnaligned(childId);
    if (unaligned) {
      suppressClose = true;
      const failure = new EarlyReturnDivergenceError(
        unaligned.coroutineId,
        unaligned.cursor,
        unaligned.totalYields,
        unaligned.entry,
      );
      rememberDurabilityFailure(childCtx, failure);
      throw failure;
    }

    closeEvent = {
      type: "close",
      coroutineId: childId,
      result: { status: "ok", value: result as Json },
    };

    return result;
  } catch (error) {
    const primary = error instanceof Error ? error : new Error(String(error));
    const durabilityFailure = activeDurabilityFailure(childCtx, primary);
    if (durabilityFailure) {
      suppressClose = true;
      throw durabilityFailure;
    }

    const unaligned = replayIndex.firstUnaligned(childId);
    if (unaligned) {
      suppressClose = true;
      const failure = new TerminalDivergenceError(
        unaligned.coroutineId,
        unaligned.cursor,
        unaligned.totalYields,
        { cause: primary, unconsumed: unaligned.entry },
      );
      rememberDurabilityFailure(childCtx, failure);
      throw failure;
    }

    closeEvent = {
      type: "close",
      coroutineId: childId,
      result: {
        status: "err",
        error: serializeError(primary),
      },
    };

    throw primary;
  }
}

/**
 * Spawn a durable child workflow, and hand its task back to the caller.
 *
 * Assigns a deterministic coroutine ID (`parentId.N`) in call order, sets up
 * DurableContext on the child scope, and ensures a Close event is emitted.
 *
 * **The task outlives this call.** It is started in the *routine's* own scope
 * rather than inside the effect that returns it, so the caller can await it,
 * cancel it, or leave it running beside other work. Spawning it through
 * `ephemeral()` instead — as this once did — put it in a scope that closed as
 * soon as the effect resolved, so every `yield* task` threw `halted`.
 *
 * A retained `Close(cancelled)` here is read for *why* it was cancelled, not
 * treated as one thing. `"unwound"` — the run was interrupted, and nothing will
 * cancel this child again — resumes the work it had left. `"caller"`, and a
 * legacy record that says nothing, is a stop this caller chose, and is
 * reproduced by suspending until its deterministic control flow chooses it
 * again. See `CancelledChildPolicy` and `Cancellation`.
 */
export function durableSpawn<T extends WorkflowValue>(
  childWorkflow: () => Workflow<T>,
): Workflow<Task<T>> {
  return (function* (): Workflow<Task<T>> {
    // Reading the context and allocating the child id is ordinary scope setup:
    // no journal entry, and it re-runs identically on replay. Allocation is
    // synchronous and in call order, so ids follow the order children are
    // asked for rather than the order they are scheduled.
    const ctx = yield* ephemeral(readDurableContext());
    const childIndex = ctx.childCounter++;
    const childId = `${ctx.coroutineId}.${childIndex}`;
    const evidence: CancellationEvidence = { deliberate: false };
    return (yield createSpawnEffect(
      () => runDurableChild(childWorkflow, childId, ctx, "resume", evidence),
      evidence,
    )) as Task<T>;
  })();
}

function* readDurableContext(): Operation<DurableContext> {
  const scope = yield* useScope();
  return scope.expect<DurableContext>(DurableContext);
}

/**
 * Start `child` in the routine's own scope and resolve with its task.
 *
 * The routine's scope is the workflow's, so the task lives for as long as the
 * workflow does — that is the whole repair. Nothing is journaled: the child
 * writes its own entries under its own coroutine id.
 *
 * A child that fails fails the workflow that spawned it, exactly as an ordinary
 * Effection `spawn` does. What replay must not do is reach the child's body
 * again to discover that.
 */
function createSpawnEffect<T>(
  child: () => Operation<T>,
  evidence: CancellationEvidence,
): DurableEffect<Task<T>> {
  return {
    description: "durable-spawn",
    effectDescription: { type: "ephemeral", name: "durable-spawn" },
    enter(resolve, routine) {
      resolve({ ok: true, value: observingHalt(routine.scope.run(child), evidence) });
      return (exit) => exit({ ok: true, value: undefined as undefined });
    },
  };
}

/**
 * The same task, with a deliberate `halt()` recorded as it happens.
 *
 * The caller receives every member the task defines — `then`, `catch`,
 * `finally`, the async dispose, the iterator — copied from the task itself
 * along with its prototype, so the public surface is the one `Task` has always
 * had. Only `halt` is replaced, and only to note that someone stopped the child
 * on purpose before stopping it.
 *
 * Copied rather than proxied: a task's members are read-only and
 * non-configurable, and a proxy is required to hand back exactly what the
 * target holds — so a `get` trap cannot substitute `halt` at all. Each copied
 * member is the task's own closure and keeps working on the copy.
 */
function observingHalt<T>(task: Task<T>, evidence: CancellationEvidence): Task<T> {
  const members = Object.getOwnPropertyDescriptors(task);
  // Replaced in the descriptor map rather than on the finished object: the
  // task's own members are non-configurable, so redefining one afterwards
  // throws.
  members.halt = {
    value: () => {
      evidence.deliberate = true;
      return task.halt();
    },
    enumerable: true,
    configurable: false,
    writable: false,
  };
  const observed: Task<T> = Object.create(Object.getPrototypeOf(task), members);
  return observed;
}

/**
 * Run multiple durable workflows concurrently and wait for all to complete.
 *
 * Each child gets a deterministic coroutine ID (parentId.0, parentId.1, ...).
 * Each child's effects are journaled under its own coroutineId.
 * Each child emits a Close event on termination.
 *
 * If any child fails, remaining children are cancelled (fail-fast,
 * Effection's default structured concurrency behavior via all()).
 *
 * Returns an array of results in the same order as the input workflows.
 *
 * See spec §7, §11.5.
 */
export function durableAll<T extends WorkflowValue>(
  workflows: (() => Workflow<T>)[],
): Workflow<T[]> {
  return ephemeral(
    (function* (): Operation<T[]> {
      const scope = yield* useScope();
      const ctx = scope.expect<DurableContext>(DurableContext);

      // Build child Operations, one per workflow. Each gets its own
      // deterministic coroutineId and Close event handling.
      const childOps: Operation<T>[] = workflows.map((workflow) => {
        const childIndex = ctx.childCounter++;
        const childId = `${ctx.coroutineId}.${childIndex}`;

        return {
          *[Symbol.iterator]() {
            return yield* runDurableChild(workflow, childId, ctx);
          },
        };
      });

      // Delegate to Effection's native all() which uses trap() internally
      // for proper error isolation. This means:
      // - Child errors are catchable by the caller via try/catch
      // - When any child fails, remaining siblings are cancelled
      // - The error propagates with the original message intact
      return yield* effectionAll(childOps);
    })(),
  );
}

/**
 * Race multiple durable workflows. The first to complete wins;
 * remaining children are cancelled.
 *
 * Each child gets a deterministic coroutine ID. When the winner
 * completes, Effection cancels the remaining children via
 * iterator.return(). The runDurableChild wrapper detects this
 * (closeEvent is undefined in the finally block) and emits
 * Close(cancelled) for each loser.
 *
 * On replay, children with Close(cancelled) in the journal suspend
 * indefinitely (yield* suspend()), letting the parent race cancel
 * them naturally — matching the original live behavior.
 *
 * See spec §10.
 */
export function durableRace<T extends WorkflowValue>(
  workflows: (() => Workflow<T>)[],
): Workflow<T> {
  return ephemeral(
    (function* (): Operation<T> {
      const scope = yield* useScope();
      const ctx = scope.expect<DurableContext>(DurableContext);

      // Build Operations for each child — each gets its own coroutineId
      // and Close event handling via runDurableChild.
      const childOps: Operation<T>[] = workflows.map((workflow) => {
        const childIndex = ctx.childCounter++;
        const childId = `${ctx.coroutineId}.${childIndex}`;

        return {
          *[Symbol.iterator]() {
            return yield* runDurableChild(workflow, childId, ctx);
          },
        };
      });

      // Use Effection's native race() which handles cancellation properly
      return yield* effectionRace(childOps);
    })(),
  );
}
