/**
 * The Workflow Run Storage Api — where a run's durable record lives.
 *
 * Shared code asks for a run by its public id and receives a handle. What is
 * behind the handle — a local SQLite file, something a remote host owns — is
 * the provider's business, and no part of this contract names one. That is what
 * lets `xmd workflow` keep a host-neutral lifecycle while the initial host
 * stores everything in one file per run.
 *
 * The default handler throws. There is no in-memory fallback here on purpose: a
 * run that appears to start and retains nothing has not started, and a host
 * that forgot to install a provider should learn that immediately rather than
 * after an interruption.
 *
 * ## Installing a provider
 *
 * ```ts
 * yield* useWorkflowRunStorage({ root: "~/.xmd/runs" });
 * ```
 *
 * Providers install at `{ at: "min" }`. Middleware installed at the default
 * position runs outermost, so an outer scope's provider would answer ahead of
 * one installed in a nested scope — the opposite of what a provider is for.
 *
 * ## Lifetime
 *
 * A handle is owned by the scope that asked for it. When that scope ends the
 * connection closes, and every later call on the handle fails rather than
 * reopening anything behind the caller's back.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation, Result } from "effection";
import type { DurableEvent, DurableStream, Json } from "@executablemd/durable-streams";
import type { WorkflowDefinition } from "./definition.ts";
import { WorkflowStorageError } from "./errors.ts";
import type {
  DefinitionRetrieval,
  DocumentExecutionCompletion,
  DocumentExecutionRecord,
  StoredRunState,
  WorkflowRunRecord,
} from "./record.ts";

/** What a caller must decide before a run can exist. */
export interface CreateWorkflowRunRequest {
  /** The public run id. Retained inside the run, and the only way back to it. */
  readonly runId: string;
  /** The immutable definition this run is a run of. */
  readonly definition: WorkflowDefinition;
  /** The Git revision chosen as the run's starting repository state. */
  readonly base: string;
  /** Root props, already normalized by whoever validated them. */
  readonly props: Json;
}

/**
 * A caller's hold on an open transaction.
 *
 * Enlistment travels with this object rather than with the database, so work
 * that never received one cannot join the transaction by accident — which is
 * what keeps an unrelated journal append from being rolled back with somebody
 * else's failure.
 */
export interface WorkflowRunTransaction {
  /** Appends inside this transaction, and commits with it or not at all. */
  readonly journal: DurableStream;
}

/**
 * One retained event together with the id it keeps.
 *
 * `DurableStream` carries events and not their identities, and a stop reason
 * points at one. This is the reading that answers "which event", without
 * putting a second journal interface beside the one replay uses.
 */
export interface JournalEntry {
  readonly eventId: string;
  readonly event: DurableEvent;
}

/** One workflow run's durable storage, open for the life of the calling scope. */
export interface WorkflowRunDatabase {
  /** The run as of the last change this handle committed. */
  readonly record: WorkflowRunRecord;

  /** Where the definition can be fetched from now, when a host recorded that. */
  readonly retrieval: DefinitionRetrieval | undefined;

  /** The run's filtered journal. An append here commits on its own. */
  readonly journal: DurableStream;

  /** Every retained event with its opaque id, in append order. */
  readJournalEntries(): Operation<Result<JournalEntry[]>>;

  /**
   * Run `body` inside one transaction, and commit only if it completes.
   *
   * The body receives the handle it must use to take part. Failure and
   * cancellation roll back everything the transaction did, including journal
   * events appended through it. Calling this inside its own body is refused
   * rather than nested.
   */
  transact<T>(body: (transaction: WorkflowRunTransaction) => Operation<T>): Operation<Result<T>>;

  /** Replace the retrieval metadata. Identity is unaffected. */
  replaceRetrievalMetadata(metadata: Json | undefined): Operation<Result<void>>;

  /** Record that a document execution has begun: the initial start, or a resume. */
  beginDocumentExecution(): Operation<Result<DocumentExecutionRecord>>;

  /** Record how a document execution ended. */
  finishDocumentExecution(
    completion: DocumentExecutionCompletion,
  ): Operation<Result<DocumentExecutionRecord>>;

  /** Every document execution, in the order they began. */
  readDocumentExecutions(): Operation<Result<DocumentExecutionRecord[]>>;

  /** Publish the run's status and stop reason. */
  updateRunState(state: StoredRunState): Operation<Result<WorkflowRunRecord>>;
}

export interface WorkflowRunStorageApi {
  /**
   * The run stored under this id, creating it when nothing is stored yet.
   *
   * Reusing an id is how a caller addresses the same run again, so a request
   * that matches what is stored answers with the existing run rather than
   * failing. A request that differs in any immutable field is a different run
   * wearing the same id, and is refused.
   */
  create(request: CreateWorkflowRunRequest): Operation<Result<WorkflowRunDatabase>>;

  /** The run stored under this id. Creates nothing. */
  lookup(runId: string): Operation<Result<WorkflowRunDatabase>>;
}

/** No storage provider is installed in this scope. Raised before anything is stored. */
export class WorkflowStorageProviderError extends WorkflowStorageError {
  override name = "WorkflowStorageProviderError";

  constructor(operation: string) {
    super(
      `no workflow run storage provider is configured, so ${operation}() cannot answer — a ` +
        "host installs one in the scope that owns the run, such as " +
        'yield* useWorkflowRunStorage({ root }) from "@executablemd/workflow/deno".',
    );
  }
}

export const WorkflowRunStorage: Api<WorkflowRunStorageApi> = createApi<WorkflowRunStorageApi>(
  "executablemd.workflow.storage",
  {
    // deno-lint-ignore require-yield
    *create(_request: CreateWorkflowRunRequest): Operation<Result<WorkflowRunDatabase>> {
      throw new WorkflowStorageProviderError("create");
    },

    // deno-lint-ignore require-yield
    *lookup(_runId: string): Operation<Result<WorkflowRunDatabase>> {
      throw new WorkflowStorageProviderError("lookup");
    },
  },
);
