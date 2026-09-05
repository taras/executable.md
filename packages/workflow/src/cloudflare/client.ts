/**
 * The runner's side of the private protocol.
 *
 * This is the only place that knows both languages. Above it, `src/remote/**`
 * speaks in workflow records and Workspace roots; below it, the connection
 * carries private commands and a private refusal union. Translating between
 * them here is what keeps the neutral code neutral, and what keeps the private
 * shapes private.
 *
 * Nothing arrives as a semantic value because the owner said so. A performed
 * answer is parsed into a record, a manifest or a verified content piece before
 * anything above can see it, and a refusal is narrowed to the exact union this
 * release declares. Both sides are the same build — admission proved that — so
 * a category this build has never heard of is not a new failure to report
 * upward, it is a channel that is not what it claims to be, and the connection
 * fails closed.
 *
 * Content is verified again on arrival. The owner validated it before sending,
 * and that says nothing about what happened in between; a digest is cheap and
 * the alternative is materializing bytes that are not the bytes the root names.
 *
 * The journal is reassembled here from anchored pages, and the assembly is
 * checked rather than assumed: each page must continue the previous one, name
 * no event twice, and end exactly at the anchor. A page that skipped, repeated
 * or reordered an event closes the connection before a single event reaches a
 * caller — half a journal that looks whole is worse than no journal.
 */

import { Err, Ok, type Operation, type Result } from "effection";
import { serializeDurableEvent } from "@executablemd/durable-streams";
import type { JournalEntry } from "../storage/api.ts";
import { parseMembers, requireMemberNames } from "../storage/members.ts";
import type { DefinitionRetrieval, WorkflowRunRecord } from "../storage/record.ts";
import type { CommitIntent, OwnerLink, StartingFrontier } from "../remote/collector.ts";
import type { CommitDecision } from "../remote/publication.ts";
import { OwnerLinkError, type OwnerAnswer, type OwnerConnection } from "../remote/client.ts";
import {
  parseRemoteExecution,
  parseRemoteInvocationSnapshot,
  parseRemoteJournalEntry,
  type RemoteInvocationSnapshot,
  parseRemoteRetrieval,
  parseRemoteRunRecord,
  RemoteRecordError,
} from "../remote/records.ts";
import {
  type RemoteContent,
  type RemoteContentRequest,
  type RemoteFrontierSnapshot,
  type RemoteReadLink,
  startingFrontier,
} from "../remote/read.ts";
import {
  parseWorkspaceRootManifest,
  SHA256,
  WORKSPACE_ROOT_DOMAIN,
  type WorkspaceRootManifest,
} from "../workspace/root-manifest.ts";
import { decodeContentManifest } from "../workspace/content-manifest.ts";
import {
  EXECUTION_PAGE_BYTES,
  EXECUTION_PAGE_ENTRIES,
  executionPageBytes,
  JOURNAL_PAGE_ENTRIES,
  MAX_CONTENT_BYTES,
} from "./commands.ts";
import type { RemoteRunLink, RemoteWorkspaceLink } from "../remote/database.ts";
import { isSchemaVersion, SCHEMA_VERSION } from "../sqlite/workflow-schema.ts";
import { canonicalJson } from "../storage/record.ts";
import {
  WorkflowDatabaseCorruptError,
  WorkflowDatabaseFormatError,
  WorkflowSchemaVersionError,
  WorkflowRecordMalformedError,
  WorkflowRequestError,
  WorkflowStorageError,
  WorkflowTransactionError,
} from "../storage/errors.ts";
import type { DocumentExecutionRecord } from "../storage/record.ts";
import { decodeBase64, encodeBase64, sha256Hex } from "./encoding.ts";

