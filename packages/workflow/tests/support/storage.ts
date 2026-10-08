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

import { DatabaseSync } from "node:sqlite";
import { type Operation, type Result, scoped } from "effection";
import { useTempDirectory } from "@executablemd/test-support/temp";
import {
  type CreateWorkflowRunRequest,
  type ExecutorLock,
  parseWorkflowDefinition,
  type WorkflowDefinition,
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
} from "../../deno.ts";
import { installWorkflowLifecycle } from "../../src/deno/lifecycle.ts";
import { workflowRunPath } from "../../deno.ts";
import { useWorkflowRunConnections } from "../../src/deno/connections.ts";
import { SavepointObservation } from "../../src/deno/savepoints.ts";
import { installWorkflowRunStorage } from "../../src/deno/provider.ts";
import type { PrivateWorkspaceOptions } from "../../src/deno/workspace/private.ts";
import { parseSourceBundleDefinition, sourceBundleHash, sourceContentHash } from "../../mod.ts";
import type { WorkflowRunCreation } from "../../deno.ts";
import type { Json } from "@executablemd/durable-streams";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { exec } from "@effectionx/process";
import { when } from "@effectionx/converge";
import { ensure, spawn } from "effection";

export const SHA1 = "9fceb02d0ae598e95dc970b74767f19372d61af8";

/** A directory that exists for the test that asked for it, and no longer. */
export function useStorageRoot(): Operation<string> {
  return useTempDirectory("xmd-workflow-runs-");
}

/**
 * The one document this suite's representative run retains.
 *
 * The hashes are the ones these exact bytes produce, computed once rather than
 * invented: the create transition recomputes them from the snapshot it is
 * given, so a descriptor naming anything else retains nothing.
 */
const ENTRYPOINT = "workflows/release.md";
const ENTRYPOINT_TEXT = "# Release\n";
const ENTRYPOINT_BYTES = new TextEncoder().encode(ENTRYPOINT_TEXT);
const SOURCE_HASH = "b78cd463c5885c1b595de07f665ce82b61df6636eb8c5f00cf11985cbfeb986d";
const BUNDLE_HASH = "e22b9d94280c8b07aac19569452576323e1662e729d36609f72fd8be44a74d6c";

/** The snapshot those sources are, as a caller offers it. */
export function entrypointSnapshot(): { path: string; bytes: Uint8Array }[] {
  return [{ path: ENTRYPOINT, bytes: ENTRYPOINT_BYTES.slice() }];
}

