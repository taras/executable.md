/**
 * The Deno lifecycle provider's read-only half.
 *
 * Inspection is a separate physical path from execution, not a politer way of
 * using the same one. It opens each database read-only, on a connection of its
 * own, outside the execution pool: the pool's connections carry DOFS caches, an
 * active-transaction marker and a teardown that rolls back, and none of that
 * belongs to a command whose whole contract is that it changes nothing. SQLite
 * itself refuses a write on these handles, so "read-only" is enforced by the
 * database rather than promised by this module.
 *
 * ## Discovery is arithmetic
 *
 * A run's file is the SHA-256 of its id with a `.sqlite` suffix directly beneath
 * the authorized root, so `status` and `history` derive one path and `list`
 * enumerates exactly that namespace. Lifecycle sidecars occupy names this
 * pattern does not match and are never candidates. There is no registry, so
 * there is nothing that could disagree with the files.
 *
 * ## One bad candidate fails the list
 *
 * A foreign, incompatible, damaged or unparseable candidate is reported as
 * itself and ends the request. Returning the healthy rows would answer "these
 * are your runs" with a list that is missing one nobody was told about.
 *
 * ## One snapshot, one moment
 *
 * Every field of a snapshot is read inside one transaction, so the record, the
 * executions, the journal frontier and the current Workspace root cannot come
 * from different commits of the same run.
 */

import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { copyFile, exists, readdir, rm } from "@effectionx/fs";
import { useWorkflowRunConnections, type WorkflowRunConnections } from "./connections.ts";
import { ensure, Err, Ok, type Operation, type Result, scoped } from "effection";
import { Database as CloudflareDatabase } from "../../vendor/cloudflare-computer-dofs/generated/storage.js";
import type {
  DurableObjectStorageLike,
  SQLCursorLike,
  SQLStorageLike,
} from "../../vendor/cloudflare-computer-dofs/generated/types.d.ts";
import {
  type ExecutorAcquisition,
  type ExecutorLock,
  type WorkflowDeletion,
  WorkflowLifecycle,
  type WorkflowLifecycleSnapshot,
} from "../lifecycle/api.ts";
import type {
  WorkflowBeginRequest,
  WorkflowExecutionTransitions,
  WorkflowExecutionBegun,
  WorkflowForkRequest,
} from "../lifecycle/execution.ts";
import { forkRunRecordEvent } from "../fork.ts";
import { readForkSource, type ForkSourceSnapshot } from "./fork-source.ts";
import { removeProviderSessions } from "./provider-sessions.ts";
import { readForkLineage, type ForkHeadEvents } from "./fork-write.ts";
import { classifyForkability, type Forkability } from "../lifecycle/forkability.ts";
import {
  readEventSource,
  type InheritedEventProvenance,
  type WorkflowHistoryEntry,
} from "../lifecycle/history.ts";
import {
  WorkflowInspectionRecoveryError,
  WorkflowRequestError,
  WorkflowRunIdMismatchError,
  WorkflowRunLocationMismatchError,
  WorkflowExportBusyError,
  WorkflowRunNotFoundError,
  WorkflowStorageError,
} from "../storage/errors.ts";
import type { WorkflowRunDatabase } from "../storage/api.ts";
import type { DocumentExecutionRecord, WorkflowRunRecord } from "../storage/record.ts";
import {
  createExecutorLockRegistry,
  type ExecutorLockHold,
  type ExecutorLockRegistry,
} from "./executor.ts";
import { readJournalEntries } from "./journal.ts";
import {
  beginExecution,
  cancelRun,
  forkExecution,
  settleExecution,
  stageFork,
} from "./transitions.ts";
import { workflowForkStaging, workflowRunPath } from "./path.ts";
import { authorizedRoot, checkRunId } from "./provider.ts";
import { reading, readTransaction } from "./reading.ts";
import type { DetachedXmdArtifact } from "./artifact/types.ts";
import type { WorkflowDefinitionSourceReader } from "./artifact/source.ts";
import type { WorkflowDefinition } from "../storage/definition.ts";
import type { Json } from "@executablemd/durable-streams";
import { writeXmdArtifact } from "./artifact/mod.ts";
import {
  matchesRetainedDefinition,
  readExportFrontier,
  readRetrievalMetadata,
} from "./artifact-frontier.ts";
import type { WorkflowExportRequest, WorkflowExportResult } from "../lifecycle/export.ts";
import { readDocumentExecution, readRetrieval, readRunRecord } from "./rows.ts";
import { translateSqliteError, verifySchema, WorkflowReadonlyRollbackError } from "./schema.ts";
import { holdRecoveryCoordination } from "./recovery-coordination.ts";

const SELECT_RUN = "SELECT * FROM workflow_run WHERE id = 1";
const SELECT_RETRIEVAL = "SELECT * FROM definition_retrieval WHERE id = 1";
const SELECT_EXECUTIONS = "SELECT * FROM document_executions ORDER BY sequence ASC";
const SELECT_FRONTIER =
  "SELECT event_id, workspace_root_id FROM journal_events ORDER BY sequence DESC LIMIT 1";