export type PrivateRefusal =
  | "acquisition:already-running"
  | "acquisition:not-acquired"
  | "acquisition:foreign-connection"
  | "acquisition:wrong-run"
  | "command:not-an-object"
  | "command:unknown-command"
  | "command:unknown-member"
  | "command:malformed-member"
  | "command:too-large"
  | "command:duplicate-conflict"
  | "command:capacity"
  | "command:unavailable"
  | "command:stale-root"
  | "command:stale-journal"
  | "command:mapping-conflict"
  | "storage:foreign"
  | `storage:unsupported-version-v${number}`
  | "storage:corrupt";

export class CloudflareOwnerRefusalError extends Error {
  override name = "CloudflareOwnerRefusalError";

  constructor(readonly refusal: PrivateRefusal) {
    super(`the workflow owner refused the request (${refusal})`);
  }
}

interface FrontierHeader {
  readonly record: WorkflowRunRecord;
  readonly retrieval: DefinitionRetrieval | undefined;
  readonly workspaceRootId: string;
  readonly journalEventId: string | null;
}

interface JournalPage {
  readonly anchorEventId: string | null;
  readonly afterEventId: string | null;
  readonly entries: readonly {
    readonly previousEventId: string | null;
    readonly entry: JournalEntry;
  }[];
  readonly done: boolean;
}

function fail(reason: string): never {
  throw new RemoteRecordError(`the owner returned a malformed private answer: ${reason}`);
}

function members(value: unknown, names: readonly string[]): Map<string, unknown> {
  const found = parseMembers(value, "$", (reason) => new RemoteRecordError(reason));
  requireMemberNames(found, names, "$", (reason) => new RemoteRecordError(reason));
  if (found.size !== names.length || names.some((name) => !found.has(name))) {
    return fail("it omitted a declared member");
  }
  return found;
}

function rootId(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    return fail("it did not name a canonical Workspace root");
  }
  return value;
}

function nullableIdentity(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || value === "") {
    return fail("it did not name an event identity");
  }
  return value;
}

function privateRefusal(value: string): PrivateRefusal {
  switch (value) {
    case "acquisition:already-running":
    case "acquisition:not-acquired":
    case "acquisition:foreign-connection":
    case "acquisition:wrong-run":
    case "command:not-an-object":
    case "command:unknown-command":
    case "command:unknown-member":
    case "command:malformed-member":
    case "command:too-large":
    case "command:duplicate-conflict":
    case "command:capacity":
    case "command:unavailable":
    case "command:stale-root":
    case "command:stale-journal":
    case "command:mapping-conflict":
    case "storage:foreign":
    case "storage:corrupt":
      return value;
    default: {
      // The one category that carries a value: the schema version the owner
      // actually read, bounded and parsed rather than guessed.
      const unsupported = readUnsupportedVersion(value);
      if (unsupported !== undefined) {
        return `storage:unsupported-version-v${unsupported}`;
      }
      return fail("it named an unknown refusal category");
    }
  }
}

function answer<T>(offered: OwnerAnswer<T>): T {
  if (offered.outcome === "refused") {
    throw new CloudflareOwnerRefusalError(privateRefusal(offered.refusal));
  }
  return offered.value;
}

function parseFrontier(value: unknown): FrontierHeader {
  const found = members(value, ["record", "retrieval", "workspaceRootId", "journalEventId"]);
  return {
    record: parseRemoteRunRecord(found.get("record")),
    retrieval: parseRemoteRetrieval(found.get("retrieval")),
    workspaceRootId: rootId(found.get("workspaceRootId")),
    journalEventId: nullableIdentity(found.get("journalEventId")),
  };
}

function parseJournalPage(value: unknown): JournalPage {
  const found = members(value, ["anchorEventId", "afterEventId", "entries", "done"]);
  const offered = found.get("entries");
  if (!Array.isArray(offered) || offered.length > JOURNAL_PAGE_ENTRIES) {
    return fail("it did not contain one bounded journal page");
  }
  if (typeof found.get("done") !== "boolean") {
    return fail("it did not say whether the journal page was terminal");
  }
  return {
    anchorEventId: nullableIdentity(found.get("anchorEventId")),
    afterEventId: nullableIdentity(found.get("afterEventId")),
    entries: offered.map((entry) => {
      const item = members(entry, ["eventId", "previousEventId", "record", "workspaceRootId"]);
      return {
        previousEventId: nullableIdentity(item.get("previousEventId")),
        entry: parseRemoteJournalEntry({
          eventId: item.get("eventId"),
          record: item.get("record"),
          workspaceRootId: item.get("workspaceRootId"),
        }),
      };
    }),
    done: found.get("done") === true,
  };
}

