/**
 * What a trusted host needs to move a run's lifecycle, and nothing a document
 * could use.
 *
 * These shapes are provider-neutral, but they are deliberately not part of the
 * `WorkflowLifecycleApi`. That Api routes requests to a host and grants no
 * ownership, and everything it answers with is parsed immutable data —
 * beginning an execution answers with an open database, which is a transport.
 * A capability that hands one out belongs to the workflow executor that
 * already holds the executor lock, not to a contextual surface anything in the
 * process can reach.
 */

import type { Operation, Result } from "effection";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import type { ExecutorLock } from "./api.ts";
import type { WorkflowRunDatabase } from "../storage/api.ts";
import type { GitWorkflowDefinitionV1 } from "../storage/definition.ts";
import type { JsonObject } from "../storage/members.ts";
import type {
  SourceBundleSnapshotEntryV2,
  SourceBundleWorkflowDefinitionV2,
} from "../storage/source-bundle.ts";
import type { RetainedDefinitionSources } from "./source.ts";
import type {
  DocumentExecutionCompletion,
  DocumentExecutionRecord,
  WorkflowRunRecord,
} from "../storage/record.ts";

/** What a `start` creates a Git run from, and what compatible reuse compares. */
export interface GitWorkflowRunCreationV1 {
  readonly definition: GitWorkflowDefinitionV1;
  readonly base: string;
  readonly props: JsonObject;
  readonly retrieval?: Json;
}

/**
 * What a `start` creates a source-bundle run from.
 *
 * The descriptor and the bytes arrive together, because they are one fact: a
 * version-2 run's authoritative content is what its store holds, so a creation
 * that carried only the descriptor would be asking storage to retain an
 * identity for content nobody supplied.
 *
 * `sourceSnapshot` names exactly the descriptor's paths, in exactly its order.
 * The transition copies every byte sequence before it validates anything, so
 * mutating a caller-owned array afterwards cannot change the run.
 */
export interface SourceBundleWorkflowRunCreationV2 {
  readonly definition: SourceBundleWorkflowDefinitionV2;
  readonly sourceSnapshot: readonly SourceBundleSnapshotEntryV2[];
  readonly props: JsonObject;
  readonly retrieval?: Json;
}

/** What a `start` creates a run from, by the definition version it creates. */
export type WorkflowRunCreation = GitWorkflowRunCreationV1 | SourceBundleWorkflowRunCreationV2;

/** Whether this creation is the Git one, narrowing to it when it is. */
export function isGitWorkflowRunCreation(
  creation: WorkflowRunCreation,
): creation is GitWorkflowRunCreationV1 {
  return creation.definition.kind === "git";
}

/** Which committed checkpoint of which run a fork continues. */
export interface WorkflowForkSelection {
  readonly sourceRunId: string;
  readonly checkpointEventId: string;
}

/**
 * One caller's request to admit a fork and begin its first execution.
 *
 * The creation is the fork's own: its definition, its base and the props it was
 * normalized to. What it inherits is decided by the selection, and the source
 * takes no part in this run's identity beyond being named as its lineage.
 */
export interface WorkflowForkRequest {
  readonly runId: string;
  readonly selection: WorkflowForkSelection;
  readonly creation: WorkflowRunCreation;
  /**
   * The root import this fork's own definition produced.
   *
   * The record holds the document's own text, and replay restores the document
   * from it — so a fork that inherited the source's would run the source's
   * definition. The caller supplies the record its candidate produced, already
   * past the secret gate, and the fork retains that one instead.
   */
  readonly rootImport: DurableEvent;
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
  /**
   * The source this run executes, authenticated against its own definition.
   *
   * Answered by the transition rather than fetched afterwards, so the check
   * happens under the executor lock and before stale recovery, a new execution
   * record, Workspace attachment or any other lifecycle write. A caller imports
   * this closure; rereading the candidate path after admission would be a
   * second source of truth about what the run is a run of.
   *
   * Always present. A source-bundle run's content comes out of its own store;
   * a Git run's comes through the host's legacy reader, which is consulted
   * against the descriptor about to be persisted — before persistence — when
   * the run is being created, and against the retained descriptor when it
   * already exists. A host that installed no reader cannot begin a Git run at
   * all, which is the honest answer: it has no way to obtain what that run
   * executes.
   */
  readonly sources: RetainedDefinitionSources;
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
  /**
   * Admit one fork and begin its first execution, in one durable commit.
   *
   * The inherited prefix, the selected Workspace root, the lineage and the
   * fork's own run all appear together or not at all. A caller that reaches
   * this has already proved the checkpoint compatible; what is left is to make
   * the fork exist.
   */
  fork(lock: ExecutorLock, request: WorkflowForkRequest): Operation<Result<WorkflowExecutionBegun>>;
  /**
   * Build the same fork where nothing recognizes it as a run, for the scope
   * that asks.
   *
   * A compatibility replay needs the fork's own Workspace — a document resolves
   * its paths through the run's filesystem, and a replay without one produces
   * effects of a different kind and diverges for a reason that is not about the
   * candidate. This is that Workspace, assembled in full, taking no executor
   * lock and creating nothing a host would discover. It goes when the calling
   * scope ends.
   */
  stageFork(request: WorkflowForkRequest): Operation<Result<WorkflowRunDatabase>>;
  settle(
    lock: ExecutorLock,
    completion: DocumentExecutionCompletion,
  ): Operation<Result<WorkflowRunRecord>>;
}
