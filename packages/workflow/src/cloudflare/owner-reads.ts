/**
 * What the owner answers a read with, read out of its own storage.
 *
 * Every value here is rebuilt from checked columns. The rows are this object's
 * own and were written by this build, which is a reason to expect them to be
 * right and no reason at all to skip asking: a row that does not parse is
 * storage damage, and storage damage answered as though it were a workflow
 * value is how damage travels.
 *
 * Three properties hold the reads together. The frontier is *coherent*: the run
 * record, the current root and the journal anchor are read as one, and the
 * anchor is the last event that existed at that moment, so later appends cannot
 * enter an earlier snapshot. Reads are *bounded*: a journal is returned in
 * pages anchored to that event, and content comes back one piece at a time.
 * Reads are *referenced*: a piece of content is admitted only if the named root
 * actually names it, directly or through a manifest it names, so this is a read
 * of one retained root rather than of a content-addressed store.
 *
 * A refusal says the category and nothing else. Column values, retained JSON
 * and request data never appear in one: the caller learns that storage is
 * damaged, which is the only thing it can act on.
 */

import { parseDurableEvent } from "@executablemd/durable-streams";
import { readRetrieval, readRunRecord, type Row } from "../sqlite/rows.ts";
import { WorkflowRecordMalformedError } from "../storage/errors.ts";
import {
  decodeDofsManifest,
  parseWorkspaceRootManifest,
  SHA256,
  WORKSPACE_ROOT_DOMAIN,
  type WorkspaceRootManifest,
} from "../workspace/root-manifest.ts";
import {
  CommandError,
  JOURNAL_PAGE_BYTES,
  JOURNAL_PAGE_ENTRIES,
  MAX_CONTENT_BYTES,
} from "./commands.ts";
import { bytesOf, encodeBase64, sha256Hex } from "./encoding.ts";
import type { OwnerStorage } from "./storage.ts";

export interface FrontierValue {
  readonly record: ReturnType<typeof readRunRecord>;
  readonly retrieval: ReturnType<typeof readRetrieval> | null;
  readonly workspaceRootId: string;
  readonly journalEventId: string | null;
}

export interface JournalPageValue {
  readonly anchorEventId: string | null;
  readonly afterEventId: string | null;
  readonly entries: readonly {
    readonly eventId: string;
    readonly previousEventId: string | null;
    readonly record: string;
    readonly workspaceRootId: string;
  }[];
  readonly done: boolean;
}

export interface RootValue {
  readonly workspaceRootId: string;
  readonly manifest: string;
}

export interface ContentValue {
  readonly kind: "manifest" | "blob";
  readonly digest: string;
  readonly size: number;
  readonly bytes: string;
}

interface StoredRoot {
  readonly manifest: string;
  readonly parsed: WorkspaceRootManifest;
  readonly manifests: ReadonlySet<string>;
}

function corrupt(reason: string): never {
  throw new WorkflowRecordMalformedError("workflow owner storage", reason);
}

function exactlyOne(rows: Row[], name: string): Row {
  if (rows.length !== 1 || rows[0] === undefined) {
    return corrupt(`expected exactly one ${name} row`);
  }
  return rows[0];
}

function safeText(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string" || value === "") {
    return corrupt(`expected ${column} to be non-empty text`);
  }
  return value;
}

function safeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return corrupt(`expected ${name} to be a nonnegative whole number`);
  }
  return value;
}

function rootIdentity(manifest: string): string {
  return sha256Hex(`${WORKSPACE_ROOT_DOMAIN}${manifest}`);
}

function byteRows(storage: OwnerStorage, sql: string, ...bindings: unknown[]): Row[] {
  return storage.sql.exec(sql, ...bindings).toArray();
}

