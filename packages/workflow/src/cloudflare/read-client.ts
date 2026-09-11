/**
 * Reading a run's owner from the runner, over the no-acquisition plane.
 *
 * Every answer is parsed before it is believed, and a paged answer is held to
 * the anchor its first page chose: a missing, repeated, reordered, wrong-run or
 * changed-anchor page fails the whole read rather than producing a shorter
 * history nobody asked for. Nothing partial is ever published.
 *
 * The transport is narrow on purpose. It sends one request and returns one
 * response, and knows nothing about runs, anchors or authority — a host wires
 * it to an ordinary HTTP request, and a test wires it to the object directly.
 */

import { Err, Ok, type Operation, type Result } from "effection";
import { parseMembers, requireMemberNames } from "../storage/members.ts";
import type { WorkflowStorageError } from "../storage/errors.ts";
import { WorkflowRecordMalformedError, WorkflowRunNotFoundError } from "../storage/errors.ts";
import { type DurableEvent, parseDurableEvent } from "@executablemd/durable-streams";
import type {
  DefinitionRetrieval,
  DocumentExecutionRecord,
  WorkflowRunRecord,
} from "../storage/record.ts";
import {
  parseRemoteExecution,
  parseRemoteRetrieval,
  parseRemoteRunRecord,
  RemoteRecordError,
} from "../remote/records.ts";
import { READ_PAGE_BYTES, READ_PAGE_ENTRIES, READ_REQUEST_ENVELOPE } from "./read-plane.ts";
import { decodeBase64, sha256Hex } from "./encoding.ts";
import {
  compareUtf8,
  parseWorkspaceRootManifest,
  SHA256,
  WORKSPACE_ROOT_DOMAIN,
  WORKSPACE_ROOT_FORMAT,
} from "../workspace/root-manifest.ts";
import { decodeContentManifest } from "../workspace/content-manifest.ts";
import type {
  RemoteBlob,
  RemoteCheckout,
  RemoteForkSource,
  RemoteManifest,
  RemoteReadPlane,
  RemoteStoredRoot,
  RetainedHistory,
  RetainedInspection,
  RetainedProvenance,
  RetainedRow,
} from "../remote/read.ts";
import { type PrivateRefusal, privateRefusal, storageFailure } from "./client.ts";

/**
 * One request out, one response back.
 *
 * The admission travels beside the body rather than inside it, because the
 * owner decides on the release before it decodes anything.
 */
export interface ReadTransport {
  send(admission: ReadAdmission, body: string): Operation<string>;
}

/** What a request carries outside its body. */
export interface ReadAdmission {
  readonly release: string;
  readonly token: string;
  readonly runId: string;
}

/** The most pages one answer may take before it is refused as unbounded. */
const MAX_PAGES = 4096;

/**
 * The most serialized bytes one fork-source answer may carry.
 *
 * Measured over the finished UTF-8 encoding, and derived from what a page may
 * hold rather than picked: one page of rows, the checkpoint the answer names —
 * an event id, bounded by the journal row that carries it being a member — and
 * the fixed envelope of anchors, roots, positions and counts around them. The
 * rows are nested values rather than strings inside a string, so what a page
 * measured is what an answer carries. A smaller number would make a retained
 * selection this build accepts impossible to read back.
 */
export const FORK_SOURCE_ANSWER_BYTES = 2 * READ_PAGE_BYTES + READ_REQUEST_ENVELOPE;

/**
 * The most serialized bytes one public answer may carry.
 *
 * Public history and inspection are paged by count rather than by bytes, and
 * one retained record may be as large as the transaction that wrote it, so
 * what bounds these is not what bounds a fork source. This is the capacity
 * these operations already had, kept as it was: a fork source's own arithmetic
 * is a fact about fork-source pages, and adopting it here would make retained
 * history that this plane could read unreadable.
 */
export const PUBLIC_ANSWER_BYTES = 1638400;

/**
 * Which ceiling one answer is held to, decided by what was asked.
 *
 * The operation is this build's own, chosen before the request is sent, so an
 * answer never selects the bound it is measured against.
 */
function answerBytes(operation: unknown): number {
  return operation === "fork-source" ? FORK_SOURCE_ANSWER_BYTES : PUBLIC_ANSWER_BYTES;
}

function fail(reason: string): never {
  throw new RemoteRecordError(`the owner returned a malformed read answer: ${reason}`);
}

function failure(reason: string, path: string): Error {
  return new RemoteRecordError(`the owner returned a malformed read answer at ${path}: ${reason}`);
}

