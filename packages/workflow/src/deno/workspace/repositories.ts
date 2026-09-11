/**
 * Reading and writing Repository and Worktree rows.
 *
 * These rows are immutable creation identity. `insertRepository()` and
 * `insertWorktree()` add one row and never mutate one; a reused name is
 * answered by reading the row back and comparing it, not by rewriting it.
 * Mutable HEAD, refs, index, checkout and linked-worktree administration live
 * inside the Workspace filesystem, and a later Git operation moves them by
 * publishing a new Workspace root rather than by touching anything here.
 *
 * The locator is retained beside the record rather than inside it. Deciding
 * whether a reused name asks for the same repository needs the bytes; the
 * journal and the document need only the fingerprint, and a URL that turned out
 * to carry a credential is then one column rather than one history.
 *
 * Every stored value is parsed on read. A row carrying an unexpected shape is
 * damage to a version-1 database rather than a partial state a repair could
 * recover, and it is reported through the same channel schema recognition uses.
 */

import type { DatabaseSync } from "node:sqlite";
import { WorkflowRecordMalformedError } from "../../storage/errors.ts";
import {
  parseCheckoutPath,
  parseFingerprint,
  parseObjectFormat,
  type GitObjectFormat,
  type RepositoryRecord,
  type WorktreeRecord,
} from "../../composition/records.ts";
import { reading } from "../reading.ts";
import type { StoredRepository, WorkspaceMetadata } from "../../workspace/metadata.ts";

export type { StoredRepository, WorkspaceMetadata } from "../../workspace/metadata.ts";

const REPOSITORY_COLUMNS = `name, locator, locator_fingerprint, requested_base,
    creation_commit, primary_branch, object_format, checkout_path`;

const WORKTREE_COLUMNS = `repository_name, name, requested_branch, requested_base,
    creation_commit, checkout_path`;

const SELECT_REPOSITORY = `SELECT ${REPOSITORY_COLUMNS} FROM workspace_repositories WHERE name = ?`;

const SELECT_REPOSITORIES = `SELECT ${REPOSITORY_COLUMNS} FROM workspace_repositories ORDER BY name`;

const INSERT_REPOSITORY = `INSERT INTO workspace_repositories (${REPOSITORY_COLUMNS})
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

const SELECT_WORKTREE = `SELECT ${WORKTREE_COLUMNS}
  FROM workspace_worktrees WHERE repository_name = ? AND name = ?`;

const SELECT_WORKTREES = `SELECT ${WORKTREE_COLUMNS}
  FROM workspace_worktrees WHERE repository_name = ? ORDER BY name`;

const INSERT_WORKTREE = `INSERT INTO workspace_worktrees (${WORKTREE_COLUMNS})
  VALUES (?, ?, ?, ?, ?, ?)`;

function malformed(table: string, column: string, expectation: string): never {
  throw new WorkflowRecordMalformedError(`${table}.${column}`, expectation);
}

function text(row: Record<string, unknown>, column: string, table: string): string {
  const value = row[column];
  if (typeof value !== "string" || value === "") {
    return malformed(table, column, "expected a non-empty text value");
  }
  return value;
}

function optionalText(row: Record<string, unknown>, column: string, table: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string" || value === "") {
    return malformed(table, column, "expected a non-empty text value or null");
  }
  return value;
}

function objectFormat(
  row: Record<string, unknown>,
  column: string,
  table: string,
): GitObjectFormat {
  const value = parseObjectFormat(row[column]);
  if (value === undefined) {
    return malformed(table, column, `expected "sha1" or "sha256"`);
  }
  return value;
}

function fingerprint(row: Record<string, unknown>, column: string, table: string): string {
  const value = parseFingerprint(row[column]);
  if (value === undefined) {
    return malformed(table, column, "expected a 64-character lowercase hex fingerprint");
  }
  return value;
}

function checkoutPath(row: Record<string, unknown>, column: string, table: string): string {
  const value = parseCheckoutPath(row[column]);
  if (value === undefined) {
    return malformed(table, column, "expected a Workspace-relative path beginning with /");
  }
  return value;
}

function readRepositoryRow(row: Record<string, unknown>): StoredRepository {
  const table = "workspace_repositories";
  return Object.freeze({
    locator: text(row, "locator", table),
    record: Object.freeze({
      name: text(row, "name", table),
      locatorFingerprint: fingerprint(row, "locator_fingerprint", table),
      requestedBase: optionalText(row, "requested_base", table),
      creationCommit: text(row, "creation_commit", table),
      primaryBranch: text(row, "primary_branch", table),
      objectFormat: objectFormat(row, "object_format", table),
      checkoutPath: checkoutPath(row, "checkout_path", table),
    }),
  });
}

function readWorktreeRow(row: Record<string, unknown>): WorktreeRecord {
  const table = "workspace_worktrees";
  return Object.freeze({
    repositoryName: text(row, "repository_name", table),
    name: text(row, "name", table),
    requestedBranch: text(row, "requested_branch", table),
    requestedBase: optionalText(row, "requested_base", table),
    creationCommit: text(row, "creation_commit", table),
    checkoutPath: checkoutPath(row, "checkout_path", table),
  });
}

export function readRepository(database: DatabaseSync, name: string): StoredRepository | undefined {
  const row = reading(database, SELECT_REPOSITORY).get(name);
  return row === undefined ? undefined : readRepositoryRow(row);
}

export function readRepositories(database: DatabaseSync): StoredRepository[] {
  return reading(database, SELECT_REPOSITORIES)
    .all()
    .map((row) => readRepositoryRow(row));
}

export function insertRepository(database: DatabaseSync, stored: StoredRepository): void {
  const { record } = stored;
  database
    .prepare(INSERT_REPOSITORY)
    .run(
      record.name,
      stored.locator,
      record.locatorFingerprint,
      record.requestedBase,
      record.creationCommit,
      record.primaryBranch,
      record.objectFormat,
      record.checkoutPath,
    );
}

export function readWorktree(
  database: DatabaseSync,
  repositoryName: string,
  name: string,
): WorktreeRecord | undefined {
  const row = reading(database, SELECT_WORKTREE).get(repositoryName, name);
  return row === undefined ? undefined : readWorktreeRow(row);
}

export function readWorktreesForRepository(
  database: DatabaseSync,
  repositoryName: string,
): WorktreeRecord[] {
  return reading(database, SELECT_WORKTREES)
    .all(repositoryName)
    .map((row) => readWorktreeRow(row));
}

export function insertWorktree(database: DatabaseSync, record: WorktreeRecord): void {
  database
    .prepare(INSERT_WORKTREE)
    .run(
      record.repositoryName,
      record.name,
      record.requestedBranch,
      record.requestedBase,
      record.creationCommit,
      record.checkoutPath,
    );
}

export function createWorkspaceMetadata(
  database: DatabaseSync,
  authorize: () => void,
): WorkspaceMetadata {
  function guarded<T>(read: () => T): T {
    authorize();
    return read();
  }

  return {
    readRepository: (name) => guarded(() => readRepository(database, name)),
    readRepositories: () => guarded(() => readRepositories(database)),
    insertRepository: (stored) => guarded(() => insertRepository(database, stored)),
    readWorktree: (repositoryName, name) =>
      guarded(() => readWorktree(database, repositoryName, name)),
    readWorktreesForRepository: (repositoryName) =>
      guarded(() => readWorktreesForRepository(database, repositoryName)),
    insertWorktree: (record) => guarded(() => insertWorktree(database, record)),
  };
}
