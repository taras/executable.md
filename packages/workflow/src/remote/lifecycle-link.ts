/**
 * The lifecycle half of one run's connection.
 *
 * Beginning, settling, cancelling and forking are the moments a run's own state
 * changes, and they travel on the same connection as everything else that
 * carries authority. This is that half of the link, stated where nothing knows
 * which host answers: a provider composes these with the Workspace half it
 * already has, and the adapter underneath decides how a command is spelled.
 *
 * Every answer here is already this build's own vocabulary. A refusal spelling,
 * a command name, a socket or a row never reaches a caller through one of
 * these; what reaches a caller is a `Result` of values the shared record
 * parsers produced.
 */

import type { Operation, Result } from "effection";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import type {
  DocumentExecutionCompletion,
  DocumentExecutionRecord,
  WorkflowRunRecord,
} from "../storage/record.ts";
import type { CreateWorkflowRunRequest } from "../storage/api.ts";
import type { RemoteFrontierSnapshot } from "./read.ts";
import type { RemoteWorkspaceLink } from "./database.ts";

/** What one begin committed, as the runner is allowed to know it. */
export interface RemoteBegun {
  readonly frontier: RemoteFrontierSnapshot;
  readonly execution: DocumentExecutionRecord;
  readonly replay: boolean;
  /** What stale recovery closed on the way in, when it closed anything. */
  readonly recovered: DocumentExecutionRecord | null;
}

/**
 * A lifecycle answer that may decline for a reason about the run.
 *
 * `refused` carries which condition applied — a cancelled run, a failed one, a
 * terminal one — because a caller acts on the difference. What the run holds
 * never travels with it.
 */
export type RemoteLifecycleAnswer<T> =
  | { readonly kind: "performed"; readonly value: T }
  | { readonly kind: "refused"; readonly refusal: RemoteLifecycleRefusal };

/**
 * A condition of the run itself, as an owner names one.
 *
 * Each is a fact a caller acts on rather than a failure to translate, and each
 * carries nothing the run holds.
 */
export type RemoteLifecycleRefusal =
  | "cancelled"
  | "resume-failed"
  | "terminal"
  | "damaged-terminal";

/** Which committed checkpoint of which run a fork continues. */
export interface RemoteForkOrigin {
  readonly sourceRunId: string;
  readonly checkpointEventId: string;
  readonly checkpointWorkspaceRootId: string;
  readonly runRecordWorkspaceRootId: string;
  readonly rootImportWorkspaceRootId: string;
  readonly anchor: string;
}

/** How many parts of each section a committed fork should find staged. */
export interface RemoteForkCounts {
  readonly inherited: number;
  readonly roots: number;
  readonly manifests: number;
  readonly blobs: number;
  readonly checkouts: number;
}

/** One part of a fork's source, offered before any of it is a run. */
export interface RemoteForkPart {
  readonly section: "inherited" | "roots" | "manifests" | "blobs" | "checkouts";
  readonly position: number;
  readonly part: Record<string, unknown>;
}

/** One begin, as the provider addresses it and may address it again. */
export interface RemoteBeginCommand {
  /** The identity this logical invocation keeps, retry after retry. */
  readonly commandId: string;
  readonly runId: string;
  readonly action: "start" | "resume";
  readonly creation: CreateWorkflowRunRequest | null;
  /** Where the definition can be fetched from, when this begin creates. */
  readonly retrieval: Json | undefined;
  readonly executionId: string;
}

/** Which fork a continuation claims, as the destination retains it. */
export interface RemoteContinuationOrigin {
  readonly sourceRunId: string;
  readonly checkpointEventId: string;
}

/** Everything one committed fork is decided from. */
/** Taking up a destination that already holds this fork, without its source. */
export interface RemoteForkContinuation {
  readonly commandId: string;
  readonly runId: string;
  readonly creation: CreateWorkflowRunRequest;
  readonly origin: RemoteContinuationOrigin;
  readonly runRecord: DurableEvent;
  readonly rootImport: DurableEvent;
  readonly executionId: string;
}

export interface RemoteForkCommit {
  /** The identity this logical invocation keeps, retry after retry. */
  readonly commandId: string;
  readonly runId: string;
  readonly creation: CreateWorkflowRunRequest;
  readonly retrieval: Json | undefined;
  readonly origin: RemoteForkOrigin;
  readonly counts: RemoteForkCounts;
  readonly runRecord: DurableEvent;
  readonly rootImport: DurableEvent;
  readonly executionId: string;
}

/**
 * One admitted executor connection, as the host arranges it.
 *
 * The two halves are the same authority and arrive together: a link that reads
 * and commits, and the lifecycle commands that move the run. A host that
 * returned them from different owners would be handing out an acquisition of
 * one run that mutates another, so they are one value.
 */
export interface RemoteExecutorConnection {
  readonly link: RemoteWorkspaceLink;
  readonly lifecycle: RemoteLifecycleLink;
  /**
   * End this connection now, before the scope that owns it ends.
   *
   * An acquisition retired while a command's outcome is unknown must stop
   * being the owner's live executor: a lock the runner has given up on while
   * its socket still holds the run would leave the run unreachable by anybody,
   * including whoever wants to ask the same question again.
   */
  close(): Operation<void>;
}

/**
 * The lifecycle commands one admitted connection may perform.
 *
 * Each is one owner transaction, and each is retried by identity rather than
 * repeated: the same command id and the same content is the same request, and
 * an owner that already decided it answers with what it decided.
 */
export interface RemoteLifecycleLink {
  /** Begin one document execution under this acquisition. */
  begin(request: RemoteBeginCommand): Operation<Result<RemoteLifecycleAnswer<RemoteBegun>>>;
  /** Finish the execution this acquisition began. */
  settle(
    commandId: string,
    completion: DocumentExecutionCompletion,
    expectedWorkspaceRootId: string,
  ): Operation<Result<RemoteFrontierSnapshot>>;
  /** Make this run terminal, following what it retains. */
  cancel(
    commandId: string,
    runId: string,
  ): Operation<Result<RemoteLifecycleAnswer<WorkflowRunRecord>>>;
  /** Offer one part of a fork's source to this acquisition's scratch. */
  stageForkPart(commandId: string, part: RemoteForkPart): Operation<Result<void>>;
  /** Commit the offered parts as one destination run and its first execution. */
  /**
   * Commit the offered parts as one destination run and its first execution.
   *
   * `needs-transfer` is the one failure a caller answers by copying the source
   * again: the destination holds nothing and the parts this command names were
   * never offered on this connection.
   */
  commitFork(
    commit: RemoteForkCommit,
  ): Operation<Result<RemoteLifecycleAnswer<RemoteBegun> | "needs-transfer">>;
  /**
   * Continue a destination that already holds this fork.
   *
   * `absent` rather than a failure when the destination holds no run: that is
   * the answer that sends a caller to the source it has not needed yet.
   */
  continueFork(
    continuation: RemoteForkContinuation,
  ): Operation<Result<RemoteLifecycleAnswer<RemoteBegun> | "absent">>;
}
