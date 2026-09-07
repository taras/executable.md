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
  | { readonly kind: "refused"; readonly refusal: "cancelled" | "resume-failed" | "terminal" };

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

/** Everything one committed fork is decided from. */
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
  commitFork(commit: RemoteForkCommit): Operation<Result<RemoteLifecycleAnswer<RemoteBegun>>>;
}
