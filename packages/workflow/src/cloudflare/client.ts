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

import { Err, type Operation, type Result } from "effection";
import type { JournalEntry } from "../storage/api.ts";
import { parseMembers, requireMemberNames } from "../storage/members.ts";
import type { DefinitionRetrieval, WorkflowRunRecord } from "../storage/record.ts";
import type { CommitIntent, OwnerLink, StartingFrontier } from "../remote/collector.ts";
import type { OwnerAnswer, OwnerConnection } from "../remote/client.ts";
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
  decodeDofsManifest,
  parseWorkspaceRootManifest,
  SHA256,
  WORKSPACE_ROOT_DOMAIN,
  type WorkspaceRootManifest,
} from "../workspace/root-manifest.ts";
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
    decodeDofsManifest(bytes, fail);
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

export function cloudflareOwnerLink(reads: RemoteReadLink): OwnerLink {
  return {
    *frontier(): Operation<StartingFrontier> {
      return startingFrontier(yield* reads.frontier());
    },
    *commit(_intent: CommitIntent): Operation<Result<void>> {
      return Err(new CloudflareOwnerRefusalError("command:unavailable"));
    },
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