function members(value: unknown, names: readonly string[]): Map<string, unknown> {
  const found = parseMembers(value, "$", failure);
  requireMemberNames(found, names, "$", failure);
  return found;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") {
    return fail(`it did not name ${what}`);
  }
  return value;
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    return fail(`it did not carry ${what}`);
  }
  return value;
}

/**
 * Open one read plane over this transport.
 *
 * `expectedRunId` is what every answer is held to. An owner that answered about
 * another run is not this run's owner, whatever the answer says.
 */
export function cloudflareReadPlane(
  transport: ReadTransport,
  release: string,
  token: () => Operation<string>,
  expectedRunId: string,
): RemoteReadPlane {
  function* ask(read: Record<string, unknown>): Operation<unknown> {
    const admission = { release, token: yield* token(), runId: expectedRunId };
    const raw = yield* transport.send(admission, JSON.stringify(read));
    if (new TextEncoder().encode(raw).length > answerBytes(read["operation"])) {
      // An answer larger than one may be is not one this build reads, and
      // reading it far enough to find out would be reading it.
      return fail("it exceeded the bytes one answer may carry");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      // Invalid JSON becomes the same bounded malformed-owner failure that
      // every unreadable answer does; no parser diagnostic escapes.
      return fail("it was not one JSON object");
    }
    const answer = members(decoded, ["outcome", "value", "refusal"]);
    if (answer.get("outcome") === "refused") {
      // Parsed into this build's closed vocabulary before it becomes an error,
      // so no refusal spelling reaches a caller.
      const refusal = privateRefusal(text(answer.get("refusal"), "a refusal"));
      // Nothing stored here is a different fact from storage this build cannot
      // use, and a caller listing an owner acts on the difference.
      throw refusal === "command:absent"
        ? new WorkflowRunNotFoundError(expectedRunId)
        : storageFailure(refusal);
    }
    if (answer.get("outcome") !== "performed") {
      return fail("it named no outcome this build reads");
    }
    return answer.get("value");
  }

  return {
    runId: expectedRunId,

    *inspect(): Operation<Result<RetainedInspection>> {
      try {
        return Ok(parseInspection(yield* ask({ operation: "inspect" }), expectedRunId));
      } catch (error) {
        return Err(translateRead(error));
      }
    },

    *history(): Operation<Result<RetainedHistory>> {
      try {
        return Ok(yield* pages(ask, (anchor, after) => ({ operation: "history", anchor, after })));
      } catch (error) {
        return Err(translateRead(error));
      }
    },

    *forkSource(checkpointEventId: string): Operation<Result<RemoteForkSource>> {
      try {
        return Ok(yield* collectForkSource(ask, expectedRunId, checkpointEventId));
      } catch (error) {
        return Err(translateRead(error));
      }
    },
  };
}

function parseEvent(record: string): DurableEvent {
  const parsed = parseDurableEvent(record);
  if (!parsed.ok) {
    return fail("it carried a retained event this build cannot read");
  }
  return parsed.value;
}

/**
 * Walk one anchored page sequence to its end, or refuse the whole answer.
 *
 * The first page chooses the anchor and every later page is held to it and to
 * the cursor it was asked to continue from. A page that skips, repeats,
 * reorders or changes the anchor is a page of some other snapshot, and there is
 * no partial answer to give.
 */
