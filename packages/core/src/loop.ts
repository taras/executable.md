import { createContext, useScope } from "effection";
import type { Context, Operation } from "effection";
import { createDurableOperation, DurableCtx, StaleInputError } from "@executablemd/durable-streams";
import type {
  DurableContext,
  EffectDescription,
  Json,
  Workflow,
} from "@executablemd/durable-streams";

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
 * How a loop finished. The three values are the only ways a loop reaches an
 * end, so a `loop` record is terminal: writing one means the loop finished.
 *
 * A loop that is interrupted — the document was cancelled, or the process died
 * — writes no terminal record. That is not a gap to fill. A record appended
 * while the loop is being torn down would sit after the iteration records a
 * resumed run still has to replay, and would make that run diverge, so
 * interrupting a loop deliberately leaves the journal without one. The durable
 * journal does not say why a loop was interrupted, and does not need to:
 * cancellation and a crash mean the same thing to a reader — the execution did
 * not finish — and take the same recovery path.
 */
export type LoopOutcome = "exhausted" | "break" | "error";

/** A loop's terminal record. */
export interface LoopRecord extends Record<string, Json> {
  /**
   * Iterations **entered**, not iterations that ran to completion. A loop that
   * breaks on its final iteration and one that exhausts the same bound record
   * the same count and differ only in `outcome`.
   */
  iterations: number;
  outcome: LoopOutcome;
}

/**
 * That an iteration was **entered**, under its zero-based identity. It says
 * nothing about whether the body completed: the record is written before the
 * body runs, so an iteration the document was interrupted in has one too.
 */
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

/**
 * Append one entry to the journal and return what the entry holds.
 *
 * A Workflow is an Operation whose only instructions are durable effects, so
 * this is how an expansion operation reaches the journal. The return value
 * matters: live it is the value passed in, and on replay it is the value the
 * journal already held, which is the only way a caller can tell the two apart.
 */
function* append(description: EffectDescription, value: Json): Workflow<unknown> {
  return yield createDurableOperation(description, function* () {
    return value;
  });
}

function isLoopOutcome(value: unknown): value is LoopOutcome {
  return value === "exhausted" || value === "break" || value === "error";
}

/** The terminal record a journal entry holds, or undefined if it holds anything else. */
function readLoopRecord(value: unknown): LoopRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const fields: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  const { iterations, outcome } = fields;
  if (typeof iterations !== "number" || !isLoopOutcome(outcome)) {
    return undefined;
  }
  return { iterations, outcome };
}

function staleTerminalRecord(
  description: EffectDescription,
  coroutineId: string,
  derived: LoopRecord,
  stored: unknown,
): StaleInputError {
  const held = readLoopRecord(stored);
  const describeHeld =
    held === undefined
      ? JSON.stringify(stored)
      : `${held.outcome} after ${held.iterations} iterations`;
  return new StaleInputError(
    `The journal records "${description.name}" finishing as ${describeHeld}, but this run ` +
      `finished it as ${derived.outcome} after ${derived.iterations} iterations. A recorded ` +
      "loop outcome cannot be replayed onto a run that reached a different one. Re-run the " +
      "document from the start rather than resuming from this journal.",
    { coroutineId, description },
  );
}

/**
 * Record that an iteration was entered, under its zero-based identity.
 *
 * Written before the body, so the record never depends on what the body
 * contains: an iteration with an empty body produces one, and so does an
 * iteration the document was interrupted in.
 *
 * Expansion driven without a journal — no durable context on the scope —
 * records nothing and behaves identically otherwise.
 */
export function* recordIteration(identity: LoopIdentity, iteration: number): Operation<void> {
  if (!(yield* durableContext())) {
    return;
  }
  const record: IterationRecord = { iteration };
  yield* append(describe(identity, `iteration:${iteration}`), record);
}

/**
 * Record that the loop finished, and how.
 *
 * A terminal entry is identified by the loop, not by the outcome, so replay
 * matches it whatever this run derived — and `createDurableOperation` hands back
 * the stored value without running its executor. The entry is therefore
 * **validated**: a stored outcome or iteration count that disagrees with what
 * this run reached means the journal no longer describes this run, and it fails
 * as a `StaleInputError` rather than quietly standing in for the truth. Live,
 * the value compared is the one just written, so the check is free.
 */
export function* recordOutcome(identity: LoopIdentity, record: LoopRecord): Operation<void> {
  const durable = yield* durableContext();
  if (!durable) {
    return;
  }
  const description = describe(identity);
  const stored = yield* append(description, record);
  const held = readLoopRecord(stored);
  if (
    held === undefined ||
    held.outcome !== record.outcome ||
    held.iterations !== record.iterations
  ) {
    throw staleTerminalRecord(description, durable.coroutineId, record, stored);
  }
}

function* durableContext(): Operation<DurableContext | undefined> {
  const scope = yield* useScope();
  return scope.get(DurableCtx);
}
