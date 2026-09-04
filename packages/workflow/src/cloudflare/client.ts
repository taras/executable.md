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
import { OwnerLinkError, type OwnerAnswer, type OwnerConnection } from "../remote/client.ts";
import {
  parseRemoteJournalEntry,
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
import { JOURNAL_PAGE_ENTRIES, MAX_CONTENT_BYTES } from "./commands.ts";
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
  | "storage:foreign"
  | "storage:unsupported-version"
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
    case "storage:foreign":
    case "storage:unsupported-version":
    case "storage:corrupt":
      return value;
    default:
      return fail("it named an unknown refusal category");
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

export function cloudflareReadLink(
  connection: OwnerConnection,
  nextId: () => string,
  expectedRunId: string,
): RemoteReadLink {
  return {
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
 * The bytes one proposed piece is made of, when the owner has to be sent them.
 *
 * A runner holds the content it captured; the owner may already hold some of
 * it. Supplying bytes by identity lets the adapter stage only what is missing
 * rather than resending a Workspace the owner never lost.
 */
export type ProposedBytes = (kind: "manifest" | "blob", digest: string) => Uint8Array | undefined;

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
  bytesOf: ProposedBytes = () => undefined,
): OwnerLink {
  return {
    *frontier(): Operation<StartingFrontier> {
      return startingFrontier(yield* reads.frontier());
    },

    *commit(intent: CommitIntent): Operation<Result<void>> {
      // Derived from the request rather than counted. The owner recognizes a
      // retry by this identity, so retrying one proposal has to produce the
      // identity it already decided — a counter would make the second attempt a
      // second question, and the owner would apply it again.
      const request = commitRequest(intent);
      const id = commandIdentity(request);
      try {
        yield* stageMissing(connection, nextId, intent, bytesOf);
        const answered = yield* ask(connection, id, request);
        return answered.outcome === "refused"
          ? Err(new CloudflareOwnerRefusalError(answered.refusal))
          : Ok();
      } catch (error) {
        if (error instanceof OwnerLinkError) {
          // The connection went while the answer was in flight. Whether the
          // owner committed is exactly what cannot be known from here, so the
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

/** One command sent and one answer read, with the private refusal narrowed. */
function* ask(
  connection: OwnerConnection,
  id: string,
  request: Record<string, unknown>,
): Operation<{ outcome: "performed" } | { outcome: "refused"; refusal: PrivateRefusal }> {
  const offered = yield* connection.ask(
    id,
    request,
    (value) => {
      // A performed commit answers with what it published. Reading it proves
      // the owner and this build agree about what just happened.
      const found = members(value, ["workspaceRootId", "journalEventIds"]);
      rootId(found.get("workspaceRootId"));
      const ids = found.get("journalEventIds");
      if (!Array.isArray(ids) || ids.some((entry) => typeof entry !== "string" || entry === "")) {
        return fail("a commit answer did not name the events it retained");
      }
      return true;
    },
    privateRefusal,
  );
  return offered.outcome === "refused"
    ? { outcome: "refused", refusal: privateRefusal(offered.refusal) }
    : { outcome: "performed" };
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
  bytesOf: ProposedBytes,
): Operation<void> {
  if (intent.publication === null) {
    return;
  }
  for (const piece of intent.publication.content) {
    const bytes = bytesOf(piece.kind, piece.digest);
    if (bytes === undefined) {
      // The owner is expected to hold this one already. If it does not, the
      // commit refuses rather than this guessing at bytes it does not have.
      continue;
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
