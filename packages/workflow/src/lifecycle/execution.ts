/**
 * What a trusted host needs to move a run's lifecycle, and nothing a document
 * could use.
 *
 * These shapes are provider-neutral, but they are deliberately not part of the
 * `WorkflowLifecycleApi`. That Api routes requests to a host and grants no
 * authority, and everything it answers with is parsed immutable data —
 * beginning an execution answers with an open database, which is a transport.
 * A capability that hands one out belongs to the workflow executor that
 * already holds the executor lock, not to a contextual surface anything in the
 * process can reach.
 */

import type { Operation, Result } from "effection";
import type { Json } from "@executablemd/durable-streams";
import type { ExecutorLock } from "./api.ts";
import type { WorkflowRunDatabase } from "../storage/api.ts";
import type { WorkflowDefinition } from "../storage/definition.ts";
import type { JsonObject } from "../storage/members.ts";
import type {
  DocumentExecutionCompletion,
  DocumentExecutionRecord,
  WorkflowRunRecord,
} from "../storage/record.ts";

/** What a `start` creates a run from, and what compatible reuse is compared against. */
export interface WorkflowRunCreation {
  readonly definition: WorkflowDefinition;
  readonly base: string;
  readonly props: JsonObject;
  readonly retrieval?: Json;
}

/** One caller's request to begin a document execution under its executor lock. */
export interface WorkflowBeginRequest {
  readonly runId: string;
  readonly action: "start" | "resume";
  /** Required for `start`, which may be creating the run it begins. */
  readonly creation?: WorkflowRunCreation;
}

/** A run this workflow executor is advancing, and the execution it just began. */
export interface WorkflowExecutionBegun {
  readonly database: WorkflowRunDatabase;
  readonly record: WorkflowRunRecord;
  readonly execution: DocumentExecutionRecord;
  /**
   * Whether the run kept a terminal state instead of publishing `running`.
   *
   * A completed or failed root replays: the execution is recorded, and the
   * outcome that already won is not made mutable again.
   */
  readonly replay: boolean;
  /** What stale recovery closed on the way in, when it closed anything. */
  readonly recovered?: DocumentExecutionRecord;
}

/**
 * The transitions a trusted host performs under an executor lock it holds.
 *
 * Supplied by the host as a closure rather than installed anywhere: the exact
 * executor lock travels separately from the data it authorizes, and the
 * provider validates it synchronously inside the transaction that writes.
 */
export interface WorkflowExecutionTransitions {
  begin(
    lock: ExecutorLock,
    request: WorkflowBeginRequest,
  ): Operation<Result<WorkflowExecutionBegun>>;
  settle(
    lock: ExecutorLock,
    completion: DocumentExecutionCompletion,
  ): Operation<Result<WorkflowRunRecord>>;
}