function parseAnchoredJournalPage(
  value: unknown,
  anchorEventId: string,
  afterEventId: string | null,
  seen: ReadonlySet<string>,
): JournalPage {
  const page = parseJournalPage(value);
  if (
    page.anchorEventId !== anchorEventId ||
    page.afterEventId !== afterEventId ||
    page.entries.length === 0
  ) {
    return fail("a journal page did not continue its anchored snapshot");
  }
  let previous = afterEventId;
  const found = new Set(seen);
  for (const item of page.entries) {
    if (item.previousEventId !== previous) {
      return fail("an anchored journal page skipped or reordered an event");
    }
    if (found.has(item.entry.eventId)) {
      return fail("an anchored journal repeated an event");
    }
    found.add(item.entry.eventId);
    previous = item.entry.eventId;
  }
  if ((page.done && previous !== anchorEventId) || (!page.done && previous === anchorEventId)) {
    return fail("an anchored journal page disagreed with its terminal event");
  }
  return page;
}

function parseRoot(value: unknown): { workspaceRootId: string; manifest: WorkspaceRootManifest } {
  const found = members(value, ["workspaceRootId", "manifest"]);
  const identity = rootId(found.get("workspaceRootId"));
  const manifest = found.get("manifest");
  if (
    typeof manifest !== "string" ||
    new TextEncoder().encode(manifest).length > MAX_CONTENT_BYTES
  ) {
    return fail("it did not contain one bounded root manifest");
  }
  const parsed = parseWorkspaceRootManifest(manifest, fail);
  if (sha256Hex(`${WORKSPACE_ROOT_DOMAIN}${manifest}`) !== identity) {
    return fail("the root manifest disagreed with its identity");
  }
  return { workspaceRootId: identity, manifest: parsed };
}

function parseContent(value: unknown): RemoteContent {
  const found = members(value, ["kind", "digest", "size", "bytes"]);
  const kind = found.get("kind");
  if (kind !== "manifest" && kind !== "blob") {
    return fail("it did not name a content kind");
  }
  const digest = rootId(found.get("digest"));
  const size = found.get("size");
  const encoded = found.get("bytes");
  if (
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > MAX_CONTENT_BYTES ||
    typeof encoded !== "string"
  ) {
    return fail("it did not contain one bounded content piece");
  }
  const bytes = decodeBase64(encoded);
  if (bytes.length !== size || sha256Hex(bytes) !== digest) {
    return fail("the content disagreed with its identity or size");
  }
  if (kind === "manifest") {
    decodeContentManifest(bytes, fail);
  }
  return { kind, digest, bytes };
}

/**
 * The schema version an unsupported-version refusal names, if it names one.
 *
 * The grammar covers exactly the versions the owner can recognize as
 * unsupported, so a same-release owner and client never disagree about whether
 * a refusal is readable. Anything else is not this category.
 */
function readUnsupportedVersion(refusal: string): number | undefined {
  const found = /^storage:unsupported-version-v(\d{1,10})$/.exec(refusal);
  if (found === null) {
    return undefined;
  }
  const version = Number(found[1]);
  return isSchemaVersion(version) ? version : undefined;
}