function* pages(
  ask: (read: Record<string, unknown>) => Operation<unknown>,
  request: (anchor: string | null, after: string | null) => Record<string, unknown>,
): Operation<RetainedHistory> {
  const entries: RetainedRow[] = [];
  const seen = new Set<string>();
  let anchor: string | null | undefined;
  let after: string | null = null;
  let retainedRoots: ReadonlySet<string> = new Set();
  let inherited: ReadonlyMap<string, RetainedProvenance> = new Map();

  for (let page = 0; ; page += 1) {
    if (page > MAX_PAGES) {
      return fail("it did not terminate its anchored answer");
    }
    const found = members(yield* ask(request(anchor ?? null, after)), [
      "anchor",
      "after",
      "rows",
      "done",
      "retainedRoots",
      "provenance",
    ]);
    const offered = found.get("anchor");
    const expected = anchor === undefined ? offered : anchor;
    if (offered !== expected || found.get("after") !== after) {
      return fail("a page did not continue its anchored snapshot");
    }
    anchor = offered === null ? null : text(offered, "an anchor");
    const rows = list(found.get("rows"), "rows");
    if (rows.length > READ_PAGE_ENTRIES) {
      return fail("a page carried more rows than one may");
    }
    if (anchor === null) {
      if (rows.length > 0 || found.get("done") !== true || after !== null) {
        return fail("an empty snapshot carried rows or did not terminate");
      }
      return { entries, retainedRoots, inherited };
    }
    if (rows.length === 0) {
      return fail("a page of an anchored snapshot carried no rows");
    }
    for (const row of rows) {
      const entry = members(row, ["eventId", "record", "workspaceRootId"]);
      const eventId = text(entry.get("eventId"), "an event");
      if (seen.has(eventId)) {
        return fail("a page repeated an event");
      }
      seen.add(eventId);
      entries.push({
        eventId,
        event: parseEvent(text(entry.get("record"), "a retained record")),
        workspaceRootId: text(entry.get("workspaceRootId"), "a Workspace root"),
      });
      after = eventId;
    }
    if (found.get("done") !== true) {
      continue;
    }
    if (after !== anchor) {
      return fail("a page terminated short of its anchor");
    }
    retainedRoots = new Set(
      list(found.get("retainedRoots"), "retained roots").map((root) => text(root, "a root")),
    );
    inherited = new Map(
      list(found.get("provenance"), "provenance").map((row) => {
        const entry = members(row, ["eventId", "sourceRunId", "sourceEventId"]);
        return [
          text(entry.get("eventId"), "an event"),
          Object.freeze({
            sourceRunId: text(entry.get("sourceRunId"), "a source run"),
            sourceEventId: text(entry.get("sourceEventId"), "a source event"),
          }),
        ];
      }),
    );
    return { entries, retainedRoots, inherited };
  }
}

function parseInspection(value: unknown, expectedRunId: string): RetainedInspection {
  const found = members(value, [
    "record",
    "executions",
    "retrieval",
    "journalFrontier",
    "currentWorkspaceRootId",
    "lineage",
  ]);
  const record = parseRemoteRunRecord(found.get("record"));
  if (record.runId !== expectedRunId) {
    return fail("it described another run");
  }
  const executions = list(found.get("executions"), "executions").map((entry) =>
    parseRemoteExecution(entry),
  );
  const frontier = found.get("journalFrontier");
  const lineage = found.get("lineage");
  const retrieval = parseRemoteRetrieval(found.get("retrieval"));

  return Object.freeze({
    record,
    executions: Object.freeze(executions),
    ...(retrieval === undefined ? {} : { retrieval }),
    ...(frontier === null
      ? {}
      : {
          journalFrontier: Object.freeze({
            eventId: text(
              members(frontier, ["eventId", "workspaceRootId"]).get("eventId"),
              "an event",
            ),
            workspaceRootId: text(
              members(frontier, ["eventId", "workspaceRootId"]).get("workspaceRootId"),
              "a Workspace root",
            ),
          }),
        }),
    currentWorkspaceRootId: text(found.get("currentWorkspaceRootId"), "a Workspace root"),
    ...(lineage === null
      ? {}
      : {
          lineage: Object.freeze(parseLineage(lineage)),
        }),
  });
}

function parseLineage(value: unknown) {
  const found = members(value, ["sourceRunId", "checkpointEventId", "checkpointWorkspaceRootId"]);
  return {
    sourceRunId: text(found.get("sourceRunId"), "a source run"),
    checkpointEventId: text(found.get("checkpointEventId"), "a checkpoint"),
    checkpointWorkspaceRootId: text(found.get("checkpointWorkspaceRootId"), "a Workspace root"),
  };
}

/** Any failure from the read plane, as a provider-neutral one. */
function translateRead(error: unknown): WorkflowStorageError {
  if (error instanceof WorkflowRecordMalformedError || error instanceof WorkflowRunNotFoundError) {
    return error;
  }
  if (error instanceof RemoteRecordError) {
    return new WorkflowRecordMalformedError(
      "record this run's owner returned",
      "it is not a record this build can read",
    );
  }
  return storageFailure(readRefusal(error));
}

function readRefusal(error: unknown): PrivateRefusal {
  return error instanceof Error && "refusal" in error
    ? privateRefusal(String(Reflect.get(error, "refusal")))
    : "command:unavailable";
}

/**
 * Read every section of one fork source, and hold them all to one selection.
 *
 * Each section is its own anchored sequence; the anchor covers the whole
 * selection rather than the checkpoint alone, so a section that arrived from a
 * different selection is refused rather than mixed in. The head members are
 * checked to agree across every page of every section for the same reason.
 */
