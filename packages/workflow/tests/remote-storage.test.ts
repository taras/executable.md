/**
 * Tier WRH — what the remote storage provider answers when the owner does not.
 *
 * The owner's own behavior is proved against a real Durable Object in
 * `tests/cloudflare/remote-storage.vitest.ts`. These are the cases a real owner
 * cannot produce: an answer this build cannot read, and a connection that ends
 * before it answers. Both go through the production
 * `cloudflareRunLink().open()` and the installed `WorkflowRunStorage`, because
 * what is claimed is that neither escapes the provider's `Result`.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { type Operation, type Result, scoped } from "effection";
import { cloudflareRunLink } from "../src/cloudflare/client.ts";
import { type OwnerSocket, type SocketListener, useOwnerConnection } from "../src/remote/client.ts";
import { useRemoteRunStorage } from "../src/remote/storage.ts";
import type { CreateWorkflowRunRequest, WorkflowRunDatabase } from "../src/storage/api.ts";
import { WorkflowRunStorage } from "../src/storage/api.ts";
import { WorkflowRecordMalformedError, WorkflowStorageError } from "../src/storage/errors.ts";

const RUN_ID = "5cktgrv2zyutngh7bbddr2tyg2b5a567cg725hu5e7u42orerxaa";

function creation(): CreateWorkflowRunRequest {
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
  };
}

function runRecord(): Record<string, unknown> {
  return {
    runId: RUN_ID,
    definition: creation().definition,
    base: "main",
    props: {},
    status: "running",
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
  };
}

/**
 * One request, read rather than believed.
 *
 * `JSON.parse` answers `unknown`, and this owner has to reflect a correlation
 * id back off whatever it was sent. Checking that it is an object before
 * reading one is what makes the reflection honest instead of a promise about
 * what the client sends.
 */
function decoded(data: string): Record<string, unknown> {
  const value: unknown = JSON.parse(data);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected the client to send one JSON object");
  }
  return Object.fromEntries(Object.entries(value));
}

/** An owner whose answers a test writes, and which can simply stop answering. */
function wire(answer: (request: Record<string, unknown>) => Record<string, unknown> | "lost") {
  const sent: Record<string, unknown>[] = [];
  const listeners = new Map<string, Set<SocketListener>>();
  const socket: OwnerSocket = {
    send(data: string): void {
      const request = decoded(data);
      sent.push(request);
      const response = answer(request);
      if (response === "lost") {
        for (const listener of listeners.get("close") ?? []) {
          listener({});
        }
        return;
      }
      for (const listener of listeners.get("message") ?? []) {
        listener({ data: JSON.stringify({ id: request["id"], ...response }) });
      }
    },
    close(): void {},
    addEventListener(type, listener): void {
      const found = listeners.get(type) ?? new Set<SocketListener>();
      found.add(listener);
      listeners.set(type, found);
    },
    removeEventListener(type, listener): void {
      listeners.get(type)?.delete(listener);
    },
  };
  return { socket, sent };
}

/** The installed provider, over one scripted owner. */
function* installed<T>(
  answer: (request: Record<string, unknown>) => Record<string, unknown> | "lost",
  body: () => Operation<T>,
): Operation<T> {
  return yield* scoped(function* () {
    const transport = wire(answer);
    const connection = yield* useOwnerConnection(transport.socket);
    let identifier = 0;
    yield* useRemoteRunStorage(
      cloudflareRunLink(connection, () => `open-${(identifier += 1)}`, RUN_ID),
    );
    return yield* body();
  });
}

function refused(result: Result<WorkflowRunDatabase>): Error {
  if (result.ok) {
    throw new Error("expected a refused result");
  }
  return result.error;
}

describe("remote storage, when the owner answers badly", () => {
  it("returns a malformed record for every open answer it cannot read", function* () {
    // Each of these is a shape the owner could never build. What matters is
    // that reading one is a refusal rather than a value, and that the refusal
    // says the record was unreadable rather than repeating what was in it.
    const answers: Record<string, Record<string, unknown>> = {
      "an answer that both opened and refused": {
        conflict: ["base"],
        frontier: {
          record: runRecord(),
          retrieval: null,
          workspaceRootId: "a".repeat(64),
          journalEventId: null,
        },
      },
      "a differing field this build does not read": { conflict: ["everything"], frontier: null },
      "no differing field at all": { conflict: [], frontier: null },
      "differing fields out of order": { conflict: ["props", "base"], frontier: null },
      "one differing field twice": { conflict: ["base", "base"], frontier: null },
      "a differing field that is not text": { conflict: [7], frontier: null },
      "a frontier naming another run": {
        conflict: null,
        frontier: {
          record: { ...runRecord(), runId: "6dktgrv2zyutngh7bbddr2tyg2b5a567cg725hu5e7u42orerxaa" },
          retrieval: null,
          workspaceRootId: "a".repeat(64),
          journalEventId: null,
        },
      },
      "an answer carrying neither": { conflict: null, frontier: null },
    };

    for (const [description, value] of Object.entries(answers)) {
      const outcome = yield* installed(
        () => ({ outcome: "performed", value }),
        () => WorkflowRunStorage.operations.create(creation()),
      );
      const error = refused(outcome);
      expect([description, error]).toEqual([description, expect.any(WorkflowRecordMalformedError)]);
      // Nothing of the answer, and nothing of the protocol.
      expect([description, String(error)]).not.toContain("everything");
      expect(String(error)).not.toContain("command:");
      expect(String(error)).not.toContain("6dktgrv");
    }
  });

  it("returns a provider failure when the connection ends before its answer", function* () {
    const outcome = yield* installed(
      () => "lost",
      () => WorkflowRunStorage.operations.create(creation()),
    );
    const error = refused(outcome);
    // Inside the `Result` this interface promises, provider-neutral, and
    // carrying no transport vocabulary.
    expect(error).toEqual(expect.any(WorkflowStorageError));
    expect(String(error)).not.toContain("OwnerLinkError");
    expect(String(error)).not.toContain("command:");

    const looked = yield* installed(
      () => "lost",
      () => WorkflowRunStorage.operations.lookup(RUN_ID),
    );
    expect(refused(looked)).toEqual(expect.any(WorkflowStorageError));
  });

  it("sends the request it parsed, not the object it was handed", function* () {
    // A request that answers one identity while it is validated and another
    // when it is read again. Only the parsed value may reach the owner.
    let reads = 0;
    const unstable = {
      get runId(): string {
        return RUN_ID;
      },
      definition: creation().definition,
      get base(): string {
        reads += 1;
        return reads > 1 ? "a-later-base" : "main";
      },
      props: {},
    };

    let observed: unknown;
    yield* installed(
      (request) => {
        if (request["command"] === "open") {
          observed = request["creation"];
        }
        return { outcome: "performed", value: { conflict: ["base"], frontier: null } };
      },
      () => WorkflowRunStorage.operations.create(unstable),
    );

    const sent = observed === null || typeof observed !== "object" ? {} : { ...observed };
    // The getter ran while the request was parsed, and what travelled is that
    // reading. A later reading never reached the owner.
    expect(reads).toBe(1);
    expect(Reflect.get(sent, "base")).toBe("main");
  });
});
