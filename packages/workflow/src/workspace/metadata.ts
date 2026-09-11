/**
 * Retained Repository and Worktree identity, as a mutation may reach it.
 *
 * These rows are immutable creation identity. Insertion adds one and never
 * mutates one; a reused name is answered by reading the row back and comparing
 * it. Where the rows live is the host's business — SQLite rows inside the Deno
 * transaction's savepoint, a detached invocation snapshot and staged deltas on
 * the runner — and the rules that decide whether a reused name is the same
 * repository are shared, so they are stated against this interface rather than
 * against either store.
 *
 * The locator is retained beside the record rather than inside it. Deciding
 * whether a reused name asks for the same repository needs the bytes; the
 * journal and the document need only the fingerprint, and a URL that turned out
 * to carry a credential is then one column rather than one history.
 */

import type { RepositoryRecord, WorktreeRecord } from "../composition/records.ts";

/** A Repository row: its journal-safe record, and the locator only storage sees. */
export interface StoredRepository {
  readonly record: RepositoryRecord;
  readonly locator: string;
}

export interface WorkspaceMetadata {
  readRepository(name: string): StoredRepository | undefined;
  readRepositories(): StoredRepository[];
  insertRepository(stored: StoredRepository): void;
  readWorktree(repositoryName: string, name: string): WorktreeRecord | undefined;
  readWorktreesForRepository(repositoryName: string): WorktreeRecord[];
  insertWorktree(record: WorktreeRecord): void;
}
