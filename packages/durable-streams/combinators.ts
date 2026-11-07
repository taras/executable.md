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

import {
  all as effectionAll,
  ensure,
  race as effectionRace,
  spawn,
  suspend,
  useScope,
} from "effection";
import type { Operation, Task } from "effection";
import { DurableContext } from "./context.ts";
import {
  activeDurabilityFailure,
  appendDurableEvent,
  rememberDurabilityFailure,
} from "./durability.ts";
import { ephemeral } from "./ephemeral.ts";
import { EarlyReturnDivergenceError, StaleInputError, TerminalDivergenceError } from "./errors.ts";
import { deserializeError, serializeError } from "./serialize.ts";
import type { Close, Json, Workflow, WorkflowValue } from "./types.ts";

/**
 * Run a child workflow within a spawned scope, setting up its own
 * DurableContext and emitting a Close event when it terminates.
 *
 * The caller must spawn it so the child owns its scope. A recorded Close
 * restores the result without running the child again.
 */
function* runDurableChild<T extends WorkflowValue>(
  childWorkflow: () => Workflow<T>,
  childId: string,
  parentCtx: DurableContext,
  cancellation: DurableCancellation = () => "terminal",
): Operation<T> {
  const { replayIndex, stream } = parentCtx;
  replayIndex.claim(childId);

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
    } else {
      // cancelled — this child was cancelled in a previous run (e.g.,
      // a race loser). Instead of throwing, we suspend forever. The
      // parent combinator (race/all) will cancel this child as part of
      // normal structured concurrency teardown, just like the original
      // run. The Close(cancelled) event already exists in the journal,
      // so we skip re-emitting it (the ensure teardown checks for this).
      //
      // INVARIANT: This branch is only reachable when a parent combinator
      // (durableRace or durableAll with a failed sibling) will cancel this
      // child. Close(cancelled) in the journal means the child was
      // previously cancelled by structured concurrency, so on replay the
      // same combinator will cancel it again. This cannot deadlock.
      yield* suspend();
      // unreachable — suspend blocks until cancelled
      return undefined as T;
    }
  }

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
      if (cancellation() === "resumable") {
        return;
      }
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
        result: { status: "cancelled" },
      };
    }

    // Don't re-emit a Close event if one already exists in the journal
    // (e.g., a cancelled child being replayed via suspend()).
    if (!replayIndex.hasClose(childId)) {
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
 * Spawn a durable child workflow.
 *
 * Assigns a deterministic coroutine ID (parentId.N), sets up DurableContext
 * on the child scope, and ensures Close events are emitted.
 *
 * Returns a Task<T> that can be yield*-ed to get the child's result.
 *
 * Returns Workflow<Task<T>> via ephemeral() — the infrastructure effects
 * (useScope, spawn) are durable-safe scope setup that doesn't need
 * journaling and re-runs correctly on replay.
 */
export function durableSpawn<T extends WorkflowValue>(
  childWorkflow: () => Workflow<T>,
): Workflow<Task<T>> {
  return ephemeral(
    (function* (): Operation<Task<T>> {
      const scope = yield* useScope();
      const ctx = scope.expect<DurableContext>(DurableContext);

      const childIndex = ctx.childCounter++;
      const childId = `${ctx.coroutineId}.${childIndex}`;

      return yield* spawn(() => runDurableChild(childWorkflow, childId, ctx));
    })(),
  );
}

/** Read whether cancellation ends the logical child or only its physical lifetime. */
export type DurableCancellation = () => "terminal" | "resumable";

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
  workflows: ((cancellation: DurableCancellation) => Workflow<T>)[],
  options?: { readonly cancellation?: DurableCancellation },
): Workflow<T[]> {
  return ephemeral(
    (function* (): Operation<T[]> {
      const scope = yield* useScope();
      const ctx = scope.expect<DurableContext>(DurableContext);

      const enclosing = options?.cancellation ?? (() => "terminal");
      let abandoned = false;
      const cancellation: DurableCancellation = () => (abandoned ? "terminal" : enclosing());
      const children = workflows.map((workflow) => ({
        workflow,
        id: `${ctx.coroutineId}.${ctx.childCounter++}`,
      }));
      const closes = children.map(({ id }) => ctx.replayIndex.getClose(id));
      if (
        closes.some((close) => close?.result.status === "cancelled") &&
        !closes.some((close) => close?.result.status === "err")
      ) {
        const failure = new StaleInputError(
          "All has retained cancelled children without a failed sibling to settle the join.",
        );
        rememberDurabilityFailure(ctx, failure);
        throw failure;
      }
      const childOps: Operation<T>[] = children.map(({ workflow, id }) => ({
        *[Symbol.iterator]() {
          try {
            return yield* runDurableChild(() => workflow(cancellation), id, ctx, cancellation);
          } catch (error) {
            abandoned = true;
            throw error;
          }
        },
      }));

      // Native all() isolates child failures so the caller can catch them.
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

      const childOps: Operation<T>[] = workflows.map((workflow) => {
        const childIndex = ctx.childCounter++;
        const childId = `${ctx.coroutineId}.${childIndex}`;

        return {
          *[Symbol.iterator]() {
            return yield* runDurableChild(workflow, childId, ctx);
          },
        };
      });

      return yield* effectionRace(childOps);
    })(),
  );
}