const SELECT_CURRENT_ROOT = "SELECT current_root_id FROM workspace_state WHERE singleton_id = 1";

/** A run's file: the hash of its id, and nothing else in this namespace. */
const CANDIDATE = /^[0-9a-f]{64}\.sqlite$/;

/** A point recovered inspection passes, named so a test can stop it there. */
export type RecoveryPhase =
  | "scratch-created"
  | "source-pair-copied"
  | "scratch-recovered"
  | "before-cleanup";

/**
 * What recovered inspection reports about where it has reached.
 *
 * The directory is host arrangement this installation just made, which is what
 * lets a test plant a real filesystem fault or start a real competing process
 * at the exact moment that matters. It is not retained state, and nothing else
 * about the run travels with it: no lock, no transition, no database handle and
 * no value the run kept.
 */
export interface RecoveryObservation {
  readonly phase: RecoveryPhase;
  readonly directory: string;
}

/**
 * A test's view of recovered inspection, and its chance to pause one.
 *
 * Internal to this module and the installation that takes it. Production hands
 * over `unobserved`, so nothing in a shipped run consults an environment
 * variable, a file or a registry to decide how inspection behaves.
 */
export type RecoveryObserver = (observation: RecoveryObservation) => Operation<void>;

// deno-lint-ignore require-yield
function* unobserved(): Operation<void> {
  return undefined;
}

export interface WorkflowLifecycleOptions {
  /** The directory this host keeps runs in. Absolute, as storage requires. */
  readonly root: string;
  /**
   * How this host reads a retained definition's Markdown back, for export.
   *
   * Captured in the provider's closure at installation and never reachable
   * afterwards. A host that installs none can inspect and control runs and
   * cannot export one — which is the honest answer, because an export it could
   * perform without this would be sealing source nobody fetched.
   */
  readonly definitionSource?: WorkflowDefinitionSourceReader;
}

/**
 * Install lifecycle for the current scope and its descendants.
 *
 * `{ at: "min" }` for the same reason storage uses it: middleware at the
 * default position runs outermost, so an outer scope's provider would answer
 * ahead of one installed nearer the work.
 *
 * The executor registry belongs to this installation's closure rather than to
 * module scope, so the locks it issued last exactly as long as the scope that
 * installed the provider and nothing accumulates between runs.
 *
 */
export function* useWorkflowLifecycle(options: WorkflowLifecycleOptions): Operation<void> {
  yield* installWorkflowLifecycle(options, yield* useWorkflowRunConnections());
}

/**
 * The same installation, over a registry the host already owns.
 *
 * Storage writes to the same databases, so a host running both hands each the
 * one registry rather than letting either open a second authoritative
 * connection. Inspection still stays off it entirely: a read-only snapshot has
 * its own connection and never enters the pool execution serializes on.
 */
export function* installWorkflowLifecycle(
  options: WorkflowLifecycleOptions,
  connections: WorkflowRunConnections,
  observe: RecoveryObserver = unobserved,
): Operation<WorkflowExecutionTransitions> {
  const root = authorizedRoot(options.root);
  const executors = createExecutorLockRegistry();
  yield* WorkflowLifecycle.around(
    {
      *acquireExecutor([runId]) {
        return yield* acquire(root, executors, runId);
      },
      *cancel([runId]) {
        return yield* cancel(root, connections, executors, runId);
      },
      *delete([runId]) {
        return yield* remove(root, connections, executors, runId);
      },
      *inspect([runId]) {
        return yield* inspectRun(root, runId, observe);
      },
      *list() {
        return yield* listRuns(root, observe);
      },
      *history([runId]) {
        return yield* runHistory(root, runId, observe);
      },
      *export([request]) {
        return yield* exportRun(root, executors, options.definitionSource, request, observe);
      },
    },
    { at: "min" },
  );

  // Handed back rather than installed. Beginning an execution answers with an
  // open database, and a contextual surface anything can reach is the wrong
  // place for a capability that hands out transports.
  return {
    begin(executorLock, request) {
      return beginRun(root, connections, executors, executorLock, request);
    },
    fork(executorLock, request) {
      return forkRun(root, connections, executors, executorLock, request);
    },
    stageFork(request) {
      return stageForkRun(root, connections, request);
    },
    *settle(executorLock, completion) {
      // Authorized before a connection exists: the path comes from the hold the
      // provider issued, never from what the lock says about itself.
      const authorized = authorizeHold(executors, executorLock);
      if (!authorized.ok) {
        return authorized;
      }
      const hold = authorized.value;
      return yield* settleExecution(
        connections,
        workflowRunPath(root, hold.runId),
        hold,
        () => executors.authorize(executorLock),
        completion,
      );
    },
  };
}

