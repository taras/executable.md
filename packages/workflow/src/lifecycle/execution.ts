/**
 * What a trusted host needs to move a run's lifecycle, and nothing a document
 * could use.
 *
 * These shapes are provider-neutral, but they are deliberately not part of the
 * `WorkflowLifecycleApi`. That Api routes requests to a host and grants no
 * authority, and everything it answers with is parsed immutable data —
 * beginning an execution answers with an open database, which is a transport.
 * A capability that hands one out belongs to the host that already holds the
 * lease, not to a contextual surface anything in the process can reach.
 */

import type { Operation, Result } from "effection";
import type { Json } from "@executablemd/durable-streams";
import type { ExecutorLease } from "./api.ts";
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

/**
 * A cancellation the provider found waiting, as it stood before the transition.
 *
 * Never part of a caller's request. It is evidence the provider gathered about
 * an executor that is gone, and a caller that could supply it could ask for a
 * cancellation nobody wrote. It carries both identities because acting on it
 * later — acknowledging it, clearing it — must prove it is still *this*
 * request: one that arrived after the snapshot belongs to a decision nobody has
 * made yet, and clearing it would drop a caller's request on the floor.
 */
export interface PendingCancellation {
  readonly requestId: string;
  readonly generation: string;
}

/** One caller's request to begin a document execution under its lease. */
export interface WorkflowBeginRequest {
  readonly runId: string;
  readonly action: "start" | "resume";
  /** Required for `start`, which may be creating the run it begins. */
  readonly creation?: WorkflowRunCreation;
}

/** A run this caller now owns, and the execution it just began. */
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
 * The transitions a trusted host performs under a lease it holds.
 *
 * Supplied by the host as a closure rather than installed anywhere: the lease
 * travels separately from the data it authorizes, and the provider validates it
 * synchronously inside the transaction that writes.
 */
export interface WorkflowExecutionAuthority {
  begin(
    lease: ExecutorLease,
    request: WorkflowBeginRequest,
  ): Operation<Result<WorkflowExecutionBegun>>;
  settle(
    lease: ExecutorLease,
    completion: DocumentExecutionCompletion,
  ): Operation<Result<WorkflowRunRecord>>;
}