export function cloudflareReadLink(
  connection: OwnerConnection,
  nextId: () => string,
  expectedRunId: string,
): RemoteReadLink {
  return {
    *invocationSnapshot(): Operation<RemoteInvocationSnapshot> {
      return answer(
        yield* connection.ask(
          nextId(),
          { command: "mappings" },
          (value) => parseRemoteInvocationSnapshot(value),
          privateRefusal,
        ),
      );
    },

    *frontier(): Operation<RemoteFrontierSnapshot> {
      const header = answer(
        yield* connection.ask(
          nextId(),
          { command: "frontier" },
          (value) => {
            const parsed = parseFrontier(value);
            if (parsed.record.runId !== expectedRunId) {
              return fail("a frontier answer named another run");
            }
            return parsed;
          },
          privateRefusal,
        ),
      );
      const entries: JournalEntry[] = [];
      const seen = new Set<string>();
      let afterEventId: string | null = null;
      let done = header.journalEventId === null;
      while (!done) {
        const page: JournalPage = answer(
          yield* connection.ask(
            nextId(),
            { command: "journal", anchorEventId: header.journalEventId, afterEventId },
            (value) =>
              parseAnchoredJournalPage(value, header.journalEventId ?? "", afterEventId, seen),
            privateRefusal,
          ),
        );
        for (const item of page.entries) {
          const entry = item.entry;
          seen.add(entry.eventId);
          entries.push(entry);
          afterEventId = entry.eventId;
        }
        done = page.done;
      }
      return { ...header, entries };
    },
    *root(workspaceRootId: string): Operation<WorkspaceRootManifest> {
      const read = answer(
        yield* connection.ask(
          nextId(),
          { command: "root", workspaceRootId },
          (value) => {
            const parsed = parseRoot(value);
            if (parsed.workspaceRootId !== workspaceRootId) {
              return fail("a root answer named another root");
            }
            return parsed;
          },
          privateRefusal,
        ),
      );
      return read.manifest;
    },
    *content(workspaceRootId, request: RemoteContentRequest): Operation<RemoteContent> {
      const read = answer(
        yield* connection.ask(
          nextId(),
          {
            command: "content",
            workspaceRootId,
            kind: request.kind,
            digest: request.digest,
            sourceManifest: request.kind === "blob" ? request.manifestDigest : null,
          },
          (value) => {
            const parsed = parseContent(value);
            if (parsed.kind !== request.kind || parsed.digest !== request.digest) {
              return fail("a content answer named another piece");
            }
            return parsed;
          },
          privateRefusal,
        ),
      );
      return read;
    },
  };
}

/**
 * The runner's production link to its owner.
 *
 * `commit()` is the whole publication path: stage the pieces the owner does not
 * have, encode one closed command, send it, and read the decision. The command
 * identity is minted once per intent and reused verbatim on a retry, because
 * the owner recognizes a retry by that identity and a regenerated one would be
 * a second proposal rather than the same question asked again.
 */
export function cloudflareOwnerLink(
  connection: OwnerConnection,
  reads: RemoteReadLink,
  nextId: () => string,
): OwnerLink {
  return {
    *frontier(): Operation<StartingFrontier> {
      return startingFrontier(yield* reads.frontier());
    },

    *commit(intent: CommitIntent): Operation<Result<CommitDecision>> {
      // Derived from the request rather than counted. The owner recognizes a
      // retry by this identity, so retrying one proposal has to produce the
      // identity it already decided — a counter would make the second attempt a
      // second question, and the owner would apply it again.
      const request = commitRequest(intent);
      const id = commandIdentity(request);
      try {
        yield* stageMissing(connection, nextId, intent);
        const answered = yield* ask(connection, id, request, intent);
        return answered.outcome === "refused"
          ? Err(new CloudflareOwnerRefusalError(answered.refusal))
          : Ok(answered.decision);
      } catch (error) {
        if (error instanceof OwnerLinkError || error instanceof RemoteRecordError) {
          // The connection went while the answer was in flight, or the owner
          // answered in a way this build cannot read. Whether the owner
          // committed is exactly what cannot be known from either, so the
          // caller learns the outcome is undecided rather than being told it
          // failed — retrying this same id is what settles it.
          return Err(error);
        }
        throw error;
      }
    },
  };
}