function* beginRun(
  root: string,
  connections: WorkflowRunConnections,
  executors: ExecutorLockRegistry,
  executorLock: ExecutorLock,
  request: WorkflowBeginRequest,
): Operation<Result<WorkflowExecutionBegun>> {
  const checked = checkRunId(request.runId);
  if (!checked.ok) {
    return checked;
  }
  // Authorized before a connection exists, so a fabricated lock cannot cause a
  // database to be created or opened on its way to being refused. The path
  // comes from the hold rather than from what the lock says about itself.
  const authorized = authorizeHold(executors, executorLock, checked.value);
  if (!authorized.ok) {
    return authorized;
  }
  const hold = authorized.value;
  const begun = yield* beginExecution(
    connections,
    workflowRunPath(root, hold.runId),
    hold,
    () => executors.authorize(executorLock, checked.value),
    request,
  );
  if (!begun.ok) {
    return begun;
  }
  if (begun.value.kind === "refused") {
    return Err(begun.value.reason);
  }
  return Ok(begun.value);
}

/**
 * Admit one fork, and begin the execution that continues it.
 *
 * The source is read first, read-only, on a connection of its own and outside
 * the execution pool — the same physical path inspection uses, for the same
 * reason: reading a run in order to fork it is still reading it, and a fork
 * never takes the source's executor lock or writes a row of it.
 *
 * A destination the caller's request never brought into being is left absent.
 * A rolled-back transaction leaves an empty SQLite file behind, and an empty
 * file at a run's calculated path is a candidate `list` would refuse — so a
 * fork that failed before its commit removes the file it created.
 */
function* forkRun(
  root: string,
  connections: WorkflowRunConnections,
  executors: ExecutorLockRegistry,
  executorLock: ExecutorLock,
  request: WorkflowForkRequest,
): Operation<Result<WorkflowExecutionBegun>> {
  const checked = checkRunId(request.runId);
  if (!checked.ok) {
    return checked;
  }
  const source = checkRunId(request.selection.sourceRunId);
  if (!source.ok) {
    return source;
  }
  const authorized = authorizeHold(executors, executorLock, checked.value);
  if (!authorized.ok) {
    return authorized;
  }
  const hold = authorized.value;

  const snapshot = yield* readSource(root, source.value, request.selection.checkpointEventId);
  if (!snapshot.ok) {
    return snapshot;
  }

  const path = workflowRunPath(root, hold.runId);
  const existed = yield* exists(path);
  const forked = yield* forkExecution(
    connections,
    path,
    hold,
    () => executors.authorize(executorLock, checked.value),
    request,
    snapshot.value,
    forkHead(hold.runId, request),
  );

  if (forked.ok) {
    const outcome = forked.value;
    if (outcome.kind === "begun") {
      return Ok(outcome);
    }
    yield* discardEmptyDestination(connections, path, existed);
    return Err(outcome.reason);
  }
  yield* discardEmptyDestination(connections, path, existed);
  return forked;
}

/**
 * Leave nothing behind at a destination this request brought into being.
 *
 * A rolled-back transaction leaves an empty SQLite file, and an empty file at a
 * run's calculated path is a candidate `list` would refuse — so a fork that
 * failed before its commit removes what opening the destination created.
 */
function* discardEmptyDestination(
  connections: WorkflowRunConnections,
  path: string,
  existed: boolean,
): Operation<void> {
  if (existed) {
    return;
  }
  connections.close(path);
  if (yield* exists(path)) {
    yield* rm(path);
  }
}

/**
 * The same fork, assembled where nothing recognizes it as a run.
 *
 * The source is read on the same read-only terms, and the staging file is this
 * scope's: it is created here and removed when the caller's scope ends,
 * whatever the replay it exists for decides.
 */
function* stageForkRun(
  root: string,
  connections: WorkflowRunConnections,
  request: WorkflowForkRequest,
): Operation<Result<WorkflowRunDatabase>> {
  const checked = checkRunId(request.runId);
  if (!checked.ok) {
    return checked;
  }
  const source = checkRunId(request.selection.sourceRunId);
  if (!source.ok) {
    return source;
  }
  const snapshot = yield* readSource(root, source.value, request.selection.checkpointEventId);
  if (!snapshot.ok) {
    return snapshot;
  }
  return yield* stageFork(
    connections,
    workflowForkStaging(root, checked.value),
    request,
    snapshot.value,
    forkHead(checked.value, request),
  );
}

/** The two records a fork writes for itself, wherever it is being assembled. */
function forkHead(runId: string, request: WorkflowForkRequest): ForkHeadEvents {
  return {
    runRecord: forkRunRecordEvent({
      runId,
      base: request.creation.base,
      pinnedCommit: request.creation.definition.objectId,
    }),
    rootImport: request.rootImport,
  };
}

/** The committed source prefix, read exactly the way inspection reads a run. */
function* readSource(
  root: string,
  sourceRunId: string,
  checkpointEventId: string,
): Operation<Result<ForkSourceSnapshot>> {
  return yield* atRun(root, sourceRunId, (database, _record, path) =>
    readForkSource(database, path, sourceRunId, checkpointEventId),
  );
}