export function definition(overrides: Record<string, unknown> = {}): WorkflowDefinition {
  const result = parseWorkflowDefinition({
    hashAlgorithm: "sha256",
    bundleHash: BUNDLE_HASH,
    entrypoint: ENTRYPOINT,
    sources: [
      { path: ENTRYPOINT, sourceHash: SOURCE_HASH, byteLength: ENTRYPOINT_BYTES.byteLength },
    ],
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
    sourceSnapshot: entrypointSnapshot(),
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
  return {
    definition: definition(),
    sourceSnapshot: entrypointSnapshot(),
    props: { channel: "stable" },
    ...overrides,
  };
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

/** The Markdown a source-bundle fixture retains, and its logical path. */
export const BUNDLE_ENTRYPOINT = "release.md";
export const BUNDLE_SOURCE = "# Release\n\nthis run retains these exact bytes\n";

/**
 * A complete source-bundle creation, descriptor and bytes together.
 *
 * Built the way a host builds one: the source hashes come from the bytes, and
 * the bundle hash from the manifest those hashes make — so the descriptor
 * describes itself before anything is asked to retain it.
 */
export function* sourceBundleCreation(
  options: {
    readonly content?: string;
    readonly targetPath?: string;
    readonly props?: { [key: string]: Json };
  } = {},
): Operation<WorkflowRunCreation> {
  const text = options.content ?? BUNDLE_SOURCE;
  const bytes = new TextEncoder().encode(text);
  const sources = [
    {
      path: BUNDLE_ENTRYPOINT,
      sourceHash: yield* sourceContentHash(bytes),
      byteLength: bytes.byteLength,
    },
  ];
  const bundleHash = yield* sourceBundleHash({ entrypoint: BUNDLE_ENTRYPOINT, sources });
  const parsed = parseSourceBundleDefinition({
    hashAlgorithm: "sha256",
    bundleHash,
    entrypoint: BUNDLE_ENTRYPOINT,
    sources,
    ...(options.targetPath === undefined ? {} : { targetPath: options.targetPath }),
  });
  if (!parsed.ok) {
    throw parsed.error;
  }
  return {
    definition: parsed.value,
    sourceSnapshot: [{ path: BUNDLE_ENTRYPOINT, bytes }],
    props: options.props ?? { channel: "stable" },
  };
}

/**
 * The descriptor and snapshot one document's exact bytes produce.
 *
 * Derived rather than written beside them: the create and begin transitions
 * recompute every hash from the snapshot they are given, so a fixture naming
 * anything else retains nothing.
 */
export function* retainedSource(
  entrypoint: string,
  content: string,
): Operation<{
  definition: WorkflowDefinition;
  sourceSnapshot: readonly { path: string; bytes: Uint8Array }[];
}> {
  const bytes = new TextEncoder().encode(content);
  const sources = [
    {
      path: entrypoint,
      sourceHash: yield* sourceContentHash(bytes),
      byteLength: bytes.byteLength,
    },
  ];
  const parsed = parseSourceBundleDefinition({
    hashAlgorithm: "sha256",
    bundleHash: yield* sourceBundleHash({ entrypoint, sources }),
    entrypoint,
    sources,
  });
  if (!parsed.ok) {
    throw parsed.error;
  }
  return { definition: parsed.value, sourceSnapshot: [{ path: entrypoint, bytes }] };
}

/**
 * A creation over several retained sources, with a declared component mapping.
 *
 * The manifest is derived from the bytes and sorted canonically, so a fixture
 * says what it retains and the descriptor it gets is the one those bytes
 * really produce.
 */
export function* bundleCreationOver(
  entrypoint: string,
  files: readonly { readonly path: string; readonly content: string }[],
  components: readonly { readonly name: string; readonly path: string }[] = [],
): Operation<WorkflowRunCreation> {
  const encoder = new TextEncoder();
  const snapshot = files.map((file) => ({ path: file.path, bytes: encoder.encode(file.content) }));
  const sources: { path: string; sourceHash: string; byteLength: number }[] = [];
  for (const entry of snapshot) {
    sources.push({
      path: entry.path,
      sourceHash: yield* sourceContentHash(entry.bytes),
      byteLength: entry.bytes.byteLength,
    });
  }
  sources.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const mapping = [...components].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  const identity = {
    entrypoint,
    sources,
    ...(mapping.length === 0 ? {} : { components: mapping }),
  };
  const parsed = parseSourceBundleDefinition({
    hashAlgorithm: "sha256",
    bundleHash: yield* sourceBundleHash(identity),
    ...identity,
  });
  if (!parsed.ok) {
    throw parsed.error;
  }
  return {
    definition: parsed.value,
    sourceSnapshot: snapshot.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    ),
    props: { channel: "stable" },
  };
}

/**
 * One executor lock, held for the body and released with it.
 *
 * `withExecutorRun` begins an execution and raises a refusal; a case whose
 * subject *is* the refusal needs the lock without the begin, so it can look at
 * the answer rather than at an exception.
 */
export function withExecutor<T>(
  runId: string,
  body: (executorLock: ExecutorLock) => Operation<T>,
): Operation<T> {
  return scoped(function* () {
    const acquisition = yield* WorkflowLifecycle.operations.acquireExecutor(runId);
    if (!acquisition.ok) {
      throw acquisition.error;
    }
    if (acquisition.value.kind !== "acquired") {
      throw new Error(`the run ${runId} already has a live workflow executor`);
    }
    return yield* body(acquisition.value.lock);
  });
}

/**
 * One stored byte column, checked rather than coerced.
 *
 * A row is whatever SQLite handed back, so a column that is not bytes is a
 * failure about the row rather than a `TextDecoder` throwing somewhere else.
 */
export function storedBytes(row: Record<string, unknown> | undefined, column: string): Uint8Array {
  const value = row?.[column];
  if (!(value instanceof Uint8Array)) {
    throw new Error(`the row carries no ${column}`);
  }
  return value;
}

const DEATH_CHILD = fileURLToPath(new URL("./executor-death-child.ts", import.meta.url));
const REPOSITORY = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * Leave `runId` the way a workflow executor that died leaves it.
 *
 * A run durably `running`, one execution with no end, and an advisory lock the
 * kernel released rather than a host did. It takes a whole process because a
 * process is the only thing that can be lost: a scope that closes in this one
 * runs the executor hold's teardown, and that teardown settles the execution
 * the acquisition began. Ending a scope therefore proves the opposite of what
 * a dead executor leaves, which is why nothing here stands in for the child.
 */
export function* runLeftUnfinished(root: string, runId: string): Operation<void> {
  yield* scoped(function* () {
    const child = yield* exec(process.execPath, {
      arguments: ["run", "--allow-all", "--frozen", DEATH_CHILD, root, runId],
      cwd: REPOSITORY,
    });
    let announced = false;
    yield* spawn(function* () {
      const output = yield* child.stdout;
      let next = yield* output.next();
      while (!next.done) {
        if (new TextDecoder().decode(next.value).includes("READY")) {
          announced = true;
        }
        next = yield* output.next();
      }
    });
    // Killed rather than asked: this child exists to be lost, and a process
    // suspended on purpose has no other way to end.
    yield* ensure(function* () {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Already gone, which is the outcome this wanted.
      }
      yield* child.join();
    });
    yield* when(
      function* () {
        if (!announced) {
          throw new Error(`the executor child has not begun ${runId} yet`);
        }
      },
      { timeout: 30_000 },
    );
    process.kill(child.pid, "SIGKILL");
  });
}