function referencedRoot(storage: OwnerStorage, rootId: string): StoredRoot {
  if (!SHA256.test(rootId)) {
    return corrupt("a Workspace root identity is malformed");
  }
  const root = exactlyOne(
    byteRows(
      storage,
      "SELECT root_id, format_version, manifest FROM workspace_roots WHERE root_id = ?",
      rootId,
    ),
    "Workspace root",
  );
  const manifest = safeText(root, "manifest");
  if (root["format_version"] !== 1) {
    return corrupt("a Workspace root has an unsupported format");
  }
  const parsed = parseWorkspaceRootManifest(manifest, corrupt);
  if (rootIdentity(manifest) !== rootId || root["root_id"] !== rootId) {
    return corrupt("a Workspace root disagrees with its identity");
  }
  if (new TextEncoder().encode(manifest).length > MAX_CONTENT_BYTES) {
    throw new CommandError("too-large");
  }

  const expectedManifests = new Set(
    parsed.entries.flatMap((entry) => (entry.kind === "file" ? [entry.manifest] : [])),
  );
  const manifestRows = byteRows(
    storage,
    `SELECT lower(hex(manifest_hash)) AS digest
       FROM workspace_root_manifest_refs WHERE root_id = ? ORDER BY digest`,
    rootId,
  );
  if (manifestRows.length !== expectedManifests.size) {
    return corrupt("a Workspace root's manifest references are incomplete");
  }
  const manifests = new Set<string>();
  for (const row of manifestRows) {
    const digest = safeText(row, "digest");
    if (!expectedManifests.has(digest)) {
      return corrupt("a Workspace root has an extra manifest reference");
    }
    manifests.add(digest);
  }
  return { manifest, parsed, manifests };
}

function retainedManifest(
  storage: OwnerStorage,
  root: StoredRoot,
  digest: string,
): { bytes: Uint8Array; chunks: ReturnType<typeof decodeDofsManifest>["chunks"] } {
  if (!root.manifests.has(digest)) {
    return corrupt("a DOFS manifest is not referenced by this Workspace root");
  }
  const row = exactlyOne(
    byteRows(storage, "SELECT size, encoded FROM vfs_manifests WHERE lower(hex(hash)) = ?", digest),
    "DOFS manifest",
  );
  const bytes = bytesOf(row["encoded"]);
  if (bytes.length > MAX_CONTENT_BYTES || sha256Hex(bytes) !== digest) {
    return corrupt("a retained DOFS manifest disagrees with its identity");
  }
  const decoded = decodeDofsManifest(bytes, corrupt);
  if (safeInteger(row["size"], "manifest size") !== decoded.size) {
    return corrupt("a retained DOFS manifest disagrees with its recorded size");
  }
  for (const entry of root.parsed.entries) {
    if (entry.kind === "file" && entry.manifest === digest && entry.size !== decoded.size) {
      return corrupt("a Workspace file size disagrees with its retained manifest");
    }
  }
  return { bytes, chunks: decoded.chunks };
}

function retainedBlob(
  storage: OwnerStorage,
  rootId: string,
  root: StoredRoot,
  sourceManifest: string,
  digest: string,
): Uint8Array {
  const manifest = retainedManifest(storage, root, sourceManifest);
  const expected = manifest.chunks.find((chunk) => chunk.hash === digest);
  if (expected === undefined) {
    return corrupt("a blob is not referenced by the named DOFS manifest");
  }
  const row = exactlyOne(
    byteRows(
      storage,
      `SELECT b.size, x.bytes FROM workspace_root_blob_refs AS r
        JOIN vfs_blobs AS b ON b.hash = r.blob_hash
        JOIN vfs_blob_bytes AS x ON x.hash = r.blob_hash
       WHERE r.root_id = ? AND lower(hex(r.blob_hash)) = ?`,
      rootId,
      digest,
    ),
    "DOFS blob",
  );
  const bytes = bytesOf(row["bytes"]);
  if (
    bytes.length > MAX_CONTENT_BYTES ||
    bytes.length !== expected.size ||
    safeInteger(row["size"], "blob size") !== expected.size ||
    sha256Hex(bytes) !== digest
  ) {
    return corrupt("a retained DOFS blob disagrees with its identity or size");
  }
  return bytes;
}

export function readFrontier(storage: OwnerStorage, runId: string): FrontierValue {
  const record = readRunRecord(
    exactlyOne(
      byteRows(
        storage,
        `SELECT run_id, definition, base, props, status,
                stop_reason_kind, stop_reason_code, stop_reason_event_id,
                created_at, updated_at FROM workflow_run`,
      ),
      "workflow run",
    ),
  );
  if (record.runId !== runId) {
    return corrupt("the retained run identity does not address this owner");
  }
  const state = exactlyOne(
    byteRows(storage, "SELECT current_root_id FROM workspace_state WHERE singleton_id = 1"),
    "Workspace state",
  );
  const workspaceRootId = safeText(state, "current_root_id");
  referencedRoot(storage, workspaceRootId);
  const retrievalRows = byteRows(
    storage,
    "SELECT metadata, revision, updated_at FROM definition_retrieval WHERE id = 1",
  );
  if (retrievalRows.length > 1) {
    return corrupt("the definition retrieval is not a singleton");
  }
  const last = byteRows(
    storage,
    "SELECT event_id FROM journal_events ORDER BY sequence DESC LIMIT 1",
  )[0];
  return {
    record,
    retrieval: retrievalRows[0] === undefined ? null : readRetrieval(retrievalRows[0]),
    workspaceRootId,
    journalEventId: last === undefined ? null : safeText(last, "event_id"),
  };
}

