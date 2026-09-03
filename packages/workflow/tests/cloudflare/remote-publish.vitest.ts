/**
 * Publishing one proposal on real workerd.
 *
 * This is the point where a remote run moves, and almost nothing about it is
 * provable against a model. Whether content, roots, references, mappings, the
 * current pointer, the journal and the retry decision commit together is a
 * property of the Durable Object's own `transactionSync()`. Whether a lost
 * response can be retried exactly once is a property of storage surviving
 * eviction. Whether a stale socket can still write is a property of the
 * runtime's socket list.
 *
 * So these run against a real namespace, real SQLite and real Hibernation
 * WebSockets, and the assertions are about what was published, what was
 * refused, and what was left exactly as it was.
 */

import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { serializeDurableEvent } from "@executablemd/durable-streams";
import type { ExecutorObject } from "./support/executor-object.ts";
import {
  NEXT_BLOB_ID,
  NEXT_BYTES,
  NEXT_ROOT_ID,
  nextPublication,
  POLICY,
  ROOT_ID,
  RUN_ID,
  VALID_CLAIMS,
} from "./support/executor-object.ts";
import { encodeBase64 } from "../../src/cloudflare/encoding.ts";
import { sha256Hex } from "../../src/workspace/sha256.ts";
import { generateKeys, signToken, type TestKeys } from "./support/tokens.ts";

let unique = 0;
const NOW = 1_800_000_000;
let keys: TestKeys;

beforeAll(async () => {
  keys = await generateKeys();
});

function executor() {
  unique += 1;
  return env.EXECUTOR.get(env.EXECUTOR.idFromName(`publish-${unique}-${Math.random()}`));
}

function on<T>(stub: ReturnType<typeof executor>, body: (owner: ExecutorObject) => T): Promise<T> {
  return runInDurableObject(stub, body);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected an object answer");
  }
  return Object.fromEntries(Object.entries(value));
}

async function admit(stub: ReturnType<typeof executor>): Promise<void> {
  await on(stub, (owner) => owner.configure([{ kid: keys.kid, jwk: keys.publicJwk }], NOW));
  const token = await signToken(keys, {
    ...VALID_CLAIMS,
    iat: NOW - 10,
    nbf: NOW - 10,
    exp: NOW + 600,
  });
  expect(await on(stub, (owner) => owner.admitConnection({ token, release: POLICY.release }))).toBe(
    "admitted",
  );
}

function send(
  stub: ReturnType<typeof executor>,
  id: string,
  command: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return on(stub, (owner) => record(owner.send(1, JSON.stringify({ id, ...command }))));
}

/**
 * A real accepted connection, which is what survives eviction.
 *
 * A `WebSocketPair` made inside the object is gone once the object is evicted;
 * only a socket the runtime accepted through a request comes back with its
 * attachment. The retry claim is about exactly that, so it has to use this.
 */
async function connect(stub: ReturnType<typeof executor>): Promise<WebSocket> {
  await on(stub, (owner) => owner.configure([{ kid: keys.kid, jwk: keys.publicJwk }], NOW));
  const token = await signToken(keys, {
    ...VALID_CLAIMS,
    iat: NOW - 10,
    nbf: NOW - 10,
    exp: NOW + 600,
  });
  const response = await stub.fetch("https://owner.invalid/executor", {
    headers: {
      authorization: `Bearer ${token}`,
      upgrade: "websocket",
      "x-release": POLICY.release,
      "x-run-id": RUN_ID,
    },
  });
  const socket = response.webSocket;
  if (socket === null) {
    throw new Error(`expected an executor WebSocket, received ${response.status}`);
  }
  socket.accept();
  return socket;
}

function ask(
  socket: WebSocket,
  id: string,
  command: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const receive = (message: MessageEvent) => {
      socket.removeEventListener("message", receive);
      if (typeof message.data !== "string") {
        reject(new Error("expected a text answer"));
        return;
      }
      resolve(record(JSON.parse(message.data)));
    };
    socket.addEventListener("message", receive);
    socket.send(JSON.stringify({ id, ...command }));
  });
}

function event(name: string): string {
  return serializeDurableEvent({
    type: "yield",
    coroutineId: "root",
    description: { type: "test", name },
    result: { status: "ok", value: name },
  });
}

/** The repository mapping one proposal carries alongside its bytes. */
const REPOSITORY = {
  kind: "repository",
  record: {
    name: "app",
    locatorFingerprint: "c".repeat(64),
    requestedBase: null,
    creationCommit: "9".repeat(40),
    primaryBranch: "main",
    objectFormat: "sha1",
    checkoutPath: "/app",
  },
};