/**
 * The identity one closed command is known by.
 *
 * A digest of the exact bytes that will be sent, so two attempts at the same
 * proposal share an identity and two different proposals cannot. It is bounded
 * well inside the correlation limit and carries nothing about the run: it is a
 * name for a request, not a fact about the Workspace.
 */
function commandIdentity(request: Record<string, unknown>): string {
  return `commit-${sha256Hex(JSON.stringify(request))}`;
}

/**
 * One command sent and one answer read, checked against what was asked.
 *
 * A performed answer is not taken on its word. It has to name the root this
 * proposal selected — the proposed one when there is a publication, the
 * unchanged expected one when there is not — and one event identity for each
 * event that was sent. An owner agreeing to something else is not an owner this
 * runner can go on talking to: it would promote a Workspace nobody proposed, so
 * the channel fails closed instead.
 */
function* ask(
  connection: OwnerConnection,
  id: string,
  request: Record<string, unknown>,
  intent: CommitIntent,
): Operation<
  | { outcome: "performed"; decision: CommitDecision }
  | { outcome: "refused"; refusal: PrivateRefusal }
> {
  const selected =
    intent.publication === null
      ? intent.expectedWorkspaceRootId
      : intent.publication.proposedWorkspaceRootId;
  const offered = yield* connection.ask(
    id,
    request,
    (value): CommitDecision => {
      const found = members(value, ["workspaceRootId", "journalEventIds"]);
      const workspaceRootId = rootId(found.get("workspaceRootId"));
      const ids = found.get("journalEventIds");
      if (!Array.isArray(ids) || ids.some((entry) => typeof entry !== "string" || entry === "")) {
        return fail("a commit answer did not name the events it retained");
      }
      if (workspaceRootId !== selected) {
        return fail("a commit answer named a Workspace root this proposal did not select");
      }
      if (ids.length !== intent.events.length) {
        return fail("a commit answer did not retain one identity for each proposed event");
      }
      return Object.freeze({ workspaceRootId, journalEventIds: Object.freeze([...ids]) });
    },
    privateRefusal,
  );
  return offered.outcome === "refused"
    ? { outcome: "refused", refusal: privateRefusal(offered.refusal) }
    : { outcome: "performed", decision: offered.value };
}

/**
 * Send the pieces the owner does not already hold.
 *
 * Staging is idempotent by identity, so a retry after an ambiguous answer
 * re-offers the same bytes and the owner recognizes them rather than storing
 * them twice. Anything the owner already has is not sent at all: content is
 * addressed by what it is, and re-uploading a Workspace it never lost would be
 * bytes crossing for nothing.
 */
function* stageMissing(
  connection: OwnerConnection,
  nextId: () => string,
  intent: CommitIntent,
): Operation<void> {
  if (intent.publication === null) {
    return;
  }
  for (const piece of intent.publication.content) {
    const bytes = intent.bytes.get(piece.digest);
    if (bytes === undefined) {
      // The owner is expected to hold this one already. If it does not, the
      // commit refuses rather than this guessing at bytes it does not have.
      continue;
    }
    // The sealed bytes have to be the piece they were sealed as. Staging
    // something else would mean the command identity described one proposal and
    // the content described another.
    if (bytes.length !== piece.size || sha256Hex(bytes) !== piece.digest) {
      return fail("a sealed content piece does not match the identity it was proposed under");
    }
    yield* stageCloudflareContent(connection, nextId(), piece.kind, bytes);
  }
}

