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
 * Reads are *referenced*: a root is returned only once its complete content
 * graph has been proved present and self-consistent, and a piece is admitted
 * only if that root actually names it, so this is a read of one retained root
 * rather than of a content-addressed store. Validating the graph up front is
 * the point: a root is a starting frontier, and a frontier that turns out not
 * to be materializable after the runner has it is a failure arriving too late
 * to mean anything.
 *
 * A refusal says the category and nothing else. Column values, retained JSON
 * and request data never appear in one: the caller learns that storage is
 * damaged, which is the only thing it can act on.
 */

import { parseDurableEvent } from "@executablemd/durable-streams";
import { readDocumentExecution, readRetrieval, readRunRecord, type Row } from "../sqlite/rows.ts";
import type { DocumentExecutionRecord } from "../storage/record.ts";
import { WorkflowRecordMalformedError } from "../storage/errors.ts";
import {
  parseWorkspaceRootManifest,
  SHA256,
  WORKSPACE_ROOT_DOMAIN,
  type WorkspaceRootManifest,
} from "../workspace/root-manifest.ts";
import { type ContentManifest, decodeContentManifest } from "../workspace/content-manifest.ts";
import {
  CommandError,
  EXECUTION_PAGE_BYTES,
  EXECUTION_PAGE_ENTRIES,
  executionPageBytes,
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

/**
 * One retained root, and the whole content graph it names, proved.
 *
 * `manifests` and `blobs` are not a description of what the root refers to —
 * they are what was found and checked. A `StoredRoot` therefore cannot exist
 * for a root whose graph is incomplete or disagrees with itself.
 */
interface StoredRoot {
  readonly manifest: string;
  readonly parsed: WorkspaceRootManifest;
  readonly manifests: ReadonlyMap<string, ContentManifest>;
  readonly blobs: ReadonlySet<string>;
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

/** Every content identity one root's reference table holds, in order. */
function referenceRows(
  storage: OwnerStorage,
  table: string,
  column: string,
  rootId: string,
): string[] {
  return byteRows(
    storage,
    `SELECT lower(hex(${column})) AS digest FROM ${table} WHERE root_id = ? ORDER BY digest`,
    rootId,
  ).map((row) => safeText(row, "digest"));
}

/**
 * Whether a reference table holds exactly the identities the content names.
 *
 * Both directions matter and for different reasons. A missing row is content
 * the root depends on that nothing is keeping alive, so retention may already
 * have collected it. An extra row is the root claiming content it does not use,
 * which keeps bytes reachable that no manifest accounts for. Neither is a root
 * this owner will hand to a runner as a starting frontier.
 */
function requireReferenceSet(
  found: readonly string[],
  expected: ReadonlySet<string>,
  what: string,
): void {
  if (found.length !== expected.size || found.some((digest) => !expected.has(digest))) {
    corrupt(`a Workspace root's ${what} references disagree with its content`);
  }
}

/** One retained DOFS manifest, proved against its identity, size and entries. */
function validatedManifest(
  storage: OwnerStorage,
  parsed: WorkspaceRootManifest,
  digest: string,
): { bytes: Uint8Array; manifest: ContentManifest } {
  const row = exactlyOne(
    byteRows(storage, "SELECT size, encoded FROM vfs_manifests WHERE lower(hex(hash)) = ?", digest),
    "DOFS manifest",
  );
  const bytes = bytesOf(row["encoded"]);
  if (bytes.length > MAX_CONTENT_BYTES || sha256Hex(bytes) !== digest) {
    return corrupt("a retained DOFS manifest disagrees with its identity");
  }
  const manifest = decodeContentManifest(bytes, corrupt);
  if (safeInteger(row["size"], "manifest size") !== manifest.size) {
    return corrupt("a retained DOFS manifest disagrees with its recorded size");
  }
  for (const entry of parsed.entries) {
    if (entry.kind === "file" && entry.manifest === digest && entry.size !== manifest.size) {
      return corrupt("a Workspace file size disagrees with its retained manifest");
    }
  }
  return { bytes, manifest };
}

/** One retained blob, proved against its identity and every chunk naming it. */
function validatedBlob(
  storage: OwnerStorage,
  rootId: string,
  manifests: ReadonlyMap<string, ContentManifest>,
  digest: string,
): Uint8Array {
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
  if (bytes.length > MAX_CONTENT_BYTES || sha256Hex(bytes) !== digest) {
    return corrupt("a retained DOFS blob disagrees with its identity");
  }
  if (safeInteger(row["size"], "blob size") !== bytes.length) {
    return corrupt("a retained DOFS blob disagrees with its recorded size");
  }
  for (const manifest of manifests.values()) {
    for (const chunk of manifest.chunks) {
      if (chunk.hash === digest && chunk.size !== bytes.length) {
        return corrupt("a DOFS chunk size disagrees with the blob it names");
      }
    }
  }
  return bytes;
}

/**
 * One retained root, with its complete content graph proved before it is a root
 * at all.
 *
 * Accepting a root is accepting a starting frontier: the runner will
 * materialize it, work in it, and propose against it. A root whose graph cannot
 * be materialized is not a frontier, and discovering that one piece at a time —
 * after the frontier has already crossed to the runner — would mean the failure
 * arrives once the run has already been told where it stands.
 *
 * So the whole graph is walked here. The manifests the entries name must be
 * exactly the manifests the root retains; each must exist, be bounded, decode
 * canonically, hash to its identity, and agree with its recorded size and with
 * every file that names it. The blobs those manifests name must be exactly the
 * blobs the root retains; each must exist, be bounded, hash to its identity,
 * and agree with its recorded size and with every chunk that names it.
 *
 * The bytes are read and dropped. What is kept is the proof, and a later
 * content request re-reads the single piece it is sending — which is what keeps
 * the transport piece-oriented rather than turning a validated root into one
 * unbounded answer.
 */
/**
 * Prove one retained root is complete, for a caller that is about to write.
 *
 * The same validator the reads use. Keeping the read boundary and the write
 * boundary on one proof is what stops a root being publishable by one path and
 * refused by the other.
 */
export function validateRetainedRoot(storage: OwnerStorage, rootId: string): void {
  referencedRoot(storage, rootId);
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

  const named = new Set(
    parsed.entries.flatMap((entry) => (entry.kind === "file" ? [entry.manifest] : [])),
  );
  requireReferenceSet(
    referenceRows(storage, "workspace_root_manifest_refs", "manifest_hash", rootId),
    named,
    "manifest",
  );

  const manifests = new Map<string, ContentManifest>();
  for (const digest of named) {
    manifests.set(digest, validatedManifest(storage, parsed, digest).manifest);
  }

  const reachable = new Set<string>();
  for (const decoded of manifests.values()) {
    for (const chunk of decoded.chunks) {
      reachable.add(chunk.hash);
    }
  }
  requireReferenceSet(
    referenceRows(storage, "workspace_root_blob_refs", "blob_hash", rootId),
    reachable,
    "blob",
  );
  for (const digest of reachable) {
    validatedBlob(storage, rootId, manifests, digest);
  }

  return { manifest, parsed, manifests, blobs: reachable };
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
  const bytes = piece(storage, workspaceRootId, root, kind, digest, sourceManifest);
  if (bytes.length === 0) {
    return corrupt("a retained content piece is empty");
  }
  return { kind, digest, size: bytes.length, bytes: encodeBase64(bytes) };
}

/**
 * The one piece a content request names, re-read from the proved graph.
 *
 * Membership is decided against what the root actually names rather than
 * against the reference tables alone, and a blob is reached only through a
 * manifest the request names. That is what keeps this a read of one retained
 * root instead of a read of the content store: staged, orphaned or
 * otherwise-unreferenced bytes are addressable by nobody through here.
 */
function piece(
  storage: OwnerStorage,
  rootId: string,
  root: StoredRoot,
  kind: "manifest" | "blob",
  digest: string,
  sourceManifest: string | null,
): Uint8Array {
  if (kind === "manifest") {
    if (!root.manifests.has(digest)) {
      return corrupt("a DOFS manifest is not referenced by this Workspace root");
    }
    return validatedManifest(storage, root.parsed, digest).bytes;
  }
  const source = sourceManifest === null ? undefined : root.manifests.get(sourceManifest);
  if (source === undefined || !source.chunks.some((chunk) => chunk.hash === digest)) {
    return corrupt("a blob is not referenced by the named DOFS manifest");
  }
  return validatedBlob(storage, rootId, root.manifests, digest);
}

/** One page of document executions, anchored to the snapshot that began it. */
export interface ExecutionsValue {
  readonly runId: string;
  readonly anchor: number | null;
  readonly after: number | null;
  readonly rows: readonly { readonly sequence: number; readonly record: DocumentExecutionRecord }[];
  readonly done: boolean;
}

/**
 * Read one bounded page of the executions this run has begun.
 *
 * Anchored the way the journal is, and for the same reason: a caller assembling
 * a list across several requests must see one snapshot rather than whatever the
 * table held at each moment. The first page fixes the terminal sequence; every
 * later page is constrained to it, so an execution begun while the read is in
 * flight cannot appear halfway through the answer.
 *
 * The run identity travels with the page so the runner can refuse an answer
 * from another run, and the sequence travels so it can prove adjacency. Neither
 * becomes part of the semantic record.
 */
export function readExecutions(
  storage: OwnerStorage,
  runId: string,
  anchor: number | null,
  after: number | null,
): ExecutionsValue {
  // The first request carries no anchor because the runner has nothing to
  // anchor to yet. The owner chooses it — the terminal row at this moment — and
  // answers with it, so every later page is held to the snapshot this one
  // began. An empty run answers with an explicit empty anchor.
  const selected = anchor ?? (after === null ? executionAnchor(storage) : null);
  if (selected === null) {
    if (after !== null) {
      return corrupt("an empty execution snapshot names an earlier row");
    }
    return { runId, anchor: null, after, rows: [], done: true };
  }

  const found = byteRows(
    storage,
    `SELECT sequence, execution_id, started_at, stopped_at, stop_status,
            stop_reason_kind, stop_reason_code, stop_reason_event_id
       FROM document_executions
      WHERE sequence > ? AND sequence <= ? ORDER BY sequence ASC LIMIT ?`,
    after ?? 0,
    selected,
    EXECUTION_PAGE_ENTRIES + 1,
  );

  const page: { sequence: number; record: DocumentExecutionRecord }[] = [];
  for (const row of found.slice(0, EXECUTION_PAGE_ENTRIES)) {
    const at = safeInteger(row["sequence"], "execution sequence");
    // The semantic record is what crosses, not the physical row. A row this
    // owner cannot read is storage damage; sending its columns would make the
    // runner responsible for a shape it has no business knowing.
    const entry = { sequence: at, record: readDocumentExecution(row) };
    const grown = [...page, entry];
    if (executionPageBytes(grown) > EXECUTION_PAGE_BYTES) {
      if (page.length === 0) {
        // One record larger than a whole page: this snapshot cannot be paged,
        // and answering with it would send what the runner must refuse.
        throw new CommandError("too-large");
      }
      break;
    }
    page.push(entry);
  }

  const done = found.length <= page.length;
  if (done && page.at(-1)?.sequence !== selected) {
    return corrupt("an anchored execution snapshot is incomplete");
  }
  return { runId, anchor: selected, after, rows: page, done };
}

/** The terminal execution sequence right now, or `null` when there is none. */
export function executionAnchor(storage: OwnerStorage): number | null {
  const last = byteRows(
    storage,
    "SELECT sequence FROM document_executions ORDER BY sequence DESC LIMIT 1",
  )[0];
  return last === undefined ? null : safeInteger(last["sequence"], "execution sequence");
}
