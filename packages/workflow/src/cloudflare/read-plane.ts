/**
 * Reading a run's owner without taking it.
 *
 * The executor plane is one admitted WebSocket and one acquisition: whoever
 * holds it is *the* executor, and nobody else may advance the run. That is the
 * right shape for mutation and the wrong shape for reading. Inspecting a run,
 * listing what an owner holds, replaying its history, and selecting a fork's
 * source are all questions about committed state, and asking one must not make
 * the run unrunnable for as long as the answer takes.
 *
 * So this is an ordinary request plane. It accepts no socket, mints no
 * acquisition, writes nothing, and can be answered while an executor is live.
 * Admission shares the executor plane's order — release before token, token
 * before the run is touched — but stops before the acquisition the executor
 * plane takes last.
 *
 * What crosses is closed and private to this release. Public history is
 * projected on the runner from the retained rows this returns, so there is one
 * interpretation of a journal rather than two.
 */

import { parseMembers, requireMemberNames } from "../storage/members.ts";
import { WorkflowRecordMalformedError } from "../storage/errors.ts";
import { readDocumentExecution, readRetrieval, readRunRecord, type Row } from "../sqlite/rows.ts";
import { CommandError } from "./commands.ts";
import type { OwnerStorage } from "./storage.ts";
import { recognizeObject } from "./recognition.ts";
import { isRootImportEvent, isRunRecordEvent } from "../journal-events.ts";
import { parseDurableEvent } from "@executablemd/durable-streams";
import { compareUtf8, parseWorkspaceRootManifest } from "../workspace/root-manifest.ts";
import {
  type AnchorBlob,
  type AnchorManifest,
  type AnchorRoot,
  checkoutKey,
  forkSelectionAnchor,
} from "./fork-anchor.ts";
import { encodeBase64, sha256Hex } from "./encoding.ts";
import {
  retainedBytes,
  retainedCount,
  retainedDigest,
  retainedNullableText,
  retainedObjectFormat,
  retainedPath,
  retainedText,
} from "./retained.ts";

/** What a read answered, or why it would not. */
export type ReadAnswer =
  | { readonly outcome: "performed"; readonly value: unknown }
  | { readonly outcome: "refused"; readonly refusal: string };

/** The most rows one page of a read answer may carry. */
export const READ_PAGE_ENTRIES = 128;

/** The most serialized bytes one page of a read answer may carry. */
export const READ_PAGE_BYTES = 512 * 1024;

/** The most characters a public run id may carry. */
const MAX_RUN_ID = 128;

/**
 * What a request carries besides the checkpoint it names.
 *
 * An operation, a section, an anchor, an ordinal and the punctuation around
 * them: all fixed shapes, so one generous constant covers every request this
 * build makes.
 */
export const READ_REQUEST_ENVELOPE = 4096;

/**
 * The most serialized bytes one request may carry.
 *
 * Measured over the finished UTF-8 encoding, because that is what crosses. A
 * request names a checkpoint, and a checkpoint event id is retained text: what
 * bounds it is that its own journal row is a member, and no page carries a
 * member larger than a page. Everything else in a request is fixed.
 */
export const READ_REQUEST_BYTES = READ_PAGE_BYTES + READ_REQUEST_ENVELOPE;

/**
 * What a reader may ask for.
 *
 * Closed, and none of it names a table, a row, a root or a hash: a caller
 * chooses a run, an operation and — where an answer is paged — the anchor it is
 * continuing. Everything else is the owner's to decide.
 */
export type ReadOperation =
  | { readonly operation: "inspect" }
  | { readonly operation: "history"; readonly anchor: string | null; readonly after: string | null }
  | {
      readonly operation: "fork-source";
      readonly checkpointEventId: string;
      /** Which part of the selection this page continues. */
      readonly section: ForkSourceSection;
      readonly anchor: string | null;
      /**
       * Where in the anchored selection to continue, as a position rather than
       * a name.
       *
       * A name would have to be spelled inside this request, and a retained
       * name is text that JSON escapes — twice, once for the name's own
       * encoding and once for the request carrying it — so a member the owner
       * will put in a page could name a page nobody can ask for. A position is
       * the same size whatever it points at, and it means nothing outside the
       * anchor that pins the selection.
       */
      readonly after: number | null;
    };

