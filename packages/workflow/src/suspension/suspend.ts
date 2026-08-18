/**
 * Waiting durably for something this run cannot produce itself.
 *
 * ```ts
 * const approval = yield* suspendFor({
 *   request: { kind: "approval", release: "1.4" },
 *   responseSchema: { type: "object", properties: { approved: { type: "boolean" } } },
 * });
 * ```
 *
 * The document says what it is waiting for and what shape an answer takes. What
 * happens next is not an error and not a value: the run stops. Its executor lock
 * is released, its status becomes `suspended`, and a later execution reaches
 * this same wait rather than starting the procedure again.
 *
 * ## Three steps, and each means only what it says
 *
 * **Refusal first.** A request that cannot be retained, or a schema that is not
 * an object, is refused before anything is published — a durable event nothing
 * can act on would be worse than no wait at all.
 *
 * **Publication next.** One ordinary durable Yield retains the suspension ID,
 * the request and the response schema. It crosses the same secret gate as every
 * other event and receives the same Workspace-root association. A successful
 * Yield means the request was retained. It does not mean the wait ended, and it
 * does not authorize anything.
 *
 * **Authority last, and it is this operation running.** The execution-owned
 * controller accepts the wait only from this operation, at the position it just
 * published from. Neither half is sufficient alone: a retained request proves
 * publication rather than arrival, and a position can be reached by any durable
 * operation of the same shape. Nothing is handed to the caller to present,
 * because anything a caller could hold is something another caller could
 * obtain.
 *
 * ## Why replay reaches the same wait
 *
 * The suspension ID is derived from the run and the durable coroutine position
 * — not from a name, a counter the caller keeps, or anything the caller could
 * supply. A resumed execution replaying the same procedure arrives at the same
 * position, derives the same ID, restores the published request instead of
 * appending a second one, and reports the same wait. Two different waits in one
 * procedure sit at different positions and cannot receive each other's answer.
 */

import { type Operation } from "effection";
import { canonicalFingerprint, type Json } from "@executablemd/core";
import { createDurableOperation, durablePosition } from "@executablemd/durable-streams";
import type { DurablePosition, EffectDescription, Workflow } from "@executablemd/durable-streams";
import { getWorkflowRun } from "../run.ts";
import { armSuspensionEntry, enterSuspension } from "./entry.ts";
import { parseSuspensionRequest, type WorkflowSuspensionRequest } from "./api.ts";

/** The effect type one durable wait's request is retained under. */
export const SUSPENSION_REQUEST = "suspension_request";

/**
 * The opaque name one wait has, in this run, at this position.
 *
 * A digest rather than the three values joined, because the parts are a run
 * identifier a caller chose and a coroutine identifier with its own separators;
 * joined, two different triples could spell one string. It is opaque on
 * purpose: #300 will correlate an answer to it, and a correlation key that
 * revealed the position it came from would invite guessing a neighbouring wait.
 */
export function suspensionId(runId: string, position: DurablePosition): string {
  return canonicalFingerprint({
    runId,
    coroutineId: position.coroutineId,
    index: position.index,
  }).slice(0, 32);
}

function describeSuspension(id: string, request: WorkflowSuspensionRequest): EffectDescription {
  return {
    type: SUSPENSION_REQUEST,
    name: id,
    suspensionId: id,
    request: request.request,
    responseSchema: request.responseSchema,
  };
}

/**
 * Retain the request, or restore the one a previous execution retained.
 *
 * A `Workflow` of its own so the durable yield lives where a durable yield
 * belongs; `suspendFor()` is an ordinary operation around it.
 */
function* publishRequest(id: string, parsed: WorkflowSuspensionRequest): Workflow<void> {
  // The retained value is the suspension ID, and the yield's own result is
  // discarded: what this step establishes is that the request is in the
  // journal, not what it evaluated to.
  yield createDurableOperation<string>(describeSuspension(id, parsed), function* () {
    return id;
  });
}

/**
 * Wait durably for a value this run cannot produce.
 *
 * Returns the value that ended the wait. With no delivered answer it does not
 * return: the execution settles `suspended` around it.
 */
export function* suspendFor(request: WorkflowSuspensionRequest): Operation<Json> {
  const parsed = parseSuspensionRequest(request);

  const run = yield* getWorkflowRun();
  const position = yield* durablePosition();
  const id = suspensionId(run.runId, position);

  // Published before the wait is entered, and in that order for a reason: the
  // controller reads the request back from the position this operation is about
  // to stand at, so a wait entered before its request exists has nothing behind
  // it to check.
  yield* publishRequest(id, parsed);

  // Armed immediately before entering, and taken by the controller: the wait is
  // entered by the operation that is running, not by whatever reached this
  // position.
  armSuspensionEntry(id);
  return yield* enterSuspension(run.runId, id, parsed);
}