/** Stage the one piece the owner does not already hold. */
async function stageNewContent(stub: ReturnType<typeof executor>): Promise<void> {
  expect(
    await send(stub, "stage-blob", {
      command: "stage",
      kind: "blob",
      digest: NEXT_BLOB_ID,
      bytes: encodeBase64(NEXT_BYTES),
    }),
  ).toMatchObject({ outcome: "performed" });
  const manifest = new TextEncoder().encode(
    JSON.stringify({ version: 1, chunks: [{ hash: NEXT_BLOB_ID, size: NEXT_BYTES.length }] }),
  );
  expect(
    await send(stub, "stage-manifest", {
      command: "stage",
      kind: "manifest",
      digest: sha256Hex(manifest),
      bytes: encodeBase64(manifest),
    }),
  ).toMatchObject({ outcome: "performed" });
}

function commit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    command: "commit",
    expectedWorkspaceRootId: ROOT_ID,
    expectedJournalEventId: null,
    publication: nextPublication(),
    mappings: [REPOSITORY],
    events: [event("published")],
    ...overrides,
  };
}

describe("publishing one proposal", () => {
  it("adopts content, root, references, mapping, pointer and journal together", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    await admit(stub);
    await stageNewContent(stub);

    const before = await on(stub, (owner) => owner.published());
    expect(before).toMatchObject({ currentRootId: ROOT_ID, roots: 1, events: [] });

    const answer = await send(stub, "publish", commit());
    expect(answer).toMatchObject({ outcome: "performed" });
    const value = record(answer["value"]);
    expect(value["workspaceRootId"]).toBe(NEXT_ROOT_ID);
    expect(Array.isArray(value["journalEventIds"]) && value["journalEventIds"]).toHaveLength(1);

    const after = await on(stub, (owner) => owner.published());
    expect(after["currentRootId"]).toBe(NEXT_ROOT_ID);
    // The old root stays retained; publication moves only the pointer.
    expect(after["roots"]).toBe(2);
    expect(after["repositories"]).toEqual([{ name: "app", checkout_path: "/app" }]);
    // The journal row names the root this commit selected, not the one it
    // started from.
    expect(after["events"]).toEqual([expect.objectContaining({ workspace_root_id: NEXT_ROOT_ID })]);
    // Content the owner already held was reused by identity rather than
    // resent: two blobs exist, and the proposal only staged one.
    expect(after["blobs"]).toBe(2);
    expect(after["blobRefs"]).toBe(3);

    // And the new frontier reads back whole.
    const frontier = record(record(await send(stub, "read", { command: "frontier" }))["value"]);
    expect(frontier["workspaceRootId"]).toBe(NEXT_ROOT_ID);
    expect(
      record(await send(stub, "root", { command: "root", workspaceRootId: NEXT_ROOT_ID })),
    ).toMatchObject({ outcome: "performed" });
  });

  it("keeps the expected root current for a journal-only transaction", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    await admit(stub);
    const answer = await send(
      stub,
      "journal-only",
      commit({ publication: null, mappings: [], events: [event("noted")] }),
    );
    expect(answer).toMatchObject({ outcome: "performed" });
    const after = await on(stub, (owner) => owner.published());
    expect(after["currentRootId"]).toBe(ROOT_ID);
    expect(after["roots"]).toBe(1);
    expect(after["events"]).toEqual([expect.objectContaining({ workspace_root_id: ROOT_ID })]);
  });

  it("commits an empty transaction without inventing a Workspace change", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    await admit(stub);
    expect(
      await send(stub, "empty", commit({ publication: null, mappings: [], events: [] })),
    ).toMatchObject({ outcome: "performed", value: { workspaceRootId: ROOT_ID } });
    expect(await on(stub, (owner) => owner.published())).toMatchObject({
      currentRootId: ROOT_ID,
      roots: 1,
      events: [],
    });
  });

  it("rolls every category back when the transaction fails after applying", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    await admit(stub);
    await stageNewContent(stub);
    const before = await on(stub, (owner) => owner.published());

    expect(
      await on(stub, (owner) =>
        owner.failAfterApply(JSON.stringify({ id: "doomed", ...commit() })),
      ),
    ).toBe("rolled-back");

    // Content, root, references, mapping, pointer and journal are all back
    // where they were — and so is the retry decision, so the same id is free.
    expect(await on(stub, (owner) => owner.published())).toEqual(before);
    expect(await on(stub, (owner) => owner.scratch())).toMatchObject({ commands: 2 });
    expect(await send(stub, "doomed", commit())).toMatchObject({ outcome: "performed" });
  });

  it("applies a lost-response retry exactly once, across eviction", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    const socket = await connect(stub);
    await ask(socket, "stage-blob", {
      command: "stage",
      kind: "blob",
      digest: NEXT_BLOB_ID,
      bytes: encodeBase64(NEXT_BYTES),
    });
    const manifestBytes = new TextEncoder().encode(
      JSON.stringify({ version: 1, chunks: [{ hash: NEXT_BLOB_ID, size: NEXT_BYTES.length }] }),
    );
    await ask(socket, "stage-manifest", {
      command: "stage",
      kind: "manifest",
      digest: sha256Hex(manifestBytes),
      bytes: encodeBase64(manifestBytes),
    });

    const first = await ask(socket, "once", commit());
    expect(first).toMatchObject({ outcome: "performed" });
    const published = await on(stub, (owner) => owner.published());

    // The runner never saw that answer. The object is evicted, and the same
    // healthy socket asks the same question again with the same id and the same
    // canonical request.
    await evictDurableObject(stub);
    expect(await ask(socket, "once", commit())).toEqual(first);

    // One root, one journal row, one mapping — the retry returned the decision
    // rather than doing the work a second time.
    expect(await on(stub, (owner) => owner.published())).toEqual(published);

    // Reusing that id for a different request is not a retry.
    expect(await ask(socket, "once", commit({ events: [event("something else")] }))).toMatchObject({
      outcome: "refused",
      refusal: "command:duplicate-conflict",
    });
    expect(await on(stub, (owner) => owner.published())).toEqual(published);
  });

  it("changes nothing when the frontier or the proposal is not what it claims", async () => {
    const cases: Record<string, Record<string, unknown>> = {
      "a root the run is not at": commit({ expectedWorkspaceRootId: `f${"0".repeat(63)}` }),
      "an anchor the run is not at": commit({ expectedJournalEventId: "never-happened" }),
      "an identity that is not the digest of its manifest": commit({
        publication: { ...nextPublication(), proposedWorkspaceRootId: `a${"1".repeat(63)}` },
      }),
      "an inventory missing a piece the root names": commit({
        publication: {
          ...nextPublication(),
          content: (nextPublication()["content"] as unknown[]).slice(1),
        },
      }),
      "an inventory naming a piece the root does not": commit({
        publication: {
          ...nextPublication(),
          content: [
            ...(nextPublication()["content"] as Record<string, unknown>[]),
            { kind: "blob", digest: "e".repeat(64), size: 4 },
          ],
        },
      }),
    };

    for (const [description, request] of Object.entries(cases)) {
      const stub = executor();
      await on(stub, (owner) => owner.initialize());
      await admit(stub);
      await stageNewContent(stub);
      const before = await on(stub, (owner) => owner.published());
      const answer = await send(stub, "refused", request);
      expect([description, answer["outcome"]]).toEqual([description, "refused"]);
      expect([description, await on(stub, (owner) => owner.published())]).toEqual([
        description,
        before,
      ]);
    }
  });

  it("refuses content this acquisition did not stage", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    await admit(stub);
    // Nothing staged: the proposal names a piece the owner neither holds nor
    // was given by this connection.
    const before = await on(stub, (owner) => owner.published());
    expect(await send(stub, "unstaged", commit())).toMatchObject({ outcome: "refused" });
    expect(await on(stub, (owner) => owner.published())).toEqual(before);
  });

  it("refuses a mapping that would rewrite an established identity", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    await admit(stub);
    await stageNewContent(stub);
    expect(await send(stub, "first", commit())).toMatchObject({ outcome: "performed" });
    const published = await on(stub, (owner) => owner.published());

    // The same Repository name, a different creation commit. Creation identity
    // is immutable, so this is refused rather than allowed to overwrite it.
    expect(
      await send(
        stub,
        "second",
        commit({
          expectedWorkspaceRootId: NEXT_ROOT_ID,
          expectedJournalEventId: String(
            (published["events"] as Record<string, unknown>[])[0]?.["event_id"],
          ),
          publication: null,
          mappings: [
            { ...REPOSITORY, record: { ...REPOSITORY.record, creationCommit: "1".repeat(40) } },
          ],
          events: [],
        }),
      ),
    ).toMatchObject({ outcome: "refused", refusal: "command:mapping-conflict" });
    expect(await on(stub, (owner) => owner.published())).toEqual(published);
  });

  it("grants a closed or foreign socket no publication", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    await admit(stub);
    await stageNewContent(stub);
    const before = await on(stub, (owner) => owner.published());
    expect(
      await on(stub, (owner) =>
        record(owner.sendAsStranger(JSON.stringify({ id: "foreign", ...commit() }))),
      ),
    ).toMatchObject({ outcome: "refused", refusal: "acquisition:foreign-connection" });
    expect(await on(stub, (owner) => owner.published())).toEqual(before);
  });
});