/**
 * The parts a fork's source is read in.
 *
 * Separate sections rather than one stream because they are different kinds of
 * thing and different sizes: rows, root manifests, encoded manifests and blob
 * content each need their own bound, and content needs chunking that rows do
 * not.
 */
export type ForkSourceSection = "inherited" | "roots" | "manifests" | "blobs" | "checkouts";

/**
 * What a read request carries outside its body.
 *
 * Separate from the operation on purpose. The release fingerprint decides
 * whether this build will talk to the caller at all, and deciding that after
 * decoding the body would mean a mismatched release had already been allowed to
 * drive a parser. A host reads these from the request's own metadata, exactly
 * as the executor plane reads them from its upgrade headers.
 */
export interface ReadAdmission {
  readonly release: string | null;
  readonly token: string | null;
  readonly runId: string | null;
}

function failure(reason: string, path: string): Error {
  return new WorkflowRecordMalformedError(`read request at ${path}`, reason);
}

function text(value: unknown, path: string, maximum = MAX_RUN_ID): string {
  if (typeof value !== "string" || value === "" || value.length > maximum) {
    throw failure("expected bounded non-empty text", path);
  }
  return value;
}

function nullableText(value: unknown, path: string): string | null {
  return value === null ? null : text(value, path);
}

/** A position in a selection: whole, not negative, and one this build can hold. */
function ordinal(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw failure("expected a position in the selection", path);
  }
  return value;
}

/**
 * One read operation, parsed only after admission has passed.
 *
 * Strict about membership on purpose: a body carrying more than this release
 * declares is not a request this build understands, and reading it leniently
 * would accept a shape a later version wrote.
 */
export function parseReadOperation(raw: string): ReadOperation {
  if (new TextEncoder().encode(raw).length > READ_REQUEST_BYTES) {
    throw failure("expected a bounded request", "$");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw failure("expected one JSON object", "$");
  }
  const read = parseMembers(decoded, "$", failure);
  const operation = read.get("operation");

  if (operation === "inspect") {
    requireMemberNames(read, ["operation"], "$", failure);
    return { operation };
  }
  if (operation === "history" || operation === "fork-source") {
    const names =
      operation === "history"
        ? ["operation", "anchor", "after"]
        : ["operation", "checkpointEventId", "section", "anchor", "after"];
    requireMemberNames(read, names, "$", failure);
    const anchor = nullableText(read.get("anchor"), "$.anchor");
    const after =
      read.get("after") === null
        ? null
        : operation === "history"
          ? text(read.get("after"), "$.after")
          : ordinal(read.get("after"), "$.after");
    if (anchor === null && after !== null) {
      // Nothing to continue from: a cursor without a snapshot names no page.
      throw failure("expected a cursor only inside an anchored snapshot", "$");
    }
    if (operation === "history") {
      if (typeof after === "number") {
        throw failure("expected a cursor this operation pages by", "$.after");
      }
      return { operation, anchor, after };
    }
    if (typeof after === "string") {
      throw failure("expected a cursor this operation pages by", "$.after");
    }
    const section = read.get("section");
    if (
      section !== "inherited" &&
      section !== "roots" &&
      section !== "manifests" &&
      section !== "blobs" &&
      section !== "checkouts"
    ) {
      throw failure("expected a section this build answers", "$.section");
    }
    return {
      operation,
      checkpointEventId: text(read.get("checkpointEventId"), "$.checkpointEventId"),
      section,
      anchor,
      after,
    };
  }
  throw failure("expected an operation this build answers", "$.operation");
}

function rows(storage: OwnerStorage, sql: string, ...bindings: unknown[]): Row[] {
  return storage.sql.exec(sql, ...bindings).toArray();
}

function only(storage: OwnerStorage, sql: string): Row | undefined {
  return rows(storage, sql)[0];
}

