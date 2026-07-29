import { createContext, useScope } from "effection";
import type { Context, Operation } from "effection";
import { createDurableOperation, DurableCtx } from "@executablemd/durable-streams";
import type { EffectDescription, Json, Workflow } from "@executablemd/durable-streams";

/**
 * The loop a `<Break>` exits (spec §6.5 `<Loop>`).
 *
 * `<Loop>` publishes a frame for the body it expands, and `<Break>` marks it.
 * Expansion checks the mark after every segment, so the rest of the iteration
 * is never reached and the loop stops before its next one.
 *
 * A nested `<Loop>` publishes its own frame, so a `<Break>` beneath it marks
 * the inner loop and leaves the outer one running.
 *
 * A component invocation publishes `undefined` for its own body, so a
 * `<Break>` a component writes is stray however it was invoked. Content the
 * caller projected through it keeps the caller's frame: it was written where
 * the loop is, and it means the loop the author could see.
 */
export interface LoopFrame {
  broken: boolean;
}

export const ActiveLoop: Context<LoopFrame | undefined> = createContext<LoopFrame | undefined>(
  "expand.loop",
  undefined,
);

/**
 * How a loop finished. Cancellation is deliberately absent: a cancelled loop
 * writes no outcome record at all, because a record appended during teardown
 * would sit after the iteration entries a resumed run still has to replay and
 * would make that run diverge. Absence is the record — an execution whose loop
 * has iteration entries and no outcome entry was interrupted, and the
 * execution's own Close says whether that was cancellation or a crash.
 */
export type LoopOutcome = "exhausted" | "break" | "error";

export interface LoopRecord extends Record<string, Json> {
  /** Iterations that began, so a break and an exhaustion of the same length differ only in `outcome`. */
  iterations: number;
  outcome: LoopOutcome;
}

/** One iteration's zero-based identity, as it appears in the journal. */
export interface IterationRecord extends Record<string, Json> {
  iteration: number;
}

/**
 * A loop's identity within one execution. `id` comes from the block counter,
 * so it is deterministic and distinct for every `<Loop>` an execution enters —
 * including each entry into a loop nested in another one. `name` is the
 * author's optional label, carried for readers and never compared during
 * divergence detection.
 */
export interface LoopIdentity {
  id: number;
  name?: string;
}

function describe(identity: LoopIdentity, suffix?: string): EffectDescription {
  const name = suffix === undefined ? `loop:${identity.id}` : `loop:${identity.id}:${suffix}`;
  return {
    type: suffix === undefined ? "loop" : "loop_iteration",
    name,
    ...(identity.name === undefined ? {} : { loop: identity.name }),
  };
}

// A Workflow is an Operation whose only instructions are durable effects, so
// this is how an expansion operation appends one entry to the journal.
function* append(description: EffectDescription, value: Json): Workflow<void> {
  yield createDurableOperation(description, function* () {
    return value;
  });
}

/**
 * Record that an iteration began, under its zero-based identity.
 *
 * Written before the body, so every iteration is on the record whatever the
 * body contains — an empty body still produces an entry, and an exhausted loop
 * is distinguishable from one that broke immediately.
 *
 * Expansion driven without a journal — no durable context on the scope —
 * records nothing and behaves identically otherwise.
 */
export function* recordIteration(identity: LoopIdentity, iteration: number): Operation<void> {
  if (!(yield* journaling())) {
    return;
  }
  const record: IterationRecord = { iteration };
  yield* append(describe(identity, `iteration:${iteration}`), record);
}

/** Record how the loop finished. */
export function* recordOutcome(identity: LoopIdentity, record: LoopRecord): Operation<void> {
  if (!(yield* journaling())) {
    return;
  }
  yield* append(describe(identity), record);
}

function* journaling(): Operation<boolean> {
  const scope = yield* useScope();
  return scope.get(DurableCtx) !== undefined;
}