/**
 * Remove one run's retained storage under its executor lock.
 *
 * The lock decides whether there is anything to refuse: a live workflow executor holds
 * it, and a run somebody is running is not one to delete. Everything else may
 * be, including a `running` record whose workflow executor is gone — acquiring
 * the released lock is what proves it.
 *
 * What goes is the run's database and the provider sessions it retained. The
 * lock file stays, empty: unlinking a file
 * this workflow executor still holds would let the next caller create and lock
 * a different file at the same path. An empty lock is host
 * arrangement rather than retained run state, so it is not a category anybody
 * is told about.
 */
function* remove(
  root: string,
  connections: WorkflowRunConnections,
  executors: ExecutorLockRegistry,
  runId: string,
): Operation<Result<WorkflowDeletion>> {
  const checked = checkRunId(runId);
  if (!checked.ok) {
    return checked;
  }
  return yield* scoped(function* (): Operation<Result<WorkflowDeletion>> {
    const hold = yield* executors.acquire(root, checked.value);
    if (hold === undefined) {
      return Err(
        new WorkflowRequestError(
          `workflow run ${checked.value} is running: a run with a live workflow executor is not ` +
            "deleted. Interrupt that foreground process first.",
        ),
      );
    }

    const path = workflowRunPath(root, hold.runId);
    // Closed before anything reads it, for two reasons. The connection this
    // host holds on the file has to go before the file does, or the next caller
    // opens the one that was removed. And a write-capable connection owns the
    // database-and-journal pair while it is open, so recognizing a crashed run
    // below would otherwise wait for a connection only this line closes.
    // Closing changes nothing about the file, so nothing is recognized any
    // differently for having done it first.
    connections.close(path);

    // Recognized before anything is removed: deleting a file because its name
    // matches would remove whatever happened to be there, and an absent run is
    // reported rather than treated as an idempotent success.
    const recognized = yield* inspectRun(root, checked.value);
    if (!recognized.ok) {
      return recognized;
    }

    yield* rm(path);
    // After the run's own storage, and under the same lock. A provider session
    // is retained state this run owns, so deleting the run and leaving the
    // conversation it was having behind would be a deletion that reported more
    // than it did. Absent is not removed, and is not reported as such.
    const sessions = yield* removeProviderSessions(root, hold.runId);
    return Ok({ removed: sessions ? ["run-storage", "provider-sessions"] : ["run-storage"] });
  });
}

/** The hold this executor lock stands for, as a refusal rather than a raise. */
function authorizeHold(
  executors: ExecutorLockRegistry,
  lock: ExecutorLock,
  runId?: string,
): Result<ExecutorLockHold> {
  try {
    return Ok(executors.authorize(lock, runId));
  } catch (error) {
    if (error instanceof WorkflowStorageError) {
      return Err(error);
    }
    throw error;
  }
}

/**
 * Make one run terminal, when nothing is running it.
 *
 * The lock is the whole test for whether anything is: a live workflow executor holds it,
 * and this host does not reach into another process's document execution. A
 * caller who wants a running workflow to stop interrupts the foreground process
 * running it, which publishes `interrupted` and leaves the run resumable.
 */
function* cancel(
  root: string,
  connections: WorkflowRunConnections,
  executors: ExecutorLockRegistry,
  runId: string,
): Operation<Result<WorkflowRunRecord>> {
  const checked = checkRunId(runId);
  if (!checked.ok) {
    return checked;
  }
  return yield* scoped(function* (): Operation<Result<WorkflowRunRecord>> {
    const hold = yield* executors.acquire(root, checked.value);
    if (hold === undefined) {
      return Err(
        new WorkflowRequestError(
          `workflow run ${checked.value} is running: cancellation does not reach into a live ` +
            "document execution. Interrupt that foreground process — Ctrl-C tears " +
            "its scope down in order, publishes interrupted and leaves the run resumable.",
        ),
      );
    }
    return yield* cancelRun(connections, workflowRunPath(root, hold.runId), hold, () =>
      executors.authorize(hold.lock, checked.value),
    );
  });
}

/**
 * Take the executor lock for one run, or report that a live workflow executor holds it.
 *
 * The lock is taken before anything reads or writes the run, and the executor
 * lock it produces belongs to the scope that asked. An acquisition made
 * inside a `scoped()` block releases when that block ends, whatever happened
 * inside it.
 */
function* acquire(
  root: string,
  executors: ExecutorLockRegistry,
  runId: string,
): Operation<Result<ExecutorAcquisition>> {
  const checked = checkRunId(runId);
  if (!checked.ok) {
    return checked;
  }
  const hold = yield* executors.acquire(root, checked.value);
  if (hold === undefined) {
    return Ok({ kind: "already-running" });
  }
  return Ok({ kind: "acquired", lock: hold.lock });
}

/**
 * Seal one committed frontier, and leave the run exactly as it was found.
 *
 * The lock is held for the read and for nothing else. What it buys is that the
 * frontier is one consistent committed view rather than a moving one — once the
 * rows are values in memory, no execution can invalidate them, so the container
 * is written with the lock already released and a long export does not keep a
 * run unrunnable.
 *
 * The read itself is the ordinary inspection path, which is what gives a
 * crashed source the existing recovery-copy discipline for free: a private copy
 * is recovered and read, and the retained database is left untouched.
 */