/** The run this owner holds, or a refusal that it holds another or none. */
function retained(storage: OwnerStorage, runId: string): Row {
  recognizeObject(storage);
  const row = only(
    storage,
    `SELECT run_id, definition, base, props, status, stop_reason_kind, stop_reason_code,
            stop_reason_event_id, created_at, updated_at FROM workflow_run`,
  );
  if (row === undefined) {
    throw new CommandError("absent");
  }
  if (readRunRecord(row).runId !== runId) {
    throw new CommandError("wrong-run");
  }
  return row;
}

/**
 * One coherent inspection, from one committed reading.
 *
 * Every member describes the same moment: the record, its executions, the
 * frontier, the current root and the lineage are read together so a caller
 * cannot be handed a run whose parts came from different commits.
 */
export function readInspection(storage: OwnerStorage, runId: string): Record<string, unknown> {
  const row = retained(storage, runId);
  const executions = rows(
    storage,
    `SELECT execution_id, started_at, stopped_at, stop_status, stop_reason_kind,
            stop_reason_code, stop_reason_event_id FROM document_executions ORDER BY sequence`,
  ).map((entry) => readDocumentExecution(entry));
  const retrieval = only(
    storage,
    "SELECT metadata, revision, updated_at FROM definition_retrieval WHERE id = 1",
  );
  const frontier = only(
    storage,
    "SELECT event_id, workspace_root_id FROM journal_events ORDER BY sequence DESC LIMIT 1",
  );
  const state = only(storage, "SELECT current_root_id FROM workspace_state WHERE singleton_id = 1");
  if (state === undefined) {
    throw new WorkflowRecordMalformedError("workflow owner storage", "it selects no Workspace");
  }
  const lineage = only(
    storage,
    `SELECT source_run_id, checkpoint_event_id, checkpoint_workspace_root_id
       FROM workflow_fork_lineage WHERE id = 1`,
  );

  return {
    record: readRunRecord(row),
    executions,
    retrieval: retrieval === undefined ? null : readRetrieval(retrieval),
    journalFrontier:
      frontier === undefined
        ? null
        : {
            eventId: retainedText(frontier, "event_id"),
            workspaceRootId: retainedDigest(frontier, "workspace_root_id"),
          },
    currentWorkspaceRootId: retainedDigest(state, "current_root_id"),
    lineage:
      lineage === undefined
        ? null
        : {
            sourceRunId: retainedText(lineage, "source_run_id"),
            checkpointEventId: retainedText(lineage, "checkpoint_event_id"),
            checkpointWorkspaceRootId: retainedDigest(lineage, "checkpoint_workspace_root_id"),
          },
  };
}

/**
 * One anchored page of retained journal rows.
 *
 * The anchor is the terminal event the first page chose, and every later page
 * is held to it: a run that appended after the snapshot began does not grow the
 * answer, because the anchor decides what the answer is about.
 */
export function readHistoryPage(
  storage: OwnerStorage,
  runId: string,
  anchor: string | null,
  after: string | null,
): Record<string, unknown> {
  retained(storage, runId);
  const terminal = only(
    storage,
    "SELECT event_id FROM journal_events ORDER BY sequence DESC LIMIT 1",
  );
  const selected = anchor ?? (terminal === undefined ? null : retainedText(terminal, "event_id"));
  if (selected === null) {
    // An empty history is terminal and carries nothing.
    return { anchor: null, after: null, rows: [], done: true, retainedRoots: [], provenance: [] };
  }
  const sequenceOf = (eventId: string): number => {
    const row = rows(storage, "SELECT sequence FROM journal_events WHERE event_id = ?", eventId)[0];
    if (row === undefined) {
      // An anchor or cursor this run does not hold. Answering from the rest
      // would be answering about a different snapshot.
      throw new CommandError("stale-journal");
    }
    return retainedCount(row, "sequence");
  };
  const anchorAt = sequenceOf(selected);
  const afterAt = after === null ? 0 : sequenceOf(after);
  const page = rows(
    storage,
    `SELECT event_id, record, workspace_root_id FROM journal_events
       WHERE sequence > ? AND sequence <= ? ORDER BY sequence LIMIT ?`,
    afterAt,
    anchorAt,
    READ_PAGE_ENTRIES,
  ).map((row) => ({
    eventId: retainedText(row, "event_id"),
    record: retainedText(row, "record"),
    workspaceRootId: retainedDigest(row, "workspace_root_id"),
  }));
  const last = page.at(-1);
  const done = last === undefined || last.eventId === selected;
  return {
    anchor: selected,
    after,
    rows: page,
    done,
    // Sent with the terminal page alone, because they describe the whole
    // snapshot rather than one page of it.
    retainedRoots: done
      ? rows(storage, "SELECT root_id FROM workspace_roots ORDER BY root_id").map((row) =>
          retainedDigest(row, "root_id"),
        )
      : [],
    provenance: done
      ? rows(
          storage,
          `SELECT event_id, source_run_id, source_event_id
             FROM journal_event_provenance ORDER BY event_id`,
        ).map((row) => ({
          eventId: retainedText(row, "event_id"),
          sourceRunId: retainedText(row, "source_run_id"),
          sourceEventId: retainedText(row, "source_event_id"),
        }))
      : [],
  };
}