function* collectForkSource(
  ask: (read: Record<string, unknown>) => Operation<unknown>,
  sourceRunId: string,
  checkpointEventId: string,
): Operation<RemoteForkSource> {
  let head: Map<string, unknown> | undefined;
  let anchor: string | undefined;

  /**
   * Read one section to its end, holding every page to the same selection.
   *
   * The cursor is not taken on trust: it must be the identity of the last row
   * the page actually carried, so a page cannot advance past rows it did not
   * send, and each page must begin where the sequence has reached. Identities
   * are unique within a section, and the sorted sections are required to
   * arrive in the order they are sorted in, so a sequence cannot repeat, skip
   * or reorder the members a destination will retain. The declared total is
   * pinned by the first page and must describe what finally arrived.
   */
  function* section(name: string, order: "sorted" | "journal"): Operation<unknown[]> {
    const carried: unknown[] = [];
    const seen = new Set<string>();
    let after: number | null = null;
    let declared: number | undefined;
    let previous: readonly string[] | undefined;

    for (let page = 0; ; page += 1) {
      if (page > MAX_PAGES) {
        return fail("it did not terminate a fork-source section");
      }
      const found = members(
        yield* ask({
          operation: "fork-source",
          checkpointEventId,
          section: name,
          anchor: anchor ?? null,
          after,
        }),
        [
          "anchor",
          "after",
          "section",
          "checkpointEventId",
          "checkpointWorkspaceRootId",
          "runRecordWorkspaceRootId",
          "rootImportWorkspaceRootId",
          "rows",
          "from",
          "cursor",
          "done",
          "total",
        ],
      );
      const offered = text(found.get("anchor"), "a selection anchor");
      if (anchor === undefined) {
        anchor = offered;
        head = found;
      }
      if (
        offered !== anchor ||
        found.get("section") !== name ||
        found.get("after") !== after ||
        found.get("checkpointEventId") !== checkpointEventId ||
        found.get("checkpointWorkspaceRootId") !== head?.get("checkpointWorkspaceRootId") ||
        found.get("runRecordWorkspaceRootId") !== head?.get("runRecordWorkspaceRootId") ||
        found.get("rootImportWorkspaceRootId") !== head?.get("rootImportWorkspaceRootId")
      ) {
        return fail("a page did not continue its selection");
      }
      const total = count(found.get("total"), "a section total");
      if (declared === undefined) {
        declared = total;
      }
      if (total !== declared) {
        // The section changed size under the sequence, so its pages describe
        // two different answers.
        return fail("a page redeclared the size of its section");
      }

      const rows = list(found.get("rows"), "rows");
      if (rows.length > READ_PAGE_ENTRIES) {
        return fail("a page carried more rows than one may");
      }
      // Where the owner says this page begins has to be where the sequence
      // has got to. A page beginning anywhere else skipped members or sent
      // some of them twice, whatever its cursor says.
      if (count(found.get("from"), "a section position") !== carried.length) {
        return fail("a page did not begin where the sequence had reached");
      }
      for (const row of rows) {
        const identity = identityOf(name, row);
        if (seen.has(identity)) {
          return fail("a section repeated a member");
        }
        if (order === "journal") {
          // The one order nothing here can derive, so the owner states it per
          // member and it must advance by one from where the section stood.
          // Two rows swapped inside a page carry each other's positions.
          if (positionOf(row) !== carried.length) {
            return fail("a member did not stand where the section had reached");
          }
        }
        if (order === "sorted") {
          const sorts = orderOf(name, row);
          if (previous !== undefined && !precedes(previous, sorts)) {
            return fail("a section carried its members out of order");
          }
          previous = sorts;
        }
        seen.add(identity);
        carried.push(row);
      }

      // Derived from what arrived, never believed: the page ended on the last
      // row it actually carried, so that is the only position it may name.
      const ended: number | null = rows.length === 0 ? after : carried.length - 1;
      const cursor = found.get("cursor");
      if (found.get("done") === true) {
        if (carried.length !== declared) {
          return fail("a section terminated short of what it declared");
        }
        // A terminal page still describes where it ended.
        if (cursor !== ended) {
          return fail("a terminal page did not name the member it ended on");
        }
        return carried;
      }
      if (rows.length === 0) {
        return fail("a page of an unfinished section carried no rows");
      }
      if (cursor !== ended) {
        return fail("a page did not advance to the member it ended on");
      }
      after = ended;
    }
  }

  const inherited = (yield* section("inherited", "journal")).map((row) => {
    const found = members(row, ["eventId", "record", "workspaceRootId", "position"]);
    const record = text(found.get("record"), "a retained record");
    // Parsed to prove it is a record this build can read, and then kept
    // exactly: a destination inserts these bytes, and a spelling reconstructed
    // from the parse would be a different history.
    parseEvent(record);
    return {
      eventId: text(found.get("eventId"), "an event"),
      record,
      workspaceRootId: digest(found.get("workspaceRootId"), "a Workspace root"),
    };
  });
  // These four arrive sorted by identities this side can derive, so a
  // reordering is a sequence this build did not produce. The inherited rows
  // arrive in the source's own journal order, which nothing here can derive:
  // what holds them is that each page begins where the sequence reached, that
  // no identity arrives twice, and that the whole selection is anchored.
  const roots = (yield* section("roots", "sorted")).map((row) => parseStoredRoot(row));
  const manifests = (yield* section("manifests", "sorted")).map((row) => parseManifest(row));
  const blobs = (yield* section("blobs", "sorted")).map((row) => parseBlob(row));
  const checkouts = (yield* section("checkouts", "sorted")).map((row) => parseCheckout(row));

  validateClosure(inherited, roots, manifests, blobs);

  const checkpointWorkspaceRootId = digest(
    head?.get("checkpointWorkspaceRootId"),
    "a checkpoint Workspace root",
  );
  const runRecordWorkspaceRootId = digest(
    head?.get("runRecordWorkspaceRootId"),
    "a Workspace root",
  );
  const rootImportWorkspaceRootId = digest(
    head?.get("rootImportWorkspaceRootId"),
    "a Workspace root",
  );
  // All three heads, not just the checkpoint. A destination writes its own run
  // record and root import against these, and it cannot write against a root
  // it was not given.
  const carried = new Set(roots.map((root) => root.rootId));
  for (const rootId of [
    checkpointWorkspaceRootId,
    runRecordWorkspaceRootId,
    rootImportWorkspaceRootId,
  ]) {
    if (!carried.has(rootId)) {
      return fail("a head names a Workspace root the selection did not carry");
    }
  }
  validateCheckouts(checkouts, roots, checkpointWorkspaceRootId);
  return Object.freeze({
    sourceRunId,
    anchor: anchor ?? fail("it answered no page of the selection"),
    checkpointEventId,
    checkpointWorkspaceRootId,
    runRecordWorkspaceRootId,
    rootImportWorkspaceRootId,
    inherited: Object.freeze(inherited),
    roots: Object.freeze(roots),
    manifests: Object.freeze(manifests),
    blobs: Object.freeze(blobs),
    checkouts: Object.freeze(checkouts),
  });
}

