/**
 * Planting one source's committed prefix in a destination this owner holds.
 *
 * A fork arrives in two stages because a source is larger than one message may
 * be. First the runner offers its parts — the roots, the inherited rows, the
 * checkouts, and the content those roots name — and each part is scratch that
 * belongs to the offering connection and describes nothing. Then one command
 * commits them: the destination's schema, its immutable identity, the whole
 * copied prefix, its Workspace closure, its lineage and its first execution all
 * appear together, or the destination holds nothing at all.
 *
 * Nothing here trusts the parts for being staged. A staged root is held to its
 * own manifest, its reference arrays are derived rather than believed, every
 * piece of content it names must have been offered, and every inherited row
 * must belong to a root that came with it. Staging is a way to cross, not a way
 * to be believed.
 */

import {
  type DurableEvent,
  parseDurableEvent,
  serializeDurableEvent,
} from "@executablemd/durable-streams";
import {
  compareUtf8,
  parseWorkspaceRootManifest,
  WORKSPACE_ROOT_DOMAIN,
  WORKSPACE_ROOT_FORMAT,
} from "../workspace/root-manifest.ts";
import { decodeContentManifest } from "../workspace/content-manifest.ts";
import { sha256Hex } from "../workspace/sha256.ts";
import { bytesOf } from "./encoding.ts";
import type { CreateWorkflowRunRequest } from "../storage/api.ts";
import {
  CommandError,
  type ForkCounts,
  type ForkOrigin,
  type ForkPart,
  type ForkSection,
} from "./commands.ts";
import type { OwnerStorage } from "./storage.ts";
import type { OwnerTransaction } from "./owner-transaction.ts";
import { establishRun } from "./owner-open.ts";
import { readFrontier, validateRetainedRoot, type FrontierValue } from "./owner-reads.ts";
import { FORK_TABLE, holdExecution, STAGING_TABLE } from "./private-schema.ts";
import { readDocumentExecution, readRunRecord, type Row } from "../sqlite/rows.ts";
import type { DocumentExecutionRecord } from "../storage/record.ts";

/** What one committed fork produced. */
export interface ForkedValue {
  readonly frontier: FrontierValue;
  readonly execution: DocumentExecutionRecord;
}

/** A fork answer: the destination, or which immutable fields say it is another. */
export interface ForkValue {
  readonly conflict: readonly string[] | null;
  readonly value: ForkedValue | null;
}

const MAX_PART_BYTES = 256 * 1024;
const MAX_PARTS = 8192;

function rows(storage: OwnerStorage, sql: string, ...bindings: unknown[]): Row[] {
  return storage.sql.exec(sql, ...bindings).toArray();
}

function text(value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw new CommandError("malformed-member");
  }
  return value;
}

function digest(value: unknown): string {
  const candidate = text(value);
  if (!/^[0-9a-f]{64}$/.test(candidate)) {
    throw new CommandError("malformed-member");
  }
  return candidate;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CommandError("malformed-member");
  }
  return value;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new CommandError("malformed-member");
  }
  return value;
}

function members(value: unknown, names: readonly string[]): Map<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CommandError("malformed-member");
  }
  const found = new Map(Object.entries(value));
  if (found.size !== names.length || names.some((name) => !found.has(name))) {
    throw new CommandError("unknown-member");
  }
  return found;
}

/**
 * Keep one offered part, bounded and in its place.
 *
 * Offering the same position twice is a conflict rather than a replacement: a
 * transfer that rewrote its own members would be one nobody could describe.
 */
export function stageForkPart(
  storage: OwnerStorage,
  acquisitionId: string,
  part: ForkPart,
): { staged: number } {
  const encoded = JSON.stringify(part.part);
  const size = new TextEncoder().encode(encoded).length;
  if (size > MAX_PART_BYTES) {
    throw new CommandError("too-large");
  }
  const held = rows(
    storage,
    `SELECT count(*) AS parts FROM ${FORK_TABLE} WHERE acquisition_id = ?`,
    acquisitionId,
  )[0];
  if (count(held?.["parts"]) >= MAX_PARTS) {
    throw new CommandError("capacity");
  }
  const already = rows(
    storage,
    `SELECT part FROM ${FORK_TABLE}
      WHERE acquisition_id = ? AND section = ? AND position = ?`,
    acquisitionId,
    part.section,
    part.position,
  )[0];
  if (already !== undefined) {
    if (already["part"] !== encoded) {
      throw new CommandError("duplicate-conflict");
    }
    return { staged: count(held?.["parts"]) };
  }
  storage.sql.exec(
    `INSERT INTO ${FORK_TABLE} (acquisition_id, section, position, part, part_bytes)
      VALUES (?, ?, ?, ?, ?)`,
    acquisitionId,
    part.section,
    part.position,
    encoded,
    size,
  );
  return { staged: count(held?.["parts"]) + 1 };
}