/** The one closed command a complete intent becomes. */
function commitRequest(intent: CommitIntent): Record<string, unknown> {
  return {
    command: "commit",
    expectedWorkspaceRootId: intent.expectedWorkspaceRootId,
    expectedJournalEventId: intent.expectedJournalEventId,
    publication:
      intent.publication === null
        ? null
        : {
            proposedWorkspaceRootId: intent.publication.proposedWorkspaceRootId,
            proposedManifest: intent.publication.proposedManifest,
            content: intent.publication.content.map((piece) => ({
              kind: piece.kind,
              digest: piece.digest,
              size: piece.size,
            })),
          },
    mappings: intent.mappings.map((mapping) =>
      mapping.kind === "repository"
        ? { kind: mapping.kind, record: { ...mapping.record }, locator: mapping.locator }
        : { kind: mapping.kind, record: { ...mapping.record } },
    ),
    // Exactly what the serializer produces, in the order the transaction
    // appended them. The owner parses each one and requires these same bytes.
    events: intent.events.map((event) => serializeDurableEvent(event)),
  };
}

export function* stageCloudflareContent(
  connection: OwnerConnection,
  id: string,
  kind: RemoteContent["kind"],
  bytes: Uint8Array,
): Operation<{ kind: RemoteContent["kind"]; digest: string; size: number }> {
  if (bytes.length === 0 || bytes.length > MAX_CONTENT_BYTES) {
    return fail("the staged content is outside the private piece bound");
  }
  const digest = sha256Hex(bytes);
  return answer(
    yield* connection.ask(
      id,
      { command: "stage", kind, digest, bytes: encodeBase64(bytes) },
      (value) => {
        const found = members(value, ["kind", "digest", "size"]);
        if (
          found.get("kind") !== kind ||
          found.get("digest") !== digest ||
          found.get("size") !== bytes.length
        ) {
          return fail("a staging answer named another content piece");
        }
        return { kind, digest, size: bytes.length };
      },
      privateRefusal,
    ),
  );
}

/**
 * The runner's production link to everything the database asks for.
 *
 * Wraps the publication link with the two reads and one mutation the database
 * needs, so a handle receives one seam rather than assembling the protocol
 * itself. Every answer is parsed and cross-checked against the request before
 * it becomes a semantic value, and every failure crosses as a provider-neutral
 * storage error rather than as a private refusal.
 */
/**
 * One run's whole owner link, from one connection.
 *
 * The read link is made here rather than accepted, so the reads a Workspace
 * invocation is admitted from and the commits it publishes cannot be two
 * different owners. A caller holding this holds one authority.
 */