function* exportRun(
  root: string,
  executors: ExecutorLockRegistry,
  readDefinitionSource: WorkflowDefinitionSourceReader | undefined,
  request: WorkflowExportRequest,
  observe: RecoveryObserver,
): Operation<Result<WorkflowExportResult>> {
  const checked = checkRunId(request.runId);
  if (!checked.ok) {
    return checked;
  }
  if (readDefinitionSource === undefined) {
    return Err(
      new WorkflowRequestError(
        "this host installs no way to read a retained definition's source, so it cannot export " +
          "a run. An artifact carries the document the run was of, and one sealed without it " +
          "would be evidence nobody could continue from.",
      ),
    );
  }

  // The lock covers selection and detachment, and stops there. Reading the
  // definition's source means opening a repository, and holding a run
  // unrunnable for as long as that takes would buy nothing: the frontier is
  // already values in memory, and no later execution can change what they say.
  const selected = yield* scoped(function* (): Operation<Result<SelectedFrontier>> {
    const hold = yield* executors.acquire(root, checked.value);
    if (hold === undefined) {
      return Err(new WorkflowExportBusyError(checked.value));
    }
    return yield* atRun(
      root,
      checked.value,
      (database, record, path) => ({
        detached: readExportFrontier(database, record, path),
        definition: record.definition,
        retrieval: readRetrievalMetadata(database),
      }),
      observe,
    );
  });
  if (!selected.ok) {
    return selected;
  }

  const closure = yield* readDefinitionSource(selected.value.definition, selected.value.retrieval);
  if (!closure.ok) {
    return closure;
  }
  // Asked even though the host fetched it: a reader is host code, and the one
  // thing the provider can still check is that what came back describes the
  // definition this frontier retains rather than some other run's.
  const matched = matchesRetainedDefinition(selected.value.definition, closure.value);
  if (!matched.ok) {
    return matched;
  }

  const written = yield* writeXmdArtifact(request.stagingPath, {
    ...selected.value.detached,
    definition: closure.value,
  });
  if (!written.ok) {
    return written;
  }
  return Ok({
    stagingPath: request.stagingPath,
    frontier: written.value.artifact.frontier,
    identity: written.value.identity,
    fileSha256: written.value.fileSha256,
  });
}

/** What one locked selection detached, before any source was fetched. */
interface SelectedFrontier {
  readonly detached: Omit<DetachedXmdArtifact, "definition">;
  readonly definition: WorkflowDefinition;
  readonly retrieval: Json | undefined;
}

function* inspectRun(
  root: string,
  runId: string,
  observe: RecoveryObserver = unobserved,
): Operation<Result<WorkflowLifecycleSnapshot>> {
  return yield* atRun(root, runId, snapshot, observe);
}

function* runHistory(
  root: string,
  runId: string,
  observe: RecoveryObserver,
): Operation<Result<readonly WorkflowHistoryEntry[]>> {
  return yield* atRun(
    root,
    runId,
    (database) => {
      const entries = readJournalEntries(database);
      // Classified against the roots this database still holds, read in the same
      // snapshot as the events. A root that was never retained and a root deleted
      // since are the same fact to a fork: it cannot be given that Workspace.
      const forkability = classifyForkability(entries, { retainedRoots: retainedRoots(database) });
      const inherited = readEventProvenance(database);
      return Object.freeze(
        entries.map((entry, index) =>
          Object.freeze({
            eventId: entry.eventId,
            event: entry.event,
            workspaceRootId: entry.workspaceRootId,
            ...sourceOf(entry.event),
            forkability: forkability[index] ?? UNCLASSIFIED,
            ...provenanceOf(inherited, entry.eventId),
          }),
        ),
      );
    },
    observe,
  );
}

/**
 * The answer for an event the classification did not reach.
 *
 * It never happens — one forkability is produced per event — and reporting a
 * forkable checkpoint if it ever did would offer a fork a prefix nothing
 * examined.
 */
const UNCLASSIFIED: Forkability = Object.freeze({
  forkable: false,
  blockers: Object.freeze([Object.freeze({ code: "unsupported-effect" as const, eventId: "" })]),
});

function provenanceOf(
  inherited: ReadonlyMap<string, InheritedEventProvenance>,
  eventId: string,
): Partial<WorkflowHistoryEntry> {
  const provenance = inherited.get(eventId);
  return provenance === undefined ? {} : { inherited: provenance };
}

/**
 * Which rows this run inherited, and from where.
 *
 * Only a fork has any. The rows a run wrote itself are absent from this table,
 * and absence is what marks them as its own.
 */
function readEventProvenance(
  database: DatabaseSync,
): ReadonlyMap<string, InheritedEventProvenance> {
  const provenance = new Map<string, InheritedEventProvenance>();
  for (const row of reading(
    database,
    "SELECT event_id, source_run_id, source_event_id FROM journal_event_provenance",
  ).all()) {
    const eventId = row["event_id"];
    const sourceRunId = row["source_run_id"];
    const sourceEventId = row["source_event_id"];
    if (
      typeof eventId !== "string" ||
      typeof sourceRunId !== "string" ||
      typeof sourceEventId !== "string"
    ) {
      throw new WorkflowRequestError(
        "a retained inherited-event provenance row does not describe an inherited event.",
      );
    }
    provenance.set(eventId, Object.freeze({ sourceRunId, sourceEventId }));
  }
  return provenance;
}