export function readJournalPage(
  storage: OwnerStorage,
  anchorEventId: string | null,
  afterEventId: string | null,
): JournalPageValue {
  if (anchorEventId === null) {
    if (afterEventId !== null) {
      return corrupt("an empty journal snapshot names an earlier event");
    }
    return { anchorEventId, afterEventId, entries: [], done: true };
  }
  const anchor = exactlyOne(
    byteRows(storage, "SELECT sequence FROM journal_events WHERE event_id = ?", anchorEventId),
    "journal anchor",
  );
  const anchorSequence = safeInteger(anchor["sequence"], "journal anchor sequence");
  let afterSequence = 0;
  if (afterEventId !== null) {
    const after = exactlyOne(
      byteRows(storage, "SELECT sequence FROM journal_events WHERE event_id = ?", afterEventId),
      "journal cursor",
    );
    afterSequence = safeInteger(after["sequence"], "journal cursor sequence");
    if (afterSequence >= anchorSequence) {
      return corrupt("a journal cursor is outside its anchored snapshot");
    }
  }
  const rows = byteRows(
    storage,
    `SELECT event_id, record, workspace_root_id,
            (SELECT event_id FROM journal_events AS predecessor
              WHERE predecessor.sequence < event.sequence
              ORDER BY predecessor.sequence DESC LIMIT 1) AS previous_event_id
       FROM journal_events AS event
      WHERE sequence > ? AND sequence <= ? ORDER BY sequence ASC LIMIT ?`,
    afterSequence,
    anchorSequence,
    JOURNAL_PAGE_ENTRIES + 1,
  );
  const entries: JournalPageValue["entries"][number][] = [];
  let encodedBytes = 0;
  for (const row of rows.slice(0, JOURNAL_PAGE_ENTRIES)) {
    const eventId = safeText(row, "event_id");
    const previous = row["previous_event_id"];
    if (previous !== null && typeof previous !== "string") {
      return corrupt("a journal predecessor identity is malformed");
    }
    const record = safeText(row, "record");
    const workspaceRootId = safeText(row, "workspace_root_id");
    if (!SHA256.test(workspaceRootId) || !parseDurableEvent(record).ok) {
      return corrupt("a journal row is malformed");
    }
    const entry = { eventId, previousEventId: previous, record, workspaceRootId };
    const nextBytes = new TextEncoder().encode(JSON.stringify(entry)).length;
    if (entries.length > 0 && encodedBytes + nextBytes > JOURNAL_PAGE_BYTES) {
      break;
    }
    if (nextBytes > MAX_CONTENT_BYTES) {
      throw new CommandError("too-large");
    }
    entries.push(entry);
    encodedBytes += nextBytes;
  }
  const done = rows.length <= entries.length;
  if (done && entries.at(-1)?.eventId !== anchorEventId) {
    return corrupt("an anchored journal snapshot is incomplete");
  }
  return { anchorEventId, afterEventId, entries, done };
}

export function readRoot(storage: OwnerStorage, workspaceRootId: string): RootValue {
  const root = referencedRoot(storage, workspaceRootId);
  return { workspaceRootId, manifest: root.manifest };
}

export function readContent(
  storage: OwnerStorage,
  workspaceRootId: string,
  kind: "manifest" | "blob",
  digest: string,
  sourceManifest: string | null,
): ContentValue {
  const root = referencedRoot(storage, workspaceRootId);
  const bytes =
    kind === "manifest"
      ? retainedManifest(storage, root, digest).bytes
      : retainedBlob(storage, workspaceRootId, root, sourceManifest ?? "", digest);
  if (bytes.length === 0) {
    return corrupt("a retained content piece is empty");
  }
  return { kind, digest, size: bytes.length, bytes: encodeBase64(bytes) };
}
