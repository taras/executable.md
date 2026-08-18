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
 * **Authority last, and it is the request at this position.** The controller is
 * reached through a stable contextual name, which is how a component's own
 * loaded copy of this package finds the controller the running binary installed.
 * That route is composition rather than authority: middleware may refuse it, but
 * no value it returns is an answer and none of them makes this operation
 * continue. What authorizes the wait is the retained request at the exact
 * position this operation just published from.
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

import type { Operation } from "effection";
import { canonicalFingerprint, type Json } from "@executablemd/core";
import { createDurableOperation, durablePosition } from "@executablemd/durable-streams";
import type { DurablePosition, EffectDescription, Workflow } from "@executablemd/durable-streams";
import { getWorkflowRun } from "../run.ts";
import { parseJsonValue } from "../storage/members.ts";
import { suspensionAnswerEffect } from "./answer.ts";
import {
  parseSuspensionRequest,
  WorkflowSuspension,
  WorkflowSuspensionRequestError,
  type WorkflowSuspensionRequest,
} from "./api.ts";

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

  return yield* publishAnswer(id, parsed);
}

/**
 * The answer, restored or claimed.
 *
 * A durable operation of its own, directly behind the request, so an execution
 * that already received its answer replays it instead of asking again. Its live
 * path reaches the public route only when nothing is retained to answer with,
 * and returns only what was published — which is why returning at all means the
 * wait is over.
 */
function* publishAnswer(id: string, parsed: WorkflowSuspensionRequest): Workflow<Json> {
  // The protocol hands back what the journal held, which is `unknown` until it
  // has been walked. A retained answer reaches the document, so it is parsed
  // here rather than asserted — the same boundary every restored value passes.
  const restored: unknown = yield suspensionAnswerEffect(id, parsed, () =>
    WorkflowSuspension.operations.enter(id, parsed),
  );
  return parseJsonValue(restored, "$", answerFailure);
}

function answerFailure(reason: string, path: string): Error {
  return new WorkflowSuspensionRequestError(
    `the answer that ended this wait is not a value this run can carry: ${reason} at ${path}`,
  );
}