/**
 * Prove the transported bytes really are the Workspace this selection names.
 *
 * A digest proves its own bytes, so a manifest or blob that arrived under the
 * wrong name is caught where it is parsed. What is left is the shape of the
 * closure: every root the prefix names is here, every root's own manifest
 * derives exactly the references it was sent with, every content manifest a
 * root needs is here and decodes to the size it claims, every chunk those
 * manifests name is a blob that is here, and nothing arrived that the selection
 * does not need. Anything less would let a destination retain a history whose
 * Workspace cannot be restored.
 */
function validateClosure(
  inherited: readonly { readonly workspaceRootId: string }[],
  roots: readonly RemoteStoredRoot[],
  manifests: readonly RemoteManifest[],
  blobs: readonly RemoteBlob[],
): void {
  const held = new Set(roots.map((root) => root.rootId));
  for (const row of inherited) {
    if (!held.has(row.workspaceRootId)) {
      return fail("a selected row names a Workspace root the selection did not carry");
    }
  }

  const manifestsByHash = new Map(manifests.map((manifest) => [manifest.hash, manifest]));
  const blobsByHash = new Map(blobs.map((blob) => [blob.hash, blob]));
  if (manifestsByHash.size !== manifests.length || blobsByHash.size !== blobs.length) {
    return fail("the selection carried one piece twice");
  }

  // Derived from the roots themselves rather than believed: a reference set the
  // owner sent is only correct if the root's own manifest produces it.
  for (const blob of blobs) {
    // The bytes themselves, against the size the destination will persist
    // beside them. The digest proves which bytes these are and the chunk
    // comparison proves the manifest agrees, but two coordinated wrong sizes
    // satisfy both — only the actual length settles it.
    if (blob.content.byteLength !== blob.size) {
      return fail("a selected blob disagreed with its recorded size");
    }
  }

  const neededManifests = new Set<string>();
  const neededBlobs = new Set<string>();
  for (const root of roots) {
    const parsed = parseWorkspaceRootManifest(root.manifest, (reason) =>
      fail(`a selected root is not a canonical Workspace root: ${reason}`),
    );
    const declared = new Set<string>();
    const sizes = new Map<string, number>();
    for (const entry of parsed.entries) {
      if (entry.kind === "file") {
        declared.add(entry.manifest);
        const already = sizes.get(entry.manifest);
        if (already !== undefined && already !== entry.size) {
          // Two entries sharing one content identity must describe the same
          // bytes, so they cannot claim different sizes.
          return fail("a selected root gave one content two sizes");
        }
        sizes.set(entry.manifest, entry.size);
      }
    }
    if (!sameOrder(canonical(declared), root.manifestHashes)) {
      return fail("a selected root disagreed with the content references it carried");
    }
    const rootBlobs = new Set<string>();
    for (const hash of declared) {
      neededManifests.add(hash);
      const manifest = manifestsByHash.get(hash);
      if (manifest === undefined) {
        return fail("a selected root names a manifest the selection did not carry");
      }
      const content = decodeContentManifest(manifest.encoded, (reason) =>
        fail(`a selected manifest is not canonically encoded: ${reason}`),
      );
      if (content.size !== manifest.size) {
        return fail("a selected manifest disagreed with the size it describes");
      }
      // And with the file the root says it holds. A destination restores that
      // entry from these bytes, so a root claiming another length describes a
      // Workspace this content cannot produce.
      if (sizes.get(hash) !== content.size) {
        return fail("a selected root disagreed with the content it names");
      }
      for (const chunk of content.chunks) {
        rootBlobs.add(chunk.hash);
        neededBlobs.add(chunk.hash);
        const blob = blobsByHash.get(chunk.hash);
        if (blob === undefined) {
          return fail("a selected manifest names a blob the selection did not carry");
        }
        if (blob.size !== chunk.size) {
          return fail("a selected chunk disagreed with the blob it names");
        }
      }
    }
    if (!sameOrder(canonical(rootBlobs), root.blobHashes)) {
      return fail("a selected root disagreed with the blob references it carried");
    }
  }

  // Nothing beyond the closure: an extra piece is data the selection does not
  // account for, and a destination retaining it would hold content no root of
  // its own refers to.
  if (!sameSet(neededManifests, new Set(manifestsByHash.keys()))) {
    return fail("the selection carried a manifest no selected root requires");
  }
  if (!sameSet(neededBlobs, new Set(blobsByHash.keys()))) {
    return fail("the selection carried a blob no selected manifest requires");
  }
}