/** Every part of one section, in the order it was offered, with no gaps. */
function section(
  storage: OwnerStorage,
  acquisitionId: string,
  name: ForkSection,
  expected: number,
): Record<string, unknown>[] {
  const held = rows(
    storage,
    `SELECT position, part FROM ${FORK_TABLE}
      WHERE acquisition_id = ? AND section = ? ORDER BY position`,
    acquisitionId,
    name,
  );
  if (held.length !== expected) {
    throw new CommandError("malformed-member");
  }
  return held.map((row, at) => {
    if (count(row["position"]) !== at) {
      // A gap, so the section is not the one the counts describe.
      throw new CommandError("malformed-member");
    }
    const parsed: unknown = JSON.parse(text(row["part"]));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CommandError("malformed-member");
    }
    return Object.fromEntries(Object.entries(parsed));
  });
}

/** Content this acquisition offered, by the identity its bytes produce. */
function staged(
  storage: OwnerStorage,
  acquisitionId: string,
  kind: "manifest" | "blob",
  hash: string,
): Uint8Array {
  const row = rows(
    storage,
    `SELECT bytes FROM ${STAGING_TABLE} WHERE acquisition_id = ? AND kind = ? AND digest = ?`,
    acquisitionId,
    kind,
    hash,
  )[0];
  if (row === undefined) {
    // Named by a root but never offered: the transfer is not the closure it
    // claims to be.
    throw new CommandError("malformed-member");
  }
  const bytes = bytesOf(row["bytes"]);
  if (sha256Hex(bytes) !== hash) {
    throw new CommandError("malformed-member");
  }
  return bytes;
}

interface StagedRoot {
  readonly rootId: string;
  readonly manifest: string;
  readonly manifestHashes: readonly string[];
  readonly blobHashes: readonly string[];
}

function parseRoot(part: Record<string, unknown>): StagedRoot {
  const found = members(part, [
    "rootId",
    "formatVersion",
    "manifest",
    "manifestHashes",
    "blobHashes",
  ]);
  if (found.get("formatVersion") !== WORKSPACE_ROOT_FORMAT) {
    throw new CommandError("malformed-member");
  }
  const manifest = text(found.get("manifest"));
  const rootId = digest(found.get("rootId"));
  if (sha256Hex(`${WORKSPACE_ROOT_DOMAIN}${manifest}`) !== rootId) {
    throw new CommandError("malformed-member");
  }
  return {
    rootId,
    manifest,
    manifestHashes: list(found.get("manifestHashes")).map((value) => digest(value)),
    blobHashes: list(found.get("blobHashes")).map((value) => digest(value)),
  };
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, at) => value === right[at]);
}

/**
 * Retain one root's content and the root itself, proving the closure as it goes.
 *
 * The reference arrays are derived from the root's own manifest and compared
 * element for element, which is the same comparison a destination makes when it
 * reads the root back. A root whose arrays are the right set in the wrong order
 * is refused here rather than becoming unreadable later.
 */