/**
 * The selection one checkpoint names, as values rather than pages.
 *
 * Computed whole every time a page is asked for, from one committed reading.
 * That is what makes paging safe without a retained session: there is nothing
 * to keep alive between pages, and a page is answered from the same selection
 * the first one was — or the anchor no longer matches and the whole read fails.
 */
interface ForkSelection {
  readonly anchor: string;
  readonly checkpointWorkspaceRootId: string;
  readonly runRecordWorkspaceRootId: string;
  readonly rootImportWorkspaceRootId: string;
  readonly inherited: readonly { eventId: string; record: string; workspaceRootId: string }[];
  readonly rootIds: readonly string[];
  readonly manifestHashes: readonly string[];
  readonly blobHashes: readonly string[];
  readonly checkoutPaths: ReadonlySet<string>;
}

/**
 * Select the prefix this checkpoint names, and everything it depends on.
 *
 * The rules are the shared ones: the source's own run record and root import
 * are what a fork writes for itself and are excluded; every root the prefix
 * touches is needed, and so is the content those roots close over; and only a
 * checkout whose directory exists in the checkpoint's own Workspace is
 * inherited, so a Repository the source created afterwards does not arrive in a
 * fork with nowhere to put it.
 */
function selectForkSource(storage: OwnerStorage, checkpointEventId: string): ForkSelection {
  const all = rows(
    storage,
    "SELECT event_id, record, workspace_root_id FROM journal_events ORDER BY sequence",
  ).map((row) => ({
    eventId: retainedText(row, "event_id"),
    record: retainedText(row, "record"),
    workspaceRootId: retainedDigest(row, "workspace_root_id"),
  }));
  const at = all.findIndex((row) => row.eventId === checkpointEventId);
  if (at === -1) {
    throw new CommandError("stale-journal");
  }
  const prefix = all.slice(0, at + 1);
  const checkpoint = prefix[at];
  if (checkpoint === undefined) {
    throw new CommandError("stale-journal");
  }

  const classify = (row: { record: string }) => {
    const parsed = parseDurableEvent(row.record);
    if (!parsed.ok) {
      throw new CommandError("corrupt-journal");
    }
    return parsed.value;
  };
  const record = prefix.find((row) => isRunRecordEvent(classify(row)));
  if (record === undefined) {
    // Nothing to inherit: the source recorded no run of its own before here.
    throw new CommandError("not-forkable");
  }
  const rootImport = prefix.find((row) => isRootImportEvent(classify(row)));
  const inherited = prefix.filter((row) => row !== record && row !== rootImport);

  const rootIds = new Set(prefix.map((row) => row.workspaceRootId));
  rootIds.add(checkpoint.workspaceRootId);
  const ordered = [...rootIds].sort();

  const manifestHashes = new Set<string>();
  const blobHashes = new Set<string>();
  for (const rootId of ordered) {
    for (const hash of referenced(
      storage,
      "workspace_root_manifest_refs",
      "manifest_hash",
      rootId,
    )) {
      manifestHashes.add(hash);
    }
    for (const hash of referenced(storage, "workspace_root_blob_refs", "blob_hash", rootId)) {
      blobHashes.add(hash);
    }
  }

  const checkoutPaths = checkpointDirectories(storage, checkpoint.workspaceRootId);
  const selection = {
    checkpointEventId,
    checkpointWorkspaceRootId: checkpoint.workspaceRootId,
    runRecordWorkspaceRootId: record.workspaceRootId,
    rootImportWorkspaceRootId: rootImport?.workspaceRootId ?? record.workspaceRootId,
    inherited,
    rootIds: ordered,
    manifestHashes: [...manifestHashes].sort(),
    blobHashes: [...blobHashes].sort(),
    checkoutPaths,
  };
  return { ...selection, anchor: selectionAnchor(storage, selection) };
}

