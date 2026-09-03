/**
 * One committed frontier, read whole, as values nothing live still owns.
 *
 * This is the other half of the artifact boundary. `writeXmdArtifact()` accepts
 * a complete detached snapshot and knows nothing about runs; this produces one
 * from a run and knows nothing about containers. Everything in between — the
 * executor lock, the recovery copy, where the file goes — belongs to the export
 * operation that calls both.
 *
 * ## Whole, not a prefix
 *
 * `readForkSource()` reads the prefix one checkpoint selects, because a fork
 * inherits history up to a point and writes its own beginning. An export
 * inherits nothing: it records what the run committed, so it reads every
 * journal row, every retained root, and every other XMD-owned record the run
 * holds. The two are deliberately separate readers over the same tables rather
 * than one reader with a mode, because "up to this checkpoint" and "everything"
 * differ in what they are allowed to leave out.
 *
 * ## Read, never repair
 *
 * Everything here is a `SELECT` on a connection the caller opened read-only.
 * Nothing settles a status, relabels a stop reason, replays an event, or
 * completes a half-written Workspace. A run whose host died mid-execution
 * exports as the `running` run it is — the artifact records what was committed,
 * and inventing a tidier frontier would be recording something that never
 * happened.
 */

import type { DatabaseSync } from "node:sqlite";
import { Err, Ok, type Result } from "effection";
import type { Json } from "@executablemd/durable-streams";
import type { WorkflowDefinition } from "../storage/definition.ts";
import type {
  DetachedXmdArtifact,
  XmdArtifactDefinitionClosure,
  XmdArtifactJournalRow,
} from "./artifact/types.ts";
import type { InheritedEventProvenance } from "../lifecycle/history.ts";
import { WorkflowRequestError } from "../storage/errors.ts";
import type { WorkflowRunRecord } from "../storage/record.ts";
import { readAllRetainedAnswers } from "./answers.ts";
import type { RetainedBlob, RetainedManifest } from "./fork-source.ts";
import { readForkLineage } from "./fork-write.ts";
import { readRepositories, readRetainedRows, readWorktrees } from "./fork-source.ts";
import { reading } from "./reading.ts";
import { readDocumentExecution, readRetrieval } from "../sqlite/rows.ts";
import { readAllAgentSessions } from "./workspace/agent-sessions.ts";
import { bytes, integer } from "./workspace/manifest.ts";
import {
  currentWorkspaceRoot,
  loadWorkspaceRoot,
  retainedWorkspaceRoots,
} from "./workspace/root.ts";

const SELECT_EXECUTIONS = "SELECT * FROM document_executions ORDER BY sequence ASC";

/**
 * The complete committed state of one run, as the artifact writer's input.
 *
 * `closure` is checked against the definition this frontier actually retains
 * before it is carried, so a caller cannot seal one run's evidence around
 * another run's Markdown. The writer checks the bytes hash to the identities
 * the definition names; what is checked here is that it is the right
 * definition at all.
 */
export function readExportFrontier(
  database: DatabaseSync,
  record: WorkflowRunRecord,
  path: string,
): Omit<DetachedXmdArtifact, "definition"> {
  const journal = readExportJournal(database);
  const roots = retainedWorkspaceRoots(database).map((rootId) =>
    loadWorkspaceRoot(database, rootId, path),
  );
  const manifestHashes = new Set(roots.flatMap((root) => root.manifestHashes));
  const blobHashes = new Set(roots.flatMap((root) => root.blobHashes));
  const lineage = readForkLineage(database);
  const last = journal.at(-1);

  return {
    frontier: {
      sourceRunId: record.runId,
      // Absent for a run that was created and never appended to. That is a
      // frontier too, and writing some other event's identity there would be
      // recording a boundary this run never reached.
      ...(last === undefined ? {} : { finalEventId: last.eventId }),
      currentWorkspaceRootId: currentWorkspaceRoot(database, path),
    },
    run: record,
    executions: reading(database, SELECT_EXECUTIONS).all().map(readDocumentExecution),
    ...(lineage === undefined
      ? {}
      : {
          lineage: {
            ...lineage,
            createdAt: readLineageCreatedAt(database, path),
          },
        }),
    journal,
    roots,
    manifests: [...manifestHashes].map((hash) => readManifest(database, hash, path)),
    blobs: [...blobHashes].map((hash) => readBlob(database, hash, path)),
    repositories: readRepositories(database, path),
    worktrees: readWorktrees(database, path),
    answers: readAllRetainedAnswers(database),
    agentSessions: readAllAgentSessions(database),
  };
}