function retainRoot(storage: OwnerStorage, acquisitionId: string, root: StagedRoot): void {
  const parsed = parseWorkspaceRootManifest(root.manifest, () => {
    throw new CommandError("malformed-member");
  });
  const named = new Set<string>();
  const sizes = new Map<string, number>();
  for (const entry of parsed.entries) {
    if (entry.kind === "file") {
      named.add(entry.manifest);
      const already = sizes.get(entry.manifest);
      if (already !== undefined && already !== entry.size) {
        throw new CommandError("malformed-member");
      }
      sizes.set(entry.manifest, entry.size);
    }
  }
  const blobs = new Map<string, number>();
  const manifests = new Map<string, Uint8Array>();
  for (const hash of named) {
    const bytes = staged(storage, acquisitionId, "manifest", hash);
    const content = decodeContentManifest(bytes, () => {
      throw new CommandError("malformed-member");
    });
    if (sizes.get(hash) !== content.size) {
      throw new CommandError("malformed-member");
    }
    manifests.set(hash, bytes);
    for (const chunk of content.chunks) {
      const seen = blobs.get(chunk.hash);
      if (seen !== undefined && seen !== chunk.size) {
        throw new CommandError("malformed-member");
      }
      blobs.set(chunk.hash, chunk.size);
    }
  }
  if (
    !sameOrder([...named].toSorted(compareUtf8), root.manifestHashes) ||
    !sameOrder([...blobs.keys()].toSorted(compareUtf8), root.blobHashes)
  ) {
    throw new CommandError("malformed-member");
  }

  for (const [hash, size] of blobs) {
    const bytes = staged(storage, acquisitionId, "blob", hash);
    if (bytes.length !== size) {
      throw new CommandError("malformed-member");
    }
    const key = hexBytes(hash);
    storage.sql.exec(
      "INSERT INTO vfs_blobs (hash, size, last_seen) VALUES (?, ?, 0) ON CONFLICT(hash) DO NOTHING",
      key,
      size,
    );
    storage.sql.exec(
      "INSERT INTO vfs_blob_bytes (hash, bytes) VALUES (?, ?) ON CONFLICT(hash) DO NOTHING",
      key,
      bytes,
    );
  }
  for (const [hash, bytes] of manifests) {
    storage.sql.exec(
      `INSERT INTO vfs_manifests (hash, size, encoded, last_seen) VALUES (?, ?, ?, 0)
        ON CONFLICT(hash) DO NOTHING`,
      hexBytes(hash),
      decodeContentManifest(bytes, () => {
        throw new CommandError("malformed-member");
      }).size,
      bytes,
    );
  }

  const existing = rows(
    storage,
    "SELECT manifest FROM workspace_roots WHERE root_id = ?",
    root.rootId,
  )[0];
  if (existing === undefined) {
    storage.sql.exec(
      "INSERT INTO workspace_roots (root_id, format_version, manifest) VALUES (?, ?, ?)",
      root.rootId,
      WORKSPACE_ROOT_FORMAT,
      root.manifest,
    );
    for (const hash of root.manifestHashes) {
      storage.sql.exec(
        "INSERT INTO workspace_root_manifest_refs (root_id, manifest_hash) VALUES (?, ?)",
        root.rootId,
        hexBytes(hash),
      );
    }
    for (const hash of root.blobHashes) {
      storage.sql.exec(
        "INSERT INTO workspace_root_blob_refs (root_id, blob_hash) VALUES (?, ?)",
        root.rootId,
        hexBytes(hash),
      );
    }
  } else if (existing["manifest"] !== root.manifest) {
    throw new CommandError("duplicate-conflict");
  }
  validateRetainedRoot(storage, root.rootId);
}

function hexBytes(digestHex: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let at = 0; at < 32; at += 1) {
    bytes[at] = Number.parseInt(digestHex.slice(at * 2, at * 2 + 2), 16);
  }
  return bytes;
}

/** One inherited row, exactly as the source retained it. */
function writeInherited(
  storage: OwnerStorage,
  part: Record<string, unknown>,
  sourceRunId: string,
  carried: ReadonlySet<string>,
): void {
  const found = members(part, ["eventId", "record", "workspaceRootId"]);
  const eventId = text(found.get("eventId"));
  const record = text(found.get("record"));
  const rootId = digest(found.get("workspaceRootId"));
  if (!carried.has(rootId)) {
    throw new CommandError("malformed-member");
  }
  const parsed = parseDurableEvent(record);
  if (!parsed.ok) {
    throw new CommandError("corrupt-journal");
  }
  storage.sql.exec(
    "INSERT INTO journal_events (event_id, record, workspace_root_id) VALUES (?, ?, ?)",
    eventId,
    record,
    rootId,
  );
  storage.sql.exec(
    `INSERT INTO journal_event_provenance (event_id, source_run_id, source_event_id)
      VALUES (?, ?, ?)`,
    eventId,
    sourceRunId,
    eventId,
  );
}

