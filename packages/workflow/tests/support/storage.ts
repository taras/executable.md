/**
 * Fixtures for the Deno workflow-run storage suites.
 *
 * A storage root is a real directory and a run is a real file in it: these
 * suites are about what survives a process, so nothing here stands in for the
 * filesystem or for SQLite.
 *
 * The root is a resource rather than a `scoped()` block, because a temporary
 * directory torn down when its setup returns is gone before the test that asked
 * for it can look inside.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensure, type Operation, resource, type Result, scoped } from "effection";
import { rm } from "@effectionx/fs";
import {
  type CreateWorkflowRunRequest,
  type ExecutorLock,
  type GitWorkflowDefinitionV1,
  parseWorkflowDefinition,
  type DocumentExecutionRecord,
  WorkflowLifecycle,
  type WorkflowRunDatabase,
  type WorkflowRunRecord,
  type WorkflowRunStatus,
  WorkflowRunStorage,
  type WorkflowStopReason,
} from "../../mod.ts";
import type {
  WorkflowBeginRequest,
  WorkflowExecutionTransitions,
  WorkflowExecutionBegun,
  WorkflowRunCreation,
} from "../../deno.ts";
import { installWorkflowLifecycle } from "../../src/deno/lifecycle.ts";
import { workflowRunPath } from "../../deno.ts";
import { useWorkflowRunConnections } from "../../src/deno/connections.ts";
import { SavepointObservation } from "../../src/deno/savepoints.ts";
import { installWorkflowRunStorage } from "../../src/deno/provider.ts";
import type { PrivateWorkspaceOptions } from "../../src/deno/workspace/private.ts";

export const SHA1 = "9fceb02d0ae598e95dc970b74767f19372d61af8";

/** A directory that exists for the test that asked for it, and no longer. */
export function useStorageRoot(): Operation<string> {
  return resource<string>(function* (provide) {
    const root = mkdtempSync(join(tmpdir(), "xmd-workflow-runs-"));
    yield* ensure(function* () {
      yield* rm(root, { recursive: true, force: true });
    });
    yield* provide(root);
  });
}