export function retainedRoots(database: DatabaseSync): ReadonlySet<string> {
  const roots = new Set<string>();
  for (const row of reading(database, "SELECT root_id FROM workspace_roots").all()) {
    const rootId = row["root_id"];
    if (typeof rootId === "string") {
      roots.add(rootId);
    }
  }
  return roots;
}

function sourceOf(event: WorkflowHistoryEntry["event"]): Partial<WorkflowHistoryEntry> {
  const source = readEventSource(event);
  return source === undefined ? {} : { source };
}

/**
 * Read one run this caller named, refusing storage that holds a different one.
 *
 * Two questions, and the second is asked for every candidate rather than only
 * here: `withSnapshot` refuses a database whose retained id does not name its
 * file at all, so what is left to ask is whether the run it holds is the run
 * that was asked for.
 */
function* atRun<T>(
  root: string,
  runId: string,
  read: (database: DatabaseSync, record: WorkflowRunRecord, path: string) => T,
  observe: RecoveryObserver = unobserved,
): Operation<Result<T>> {
  const checked = checkRunId(runId);
  if (!checked.ok) {
    return checked;
  }
  const path = workflowRunPath(root, checked.value);
  // Asked before opening, because `node:sqlite` creates the file it is pointed
  // at. A read-only open of an absent run must report the absent run rather
  // than inventing an empty one.
  if (!(yield* exists(path))) {
    return Err(new WorkflowRunNotFoundError(checked.value));
  }
  return yield* withSnapshot(
    path,
    (database, record) => {
      if (record.runId !== checked.value) {
        throw new WorkflowRunIdMismatchError(checked.value, path);
      }
      return read(database, record, path);
    },
    observe,
  );
}

function* listRuns(
  root: string,
  observe: RecoveryObserver,
): Operation<Result<readonly WorkflowLifecycleSnapshot[]>> {
  const snapshots: WorkflowLifecycleSnapshot[] = [];
  for (const path of yield* candidatePaths(root)) {
    // One unreadable candidate ends the request. A list is a claim about every
    // run this root holds, and a shorter one silently answers a question the
    // caller did not ask. A candidate that is a perfectly good database of
    // *another* run is one of those: `withSnapshot` refuses it because its
    // retained id does not name the file it was found in.
    const read = yield* withSnapshot(
      path,
      (database, record) => snapshot(database, record, path),
      observe,
    );
    if (!read.ok) {
      return read;
    }
    snapshots.push(read.value);
  }

  snapshots.sort(byNewestUpdate);
  return Ok(Object.freeze(snapshots));
}

/** Newest update first; the run id breaks a tie so the order is total. */
function byNewestUpdate(left: WorkflowLifecycleSnapshot, right: WorkflowLifecycleSnapshot): number {
  if (left.record.updatedAt === right.record.updatedAt) {
    return left.record.runId < right.record.runId ? -1 : 1;
  }
  return left.record.updatedAt < right.record.updatedAt ? 1 : -1;
}

function* candidatePaths(root: string): Operation<string[]> {
  if (!(yield* exists(root))) {
    // A host that has never started a run has no runs, which is a complete
    // answer rather than a missing store.
    return [];
  }
  const names = yield* readdir(root);
  return names
    .filter((name) => CANDIDATE.test(name))
    .sort()
    .map((name) => join(root, name));
}

/**
 * One consistent reading of a run, on a connection SQLite will not let anything
 * write through, closed before the answer is returned.
 *
 * Recognition is structure and then identity: a file that is shaped like a
 * version-1 workflow run still has to be the run its location names. Because a
 * run's file name is the hash of its id, a healthy database copied or renamed
 * to another candidate's name would otherwise be returned as a second, entirely
 * genuine-looking run — so the check belongs here, where every read passes,
 * rather than only where a caller supplied an id to compare against.
 *
 * Two paths call this with two different files. The ordinary one reads the
 * retained database, where `physical` and `source` are the same path. Recovered
 * inspection reads a private copy, where `physical` is that copy and `source`
 * is still the retained database every diagnostic and every returned path is
 * about. Identity is not overridden between them: the copy is made under the
 * candidate's own filename, so the location check below asks the real file the
 * same question either way.
 */
function readSnapshot<T>(
  physical: string,
  source: string,
  read: (database: DatabaseSync, record: WorkflowRunRecord) => T,
): Result<T> {
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(physical, { readOnly: true });
  } catch (error) {
    return refusal(error, source);
  }
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    return Ok(
      readTransaction(database, () => {
        verifySchema(database, source, inertDofs(database));
        const record = readRunRow(database, source);
        if (basename(physical) !== basename(workflowRunPath(dirname(physical), record.runId))) {
          throw new WorkflowRunLocationMismatchError(record.runId, source);
        }
        return read(database, record);
      }),
    );
  } catch (error) {
    return refusal(error, source);
  } finally {
    database.close();
  }
}

