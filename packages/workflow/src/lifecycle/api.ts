/**
 * The Workflow Lifecycle Api — who may advance a run, and what may be read
 * about one.
 *
 * Storage serialization decides who uses a connection next. It does not decide
 * who may advance a workflow run. That is this contract: one executor lock per
 * run, and an inspection surface that holds no authority at all.
 *
 * ## Routing selects a host; it grants nothing
 *
 * Reaching a provider through a contextual Api says which host answers. The
 * authority is the opaque object the provider hands back after taking the
 * executor lock. It registered that object for one run and one acquisition and
 * checks it by identity — together with its open scope and run — inside every
 * mutating transaction. A run id, a database handle, a structural look-alike or
 * a retained token authorizes nothing.
 *
 * ## Inspection returns values
 *
 * `inspect`, `list` and `history` answer with parsed immutable data and never
 * with a database, transaction, stream or connection. Reading a run cannot
 * execute it, replay it, attach its Workspace, materialize a root, import a
 * document, reach a provider or append.
 *
 * ```ts
 * const snapshot = yield* WorkflowLifecycle.operations.inspect(runId);
 * ```
 *
 * The default handler throws. A host that forgot to install a provider learns
 * so immediately rather than after appearing to answer for runs it cannot see.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation, Result } from "effection";
import { WorkflowStorageError } from "../storage/errors.ts";
import type {
  DefinitionRetrieval,
  DocumentExecutionRecord,
  WorkflowRunRecord,
} from "../storage/record.ts";
import type { WorkflowHistoryEntry } from "./history.ts";

/**
 * One acquired executor lock for one run.
 *
 * The public field describes the acquisition and never validates it: the
 * provider that created this exact object is the only thing that can tell it
 * apart from a value shaped like it.
 */
export interface ExecutorLock {
  readonly runId: string;
}

/** Acquired, or already held by a live workflow executor. */
export type ExecutorAcquisition =
  | { readonly kind: "acquired"; readonly lock: ExecutorLock }
  | { readonly kind: "already-running" };

/**
 * Where a forked run came from.
 *
 * Lineage, not identity: the fork's own `workflow_run` record is what its
 * journal is held to, and this says which committed checkpoint of which run it
 * was admitted from. A run that is not a fork carries none.
 */
export interface WorkflowForkLineage {
  readonly sourceRunId: string;
  readonly checkpointEventId: string;
  readonly checkpointWorkspaceRootId: string;
}

/**
 * Everything one run says about itself, read together.
 *
 * One snapshot, so the record, its retrieval metadata, its executions, its
 * journal frontier and its current Workspace root cannot describe different
 * moments of the same run.
 */
export interface WorkflowLifecycleSnapshot {
  readonly record: WorkflowRunRecord;
  readonly retrieval?: DefinitionRetrieval;
  readonly executions: readonly DocumentExecutionRecord[];
  /** The last retained event and the root it was associated with. */
  readonly journalFrontier?: {
    readonly eventId: string;
    readonly workspaceRootId: string;
  };
  readonly currentWorkspaceRootId: string;
  /** Where this run was forked from, when it was forked from anywhere. */
  readonly lineage?: WorkflowForkLineage;
}

/**
 * What deletion actually removed.
 *
 * Categories, not a claim about the world: a push that happened is not undone
 * by removing the record of it, and nothing here says otherwise.
 */
export interface WorkflowDeletion {
  readonly removed: readonly ("run-storage" | "provider-sessions")[];
}

export interface WorkflowLifecycleApi {
  /** Take the executor lock, or report that a live workflow executor holds it. */
  acquireExecutor(runId: string): Operation<Result<ExecutorAcquisition>>;
  /** One run's immutable lifecycle snapshot. */
  inspect(runId: string): Operation<Result<WorkflowLifecycleSnapshot>>;
  /**
   * Every visible run's snapshot.
   *
   * One unreadable candidate fails the whole request with its own condition. A
   * healthy subset returned as though it were the list would be a shorter
   * answer to a question nobody asked.
   */
  list(): Operation<Result<readonly WorkflowLifecycleSnapshot[]>>;
  /** Every retained event of one run, in append order. */
  history(runId: string): Operation<Result<readonly WorkflowHistoryEntry[]>>;
  /** Make one run terminal, following its retained status. */
  cancel(runId: string): Operation<Result<WorkflowRunRecord>>;
  /** Remove one run's retained storage. */
  delete(runId: string): Operation<Result<WorkflowDeletion>>;
}

/**
 * Nothing in this scope answers that operation. Raised before anything is read.
 *
 * It says the operation went unanswered rather than that a provider is missing,
 * because both are the same fact from the caller's side: a host that installs no
 * provider and a host whose provider handles other operations both leave this
 * one with no answer, and neither may be treated as a quiet success.
 */
export class WorkflowLifecycleProviderError extends WorkflowStorageError {
  override name = "WorkflowLifecycleProviderError";

  constructor(operation: string) {
    super(
      `no workflow lifecycle provider answers ${operation}() in this scope — a host installs ` +
        "one in the scope that owns the run, such as " +
        'yield* useWorkflowLifecycle({ root }) from "@executablemd/workflow/deno".',
    );
  }
}

export const WorkflowLifecycle: Api<WorkflowLifecycleApi> = createApi<WorkflowLifecycleApi>(
  "executablemd.workflow.lifecycle",
  {
    // deno-lint-ignore require-yield
    *acquireExecutor(_runId: string): Operation<Result<ExecutorAcquisition>> {
      throw new WorkflowLifecycleProviderError("acquireExecutor");
    },

    // deno-lint-ignore require-yield
    *inspect(_runId: string): Operation<Result<WorkflowLifecycleSnapshot>> {
      throw new WorkflowLifecycleProviderError("inspect");
    },

    // deno-lint-ignore require-yield
    *list(): Operation<Result<readonly WorkflowLifecycleSnapshot[]>> {
      throw new WorkflowLifecycleProviderError("list");
    },

    // deno-lint-ignore require-yield
    *history(_runId: string): Operation<Result<readonly WorkflowHistoryEntry[]>> {
      throw new WorkflowLifecycleProviderError("history");
    },

    // deno-lint-ignore require-yield
    *cancel(_runId: string): Operation<Result<WorkflowRunRecord>> {
      throw new WorkflowLifecycleProviderError("cancel");
    },

    // deno-lint-ignore require-yield
    *delete(_runId: string): Operation<Result<WorkflowDeletion>> {
      throw new WorkflowLifecycleProviderError("delete");
    },
  },
);