function referenced(
  storage: OwnerStorage,
  table: string,
  column: string,
  rootId: string,
): string[] {
  const sql =
    table === "workspace_root_manifest_refs"
      ? "SELECT lower(hex(manifest_hash)) AS hash FROM workspace_root_manifest_refs WHERE root_id = ?"
      : "SELECT lower(hex(blob_hash)) AS hash FROM workspace_root_blob_refs WHERE root_id = ?";
  return rows(storage, sql, rootId).map((row) => retainedDigest(row, "hash"));
}

/**
 * An identity for the whole selection, not for the checkpoint alone.
 *
 * The checkpoint says which prefix; it says nothing about which roots, content
 * or checkouts came with it, and those travel in separate requests. Everything
 * a destination will copy that is not already named by a digest goes in here:
 * the inherited rows with their bytes and root associations, the three head
 * roots, each root's canonical record and its exact ordered reference sets, and
 * every selected checkout in full.
 *
 * Retained mappings are appendable, which is the case this exists for. A
 * qualifying Repository added between the earlier sections and the checkouts
 * section changes this value, so the sequence refuses instead of joining two
 * committed states.
 *
 * A content-addressed identity stands for its bytes, because the parse on the
 * other side proves the bytes hash to it. Nothing else is stood in for.
 */
function selectionAnchor(
  storage: OwnerStorage,
  selection: {
    checkpointEventId: string;
    checkpointWorkspaceRootId: string;
    runRecordWorkspaceRootId: string;
    rootImportWorkspaceRootId: string;
    inherited: readonly { eventId: string; record: string; workspaceRootId: string }[];
    rootIds: readonly string[];
    manifestHashes: readonly string[];
    blobHashes: readonly string[];
    checkoutPaths: ReadonlySet<string>;
  },
): string {
  // Built here from what this owner retains, and hashed by the shared rule a
  // destination will hash its own copy with. The two sides read from different
  // places on purpose; what they must not do is describe the selection
  // differently.
  return forkSelectionAnchor({
    checkpointEventId: selection.checkpointEventId,
    checkpointWorkspaceRootId: selection.checkpointWorkspaceRootId,
    runRecordWorkspaceRootId: selection.runRecordWorkspaceRootId,
    rootImportWorkspaceRootId: selection.rootImportWorkspaceRootId,
    inherited: selection.inherited,
    roots: selection.rootIds.map((rootId) => anchorRoot(storage, rootId)),
    manifests: selection.manifestHashes.map((hash) => anchorManifest(storage, hash)),
    blobs: selection.blobHashes.map((hash) => anchorBlob(storage, hash)),
    checkouts: [
      ...readCheckoutRepositories(storage, selection.checkoutPaths),
      ...readCheckoutWorktrees(storage, selection.checkoutPaths),
    ].map((entry) => ({ key: entry.cursor, value: entry.value })),
  });
}

/** One root, as the shared selection describes it. */
function anchorRoot(storage: OwnerStorage, rootId: string): AnchorRoot {
  const read = readStoredRoot(storage, rootId);
  return {
    rootId: retainedTextOf(read, "rootId"),
    formatVersion: retainedNumberOf(read, "formatVersion"),
    manifest: retainedTextOf(read, "manifest"),
    manifestHashes: retainedListOf(read, "manifestHashes"),
    blobHashes: retainedListOf(read, "blobHashes"),
  };
}