export function cloudflareRunLink(
  connection: OwnerConnection,
  nextId: () => string,
  expectedRunId: string,
): RemoteWorkspaceLink {
  const reads = cloudflareReadLink(connection, nextId, expectedRunId);
  const publication = cloudflareOwnerLink(connection, reads, nextId);
  return {
    ...reads,

    /**
     * Both halves of the publication link, translated.
     *
     * The database returns these failures through a provider-neutral interface,
     * so a private refusal or a transport error must not travel as itself. This
     * is the one place that translation happens.
     */
    *frontier(): Operation<StartingFrontier> {
      try {
        return yield* publication.frontier();
      } catch (error) {
        throw translate(error);
      }
    },

    *commit(intent: CommitIntent): Operation<Result<CommitDecision>> {
      try {
        const committed = yield* publication.commit(intent);
        return committed.ok ? committed : Err(translate(committed.error));
      } catch (error) {
        return Err(translate(error));
      }
    },

    *frontierSnapshot(): Operation<RemoteFrontierSnapshot> {
      try {
        return yield* reads.frontier();
      } catch (error) {
        throw translate(error);
      }
    },

    *replaceRetrieval(
      expectedWorkspaceRootId: string,
      metadata: string | null,
    ): Operation<Result<DefinitionRetrieval | undefined>> {
      // One identity per invocation, minted here. Two calls carrying identical
      // metadata are two replacements and must not collapse into one, so the
      // identity is not derived from the request's content.
      const id = nextId();
      try {
        const answered = yield* connection.ask(
          id,
          { command: "retrieval", expectedWorkspaceRootId, metadata },
          (value) => {
            const found = members(value, ["retrieval"]);
            const held = found.get("retrieval");
            if (held === null) {
              if (metadata !== null) {
                return fail("a retrieval answer cleared a replacement that was not a clear");
              }
              return undefined;
            }
            const parsed = parseRemoteRetrieval(held);
            if (parsed === undefined || metadata === null) {
              return fail("a retrieval answer disagreed with the replacement it answered");
            }
            // Compared here, where the answer arrives. An owner that performed
            // a different replacement than the one asked for is a channel the
            // two sides disagree on, so it fails closed rather than handing
            // back a value the caller would have to notice was wrong.
            if (canonicalJson(parsed.metadata) !== metadata) {
              return fail("a retrieval answer named metadata the request did not ask for");
            }
            return parsed;
          },
          privateRefusal,
        );
        return answered.outcome === "refused"
          ? Err(storageFailure(privateRefusal(answered.refusal)))
          : Ok(answered.value);
      } catch (error) {
        return Err(translate(error));
      }
    },

    *readExecutions(): Operation<Result<DocumentExecutionRecord[]>> {
      try {
        const found: DocumentExecutionRecord[] = [];
        let anchor: number | null | undefined;
        let after: number | null = null;
        let done = false;
        while (!done) {
          const page: ExecutionPage = yield* askPage(
            connection,
            nextId(),
            expectedRunId,
            anchor ?? null,
            after,
          );
          // The first page chooses the snapshot. Every later one is held to it,
          // and to the cursor it was asked to continue from.
          const expected = anchor === undefined ? page.anchor : anchor;
          anchor = expected;
          if (page.anchor !== expected || page.after !== after) {
            return Err(pageFailure("a page did not continue its anchored snapshot"));
          }
          if (page.anchor === null) {
            // An empty snapshot is terminal and carries nothing.
            if (page.rows.length > 0 || !page.done || after !== null) {
              return Err(pageFailure("an empty snapshot carried rows or did not terminate"));
            }
            break;
          }
          if (page.rows.length === 0) {
            // A page with nothing in it can only be the empty snapshot, which
            // was handled above. Otherwise the read would never advance.
            return Err(pageFailure("a page of an anchored snapshot carried no rows"));
          }
          let previous: number = after ?? 0;
          for (const row of page.rows) {
            if (row.sequence !== previous + 1) {
              // Exactly adjacent: a gap would be retained history omitted from
              // a snapshot that claims to be complete.
              return Err(pageFailure("a page skipped, repeated or reordered a row"));
            }
            if (row.sequence > page.anchor) {
              return Err(pageFailure("a page carried a row outside its snapshot"));
            }
            previous = row.sequence;
            found.push(row.record);
          }
          if (page.done !== (previous === page.anchor)) {
            // Terminal exactly at the anchor, and only there.
            return Err(pageFailure("a page disagreed with its terminal row"));
          }
          after = previous;
          done = page.done;
        }
        return Ok(found);
      } catch (error) {
        return Err(translate(error));
      }
    },
  };
}

/** What a page that does not describe the snapshot it claims becomes. */
function pageFailure(reason: string): WorkflowStorageError {
  return new WorkflowRecordMalformedError("document executions", reason);
}

/** One execution page, with the private ordering the runner checks adjacency by. */
interface ExecutionPage {
  readonly anchor: number | null;
  readonly after: number | null;
  readonly rows: readonly { readonly sequence: number; readonly record: DocumentExecutionRecord }[];
  readonly done: boolean;
}