/**
 * Prove the checkouts are a graph a destination can retain.
 *
 * Each one names a directory the checkpoint's Workspace actually holds, so a
 * fork does not inherit a checkout with nowhere to live; each Worktree names a
 * Repository that came with it; and nothing is named twice, because the
 * retained schema keys these by name and by path.
 */
function validateCheckouts(
  checkouts: readonly RemoteCheckout[],
  roots: readonly RemoteStoredRoot[],
  checkpointWorkspaceRootId: string,
): void {
  const checkpoint = roots.find((root) => root.rootId === checkpointWorkspaceRootId);
  if (checkpoint === undefined) {
    return fail("the checkpoint names a Workspace root the selection did not carry");
  }
  const directories = new Set<string>();
  for (const entry of parseWorkspaceRootManifest(checkpoint.manifest, (reason) =>
    fail(`a selected root is not a canonical Workspace root: ${reason}`),
  ).entries) {
    if (entry.kind === "directory") {
      directories.add(entry.path);
    }
  }

  const repositories = new Set<string>();
  const worktrees = new Set<string>();
  const paths = new Set<string>();
  for (const checkout of checkouts) {
    if (!directories.has(checkout.checkoutPath)) {
      return fail("a selected checkout names a directory the checkpoint Workspace does not hold");
    }
    if (paths.has(checkout.checkoutPath)) {
      return fail("two selected checkouts name one directory");
    }
    paths.add(checkout.checkoutPath);
    if (checkout.kind === "repository") {
      if (repositories.has(checkout.name)) {
        return fail("one Repository name was selected twice");
      }
      repositories.add(checkout.name);
    }
  }
  for (const checkout of checkouts) {
    if (checkout.kind !== "worktree") {
      continue;
    }
    const identity = checkoutKey(["worktree", checkout.repositoryName, checkout.name]);
    if (worktrees.has(identity)) {
      return fail("one Worktree identity was selected twice");
    }
    worktrees.add(identity);
    if (!repositories.has(checkout.repositoryName)) {
      // A checkout belonging to nothing. The destination would retain a
      // Worktree of a Repository it does not have.
      return fail("a selected Worktree names a Repository the selection did not carry");
    }
  }
}