/** One content manifest, as the shared selection describes it. */
function anchorManifest(storage: OwnerStorage, hash: string): AnchorManifest {
  const read = readStoredManifest(storage, hash);
  return {
    hash,
    size: retainedNumberOf(read, "size"),
    lastSeen: retainedNumberOf(read, "lastSeen"),
    encoded: retainedTextOf(read, "encoded"),
  };
}

/** One blob's metadata, as the shared selection describes it. */
function anchorBlob(storage: OwnerStorage, hash: string): AnchorBlob {
  const read = blobMetadata(storage, hash);
  return {
    hash,
    size: retainedNumberOf(read, "size"),
    lastSeen: retainedNumberOf(read, "lastSeen"),
  };
}

function retainedTextOf(value: Record<string, unknown>, name: string): string {
  const found = value[name];
  if (typeof found !== "string") {
    throw new CommandError("corrupt-journal");
  }
  return found;
}

function retainedNumberOf(value: Record<string, unknown>, name: string): number {
  const found = value[name];
  if (typeof found !== "number") {
    throw new CommandError("corrupt-journal");
  }
  return found;
}

function retainedListOf(value: Record<string, unknown>, name: string): string[] {
  const found = value[name];
  if (!Array.isArray(found)) {
    throw new CommandError("corrupt-journal");
  }
  return found.map((entry) => {
    if (typeof entry !== "string") {
      throw new CommandError("corrupt-journal");
    }
    return entry;
  });
}

/** The directories the checkpoint's own Workspace held. */
function checkpointDirectories(storage: OwnerStorage, rootId: string): ReadonlySet<string> {
  const row = rows(storage, "SELECT manifest FROM workspace_roots WHERE root_id = ?", rootId)[0];
  if (row === undefined) {
    throw new CommandError("stale-root");
  }
  const parsed = parseWorkspaceRootManifest(retainedText(row, "manifest"), (reason) => {
    throw new WorkflowRecordMalformedError("a retained Workspace root", reason);
  });
  const directories = new Set<string>();
  for (const entry of parsed.entries) {
    if (entry.kind === "directory") {
      directories.add(entry.path);
    }
  }
  return directories;
}

/**
 * One page of one section of a fork's source.
 *
 * Sectioned because the parts are different kinds and sizes: rows, root
 * manifests, encoded manifests and blob content each carry their own bound, and
 * a page ends on whichever of count or bytes it reaches first.
 */
export function readForkSourcePage(
  storage: OwnerStorage,
  runId: string,
  checkpointEventId: string,
  section: ForkSourceSection,
  anchor: string | null,
  after: number | null,
): Record<string, unknown> {
  retained(storage, runId);
  const selection = selectForkSource(storage, checkpointEventId);
  if (anchor !== null && anchor !== selection.anchor) {
    // The selection moved, so this page belongs to a snapshot that no longer
    // exists. There is no partial answer to give.
    throw new CommandError("stale-journal");
  }

  const head = {
    anchor: selection.anchor,
    after,
    section,
    checkpointEventId,
    checkpointWorkspaceRootId: selection.checkpointWorkspaceRootId,
    runRecordWorkspaceRootId: selection.runRecordWorkspaceRootId,
    rootImportWorkspaceRootId: selection.rootImportWorkspaceRootId,
  };

  if (section === "inherited") {
    return {
      ...head,
      ...page(
        selection.inherited,
        after,
        // The journal's own order is not derivable from the rows, so each one
        // says where it stands in the selected prefix.
        (row, at) => ({ ...row, position: at }),
      ),
    };
  }
  if (section === "roots") {
    return {
      ...head,
      ...page(selection.rootIds, after, (rootId) => readStoredRoot(storage, rootId)),
    };
  }
  if (section === "manifests") {
    return {
      ...head,
      ...page(selection.manifestHashes, after, (hash) => readStoredManifest(storage, hash)),
    };
  }
  if (section === "blobs") {
    return {
      ...head,
      ...page(selection.blobHashes, after, (hash) => readStoredBlob(storage, hash)),
    };
  }
  const checkouts = [
    ...readCheckoutRepositories(storage, selection.checkoutPaths),
    ...readCheckoutWorktrees(storage, selection.checkoutPaths),
  ];
  return {
    ...head,
    ...page(checkouts, after, (entry) => entry.value),
  };
}