/** One inherited checkout, in the directory the checkpoint's Workspace holds. */
function writeCheckout(
  storage: OwnerStorage,
  part: Record<string, unknown>,
  directories: ReadonlySet<string>,
  repositories: Set<string>,
): void {
  const kind = part["kind"];
  if (kind === "repository") {
    const found = members(part, [
      "kind",
      "name",
      "locator",
      "locatorFingerprint",
      "requestedBase",
      "creationCommit",
      "primaryBranch",
      "objectFormat",
      "checkoutPath",
    ]);
    const path = text(found.get("checkoutPath"));
    if (!directories.has(path)) {
      throw new CommandError("malformed-member");
    }
    const format = found.get("objectFormat");
    if (format !== "sha1" && format !== "sha256") {
      throw new CommandError("malformed-member");
    }
    const name = text(found.get("name"));
    storage.sql.exec(
      `INSERT INTO workspace_repositories (name, locator, locator_fingerprint, requested_base,
         creation_commit, primary_branch, object_format, checkout_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      name,
      text(found.get("locator")),
      digest(found.get("locatorFingerprint")),
      found.get("requestedBase") === null ? null : text(found.get("requestedBase")),
      text(found.get("creationCommit")),
      text(found.get("primaryBranch")),
      format,
      path,
    );
    repositories.add(name);
    return;
  }
  const found = members(part, [
    "kind",
    "repositoryName",
    "name",
    "requestedBranch",
    "requestedBase",
    "creationCommit",
    "checkoutPath",
  ]);
  if (kind !== "worktree") {
    throw new CommandError("malformed-member");
  }
  const path = text(found.get("checkoutPath"));
  if (!directories.has(path)) {
    throw new CommandError("malformed-member");
  }
  const repository = text(found.get("repositoryName"));
  if (!repositories.has(repository)) {
    // A Worktree of a Repository that did not come with it belongs to nothing.
    throw new CommandError("malformed-member");
  }
  storage.sql.exec(
    `INSERT INTO workspace_worktrees (repository_name, name, requested_branch, requested_base,
       creation_commit, checkout_path)
     VALUES (?, ?, ?, ?, ?, ?)`,
    repository,
    text(found.get("name")),
    text(found.get("requestedBranch")),
    found.get("requestedBase") === null ? null : text(found.get("requestedBase")),
    text(found.get("creationCommit")),
    path,
  );
}

/**
 * Commit one fork: the destination and everything it inherited, together.
 *
 * Runs inside the caller's transaction. What it writes is what the schema's own
 * references require, in that order: content, then the roots that name it, then
 * the Workspace pointer those roots are restored into, then the checkouts, then
 * the journal rows that name the roots, then the lineage, and last the fork's
 * own first execution. A failure anywhere rolls the whole thing back, so the
 * destination is either absent or complete.
 */
export function commitFork(
  storage: OwnerStorage,
  transaction: OwnerTransaction,
  acquisitionId: string,
  input: {
    readonly runId: string;
    readonly creation: CreateWorkflowRunRequest;
    readonly origin: ForkOrigin;
    readonly counts: ForkCounts;
    readonly runRecord: DurableEvent;
    readonly rootImport: DurableEvent;
    readonly executionId: string;
  },
  mintEventId: () => string,
  now: () => string,
): ForkValue {
  // Whether this destination already holds a run decides what committing
  // means: making one, or confirming the one that is here is this fork.
  const fresh =
    rows(storage, "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'workflow_run'")
      .length === 0;
  const conflict = establishRun(storage, transaction, input.runId, input.creation, now);
  if (conflict !== null) {
    return { conflict, value: null };
  }
  if (!fresh) {
    // A destination that already exists is the same fork only when it came
    // from the same place. Its identity was compared above; this is its
    // lineage.
    const lineage = rows(
      storage,
      `SELECT source_run_id, checkpoint_event_id, checkpoint_workspace_root_id
         FROM workflow_fork_lineage WHERE id = 1`,
    )[0];
    if (
      lineage === undefined ||
      lineage["source_run_id"] !== input.origin.sourceRunId ||
      lineage["checkpoint_event_id"] !== input.origin.checkpointEventId ||
      lineage["checkpoint_workspace_root_id"] !== input.origin.checkpointWorkspaceRootId
    ) {
      return { conflict: ["lineage"], value: null };
    }
    return { conflict: null, value: begunOn(storage, acquisitionId, input, now) };
  }

  const roots = section(storage, acquisitionId, "roots", input.counts.roots).map((part) =>
    parseRoot(part),
  );
  const carried = new Set(roots.map((root) => root.rootId));
  for (const rootId of [
    input.origin.checkpointWorkspaceRootId,
    input.origin.runRecordWorkspaceRootId,
    input.origin.rootImportWorkspaceRootId,
  ]) {
    if (!carried.has(rootId)) {
      throw new CommandError("malformed-member");
    }
  }
  for (const root of roots) {
    retainRoot(storage, acquisitionId, root);
  }

  const checkpoint = roots.find((root) => root.rootId === input.origin.checkpointWorkspaceRootId);
  if (checkpoint === undefined) {
    throw new CommandError("malformed-member");
  }
  const directories = new Set<string>();
  for (const entry of parseWorkspaceRootManifest(checkpoint.manifest, () => {
    throw new CommandError("malformed-member");
  }).entries) {
    if (entry.kind === "directory") {
      directories.add(entry.path);
    }
  }
  // The fork's live Workspace is the checkpoint's, named before a single
  // journal row names a root.
  storage.sql.exec(
    "UPDATE workspace_state SET current_root_id = ? WHERE singleton_id = 1",
    input.origin.checkpointWorkspaceRootId,
  );

  const repositories = new Set<string>();
  for (const part of section(storage, acquisitionId, "checkouts", input.counts.checkouts)) {
    writeCheckout(storage, part, directories, repositories);
  }

  // The two records the fork writes for itself stand where the source's stood,
  // against the same roots, under identities of this run's own.
  storage.sql.exec(
    "INSERT INTO journal_events (event_id, record, workspace_root_id) VALUES (?, ?, ?)",
    mintEventId(),
    serializeDurableEvent(input.runRecord),
    input.origin.runRecordWorkspaceRootId,
  );
  storage.sql.exec(
    "INSERT INTO journal_events (event_id, record, workspace_root_id) VALUES (?, ?, ?)",
    mintEventId(),
    serializeDurableEvent(input.rootImport),
    input.origin.rootImportWorkspaceRootId,
  );
  for (const part of section(storage, acquisitionId, "inherited", input.counts.inherited)) {
    writeInherited(storage, part, input.origin.sourceRunId, carried);
  }

  storage.sql.exec(
    `INSERT INTO workflow_fork_lineage
      (id, source_run_id, checkpoint_event_id, checkpoint_workspace_root_id, created_at)
      VALUES (1, ?, ?, ?, ?)`,
    input.origin.sourceRunId,
    input.origin.checkpointEventId,
    input.origin.checkpointWorkspaceRootId,
    now(),
  );

  return { conflict: null, value: begunOn(storage, acquisitionId, input, now) };
}

/** The fork's first execution, begun by the acquisition that committed it. */
function begunOn(
  storage: OwnerStorage,
  acquisitionId: string,
  input: { readonly runId: string; readonly executionId: string },
  now: () => string,
): ForkedValue {
  storage.sql.exec(
    "INSERT INTO document_executions (execution_id, started_at) VALUES (?, ?)",
    input.executionId,
    now(),
  );
  holdExecution(storage, acquisitionId, input.executionId);
  storage.sql.exec(
    "UPDATE workflow_run SET status = 'running', updated_at = ? WHERE id = 1",
    now(),
  );
  const row = rows(
    storage,
    `SELECT execution_id, started_at, stopped_at, stop_status,
            stop_reason_kind, stop_reason_code, stop_reason_event_id
       FROM document_executions WHERE execution_id = ?`,
    input.executionId,
  )[0];
  if (row === undefined) {
    throw new CommandError("malformed-member");
  }
  return {
    frontier: readFrontier(storage, input.runId),
    execution: readDocumentExecution(row),
  };
}

/** What a destination already holds, when a retry finds one. */
export function retainedFork(storage: OwnerStorage, runId: string): boolean {
  const row = rows(storage, "SELECT run_id FROM workflow_run")[0];
  return row !== undefined && readRunRecord(row).runId === runId;
}

/** Discard this acquisition's offered parts once they have been adopted. */
export function discardForkParts(storage: OwnerStorage, acquisitionId: string): void {
  storage.sql.exec(`DELETE FROM ${FORK_TABLE} WHERE acquisition_id = ?`, acquisitionId);
}
