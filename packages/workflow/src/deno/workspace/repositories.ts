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

import { WorkflowRecordMalformedError } from "../../storage/errors.ts";
import {
  parseCheckoutPath,
  parseFingerprint,
  parseObjectFormat,
  type GitObjectFormat,
  type RepositoryRecord,
  type WorktreeRecord,
} from "../../composition/records.ts";
import type {
  WorkflowWorkspaceReadStorage,
  WorkflowWorkspaceRow,
  WorkflowWorkspaceStorage,
} from "./storage.ts";

/** A Repository row: its journal-safe record, and the locator only storage sees. */
export interface StoredRepository {
  readonly record: RepositoryRecord;
  readonly locator: string;
}

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

function text(row: WorkflowWorkspaceRow, column: string, table: string): string {
  const value = row[column];
  if (typeof value !== "string" || value === "") {
    return malformed(table, column, "expected a non-empty text value");
  }
  return value;
}

function optionalText(row: WorkflowWorkspaceRow, column: string, table: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string" || value === "") {
    return malformed(table, column, "expected a non-empty text value or null");
  }
  return value;
}

function objectFormat(row: WorkflowWorkspaceRow, column: string, table: string): GitObjectFormat {
  const value = parseObjectFormat(row[column]);
  if (value === undefined) {
    return malformed(table, column, `expected "sha1" or "sha256"`);
  }
  return value;
}

function fingerprint(row: WorkflowWorkspaceRow, column: string, table: string): string {
  const value = parseFingerprint(row[column]);
  if (value === undefined) {
    return malformed(table, column, "expected a 64-character lowercase hex fingerprint");
  }
  return value;
}

function checkoutPath(row: WorkflowWorkspaceRow, column: string, table: string): string {
  const value = parseCheckoutPath(row[column]);
  if (value === undefined) {
    return malformed(table, column, "expected a Workspace-relative path beginning with /");
  }
  return value;
}

function readRepositoryRow(row: WorkflowWorkspaceRow): StoredRepository {
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

function readWorktreeRow(row: WorkflowWorkspaceRow): WorktreeRecord {
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

export function readRepository(
  storage: WorkflowWorkspaceReadStorage,
  name: string,
): StoredRepository | undefined {
  const row = storage.get(SELECT_REPOSITORY, name);
  return row === undefined ? undefined : readRepositoryRow(row);
}

export function readRepositories(storage: WorkflowWorkspaceReadStorage): StoredRepository[] {
  return storage.all(SELECT_REPOSITORIES).map((row) => readRepositoryRow(row));
}

export function insertRepository(
  storage: WorkflowWorkspaceStorage,
  stored: StoredRepository,
): void {
  const { record } = stored;
  storage.run(
    INSERT_REPOSITORY,
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
  storage: WorkflowWorkspaceReadStorage,
  repositoryName: string,
  name: string,
): WorktreeRecord | undefined {
  const row = storage.get(SELECT_WORKTREE, repositoryName, name);
  return row === undefined ? undefined : readWorktreeRow(row);
}

export function readWorktreesForRepository(
  storage: WorkflowWorkspaceReadStorage,
  repositoryName: string,
): WorktreeRecord[] {
  return storage.all(SELECT_WORKTREES, repositoryName).map((row) => readWorktreeRow(row));
}

export function insertWorktree(storage: WorkflowWorkspaceStorage, record: WorktreeRecord): void {
  storage.run(
    INSERT_WORKTREE,
    record.repositoryName,
    record.name,
    record.requestedBranch,
    record.requestedBase,
    record.creationCommit,
    record.checkoutPath,
  );
}

/**
 * The metadata one Workspace transaction may read and write.
 *
 * Handed to a mutation beside the filesystem, so retained Git identity and
 * retained Git bytes move together inside one transaction. It is the provider's
 * surface and not a document's: a component reaches it only by asking the
 * composition provider to perform an effect.
 */
export interface WorkspaceMetadataReads {
  readRepository(name: string): StoredRepository | undefined;
  readRepositories(): StoredRepository[];
  readWorktree(repositoryName: string, name: string): WorktreeRecord | undefined;
  readWorktreesForRepository(repositoryName: string): WorktreeRecord[];
}

export interface WorkspaceMetadata extends WorkspaceMetadataReads {
  insertRepository(stored: StoredRepository): void;
  insertWorktree(record: WorktreeRecord): void;
}

/**
 * These tables, read through a storage view that may only read.
 *
 * What attachment and export need, and the whole of it. Selecting a checkout
 * and proving a record still describes one are questions about rows that
 * already exist; neither writes, and neither is inside an effect that could
 * publish a row if it did.
 */
export function readWorkspaceMetadata(
  storage: WorkflowWorkspaceReadStorage,
): WorkspaceMetadataReads {
  return {
    readRepository: (name) => readRepository(storage, name),
    readRepositories: () => readRepositories(storage),
    readWorktree: (repositoryName, name) => readWorktree(storage, repositoryName, name),
    readWorktreesForRepository: (repositoryName) =>
      readWorktreesForRepository(storage, repositoryName),
  };
}

/**
 * These tables, read and written through one Workspace transaction's storage.
 *
 * The view is the whole of what this needs: the lease, the transaction, the
 * savepoint and the journal are already around every call it makes, so what is
 * left here is the SQL for these two tables and the parsers for their columns.
 */
export function createWorkspaceMetadata(storage: WorkflowWorkspaceStorage): WorkspaceMetadata {
  return {
    ...readWorkspaceMetadata(storage),
    insertRepository: (stored) => insertRepository(storage, stored),
    insertWorktree: (record) => insertWorktree(storage, record),
  };
}