/**
 * One page out of an ordered selection, bounded by count and by bytes.
 *
 * The cursor is the position of the last member carried, which is meaningful
 * only inside the anchor that pins this selection: the selection cannot have
 * moved under a position without the anchor changing first. The page also says
 * where it begins, which is what makes a whole sequence checkable against the
 * size the selection declared.
 */
function page<T, V>(
  members: readonly T[],
  after: number | null,
  valueOf: (member: T, at: number) => V,
): Record<string, unknown> {
  if (after !== null && after >= members.length) {
    // A position this selection does not hold. Under one anchor that can only
    // be a cursor from somewhere else.
    throw new CommandError("stale-journal");
  }
  const from = after === null ? 0 : after + 1;
  const carried: V[] = [];
  let bytes = 0;
  let at = from;
  for (; at < members.length && carried.length < READ_PAGE_ENTRIES; at += 1) {
    const member = members[at];
    if (member === undefined) {
      break;
    }
    const value = valueOf(member, at);
    const size = new TextEncoder().encode(JSON.stringify(value)).length;
    if (carried.length > 0 && bytes + size > READ_PAGE_BYTES) {
      break;
    }
    if (size > READ_PAGE_BYTES) {
      // One member larger than a whole page. There is no page that could
      // carry it, so the read refuses rather than answering with something the
      // runner must reject.
      throw new CommandError("too-large");
    }
    carried.push(value);
    bytes += size;
  }
  return {
    rows: carried,
    // Where this page begins in the selection, so a reader can tell that a
    // sequence covered every member exactly once rather than trusting that it
    // did.
    from,
    // Where it ends, which is where the next one continues from.
    cursor: carried.length === 0 ? after : at - 1,
    done: at >= members.length,
    total: members.length,
  };
}

function readStoredRoot(storage: OwnerStorage, rootId: string): Record<string, unknown> {
  const row = rows(
    storage,
    "SELECT root_id, format_version, manifest FROM workspace_roots WHERE root_id = ?",
    rootId,
  )[0];
  if (row === undefined) {
    throw new CommandError("stale-root");
  }
  return {
    rootId: retainedDigest(row, "root_id"),
    formatVersion: retainedCount(row, "format_version"),
    manifest: retainedText(row, "manifest"),
    // In the one order a root is retained with, which is what a destination
    // compares its own derivation against element for element.
    manifestHashes: referenced(
      storage,
      "workspace_root_manifest_refs",
      "manifest_hash",
      rootId,
    ).sort(compareUtf8),
    blobHashes: referenced(storage, "workspace_root_blob_refs", "blob_hash", rootId).sort(
      compareUtf8,
    ),
  };
}

function readStoredManifest(storage: OwnerStorage, hash: string): Record<string, unknown> {
  const row = rows(
    storage,
    "SELECT size, encoded, last_seen FROM vfs_manifests WHERE lower(hex(hash)) = ?",
    hash,
  )[0];
  if (row === undefined) {
    throw new CommandError("stale-root");
  }
  return {
    hash,
    size: retainedCount(row, "size"),
    lastSeen: retainedCount(row, "last_seen"),
    encoded: encodeBase64(retainedBytes(row, "encoded")),
  };
}

/**
 * One blob's retained metadata, without its bytes.
 *
 * The anchor needs what a destination will copy beside the content; the
 * content itself is already named by the digest, and hashing megabytes into an
 * anchor recomputed on every page would cost what it does not prove.
 */