/**
 * A root's references, in the one order a root is retained with.
 *
 * The same derivation the Workspace root implementation makes: the identities
 * a root's own manifest produces, deduplicated, ordered by their UTF-8 bytes.
 */
function canonical(references: ReadonlySet<string>): string[] {
  return [...references].sort(compareUtf8);
}

/**
 * Element for element, not member for member.
 *
 * A destination compares a root's reference arrays exactly when it retains
 * them, so an array that is the right set in the wrong order — or with one
 * identity twice — is a source it would refuse later. It is refused here
 * instead, where the whole selection can still be rejected.
 */
function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, at) => value === right[at]);
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

/**
 * What names one member of a section.
 *
 * The same key the owner pages by, derived here from the row itself so a
 * cursor is checked against what arrived rather than taken from beside it.
 */
function identityOf(section: string, row: unknown): string {
  const found = parseMembers(row, "$", failure);
  if (section === "inherited") {
    return text(found.get("eventId"), "an event");
  }
  if (section === "roots") {
    return text(found.get("rootId"), "a Workspace root");
  }
  if (section === "manifests" || section === "blobs") {
    return text(found.get("hash"), "a content identity");
  }
  if (found.get("kind") === "repository") {
    return checkoutKey(["repository", text(found.get("name"), "a name")]);
  }
  return checkoutKey([
    "worktree",
    text(found.get("repositoryName"), "a Repository"),
    text(found.get("name"), "a name"),
  ]);
}

/**
 * One checkout's identity, as a key nothing else can spell.
 *
 * The owner pages by this exact string. Repository and Worktree names are
 * retained text and may hold any character, so `("a:b", "c")` and
 * `("a", "b:c")` are two retained Worktrees that a separator would join into
 * one key: the client would refuse a valid source as a duplicate, or continue
 * from the wrong member. A JSON array separates the parts it escapes.
 */
function checkoutKey(parts: readonly string[]): string {
  return JSON.stringify(parts);
}

/** Where one member of a journal-ordered section stands in its selection. */
function positionOf(row: unknown): number {
  return count(parseMembers(row, "$", failure).get("position"), "a position");
}

/**
 * How the owner sorted this section, as the parts it sorted by.
 *
 * Compared part by part rather than as one string: the checkouts are sorted by
 * a Repository name and then a Worktree name, and joining those into one string
 * would order two names differently than sorting them separately does.
 */
function orderOf(section: string, row: unknown): readonly string[] {
  const found = parseMembers(row, "$", failure);
  if (section === "roots") {
    return [text(found.get("rootId"), "a Workspace root")];
  }
  if (section === "manifests" || section === "blobs") {
    return [text(found.get("hash"), "a content identity")];
  }
  if (found.get("kind") === "repository") {
    return ["0", text(found.get("name"), "a name")];
  }
  return [
    "1",
    text(found.get("repositoryName"), "a Repository"),
    text(found.get("name"), "a name"),
  ];
}

/** Whether one member sorts strictly before another, by UTF-8 bytes. */
function precedes(previous: readonly string[], next: readonly string[]): boolean {
  for (let at = 0; at < Math.max(previous.length, next.length); at += 1) {
    const left = previous[at];
    const right = next[at];
    if (left === undefined || right === undefined) {
      return right !== undefined;
    }
    const order = compareUtf8(left, right);
    if (order !== 0) {
      return order < 0;
    }
  }
  return false;
}