/** The reading, or `undefined` when only a hot rollback journal stopped it. */
function attemptDirect<T>(
  physical: string,
  source: string,
  read: (database: DatabaseSync, record: WorkflowRunRecord) => T,
): Result<T> | undefined {
  try {
    return readSnapshot(physical, source, read);
  } catch (error) {
    if (error instanceof WorkflowReadonlyRollbackError) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Read one run, recovering a private copy when a lost host left a hot journal.
 *
 * The ordinary reading comes first and answers almost always, at the cost of
 * nothing: no coordination, no scratch, no second open. Only the one condition
 * a read-only connection genuinely cannot get past falls through to recovery.
 */
function* withSnapshot<T>(
  path: string,
  read: (database: DatabaseSync, record: WorkflowRunRecord) => T,
  observe: RecoveryObserver,
): Operation<Result<T>> {
  const direct = attemptDirect(path, path, read);
  if (direct !== undefined) {
    return direct;
  }
  return yield* recoverSnapshot(path, read, observe);
}

/** Where a run keeps the journal that says what to put back. */
function journalOf(database: string): string {
  return `${database}-journal`;
}

/**
 * Inspect a crashed run without touching what it retained.
 *
 * The retained pair is copied under coordination and recovered nowhere near the
 * original: SQLite rolls the copy's journal back into the copy, and the answer
 * is read from that. What the run kept is exactly as its lost host left it when
 * this returns, still waiting for the write-capable owner whose job recovery
 * actually is.
 *
 * Coordination is held for the copy and released before the copy is recovered.
 * Holding it any longer would make an inspection stand between a real owner and
 * the run it is entitled to recover, for work that no longer touches the source.
 */
function* recoverSnapshot<T>(
  source: string,
  read: (database: DatabaseSync, record: WorkflowRunRecord) => T,
  observe: RecoveryObserver,
): Operation<Result<T>> {
  return yield* scoped(function* (): Operation<Result<T>> {
    let directory: string | undefined;

    // The net, and only the net. It has work to do when this operation never
    // reached its own removal below — it was cancelled, or it failed its way
    // out — and in that state there is nobody left to answer, so a removal
    // that cannot happen is raised. Whoever cancelled this receives it, which
    // is the only way they learn a copy of the run's contents is still on disk.
    yield* ensure(function* () {
      if (directory === undefined) {
        return;
      }
      const abandoned = directory;
      yield* observe({ phase: "before-cleanup", directory: abandoned });
      if (!(yield* removeScratch(abandoned))) {
        throw new WorkflowInspectionRecoveryError(source, abandoned);
      }
    });

    const outcome = yield* produceRecovered(source, read, observe, (scratch) => {
      directory = scratch;
    });

    if (directory !== undefined) {
      // Removed here rather than in teardown, because a call that has an answer
      // to give is the one call that can report a failed removal as its answer.
      // Whether "an answer was computed" is not the same question as whether
      // this operation is still live, and only this line knows both.
      const created = directory;
      yield* observe({ phase: "before-cleanup", directory: created });
      const removed = yield* removeScratch(created);
      // Cleared either way: this call has dealt with the copy, and the net
      // above must not answer for it a second time. A cancellation that
      // interrupts the removal above leaves this unset, so the net still does.
      directory = undefined;
      if (!removed) {
        return Err(new WorkflowInspectionRecoveryError(source, created));
      }
    }

    return outcome;
  });
}

/**
 * Whether the copy is gone.
 *
 * Forced, so a directory something else already removed is removal that
 * succeeded: reporting residue at a path holding nothing would send an operator
 * after a copy that is not there.
 */
function* removeScratch(directory: string): Operation<boolean> {
  try {
    yield* rm(directory, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * The answer a recovered copy gives, and the copy it needed to give it.
 *
 * `created` is called the moment the scratch directory exists, before anything
 * is written into it, so its removal is arranged before there is anything to
 * remove.
 */
function* produceRecovered<T>(
  source: string,
  read: (database: DatabaseSync, record: WorkflowRunRecord) => T,
  observe: RecoveryObserver,
  created: (directory: string) => void,
): Operation<Result<T>> {
  let directory: string | undefined;
  try {
    const retried = yield* scoped(function* (): Operation<Result<T> | undefined> {
      yield* holdRecoveryCoordination(source);

      // Asked again under coordination: a write-capable owner may have
      // recovered the run while this inspection waited, and reading what it
      // recovered is a better answer than copying anything.
      const owned = attemptDirect(source, source, read);
      if (owned !== undefined) {
        return owned;
      }

      // Created synchronously, and handed to its owner before anything can
      // suspend. `until()` stops observing a promise; it does not cancel one,
      // so an asynchronous `mkdtemp` halted mid-flight would still go on to
      // create a directory — after this generator had stopped, with nothing
      // holding its path and nothing left to remove it. Naming and creating at
      // once also means this is never a directory an earlier attempt left.
      // oxlint-disable-next-line local/no-sync-filesystem
      const scratch = mkdtempSync(join(tmpdir(), "xmd-inspection-"));
      directory = scratch;
      created(scratch);
      yield* observe({ phase: "scratch-created", directory: scratch });

      // Copied under the candidate's own name, so the copy answers the location
      // question as itself rather than needing to be told what it stands for.
      const copy = join(scratch, basename(source));
      yield* copyFile(source, copy);
      if (yield* exists(journalOf(source))) {
        yield* copyFile(journalOf(source), journalOf(copy));
      }
      yield* observe({ phase: "source-pair-copied", directory: scratch });
      return undefined;
    });
    if (retried !== undefined) {
      return retried;
    }
    if (directory === undefined) {
      throw new WorkflowRequestError("the recovered inspection copy was not created.");
    }

    const copy = join(directory, basename(source));
    recoverCopy(copy);
    yield* observe({ phase: "scratch-recovered", directory });
    return readSnapshot(copy, source, read);
  } catch {
    // Coordination, copying and the recovery read itself. What the copy then
    // turned out to describe — a damaged image, another run's identity, an
    // unparseable row — keeps its own type and never arrives here.
    return Err(new WorkflowInspectionRecoveryError(source));
  }
}

/**
 * Let SQLite put the copy's journal back.
 *
 * Write-capable because that is the whole point, and reading one page is what
 * makes SQLite notice the journal and roll it back. It recovers a copy nothing
 * else can see, so it takes no coordination and changes nothing anybody keeps.
 */
function recoverCopy(copy: string): void {
  const database = new DatabaseSync(copy);
  try {
    database.prepare("SELECT count(*) FROM sqlite_schema").get();
  } finally {
    database.close();
  }
}

/**
 * A DOFS handle for recognition, which never reaches it.
 *
 * Verification materializes no manifest, so the only DOFS call it could make is
 * one it is told not to make. Handing it a connection that refuses to write is
 * what proves that: a recognition path that started writing would fail here
 * rather than quietly repairing a database inspection promised to leave alone.
 */
function inertDofs(database: DatabaseSync): CloudflareDatabase {
  const sql: SQLStorageLike = {
    exec<Row extends object = Record<string, unknown>>(
      query: string,
      ...bindings: unknown[]
    ): SQLCursorLike<Row> {
      const statement = database.prepare(query);
      const rows = Reflect.apply(statement.all, statement, bindings);
      return {
        toArray(): Row[] {
          return rows;
        },
      };
    },
  };
  const storage: DurableObjectStorageLike = {
    sql,
    transactionSync<T>(_closure: () => T): T {
      throw new WorkflowRequestError(
        "workflow inspection does not open a DOFS transaction: it reads a snapshot and " +
          "changes nothing.",
      );
    },
  };
  return new CloudflareDatabase(storage);
}

function snapshot(
  database: DatabaseSync,
  record: WorkflowRunRecord,
  path: string,
): WorkflowLifecycleSnapshot {
  const retrievalRow = reading(database, SELECT_RETRIEVAL).get();
  const executions: DocumentExecutionRecord[] = reading(database, SELECT_EXECUTIONS)
    .all()
    .map(readDocumentExecution);

  return Object.freeze({
    record,
    ...(retrievalRow === undefined ? {} : { retrieval: readRetrieval(retrievalRow) }),
    executions: Object.freeze(executions),
    ...frontier(database, path),
    currentWorkspaceRootId: currentRoot(database, path),
    ...lineageOf(database),
  });
}

function lineageOf(database: DatabaseSync): Pick<WorkflowLifecycleSnapshot, "lineage"> {
  const lineage = readForkLineage(database);
  return lineage === undefined ? {} : { lineage };
}

function frontier(
  database: DatabaseSync,
  path: string,
): Pick<WorkflowLifecycleSnapshot, "journalFrontier"> {
  const row = reading(database, SELECT_FRONTIER).get();
  if (row === undefined) {
    return {};
  }
  const eventId = row["event_id"];
  const workspaceRootId = row["workspace_root_id"];
  if (typeof eventId !== "string" || typeof workspaceRootId !== "string") {
    throw new WorkflowRequestError(`The journal frontier at ${path} does not describe an event.`);
  }
  return { journalFrontier: Object.freeze({ eventId, workspaceRootId }) };
}

function currentRoot(database: DatabaseSync, path: string): string {
  const row = reading(database, SELECT_CURRENT_ROOT).get();
  const rootId = row?.["current_root_id"];
  if (typeof rootId !== "string") {
    throw new WorkflowRequestError(`The Workspace at ${path} has no current root.`);
  }
  return rootId;
}

function readRunRow(database: DatabaseSync, path: string): WorkflowRunRecord {
  const row = reading(database, SELECT_RUN).get();
  if (row === undefined) {
    throw new WorkflowRequestError(`The workflow-run database at ${path} holds no workflow run.`);
  }
  return readRunRecord(row);
}

function refusal<T>(error: unknown, path: string): Result<T> {
  const translated = translateSqliteError(error, path);
  if (translated instanceof WorkflowStorageError) {
    return Err(translated);
  }
  throw translated;
}