/** Where this host could fetch the definition from, as the run last recorded it. */
export function readRetrievalMetadata(database: DatabaseSync): Json | undefined {
  // The whole row: retrieval is parsed as the record it is — metadata, the
  // revision that counts replacements, and when it was last written — and a
  // projection of one column would hand that parser two members it cannot find.
  const row = reading(database, "SELECT * FROM definition_retrieval WHERE id = 1").get();
  if (row === undefined) {
    return undefined;
  }
  return readRetrieval(row).metadata;
}

/**
 * Whether a fetched closure is this run's, as a refusal or nothing.
 *
 * The identities are compared, not the bytes: whether the Markdown hashes to
 * what the definition names is the artifact writer's question, and asking it
 * twice in two places would be two answers to keep in agreement. What this
 * catches is the closure belonging to a different definition entirely, which
 * no amount of hashing downstream would notice.
 */
export function matchesRetainedDefinition(
  definition: WorkflowDefinition,
  closure: XmdArtifactDefinitionClosure,
): Result<void> {
  const root = closure.root;
  if (
    root.objectFormat !== definition.objectFormat ||
    root.pinnedCommit !== definition.objectId ||
    root.rootDocumentPath !== definition.rootDocumentPath ||
    root.targetPath !== definition.targetPath
  ) {
    return Err(
      new WorkflowRequestError(
        "the definition source this host read back does not describe the definition the run " +
          "retains, so it is not this run's source.",
      ),
    );
  }
  return Ok();
}

function readLineageCreatedAt(database: DatabaseSync, path: string): string {
  const row = reading(database, "SELECT created_at FROM workflow_fork_lineage WHERE id = 1").get();
  const createdAt = row?.["created_at"];
  if (typeof createdAt !== "string") {
    throw new WorkflowRequestError(
      `the fork lineage retained at ${path} does not say when it was created.`,
    );
  }
  return createdAt;
}

function readManifest(database: DatabaseSync, hash: string, path: string): RetainedManifest {
  const row = reading(
    database,
    "SELECT hash, size, encoded, last_seen FROM vfs_manifests WHERE hex(hash) = upper(?)",
  ).get(hash);
  if (row === undefined) {
    throw new WorkflowRequestError(
      "this run names Workspace content it no longer holds, so its frontier cannot be sealed.",
    );
  }
  return Object.freeze({
    hash: bytes(row["hash"], path, "DOFS manifest identity"),
    size: integer(row["size"], path, "DOFS manifest size"),
    encoded: bytes(row["encoded"], path, "DOFS manifest content"),
    lastSeen: integer(row["last_seen"], path, "DOFS manifest watermark"),
  });
}

function readBlob(database: DatabaseSync, hash: string, path: string): RetainedBlob {
  const row = reading(
    database,
    `SELECT blob.hash AS hash, blob.size AS size, blob.last_seen AS last_seen,
            content.bytes AS bytes
       FROM vfs_blobs AS blob
       JOIN vfs_blob_bytes AS content ON content.hash = blob.hash
      WHERE hex(blob.hash) = upper(?)`,
  ).get(hash);
  if (row === undefined) {
    throw new WorkflowRequestError(
      "this run names Workspace content it no longer holds, so its frontier cannot be sealed.",
    );
  }
  return Object.freeze({
    hash: bytes(row["hash"], path, "DOFS blob identity"),
    size: integer(row["size"], path, "DOFS blob size"),
    lastSeen: integer(row["last_seen"], path, "DOFS blob watermark"),
    content: bytes(row["bytes"], path, "DOFS blob content"),
  });
}

/**
 * Every journal row, carrying the provenance a fork left on the ones it copied.
 *
 * Two reads rather than a join, because the tables answer different questions:
 * one says what this run's history *is*, and the other says which of it came
 * from somewhere else. A row with no provenance row is one this run wrote, and
 * that absence is the record — so it is represented by leaving the member off
 * rather than by writing an empty one.
 */
function readExportJournal(database: DatabaseSync): XmdArtifactJournalRow[] {
  const inherited = new Map<string, InheritedEventProvenance>();
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
        "this run retains an inherited-event provenance row that does not describe one, so its " +
          "history cannot be sealed.",
      );
    }
    inherited.set(eventId, Object.freeze({ sourceRunId, sourceEventId }));
  }

  return readRetainedRows(database).map((row) => {
    const provenance = inherited.get(row.eventId);
    return provenance === undefined ? row : { ...row, inherited: provenance };
  });
}