function parseStoredRoot(value: unknown): RemoteStoredRoot {
  const found = members(value, [
    "rootId",
    "formatVersion",
    "manifest",
    "manifestHashes",
    "blobHashes",
  ]);
  const manifest = text(found.get("manifest"), "a root manifest");
  const rootId = digest(found.get("rootId"), "a Workspace root");
  if (found.get("formatVersion") !== WORKSPACE_ROOT_FORMAT) {
    return fail("a selected root is not the Workspace root format this build writes");
  }
  // The identity is the hash of the bytes, so a root that did not produce it
  // is not the root it says it is.
  if (sha256Hex(`${WORKSPACE_ROOT_DOMAIN}${manifest}`) !== rootId) {
    return fail("a selected root disagreed with its own identity");
  }
  return Object.freeze({
    rootId,
    formatVersion: count(found.get("formatVersion"), "a format version"),
    manifest,
    manifestHashes: Object.freeze(
      list(found.get("manifestHashes"), "manifest hashes").map((hash) =>
        digest(hash, "a manifest"),
      ),
    ),
    blobHashes: Object.freeze(
      list(found.get("blobHashes"), "blob hashes").map((hash) => digest(hash, "a blob")),
    ),
  });
}

function parseManifest(value: unknown): RemoteManifest {
  const found = members(value, ["hash", "size", "lastSeen", "encoded"]);
  const encoded = decodeBase64(text(found.get("encoded"), "encoded bytes"));
  const hash = digest(found.get("hash"), "a manifest");
  // Content-addressed, so the bytes decide the name here exactly as they do
  // for a blob. A manifest under the wrong name is not the manifest a root
  // referred to.
  if (sha256Hex(encoded) !== hash) {
    return fail("a selected manifest disagreed with its own identity");
  }
  return Object.freeze({
    hash,
    size: count(found.get("size"), "a size"),
    lastSeen: count(found.get("lastSeen"), "a timestamp"),
    encoded,
  });
}

function parseBlob(value: unknown): RemoteBlob {
  const found = members(value, ["hash", "size", "lastSeen", "content"]);
  const content = decodeBase64(text(found.get("content"), "content bytes"));
  const hash = digest(found.get("hash"), "a blob");
  // Content-addressed, so the bytes decide the name. A piece whose bytes do
  // not hash to it is not the piece the root referred to.
  if (sha256Hex(content) !== hash) {
    return fail("a selected blob disagreed with its own identity");
  }
  return Object.freeze({
    hash,
    size: count(found.get("size"), "a size"),
    lastSeen: count(found.get("lastSeen"), "a timestamp"),
    content,
  });
}

function parseCheckout(value: unknown): RemoteCheckout {
  const probe = parseMembers(value, "$", failure);
  if (probe.get("kind") === "repository") {
    const found = members(value, [
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
    return Object.freeze({
      kind: "repository",
      name: text(found.get("name"), "a name"),
      locator: text(found.get("locator"), "a locator"),
      locatorFingerprint: digest(found.get("locatorFingerprint"), "a fingerprint"),
      requestedBase: optional(found.get("requestedBase")),
      creationCommit: text(found.get("creationCommit"), "a commit"),
      primaryBranch: text(found.get("primaryBranch"), "a branch"),
      objectFormat: objectFormat(found.get("objectFormat")),
      checkoutPath: workspacePath(found.get("checkoutPath")),
    });
  }
  const found = members(value, [
    "kind",
    "repositoryName",
    "name",
    "requestedBranch",
    "requestedBase",
    "creationCommit",
    "checkoutPath",
  ]);
  if (found.get("kind") !== "worktree") {
    return fail("a selected checkout named no kind this build reads");
  }
  return Object.freeze({
    kind: "worktree",
    repositoryName: text(found.get("repositoryName"), "a Repository"),
    name: text(found.get("name"), "a name"),
    requestedBranch: text(found.get("requestedBranch"), "a branch"),
    requestedBase: optional(found.get("requestedBase")),
    creationCommit: text(found.get("creationCommit"), "a commit"),
    checkoutPath: workspacePath(found.get("checkoutPath")),
  });
}

/** One of the object formats this build writes. */
function objectFormat(value: unknown): "sha1" | "sha256" {
  const candidate = text(value, "an object format");
  if (candidate !== "sha1" && candidate !== "sha256") {
    return fail("it did not name an object format");
  }
  return candidate;
}

/** A Workspace-relative path, which is absolute within the Workspace. */
function workspacePath(value: unknown): string {
  const candidate = text(value, "a checkout path");
  if (!candidate.startsWith("/")) {
    return fail("it did not name a Workspace path");
  }
  return candidate;
}

/** A content identity, held to the shape every digest in this build has. */
function digest(value: unknown, what: string): string {
  const candidate = text(value, `${what} identity`);
  if (!SHA256.test(candidate)) {
    return fail(`it did not name ${what}`);
  }
  return candidate;
}

function count(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return fail(`it did not name ${what}`);
  }
  return value;
}

function optional(value: unknown): string | null {
  return value === null ? null : text(value, "text");
}