function* askPage(
  connection: OwnerConnection,
  id: string,
  expectedRunId: string,
  anchor: number | null,
  after: number | null,
): Operation<ExecutionPage> {
  const answered = yield* connection.ask(
    id,
    { command: "executions", anchor, after },
    (value): ExecutionPage => {
      const found = members(value, ["runId", "anchor", "after", "rows", "done"]);
      if (found.get("runId") !== expectedRunId) {
        // Another run's retained history is not this run's, however well formed.
        return fail("an execution page named another run");
      }
      const offered = found.get("rows");
      if (!Array.isArray(offered) || offered.length > EXECUTION_PAGE_ENTRIES) {
        return fail("an execution page was not one bounded page");
      }
      if (executionPageBytes(offered) > EXECUTION_PAGE_BYTES) {
        // The page bound, not the message envelope. A page that ignored it
        // would make the number of requests depend on how large one row is.
        return fail("an execution page carried more than one page of rows");
      }
      if (typeof found.get("done") !== "boolean") {
        return fail("an execution page did not say whether it was terminal");
      }
      const rows = offered.map((entry) => {
        const item = members(entry, ["sequence", "record"]);
        const sequence = item.get("sequence");
        if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) {
          return fail("an execution row did not carry a position");
        }
        return { sequence, record: parseRemoteExecution(item.get("record")) };
      });
      return {
        anchor: nullableSequence(found.get("anchor")),
        after: nullableSequence(found.get("after")),
        rows,
        done: found.get("done") === true,
      };
    },
    privateRefusal,
  );
  if (answered.outcome === "refused") {
    throw new CloudflareOwnerRefusalError(privateRefusal(answered.refusal));
  }
  return answered.value;
}

function nullableSequence(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return fail("an execution page did not name a position");
  }
  return value;
}

/**
 * The provider-neutral failure one private refusal becomes.
 *
 * A caller learns the category the local host would have reported for the same
 * condition. Command names, refusal spellings, rows and cursors stay below this
 * line: they describe a protocol nobody above here is party to.
 */
function storageFailure(refusal: PrivateRefusal): WorkflowStorageError {
  // A host acts on these differently: storage belonging to something else may
  // not be written, a version this build does not implement may not be
  // migrated, and damage may not be repaired. Collapsing them would make all
  // three look like the one that says "restore from a backup".
  if (refusal === "storage:foreign") {
    return new WorkflowDatabaseFormatError(REMOTE_STORE, "it belongs to something else");
  }
  const unsupported = readUnsupportedVersion(refusal);
  if (unsupported !== undefined) {
    return new WorkflowSchemaVersionError(REMOTE_STORE, unsupported, SCHEMA_VERSION);
  }
  if (refusal === "storage:corrupt") {
    return new WorkflowDatabaseCorruptError(REMOTE_STORE, "its retained records do not agree");
  }
  if (refusal === "command:stale-root" || refusal === "command:stale-journal") {
    return new WorkflowTransactionError(
      "this run has moved since the operation read it, so the change was not applied.",
    );
  }
  if (refusal === "command:capacity") {
    return new WorkflowRequestError("this run's owner cannot accept more work on this connection.");
  }
  return new WorkflowTransactionError("this run's owner refused the operation.");
}

/**
 * What a public error names instead of a path.
 *
 * A remote run has no file, and naming one would be an invitation to look for
 * it. The store is named as what it is.
 */
const REMOTE_STORE = "this run's remote storage";

/**
 * Any failure from the private protocol, as a provider-neutral one.
 *
 * Nothing private crosses: not a refusal class, not a refusal spelling, not the
 * message a parser wrote about a value it refused. A record this build cannot
 * read is a malformed record rather than an unreachable owner, because those
 * are different facts and a caller acts on them differently.
 */
function translate(error: unknown): WorkflowStorageError {
  if (error instanceof CloudflareOwnerRefusalError) {
    return storageFailure(error.refusal);
  }
  if (error instanceof WorkflowStorageError) {
    return error;
  }
  if (error instanceof RemoteRecordError) {
    return new WorkflowRecordMalformedError(
      "record this run's owner returned",
      "it is not a record this build can read",
    );
  }
  if (error instanceof OwnerLinkError) {
    if (error.refusal === "too-large") {
      // The channel measured the whole request and never sent it. That is a
      // request this caller cannot make, not an owner it could not reach, and
      // the two lead a host to do different things.
      return new WorkflowRequestError(
        "this request is larger than one message may carry, so it was not sent.",
      );
    }
    return new WorkflowTransactionError("this run's owner could not be reached.");
  }
  return new WorkflowTransactionError("this run's owner could not answer the operation.");
}
