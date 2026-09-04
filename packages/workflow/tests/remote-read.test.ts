/**
 * Tier WRH — reading a run from an owner somewhere else.
 *
 * What is under test here is the runner's half: whether a private answer
 * becomes a semantic value only after it has been proved to be one, and whether
 * a channel that has stopped making sense is stopped rather than followed.
 *
 * The owner is a deterministic fake, deliberately. Command-specific parsing,
 * refusal narrowing and journal reassembly are arithmetic over what arrived,
 * and a fake can produce the answers a correct owner never would — a page that
 * skips an event, a refusal category from another release, content that is not
 * what it is named. What the real owner does with a real request is proved on
 * real workerd, where the runtime is the thing being relied on.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { serializeDurableEvent } from "@executablemd/durable-streams";
import { scoped } from "effection";
import {
  cloudflareOwnerLink,
  cloudflareReadLink,
  cloudflareRunLink,
  stageCloudflareContent,
} from "../src/cloudflare/client.ts";
import { WorkflowSchemaVersionError, WorkflowStorageError } from "../src/storage/errors.ts";
import { SCHEMA_VERSION } from "../src/sqlite/workflow-schema.ts";
import { createTransactionGate, transactRemotely } from "../src/remote/collector.ts";
import { encodeBase64 } from "../src/cloudflare/encoding.ts";
import type { OwnerSocket, SocketListener } from "../src/remote/client.ts";
import { OwnerLinkError, useOwnerConnection } from "../src/remote/client.ts";
import {
  EMPTY_WORKSPACE_MANIFEST,
  EMPTY_WORKSPACE_ROOT_ID,
  workspaceRootId,
} from "../src/deno/workspace/manifest.ts";
import { WORKSPACE_ROOT_DOMAIN } from "../src/workspace/root-manifest.ts";
import { sha256Hex } from "../src/workspace/sha256.ts";

const RUN_ID = "remote-run";
const ROOT_MANIFEST = JSON.stringify({
  format: 1,
  entries: [{ path: "/", kind: "directory", mode: 493, mtime: 0 }],
});
const ROOT_ID = sha256Hex(`${WORKSPACE_ROOT_DOMAIN}${ROOT_MANIFEST}`);
const CONTENT = new TextEncoder().encode(
  JSON.stringify({ version: 1, chunks: [{ hash: "0".repeat(64), size: 1 }] }),
);
const CONTENT_ID = sha256Hex(CONTENT);

function event(name: string): string {
  return serializeDurableEvent({
    type: "yield",
    coroutineId: "root",
    description: { type: "test", name },
    result: { status: "ok", value: name },
  });
}

function runRecord(): Record<string, unknown> {
  return {
    runId: RUN_ID,
    definition: {
      version: 1,
      kind: "git",
      objectFormat: "sha1",
      objectId: "0".repeat(40),
      rootDocumentPath: "README.md",
    },
    base: "main",
    props: {},
    status: "running",
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
  };
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected an object");
  }
  return Object.fromEntries(Object.entries(value));
}

function wire(answer: (request: Record<string, unknown>) => Record<string, unknown>) {
  const listeners = new Map<string, Set<SocketListener>>();
  let closes = 0;
  const socket: OwnerSocket = {
    send(data: string): void {
      const request = object(JSON.parse(data));
      const response = answer(request);
      for (const listener of listeners.get("message") ?? []) {
        listener({ data: JSON.stringify({ id: request["id"], ...response }) });
      }
    },
    close(): void {
      closes += 1;
    },
    addEventListener(type, listener): void {
      const found = listeners.get(type) ?? new Set<SocketListener>();
      found.add(listener);
      listeners.set(type, found);
    },
    removeEventListener(type, listener): void {
      listeners.get(type)?.delete(listener);
    },
  };
  return {
    socket,
    get closes(): number {
      return closes;
    },
    get listeners(): number {
      return [...listeners.values()].reduce((sum, found) => sum + found.size, 0);
    },
  };
}

function ids(): () => string {
  let id = 0;
  return () => `request-${(id += 1)}`;
}

/** The name one retained test event carries, read rather than asserted. */
function effectName(entry: unknown): string {
  if (entry === null || typeof entry !== "object" || !("description" in entry)) {
    return "";
  }
  const description = entry.description;
  if (description === null || typeof description !== "object" || !("name" in description)) {
    return "";
  }
  const name: unknown = description["name"];
  return typeof name === "string" ? name : "";
}

