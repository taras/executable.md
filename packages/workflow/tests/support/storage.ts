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
import { ensure, type Operation, resource, scoped } from "effection";
import { rm } from "@effectionx/fs";
import {
  type CreateWorkflowRunRequest,
  type GitWorkflowDefinitionV1,
  parseWorkflowDefinition,
  type WorkflowRunDatabase,
  WorkflowRunStorage,
} from "../../mod.ts";
import { useWorkflowRunStorage, workflowRunPath } from "../../deno.ts";

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

/** Run `body` with this host's storage installed for its scope only. */
export function withStorage<T>(root: string, body: () => Operation<T>): Operation<T> {
  return scoped(function* () {
    yield* useWorkflowRunStorage({ root });
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