export function definition(
  overrides: Partial<GitWorkflowDefinitionV1> = {},
): GitWorkflowDefinitionV1 {
  const result = parseWorkflowDefinition({
    version: 1,
    kind: "git",
    objectFormat: "sha1",
    objectId: SHA1,
    rootDocumentPath: "workflows/release.md",
    ...overrides,
  });
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

export function request(
  overrides: Partial<CreateWorkflowRunRequest> = {},
): CreateWorkflowRunRequest {
  return {
    runId: "release-1.4",
    definition: definition(),
    base: "main",
    props: { channel: "stable" },
    ...overrides,
  };
}

/**
 * Run `body` with this host's storage installed for its scope only.
 *
 * `internal` is the provider's own installation option, supplied here and
 * nowhere a document could reach: the decorator it may carry replaces the
 * authoritative Workspace filesystem, and that decision belongs to whoever
 * installs the provider.
 */
export function withStorage<T>(
  root: string,
  body: () => Operation<T>,
  internal: PrivateWorkspaceOptions = {},
): Operation<T> {
  return scoped(function* () {
    // The observer travels with the registry: these suites watch real savepoint
    // behavior, and a registry created without it reports to nobody.
    const connections = yield* useWorkflowRunConnections(yield* SavepointObservation.get());
    yield* installWorkflowRunStorage({ root }, internal, connections);
    return yield* body();
  });
}

/** The database a create must produce, or the failure it produced instead. */
export function* createRun(
  overrides: Partial<CreateWorkflowRunRequest> = {},
): Operation<WorkflowRunDatabase> {
  const result = yield* WorkflowRunStorage.operations.create(request(overrides));
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/** Where a run id lands beneath a root, for tests that inspect the file. */
export function runPath(root: string, runId: string): string {
  return workflowRunPath(root, runId);
}

/**
 * Edit a run's database directly, the way something outside XMD would.
 *
 * The corruption suites need rows and headers no supported operation can
 * write, so they reach past the adapter rather than through it.
 */
export function tamper(path: string, body: (database: DatabaseSync) => void): void {
  const database = new DatabaseSync(path);
  try {
    body(database);
  } finally {
    database.close();
  }
}

/**
 * What another connection can see of a run's journal right now.
 *
 * The discriminating observation for atomicity. Rows written inside an open
 * transaction are invisible to a second connection until that transaction
 * commits, so counting from outside says whether a commit has already
 * happened — which presence in the journal afterwards cannot.
 */
export function committedEventCount(path: string): number {
  const database = new DatabaseSync(path);
  try {
    const row = database.prepare("SELECT count(*) AS total FROM journal_events").get();
    const total = row?.["total"];
    return typeof total === "number" ? total : Number(total);
  } finally {
    database.close();
  }
}

/**
 * Make one particular journal insertion fail inside SQLite.
 *
 * A trigger rather than a stubbed statement: the failure has to come from the
 * database, after the row has been offered to it, so what is under test is the
 * transaction's response to a real insertion failure and not a mock's.
 *
 * It matches one event name rather than every insertion, so a test can append
 * successfully first and then fail — which is the case worth proving, since
 * that is where a partial transaction would show.
 */
export function refuseJournalInsertNamed(path: string, name: string): void {
  tamper(path, (database) => {
    database.exec(`
      CREATE TRIGGER refuse_journal_insert BEFORE INSERT ON journal_events
      WHEN NEW.record LIKE '%"name":"${name}"%'
      BEGIN
        SELECT raise(ABORT, 'the journal refuses this row');
      END
    `);
  });
}

/** Take that refusal away again, leaving the schema as version 1 declares it. */
export function allowJournalInserts(path: string): void {
  tamper(path, (database) => {
    database.exec("DROP TRIGGER IF EXISTS refuse_journal_insert");
  });
}

/**
 * Rebuild `workflow_run` without its CHECK constraints.
 *
 * The database refuses to store an unreadable status, an incoherent stop
 * reason or props that are not JSON, so the only way to test what happens when
 * one is stored is to take the constraints away first — which is exactly the
 * state an outside editor would leave the file in.
 */
export function relaxRunConstraints(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE workflow_run RENAME TO workflow_run_relaxed;
    CREATE TABLE workflow_run (
      id INTEGER PRIMARY KEY,
      run_id TEXT,
      definition TEXT,
      base TEXT,
      props TEXT,
      status TEXT,
      stop_reason_kind TEXT,
      stop_reason_code TEXT,
      stop_reason_event_id TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    INSERT INTO workflow_run SELECT * FROM workflow_run_relaxed;
    DROP TABLE workflow_run_relaxed;
  `);
}

/**
 * Everything a Deno host installs, over one registry.
 *
 * Storage and lifecycle share the registry here for the same reason the real
 * host does: they write to the same databases. The transitions the host would
 * keep to itself are handed to the body, because a test standing in for the
 * host is the host.
 */
export function withRunHost<T>(
  root: string,
  body: (transitions: WorkflowExecutionTransitions) => Operation<T>,
  internal: PrivateWorkspaceOptions = {},
): Operation<T> {
  return scoped(function* () {
    const connections = yield* useWorkflowRunConnections(yield* SavepointObservation.get());
    yield* installWorkflowRunStorage({ root }, internal, connections);
    const transitions = yield* installWorkflowLifecycle({ root }, connections);
    return yield* body(transitions);
  });
}

/**
 * One run begun the way production begins one, for as long as the body runs.
 *
 * A real executor lock and the real transition — there is no lock-free way
 * to write a lifecycle row, in a test or anywhere else, which is the point of
 * the slice this fixture belongs to. The lock is held for the callback and
 * released with it, so nothing here hands back a database that outlives the
 * lock that opened it.
 */
export function withExecutorRun<T>(
  transitions: WorkflowExecutionTransitions,
  request: WorkflowBeginRequest,
  body: (begun: WorkflowExecutionBegun, executorLock: ExecutorLock) => Operation<T>,
): Operation<T> {
  return scoped(function* () {
    const acquisition = yield* WorkflowLifecycle.operations.acquireExecutor(request.runId);
    if (!acquisition.ok) {
      throw acquisition.error;
    }
    if (acquisition.value.kind !== "acquired") {
      throw new Error(`the run ${request.runId} already has a live workflow executor`);
    }
    const { lock: executorLock } = acquisition.value;
    const begun = yield* transitions.begin(executorLock, request);
    if (!begun.ok) {
      throw begun.error;
    }
    return yield* body(begun.value, executorLock);
  });
}

/** The creation a `start` supplies, for a fixture that does not care which. */
export function creation(overrides: Partial<WorkflowRunCreation> = {}): WorkflowRunCreation {
  return { definition: definition(), base: "main", props: { channel: "stable" }, ...overrides };
}

/** A run begun under a real executor lock, with the settlement that ends it. */
export interface BegunRun {
  readonly database: WorkflowRunDatabase;
  readonly execution: DocumentExecutionRecord;
  /** Settle the execution this run began, unless another is named. */
  settle(completion: {
    status: WorkflowRunStatus;
    reason?: WorkflowStopReason;
    executionId?: string;
  }): Operation<Result<WorkflowRunRecord>>;
}

/**
 * One begun run, for a suite whose subject is what storage retains.
 *
 * Publishing a status is a lifecycle transition now, so a test that needs a
 * settled run acquires the executor lock and settles through the same
 * transitions production uses. What the test then asserts is still storage's business: the
 * status that survived, the reason beside it, the execution row it left.
 */
export function withBegunRun<T>(
  root: string,
  body: (run: BegunRun) => Operation<T>,
  runId = "release-1.4",
): Operation<T> {
  return withRunHost(root, function* (transitions) {
    return yield* withExecutorRun(
      transitions,
      { runId, action: "start", creation: creation() },
      function* (begun, executorLock) {
        return yield* body({
          database: begun.database,
          execution: begun.execution,
          settle(completion) {
            const { executionId = begun.execution.executionId, status, reason } = completion;
            return transitions.settle(executorLock, {
              executionId,
              status,
              ...(reason === undefined ? {} : { reason }),
            });
          },
        });
      },
    );
  });
}
