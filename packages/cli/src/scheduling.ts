/**
 * Explicit scheduled resume: deciding *when* to resume, and nothing else.
 *
 * A trusted host that has independently observed a successful typed answer
 * delivery may decide the run should continue now rather than waiting for a
 * person to type `xmd workflow resume`. That decision is the whole of what
 * scheduling is. It is not a second way to execute a run, and there is
 * deliberately nothing here that could become one.
 *
 * ## What a schedule may name
 *
 * One public run id. {@link ScheduleRequest} has exactly one member so that
 * "run-id-only" is a fact about the type rather than a rule someone has to
 * remember: an answer, a suspension id, a definition, props, a document path, a
 * database, an executor token, an Agent identity, a transcript and every
 * provider-private value are all things this request has no place to carry.
 *
 * ## Where the authority lives
 *
 * Not here. {@link scheduleResume} invokes an {@link OrdinaryResume} the
 * trusted host built and handed it, and answers with that resume's ordinary
 * outcome unchanged. Acquiring the executor lock, reconstructing the retained
 * definition, attaching the Workspace, replaying the journal, claiming the
 * pending answer, ranking settlement and releasing the lock all stay inside the
 * one resume path `runWorkflow()` already owns — the same path the foreground
 * command runs. A scheduled resume that could do any of those differently would
 * be a second executor, which is the thing this slice exists not to build.
 *
 * ## What is deliberately absent
 *
 * No ledger, queue, retry loop, heartbeat, generation counter, watcher, polling
 * source or new run status. No detached task: the scheduled operation runs
 * inside the scope that invoked it and does not survive it, so a host that goes
 * away takes its scheduled work with it rather than leaving something running
 * that nobody owns. Delivery remains non-executing and is not wired to this —
 * `xmd workflow answer` retains a value and returns, and a host that wants
 * continuation asks for it explicitly.
 *
 * Duplicate and late schedules need no special handling and get none. Two calls
 * for one pending answer compete for the same non-blocking executor lock, so
 * one runs and the other receives the ordinary already-running outcome; a call
 * arriving after the winner settled performs ordinary completed replay. The
 * answer is claimed once because only the resumed `suspendFor()` may claim it,
 * inside the transaction that both publishes the answer event and consumes the
 * delivery.
 */

import type { Operation, Result } from "effection";
import { runWorkflow } from "./workflow.ts";
import type {
  WorkflowExecution,
  WorkflowHost,
  WorkflowOutcome,
  WorkflowRequest,
} from "./workflow.ts";

/**
 * The options an invocation was started with, which a run id does not carry.
 *
 * Journal verbosity, raw output and the secret policy are facts about the
 * command that is running, not about the run being continued, so the trusted
 * host states them once when it builds its resume rather than letting a
 * scheduled call choose them.
 */
export interface ScheduledResumeOptions {
  readonly verbose: boolean;
  readonly raw: boolean;
  readonly secretDetection: boolean;
}

/**
 * One trusted host's ordinary resume, as an operation over a run id alone.
 *
 * Built once, closed over the host and the document executor, and then handed
 * to whatever decides when to call it.
 */
export type OrdinaryResume = (runId: string) => Operation<WorkflowOutcome>;

/** The complete request a schedule may make. One run id, and nothing else. */
export interface ScheduleRequest {
  readonly runId: string;
}

/**
 * Build the ordinary resume this host will run, for any run it owns.
 *
 * The request it constructs is an ordinary `resume`: the only member that
 * varies per call is `target`, and `id` is absent because a resume addresses a
 * run that already exists rather than naming a new one.
 */
export function ordinaryResume(
  options: ScheduledResumeOptions,
  host: WorkflowHost,
  execute: (execution: WorkflowExecution) => Operation<Result<void>>,
): OrdinaryResume {
  return function resume(runId: string): Operation<WorkflowOutcome> {
    const request: WorkflowRequest = {
      action: "resume",
      target: runId,
      id: undefined,
      verbose: options.verbose,
      raw: options.raw,
      secretDetection: options.secretDetection,
    };
    return runWorkflow(request, undefined, host, execute);
  };
}

/**
 * Schedule an ordinary resume, now.
 *
 * The pass-through is the implementation, not a placeholder for one. Every
 * behaviour a scheduler could be expected to add — persisting the request,
 * retrying it, coalescing duplicates, waiting for a lock — is a form of
 * authority this operation is specified not to have, and adding any of them
 * would move a decision out of the resume path that owns it.
 */
export function scheduleResume(
  resume: OrdinaryResume,
  request: ScheduleRequest,
): Operation<WorkflowOutcome> {
  return resume(request.runId);
}