function blobMetadata(storage: OwnerStorage, hash: string): Record<string, unknown> {
  const row = rows(
    storage,
    "SELECT size, last_seen FROM vfs_blobs WHERE lower(hex(hash)) = ?",
    hash,
  )[0];
  if (row === undefined) {
    throw new CommandError("stale-root");
  }
  return {
    hash,
    size: retainedCount(row, "size"),
    lastSeen: retainedCount(row, "last_seen"),
  };
}

function readStoredBlob(storage: OwnerStorage, hash: string): Record<string, unknown> {
  const row = rows(
    storage,
    `SELECT b.size AS size, b.last_seen AS last_seen, x.bytes AS bytes
       FROM vfs_blobs AS b JOIN vfs_blob_bytes AS x ON x.hash = b.hash
      WHERE lower(hex(b.hash)) = ?`,
    hash,
  )[0];
  if (row === undefined) {
    throw new CommandError("stale-root");
  }
  return {
    hash,
    size: retainedCount(row, "size"),
    lastSeen: retainedCount(row, "last_seen"),
    content: encodeBase64(retainedBytes(row, "bytes")),
  };
}

/**
 * One checkout's identity, as a key nothing else can spell.
 *
 * A Repository name and a Worktree name are retained as text and may hold any
 * character, so joining them with a separator is not an identity: `("a:b", "c")`
 * and `("a", "b:c")` are two retained Worktrees that would join to one string.
 * A JSON array of the parts escapes what it must and separates what it must,
 * so distinct tuples spell distinct keys.
 */
/** Only the Repositories whose checkout the checkpoint's Workspace holds. */
function readCheckoutRepositories(
  storage: OwnerStorage,
  checkoutPaths: ReadonlySet<string>,
): { cursor: string; value: Record<string, unknown> }[] {
  return rows(
    storage,
    `SELECT name, locator, locator_fingerprint, requested_base, creation_commit,
            primary_branch, object_format, checkout_path
       FROM workspace_repositories ORDER BY name`,
  )
    .filter((row) => checkoutPaths.has(retainedPath(row, "checkout_path")))
    .map((row) => ({
      cursor: checkoutKey(["repository", retainedText(row, "name")]),
      value: {
        kind: "repository",
        name: retainedText(row, "name"),
        locator: retainedText(row, "locator"),
        locatorFingerprint: retainedDigest(row, "locator_fingerprint"),
        requestedBase: retainedNullableText(row, "requested_base"),
        creationCommit: retainedText(row, "creation_commit"),
        primaryBranch: retainedText(row, "primary_branch"),
        objectFormat: retainedObjectFormat(row, "object_format"),
        checkoutPath: retainedPath(row, "checkout_path"),
      },
    }));
}

function readCheckoutWorktrees(
  storage: OwnerStorage,
  checkoutPaths: ReadonlySet<string>,
): { cursor: string; value: Record<string, unknown> }[] {
  return rows(
    storage,
    `SELECT repository_name, name, requested_branch, requested_base,
            creation_commit, checkout_path
       FROM workspace_worktrees ORDER BY repository_name, name`,
  )
    .filter((row) => checkoutPaths.has(retainedPath(row, "checkout_path")))
    .map((row) => ({
      cursor: checkoutKey([
        "worktree",
        retainedText(row, "repository_name"),
        retainedText(row, "name"),
      ]),
      value: {
        kind: "worktree",
        repositoryName: retainedText(row, "repository_name"),
        name: retainedText(row, "name"),
        requestedBranch: retainedText(row, "requested_branch"),
        requestedBase: retainedNullableText(row, "requested_base"),
        creationCommit: retainedText(row, "creation_commit"),
        checkoutPath: retainedPath(row, "checkout_path"),
      },
    }));
}

/** Answer one admitted read from one committed reading of this owner. */
export function answerRead(
  storage: OwnerStorage,
  runId: string,
  read: ReadOperation,
): Record<string, unknown> {
  if (read.operation === "inspect") {
    return readInspection(storage, runId);
  }
  if (read.operation === "history") {
    return readHistoryPage(storage, runId, read.anchor, read.after);
  }
  return readForkSourcePage(
    storage,
    runId,
    read.checkpointEventId,
    read.section,
    read.anchor,
    read.after,
  );
}