function failure(error: unknown): string {
  if (!(error instanceof OwnerLinkError)) {
    throw new Error(`expected an OwnerLinkError, received ${String(error)}`);
  }
  return error.refusal;
}

describe("semantic reads from a Cloudflare owner", () => {
  it("uses the standard SHA-256 identity rather than an adapter-local digest", function* () {
    // The published answers, including the two-block case the padding rule is
    // easiest to get wrong on.
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
    expect(sha256Hex(new Uint8Array(1000).fill(0x61))).toBe(
      "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3",
    );
  });

  it("computes the identity the local host computes for the same root", function* () {
    // The two hosts retain the same roots and must name them identically. This
    // one is arithmetic in the language; the Deno host uses `node:crypto`. A
    // difference here would be two hosts disagreeing about history.
    expect(sha256Hex(`${WORKSPACE_ROOT_DOMAIN}${ROOT_MANIFEST}`)).toBe(
      workspaceRootId(ROOT_MANIFEST),
    );
    expect(sha256Hex(`${WORKSPACE_ROOT_DOMAIN}${EMPTY_WORKSPACE_MANIFEST}`)).toBe(
      EMPTY_WORKSPACE_ROOT_ID,
    );
  });

  it("strictly parses the private staging decision", function* () {
    const bytes = new TextEncoder().encode("staged");
    const digest = sha256Hex(bytes);
    const transport = wire((request) => ({
      outcome: "performed",
      value: { kind: request["kind"], digest: request["digest"], size: bytes.length },
    }));
    yield* scoped(function* () {
      const connection = yield* useOwnerConnection(transport.socket);
      expect(yield* stageCloudflareContent(connection, "stage", "blob", bytes)).toEqual({
        kind: "blob",
        digest,
        size: bytes.length,
      });
    });
  });

  it("parses an anchored frontier, a canonical root, and verified content", function* () {
    const transport = wire((request) => {
      if (request["command"] === "frontier") {
        return {
          outcome: "performed",
          value: {
            record: runRecord(),
            retrieval: {
              metadata: { locator: "somewhere" },
              revision: 1,
              updatedAt: "2026-09-03T00:00:00.000Z",
            },
            workspaceRootId: ROOT_ID,
            journalEventId: "event-2",
          },
        };
      }
      if (request["command"] === "journal" && request["afterEventId"] === null) {
        return {
          outcome: "performed",
          value: {
            anchorEventId: "event-2",
            afterEventId: null,
            entries: [
              {
                eventId: "event-1",
                previousEventId: null,
                record: event("one"),
                workspaceRootId: ROOT_ID,
              },
            ],
            done: false,
          },
        };
      }
      if (request["command"] === "journal") {
        return {
          outcome: "performed",
          value: {
            anchorEventId: "event-2",
            afterEventId: "event-1",
            entries: [
              {
                eventId: "event-2",
                previousEventId: "event-1",
                record: event("two"),
                workspaceRootId: ROOT_ID,
              },
            ],
            done: true,
          },
        };
      }
      if (request["command"] === "root") {
        return {
          outcome: "performed",
          value: { workspaceRootId: ROOT_ID, manifest: ROOT_MANIFEST },
        };
      }
      return {
        outcome: "performed",
        value: {
          kind: "manifest",
          digest: CONTENT_ID,
          size: CONTENT.length,
          bytes: encodeBase64(CONTENT),
        },
      };
    });

    yield* scoped(function* () {
      const connection = yield* useOwnerConnection(transport.socket);
      const reads = cloudflareReadLink(connection, ids(), RUN_ID);
      const frontier = yield* reads.frontier();
      expect(frontier.entries.map((entry) => entry.eventId)).toEqual(["event-1", "event-2"]);
      expect(frontier.workspaceRootId).toBe(ROOT_ID);
      expect((yield* reads.root(ROOT_ID)).entries).toHaveLength(1);
      expect(
        (yield* reads.content(ROOT_ID, { kind: "manifest", digest: CONTENT_ID })).bytes,
      ).toEqual(CONTENT);
    });
    expect(transport.closes).toBe(1);
    expect(transport.listeners).toBe(0);
  });

  it("closes on a journal page that does not continue its snapshot", function* () {
    const anchored = (entries: Record<string, unknown>[], done = true) => ({
      anchorEventId: "event-2",
      afterEventId: null,
      entries,
      done,
    });
    const entry = (eventId: string, previousEventId: string | null) => ({
      eventId,
      previousEventId,
      record: event(eventId),
      workspaceRootId: ROOT_ID,
    });

    // Four ways one page can fail to be the continuation it claims to be. The
    // structural consequence is one: the events never reach a caller, because
    // a journal that is missing an event looks exactly like a shorter journal.
    const pages: Record<string, ReturnType<typeof anchored>> = {
      skipped: anchored([entry("event-2", "event-1")]),
      "out of order": anchored([entry("event-2", null), entry("event-1", "event-2")], false),
      duplicated: anchored([entry("event-1", null), entry("event-1", "event-1")], false),
      "not terminal": anchored([entry("event-1", null)]),
    };

    for (const [description, page] of Object.entries(pages)) {
      const transport = wire((request) =>
        request["command"] === "frontier"
          ? {
              outcome: "performed",
              value: {
                record: runRecord(),
                retrieval: null,
                workspaceRootId: ROOT_ID,
                journalEventId: "event-2",
              },
            }
          : { outcome: "performed", value: page },
      );
      let raised: unknown;
      yield* scoped(function* () {
        const connection = yield* useOwnerConnection(transport.socket);
        try {
          yield* cloudflareReadLink(connection, ids(), RUN_ID).frontier();
        } catch (error) {
          raised = error;
        }
      });
      expect([description, failure(raised)]).toEqual([description, "malformed-answer"]);
      expect([description, transport.closes]).toEqual([description, 1]);
      expect([description, transport.listeners]).toEqual([description, 0]);
    }
  });

  it("closes on an unknown same-release refusal", function* () {
    const transport = wire(() => ({ outcome: "refused", refusal: "command:newer-release" }));
    let raised: unknown;
    yield* scoped(function* () {
      const connection = yield* useOwnerConnection(transport.socket);
      try {
        yield* cloudflareReadLink(connection, ids(), RUN_ID).frontier();
      } catch (error) {
        raised = error;
      }
    });
    expect(failure(raised)).toBe("malformed-answer");
    expect(transport.closes).toBe(1);
  });

  it("closes on a retrieval answer describing a replacement nobody asked for", function* () {
    // The contradiction is settled where the answer arrives, not by a caller
    // noticing afterwards. Two sides that disagree about which replacement was
    // performed have no shared state left to continue from.
    const transport = wire(() => ({
      outcome: "performed",
      value: {
        retrieval: {
          metadata: { locator: "something else entirely" },
          revision: 1,
          updatedAt: "2026-09-04T00:00:01.000Z",
        },
      },
    }));
    let outcome: unknown;
    yield* scoped(function* () {
      const connection = yield* useOwnerConnection(transport.socket);
      const link = cloudflareRunLink(
        connection,
        cloudflareReadLink(connection, ids(), RUN_ID),
        ids(),
        RUN_ID,
      );
      outcome = yield* link.replaceRetrieval(ROOT_ID, '{"locator":"what was asked"}');
    });
    expect((outcome as { ok: boolean }).ok).toBe(false);
    expect(transport.closes).toBe(1);
  });

  it("reports the schema version the owner actually read", function* () {
    // A version this build cannot open is the one fact the refusal exists to
    // carry. Reporting a placeholder would state something the owner never
    // said, and a host deciding whether to upgrade would act on it.
    const transport = wire(() => ({
      outcome: "refused",
      refusal: "storage:unsupported-version-v7",
    }));
    let outcome: unknown;
    yield* scoped(function* () {
      const connection = yield* useOwnerConnection(transport.socket);
      const link = cloudflareRunLink(
        connection,
        cloudflareReadLink(connection, ids(), RUN_ID),
        ids(),
        RUN_ID,
      );
      outcome = yield* link.readExecutions();
    });
    const failed = outcome as { ok: boolean; error: Error };
    expect(failed.ok).toBe(false);
    expect(failed.error).toEqual(expect.any(WorkflowSchemaVersionError));
    const version = failed.error as WorkflowSchemaVersionError;
    expect([version.stored, version.supported]).toEqual([7, SCHEMA_VERSION]);
  });

  it("closes when content bytes disagree with the requested identity", function* () {
    const transport = wire(() => ({
      outcome: "performed",
      value: {
        kind: "blob",
        digest: CONTENT_ID,
        size: 1,
        bytes: encodeBase64(new Uint8Array([1])),
      },
    }));
    let raised: unknown;
    yield* scoped(function* () {
      const connection = yield* useOwnerConnection(transport.socket);
      try {
        yield* cloudflareReadLink(connection, ids(), RUN_ID).content(ROOT_ID, {
          kind: "blob",
          digest: CONTENT_ID,
          manifestDigest: CONTENT_ID,
        });
      } catch (error) {
        raised = error;
      }
    });
    expect(failure(raised)).toBe("malformed-answer");
    expect(transport.closes).toBe(1);
  });
  it("hands the collector one assembled frontier and no page mechanics", function* () {
    const pages: Record<string, unknown> = {
      null: {
        anchorEventId: "event-2",
        afterEventId: null,
        entries: [
          {
            eventId: "event-1",
            previousEventId: null,
            record: event("one"),
            workspaceRootId: ROOT_ID,
          },
        ],
        done: false,
      },
      "event-1": {
        anchorEventId: "event-2",
        afterEventId: "event-1",
        entries: [
          {
            eventId: "event-2",
            previousEventId: "event-1",
            record: event("two"),
            workspaceRootId: ROOT_ID,
          },
        ],
        done: true,
      },
    };
    const transport = wire((request) =>
      request["command"] === "frontier"
        ? {
            outcome: "performed",
            value: {
              record: runRecord(),
              retrieval: null,
              workspaceRootId: ROOT_ID,
              journalEventId: "event-2",
            },
          }
        : { outcome: "performed", value: pages[String(request["afterEventId"])] },
    );

    let seen: unknown[] = [];
    let committed: unknown;
    yield* scoped(function* () {
      const connection = yield* useOwnerConnection(transport.socket);
      const request = ids();
      const link = cloudflareOwnerLink(
        connection,
        cloudflareReadLink(connection, request, RUN_ID),
        request,
      );
      // Two pages went over the wire. What the body reads back is one journal:
      // the collector is handed the assembled prefix and never learns that a
      // page, a cursor or an anchor was involved.
      const outcome = yield* transactRemotely(link, createTransactionGate(), function* (tx) {
        seen = yield* tx.journal.readAll();
        return "done";
      });
      committed = outcome;
    });

    expect(seen).toHaveLength(2);
    expect(seen.map(effectName)).toEqual(["one", "two"]);
    // D2 has reads and no commit. The transaction returns the owner's refusal
    // rather than a success nothing performed.
    expect(committed).toMatchObject({ ok: false });
  });
  it("assembles an execution snapshot only from pages that describe it", function* () {
    const record = (id: string) => ({ executionId: id, startedAt: "2026-09-04T00:00:00.000Z" });
    const page = (rows: unknown[], overrides: Record<string, unknown> = {}) => ({
      outcome: "performed",
      value: { runId: RUN_ID, anchor: 2, after: null, rows, done: true, ...overrides },
    });
    const row = (sequence: number, id: string) => ({ sequence, record: record(id) });

    // Each of these is a page that does not describe the snapshot it claims.
    // The structural consequence is one: no partial history is returned.
    const refused: Record<string, unknown> = {
      "another run's history": page([row(1, "a"), row(2, "b")], { runId: "somebody-else" }),
      "a terminal page short of its anchor": page([row(1, "a")]),
      "a first row that is not the first": page([row(2, "b")]),
      "a gap between rows": page([row(1, "a"), row(3, "c")]),
      "a repeated row": page([row(1, "a"), row(1, "a")]),
      "a row beyond the anchor": page([row(1, "a"), row(2, "b"), row(3, "c")]),
      "an empty page of a non-empty snapshot": page([], { done: false }),
      "an empty snapshot that carries rows": page([row(1, "a")], { anchor: null }),
      "a cursor it was not asked to continue from": page([row(1, "a"), row(2, "b")], { after: 7 }),
      "a record with a member the shape does not declare": page([
        { sequence: 1, record: { ...record("a"), note: "extra" } },
      ]),
      "a record that stopped without saying how": page([
        { sequence: 1, record: { ...record("a"), stopStatus: "completed" } },
      ]),
    };

    for (const [description, answer] of Object.entries(refused)) {
      const transport = wire(() => answer as Record<string, unknown>);
      let outcome: unknown;
      yield* scoped(function* () {
        const connection = yield* useOwnerConnection(transport.socket);
        const link = cloudflareRunLink(
          connection,
          cloudflareReadLink(connection, ids(), RUN_ID),
          ids(),
          RUN_ID,
        );
        outcome = yield* link.readExecutions();
      });
      expect([description, (outcome as { ok: boolean }).ok]).toEqual([description, false]);
      if (!(outcome as { ok: boolean }).ok) {
        const failed = outcome as { error: Error };
        // A provider-neutral failure, with nothing private in it.
        expect([description, failed.error]).toEqual([
          description,
          expect.any(WorkflowStorageError),
        ]);
        expect(String(failed.error)).not.toContain("command:");
      }
    }
  });

  it("assembles an honest snapshot across pages, and an empty one", function* () {
    const record = (id: string) => ({ executionId: id, startedAt: "2026-09-04T00:00:00.000Z" });
    const pages: Record<string, Record<string, unknown>> = {
      null: {
        outcome: "performed",
        value: {
          runId: RUN_ID,
          anchor: 2,
          after: null,
          rows: [{ sequence: 1, record: record("first") }],
          done: false,
        },
      },
      "1": {
        outcome: "performed",
        value: {
          runId: RUN_ID,
          anchor: 2,
          after: 1,
          rows: [{ sequence: 2, record: record("second") }],
          done: true,
        },
      },
    };
    const transport = wire(
      (request) =>
        pages[String(request["after"])] ?? { outcome: "refused", refusal: "storage:corrupt" },
    );
    yield* scoped(function* () {
      const connection = yield* useOwnerConnection(transport.socket);
      const link = cloudflareRunLink(
        connection,
        cloudflareReadLink(connection, ids(), RUN_ID),
        ids(),
        RUN_ID,
      );
      const read = yield* link.readExecutions();
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.value.map((entry) => entry.executionId)).toEqual(["first", "second"]);
      }
    });

    const empty = wire(() => ({
      outcome: "performed",
      value: { runId: RUN_ID, anchor: null, after: null, rows: [], done: true },
    }));
    yield* scoped(function* () {
      const connection = yield* useOwnerConnection(empty.socket);
      const link = cloudflareRunLink(
        connection,
        cloudflareReadLink(connection, ids(), RUN_ID),
        ids(),
        RUN_ID,
      );
      const read = yield* link.readExecutions();
      expect(read.ok && read.value).toEqual([]);
    });
  });
});
