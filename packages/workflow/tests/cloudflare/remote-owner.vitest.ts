/**
 * The owner's half of the private protocol, on real workerd.
 *
 * Almost nothing here would be worth proving against a model. Hibernation is a
 * property of the runtime: the object is evicted, its fields are gone, and what
 * comes back is whatever the storage and the live sockets say. Acquisition
 * replacement is a property of the runtime's socket list. Transaction
 * atomicity, `WITHOUT ROWID` constraints and blob round-trips are properties of
 * the Durable Object's SQLite. A map standing in for any of those would prove
 * that the map behaves, which is not the claim.
 *
 * So these run against a real namespace, real storage, real Hibernation
 * WebSockets and a real `evictDurableObject()`, and the assertions are about
 * what survived, what was refused, and what was left untouched.
 */

import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { MAX_COMMANDS, MAX_CONTENT_BYTES } from "../../src/cloudflare/commands.ts";
import { encodeBase64 } from "../../src/cloudflare/encoding.ts";
import { sha256Hex } from "../../src/workspace/sha256.ts";
import type { ExecutorObject } from "./support/executor-object.ts";
import {
  BLOB_ID,
  DOFS_MANIFEST,
  FILE_BYTES,
  MANIFEST_ID,
  POLICY,
  ROOT_ID,
  ROOT_MANIFEST,
  RUN_ID,
  VALID_CLAIMS,
} from "./support/executor-object.ts";
import { generateKeys, signToken, type TestKeys } from "./support/tokens.ts";
import { run } from "effection";
import {
  type OwnerSocket,
  type SocketListener,
  useOwnerConnection,
} from "../../src/remote/client.ts";
import { cloudflareReadLink, cloudflareRunLink } from "../../src/cloudflare/client.ts";

let unique = 0;
const NEW_START = "2026-02-02T00:00:00.000Z";
const NOW = 1_800_000_000;
let keys: TestKeys;

beforeAll(async () => {
  keys = await generateKeys();
});

function executor() {
  unique += 1;
  return env.EXECUTOR.get(env.EXECUTOR.idFromName(`remote-${unique}-${Math.random()}`));
}

function on<T>(
  stub: ReturnType<typeof executor>,
  body: (instance: ExecutorObject) => T,
): Promise<T> {
  return runInDurableObject(stub, body);
}

async function admission(stub: ReturnType<typeof executor>): Promise<string> {
  await on(stub, (owner) => owner.configure([{ kid: keys.kid, jwk: keys.publicJwk }], NOW));
  const token = await signToken(keys, {
    ...VALID_CLAIMS,
    iat: NOW - 10,
    nbf: NOW - 10,
    exp: NOW + 600,
  });
  return await on(stub, (owner) => owner.admitConnection({ token, release: POLICY.release }));
}

async function admit(stub: ReturnType<typeof executor>): Promise<void> {
  expect(await admission(stub)).toBe("admitted");
}

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
  return askFrame(socket, JSON.stringify({ id, ...command }));
}

function askFrame(
  socket: WebSocket,
  message: string | ArrayBuffer,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const receive = (event: MessageEvent) => {
      socket.removeEventListener("message", receive);
      if (typeof event.data !== "string") {
        reject(new Error("expected a text answer"));
        return;
      }
      resolve(record(JSON.parse(event.data)));
    };
    socket.addEventListener("message", receive);
    socket.send(message);
  });
}

/**
 * The platform socket, as the runner's client needs it.
 *
 * A host binds its own socket to this interface; the runtime's event types are
 * wider than the four members the client uses, so the binding is written out
 * rather than asserted.
 */
function ownerSocket(socket: WebSocket, beforeSend?: (raw: string) => Promise<void> | undefined) {
  const listeners = new Map<SocketListener, EventListener>();
  const bound: OwnerSocket = {
    send(data) {
      // A frame may be held back before it reaches the owner, which is how a
      // test puts a write between two pages of one read without reaching
      // inside the client.
      const waiting = beforeSend?.(data);
      if (waiting === undefined) {
        socket.send(data);
        return;
      }
      void waiting.then(() => socket.send(data));
    },
    close: () => socket.close(),
    addEventListener(type, listener) {
      const forward: EventListener = (event) => listener(event as { data?: unknown });
      listeners.set(listener, forward);
      socket.addEventListener(type, forward);
    },
    removeEventListener(type, listener) {
      const bound = listeners.get(listener);
      const found = listeners.get(listener);
      if (found !== undefined) {
        socket.removeEventListener(type, found);
      }
    },
  };
  return bound;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected an object answer");
  }
  return Object.fromEntries(Object.entries(value));
}

function send(
  stub: ReturnType<typeof executor>,
  id: string,
  command: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return on(stub, (owner) => record(owner.send(1, JSON.stringify({ id, ...command }))));
}

describe("the remote owner protocol", () => {
  it("answers a binary frame once and closes the protocol", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    const socket = await connect(stub);
    expect(await askFrame(socket, new Uint8Array([1]).buffer)).toEqual({
      id: "",
      outcome: "refused",
      refusal: "command:malformed-member",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socket.readyState).not.toBe(WebSocket.OPEN);
  });

  it("refuses pristine, foreign, unsupported, damaged, missing, and wrong-run storage", async () => {
    const cases: readonly [string, (owner: ExecutorObject) => void, string][] = [
      ["pristine", () => undefined, "storage:foreign"],
      ["foreign", (owner) => owner.makeForeign(), "storage:foreign"],
      [
        "unsupported",
        (owner) => {
          owner.initialize();
          owner.rewriteMarker(0x584d4431, 2);
        },
        "storage:unsupported-version-v2",
      ],
      [
        "damaged",
        (owner) => {
          owner.initialize();
          owner.dropTable("workflow_suspension_answers");
        },
        "storage:corrupt",
      ],
      [
        "missing",
        (owner) => {
          owner.initialize();
          owner.removeWorkspaceState();
        },
        "storage:corrupt",
      ],
      [
        "wrong-run",
        (owner) => {
          owner.initialize();
          owner.rewriteRunId("somebody-else");
        },
        "storage:corrupt",
      ],
    ];
    for (const [name, arrange, refusal] of cases) {
      const stub = executor();
      await on(stub, arrange);
      const admitted = await admission(stub);
      const answer =
        admitted === "admitted" ? await send(stub, name, { command: "frontier" }) : admitted;
      expect([name, answer]).toEqual([
        name,
        typeof answer === "string" ? refusal : { id: name, outcome: "refused", refusal },
      ]);
    }
  });

  it("names a refusal category and repeats nothing it was given or holds", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    await on(stub, (owner) => owner.rewriteRunId("a-retained-secret-run"));
    await admit(stub);
    const damaged = await send(stub, "id-carrying-a-secret", { command: "frontier" });
    // The refusal names a category. It does not repeat the retained run
    // identity it disagreed with, and it does not repeat the request beyond the
    // correlation the runner needs to match its own question.
    expect(damaged).toEqual({
      id: "id-carrying-a-secret",
      outcome: "refused",
      refusal: "storage:corrupt",
    });
    const printed = JSON.stringify(damaged);
    for (const retained of ["a-retained-secret-run", RUN_ID, ROOT_MANIFEST, "workflow_run"]) {
      expect(printed).not.toContain(retained);
    }

    const rejected = await send(stub, "unknown", {
      command: "root",
      workspaceRootId: "f".repeat(64),
      somethingElse: "a value the request supplied",
    });
    // Not even the correlation survives a request that never parsed: an id is
    // echoed once the command has been read, and this one never was.
    expect(rejected).toEqual({ id: "", outcome: "refused", refusal: "command:unknown-member" });
    expect(JSON.stringify(rejected)).not.toContain("a value the request supplied");
  });

  it("anchors and reconstructs a journal larger than one page", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    for (let index = 0; index < 129; index += 1) {
      await on(stub, (owner) => owner.appendJournal(`event-${index}`, `event ${index}`));
    }
    // A real accepted connection: this reads across several object round trips
    // and a pair socket does not survive the object being reset between them.
    const socket = await connect(stub);
    const frontier = record((await ask(socket, "frontier", { command: "frontier" }))["value"]);
    expect(frontier["workspaceRootId"]).toBe(ROOT_ID);
    expect(frontier["journalEventId"]).toBe("event-128");
    expect(record(frontier["record"])["runId"]).toBe(RUN_ID);

    await on(stub, (owner) => owner.appendJournal("event-later", "later"));
    const first = record(
      (
        await ask(socket, "journal-1", {
          command: "journal",
          anchorEventId: "event-128",
          afterEventId: null,
        })
      )["value"],
    );
    expect(Array.isArray(first["entries"]) && first["entries"]).toHaveLength(128);
    expect(first["done"]).toBe(false);
    const second = record(
      (
        await ask(socket, "journal-2", {
          command: "journal",
          anchorEventId: "event-128",
          afterEventId: "event-127",
        })
      )["value"],
    );
    expect(second["entries"]).toEqual([
      expect.objectContaining({ eventId: "event-128", previousEventId: "event-127" }),
    ]);
    expect(second["done"]).toBe(true);
  });

  it("reads a whole retained history back through the runner's own client", async () => {
    // The one test where the owner's answers and the runner's parser meet. Each
    // half was already proven against a hand-built counterpart, which is
    // exactly why a disagreement between them could survive: the owner may
    // answer a shape no runner accepts and both halves still pass. This
    // composes the real pages through the real client.
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    for (let index = 0; index < 129; index += 1) {
      const id = `execution-${String(index).padStart(3, "0")}`;
      await on(stub, (owner) => owner.beginExecution(id, `2026-01-01T00:00:0${index % 10}.000Z`));
    }
    // Two stopped rows, so the optional members cross as well as the required
    // ones. A record that only ever travelled in its shortest form would not
    // prove the parser accepts the shape the owner actually builds.
    await on(stub, (owner) =>
      owner.stopExecution("execution-001", "2026-01-01T01:00:00.000Z", "completed"),
    );
    await on(stub, (owner) =>
      owner.stopExecution("execution-002", "2026-01-01T02:00:00.000Z", "failed", "it-stopped"),
    );

    const socket = await connect(stub);
    let identifier = 0;
    // 129 rows page at 128, so the read takes two requests. The later row is
    // written between them: after the first page fixed the anchor, and before
    // the owner is asked for the second. That is the moment the anchor exists
    // to survive, and asserting it any later would prove nothing about paging.
    let requests = 0;
    let inserted = false;
    const wire = ownerSocket(socket, (raw) => {
      if (!raw.includes('"executions"')) {
        return undefined;
      }
      requests += 1;
      if (requests !== 2) {
        return undefined;
      }
      inserted = true;
      return on(stub, (owner) => owner.beginExecution("execution-later", NEW_START));
    });
    const outcome = await run(function* () {
      const connection = yield* useOwnerConnection(wire);
      const ids = () => `read-${(identifier += 1)}`;
      const link = cloudflareRunLink(
        connection,
        cloudflareReadLink(connection, ids, RUN_ID),
        ids,
        RUN_ID,
      );
      const first = yield* link.readExecutions();
      return { first, second: yield* link.readExecutions() };
    });
    // The write really did land between the two page requests.
    expect([requests >= 2, inserted]).toEqual([true, true]);

    if (!outcome.first.ok) {
      throw outcome.first.error;
    }
    const records = outcome.first.value;
    expect(records).toHaveLength(129);
    expect(records.map((held) => held.executionId)).toEqual(
      Array.from({ length: 129 }, (_, index) => `execution-${String(index).padStart(3, "0")}`),
    );
    expect(records[0]).toEqual({
      executionId: "execution-000",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(records[1]).toEqual({
      executionId: "execution-001",
      startedAt: "2026-01-01T00:00:01.000Z",
      stoppedAt: "2026-01-01T01:00:00.000Z",
      stopStatus: "completed",
    });
    expect(records[2]).toEqual({
      executionId: "execution-002",
      startedAt: "2026-01-01T00:00:02.000Z",
      stoppedAt: "2026-01-01T02:00:00.000Z",
      stopStatus: "failed",
      stopReason: { kind: "host", code: "it-stopped" },
    });
    // Nothing physical crossed: the runner never sees a column name.
    expect(Object.keys(records[0])).toEqual(["executionId", "startedAt"]);

    if (!outcome.second.ok) {
      throw outcome.second.error;
    }
    // The later row is outside the first anchored snapshot and inside the next.
    expect(outcome.second.value).toHaveLength(130);
    expect(outcome.second.value[129]?.executionId).toBe("execution-later");
  });

  it("ends a page on the byte bound, and refuses a record that can never fit", async () => {
    // The entry bound is 128 rows; this one is reached by bytes first. Both
    // ends measure the same serialized `rows` array, so what the owner decides
    // fits is exactly what the runner accepts — and the whole history still
    // arrives, in order, across however many pages that takes.
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    const padding = "p".repeat(64 * 1024);
    for (let index = 0; index < 20; index += 1) {
      const id = `${String(index).padStart(2, "0")}-${padding}`;
      await on(stub, (owner) => owner.beginExecution(id, "2026-01-01T00:00:00.000Z"));
    }
    const socket = await connect(stub);
    let identifier = 0;
    let requests = 0;
    const wire = ownerSocket(socket, (raw) => {
      if (raw.includes('"executions"')) {
        requests += 1;
      }
      return undefined;
    });
    const outcome = await run(function* () {
      const connection = yield* useOwnerConnection(wire);
      const ids = () => `page-${(identifier += 1)}`;
      return yield* cloudflareRunLink(
        connection,
        cloudflareReadLink(connection, ids, RUN_ID),
        ids,
        RUN_ID,
      ).readExecutions();
    });
    if (!outcome.ok) {
      throw outcome.error;
    }
    expect(outcome.value).toHaveLength(20);
    expect(outcome.value.map((held) => held.executionId.slice(0, 2))).toEqual(
      Array.from({ length: 20 }, (_, index) => String(index).padStart(2, "0")),
    );
    // Well under 128 entries a page, so bytes ended these pages, not the count.
    expect(requests).toBeGreaterThan(1);

    // One record larger than a whole page. There is no page that could carry
    // it, so the owner refuses rather than answering with something the runner
    // is required to reject.
    const single = executor();
    await on(single, (owner) => owner.initialize());
    const huge = "h".repeat(600 * 1024);
    await on(single, (owner) => owner.beginExecution(huge, "2026-01-01T00:00:00.000Z"));
    const alone = await connect(single);
    let count = 0;
    const refused = await run(function* () {
      const connection = yield* useOwnerConnection(ownerSocket(alone));
      const ids = () => `huge-${(count += 1)}`;
      return yield* cloudflareRunLink(
        connection,
        cloudflareReadLink(connection, ids, RUN_ID),
        ids,
        RUN_ID,
      ).readExecutions();
    });
    expect(refused.ok).toBe(false);
    // Provider-neutral, with no private refusal spelling in it.
    expect(String(refused.ok === false && refused.error)).not.toContain("command:");
  });

  it("returns only content referenced by one validated root", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    // A real accepted connection: a `WebSocketPair` made inside the object does
    // not survive the object being reset between calls, and this test reads
    // across several of them.
    const socket = await connect(stub);
    expect(await ask(socket, "root", { command: "root", workspaceRootId: ROOT_ID })).toEqual({
      id: "root",
      outcome: "performed",
      value: { workspaceRootId: ROOT_ID, manifest: ROOT_MANIFEST },
    });
    expect(
      await ask(socket, "manifest", {
        command: "content",
        workspaceRootId: ROOT_ID,
        kind: "manifest",
        digest: MANIFEST_ID,
        sourceManifest: null,
      }),
    ).toEqual({
      id: "manifest",
      outcome: "performed",
      value: {
        kind: "manifest",
        digest: MANIFEST_ID,
        size: new TextEncoder().encode(DOFS_MANIFEST).length,
        bytes: encodeBase64(new TextEncoder().encode(DOFS_MANIFEST)),
      },
    });
    expect(
      await ask(socket, "blob", {
        command: "content",
        workspaceRootId: ROOT_ID,
        kind: "blob",
        digest: BLOB_ID,
        sourceManifest: MANIFEST_ID,
      }),
    ).toMatchObject({ outcome: "performed", value: { digest: BLOB_ID, size: FILE_BYTES.length } });

    const orphan = await on(stub, (owner) =>
      owner.addUnreferencedBlob(new TextEncoder().encode("orphan")),
    );
    expect(
      await ask(socket, "orphan", {
        command: "content",
        workspaceRootId: ROOT_ID,
        kind: "blob",
        digest: orphan,
        sourceManifest: MANIFEST_ID,
      }),
    ).toEqual({ id: "orphan", outcome: "refused", refusal: "storage:corrupt" });
  });

  it("refuses a root whose content graph is incomplete, before returning one", async () => {
    // A root is a starting frontier: the runner materializes it and proposes
    // against it. Discovering a piece is missing when the runner asks for it
    // would mean the failure arrives after the run has been told where it
    // stands, so the whole graph is proved before either read answers.
    const damage: Record<string, (owner: ExecutorObject) => void> = {
      "a missing manifest row": (owner) => owner.removeManifestRow(),
      "a manifest payload that is not its identity": (owner) => owner.damageManifestPayload(),
      "a manifest size that disagrees with its chunks": (owner) => owner.damageManifestSize(),
      "a missing blob reached through a manifest": (owner) => owner.removeBlobRow(),
      "blob bytes that are not their identity": (owner) => owner.damageRetainedBlob(),
      "a blob size that disagrees with its bytes": (owner) => owner.damageBlobSize(),
      "a blob reference the manifests still name": (owner) => owner.removeBlobReference(),
      "a blob reference no manifest names": (owner) =>
        owner.addExtraBlobReference(new TextEncoder().encode("unaccounted for")),
    };

    for (const [description, arrange] of Object.entries(damage)) {
      const stub = executor();
      await on(stub, (owner) => owner.initialize());
      await on(stub, arrange);
      await admit(stub);
      for (const command of [
        { command: "frontier" },
        { command: "root", workspaceRootId: ROOT_ID },
      ]) {
        const answer = await send(stub, `${String(command.command)}`, command);
        expect([description, command.command, answer]).toEqual([
          description,
          command.command,
          { id: command.command, outcome: "refused", refusal: "storage:corrupt" },
        ]);
      }
    }
  });

  it("says only that storage is damaged, and never what it read or was asked", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    const unaccounted = await on(stub, (owner) =>
      owner.addExtraBlobReference(new TextEncoder().encode("unaccounted for")),
    );
    await admit(stub);
    const answer = await send(stub, "root", { command: "root", workspaceRootId: ROOT_ID });
    expect(answer).toEqual({ id: "root", outcome: "refused", refusal: "storage:corrupt" });
    const printed = JSON.stringify(answer);
    for (const withheld of [
      unaccounted,
      BLOB_ID,
      MANIFEST_ID,
      ROOT_ID,
      ROOT_MANIFEST,
      "workspace_root_blob_refs",
      "vfs_manifests",
      "/README.md",
    ]) {
      expect(printed).not.toContain(withheld);
    }
  });

  it("refuses retained bytes whose identity or recorded size is damaged", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    await on(stub, (owner) => owner.damageRetainedBlob());
    await admit(stub);
    expect(
      await send(stub, "blob", {
        command: "content",
        workspaceRootId: ROOT_ID,
        kind: "blob",
        digest: BLOB_ID,
        sourceManifest: MANIFEST_ID,
      }),
    ).toEqual({
      id: "blob",
      outcome: "refused",
      refusal: "storage:corrupt",
    });
  });

  it("replays compatible commands and refuses conflicting reuse", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    await on(stub, (owner) => owner.appendJournal("before", "before"));
    const socket = await connect(stub);
    const first = await ask(socket, "same", { command: "frontier" });
    await on(stub, (owner) => owner.appendJournal("after", "after"));
    // The same id and the same canonical request returns the anchored frontier
    // it already decided, not the later one.
    expect(await ask(socket, "same", { command: "frontier" })).toEqual(first);
    expect(await ask(socket, "same", { command: "root", workspaceRootId: ROOT_ID })).toEqual({
      id: "same",
      outcome: "refused",
      refusal: "command:duplicate-conflict",
    });
  });

  it("keeps staged bytes private, durable across eviction, and scoped to one acquisition", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    const socket = await connect(stub);
    const bytes = new TextEncoder().encode("proposed content");
    const digest = sha256Hex(bytes);
    const command = { command: "stage", kind: "blob", digest, bytes: encodeBase64(bytes) };
    const first = await ask(socket, "stage", command);
    expect(first).toMatchObject({ outcome: "performed", value: { digest, size: bytes.length } });
    expect(await on(stub, (owner) => owner.scratch())).toEqual({ commands: 1, staged: 1 });

    await evictDurableObject(stub);
    expect(await ask(socket, "stage", command)).toEqual(first);
    expect(await on(stub, (owner) => owner.scratch())).toEqual({ commands: 1, staged: 1 });
    expect(
      await ask(socket, "read-stage", {
        command: "content",
        workspaceRootId: ROOT_ID,
        kind: "blob",
        digest,
        sourceManifest: MANIFEST_ID,
      }),
    ).toEqual({ id: "read-stage", outcome: "refused", refusal: "storage:corrupt" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      await on(stub, (owner) =>
        owner.admitConnection({ token: "not-a-token", release: POLICY.release }),
      ),
    ).toBe("token:token-malformed");
    expect(await on(stub, (owner) => owner.scratch())).toEqual({ commands: 1, staged: 1 });
    const before = await on(stub, (owner) => owner.authoritative());
    const replaced = await on(stub, (owner) => owner.acquisitionId());
    // A real accepted connection for the replacement: the rest of this test
    // reads across several object round trips.
    const successor = await connect(stub);
    // A second acquisition, and the first one's scratch is gone rather than
    // inherited: it cannot be retried, adopted or read.
    expect(await on(stub, (owner) => owner.acquisitionId())).not.toBe(replaced);
    expect(await on(stub, (owner) => owner.scratch())).toEqual({ commands: 0, staged: 0 });
    expect(await on(stub, (owner) => owner.authoritative())).toBe(before);
    // The predecessor's own command id is free again, and staging the same
    // bytes writes a new row rather than finding the abandoned one. Nothing was
    // inherited; it was discarded and done afresh.
    expect(
      await ask(successor, "stage", {
        command: "stage",
        kind: "blob",
        digest,
        bytes: encodeBase64(bytes),
      }),
    ).toMatchObject({ outcome: "performed", value: { digest } });
    expect(await on(stub, (owner) => owner.scratch())).toEqual({ commands: 1, staged: 1 });
    expect(await ask(successor, "frontier-new", { command: "frontier" })).toMatchObject({
      outcome: "performed",
      value: { workspaceRootId: ROOT_ID },
    });
    expect(await on(stub, (owner) => owner.authoritative())).toBe(before);
  });

  it("grants a copied attachment or a foreign socket no read at all", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    await admit(stub);
    const request = JSON.stringify({ id: "borrowed", command: "frontier" });
    expect(await on(stub, (owner) => record(owner.sendWithCopiedAttachment(request)))).toEqual({
      id: "",
      outcome: "refused",
      refusal: "acquisition:foreign-connection",
    });
    expect(await on(stub, (owner) => record(owner.sendAsStranger(request)))).toEqual({
      id: "",
      outcome: "refused",
      refusal: "acquisition:foreign-connection",
    });
    expect(await on(stub, (owner) => owner.scratch())).toEqual({ commands: 0, staged: 0 });
  });

  it("leaves no staged row when decoding or digest validation fails", async () => {
    const bytes = new TextEncoder().encode("piece");
    const oversized = new Uint8Array(MAX_CONTENT_BYTES + 1);
    // Each of these is a broken channel rather than an answer, so each closes
    // the connection it arrived on — which is why every case gets its own.
    const cases: Record<string, [Record<string, unknown>, string]> = {
      "bad base64": [
        { kind: "blob", digest: sha256Hex(bytes), bytes: "not base64" },
        "command:malformed-member",
      ],
      "a digest that is not the bytes": [
        { kind: "blob", digest: "0".repeat(64), bytes: encodeBase64(bytes) },
        "command:malformed-member",
      ],
      "a piece past the bound": [
        { kind: "blob", digest: sha256Hex(oversized), bytes: encodeBase64(oversized) },
        "command:too-large",
      ],
    };
    for (const [description, [request, refusal]] of Object.entries(cases)) {
      const stub = executor();
      await on(stub, (owner) => owner.initialize());
      const socket = await connect(stub);
      const answer = await ask(socket, "staged", { command: "stage", ...request });
      expect([description, answer["refusal"]]).toEqual([description, refusal]);
      expect([description, await on(stub, (owner) => owner.scratch())]).toEqual([
        description,
        { commands: 0, staged: 0 },
      ]);
    }
  });

  it("refuses aggregate staging overflow without a partial piece or decision", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    const socket = await connect(stub);
    for (let index = 0; index < 2; index += 1) {
      const bytes = new Uint8Array(MAX_CONTENT_BYTES);
      bytes[0] = index;
      expect(
        await ask(socket, `piece-${index}`, {
          command: "stage",
          kind: "blob",
          digest: sha256Hex(bytes),
          bytes: encodeBase64(bytes),
        }),
      ).toMatchObject({ outcome: "performed", value: { size: MAX_CONTENT_BYTES } });
    }
    const overflow = new Uint8Array([3]);
    expect(
      await ask(socket, "overflow", {
        command: "stage",
        kind: "blob",
        digest: sha256Hex(overflow),
        bytes: encodeBase64(overflow),
      }),
    ).toEqual({ id: "overflow", outcome: "refused", refusal: "command:capacity" });
    expect(await on(stub, (owner) => owner.scratch())).toEqual({ commands: 2, staged: 2 });
  });

  it("bounds the retry ledger without evicting earlier decisions", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    const socket = await connect(stub);
    const first = await ask(socket, "command-0", { command: "frontier" });
    for (let index = 1; index < MAX_COMMANDS; index += 1) {
      expect(await ask(socket, `command-${index}`, { command: "frontier" })).toMatchObject({
        outcome: "performed",
      });
    }
    expect(await ask(socket, "overflow", { command: "frontier" })).toEqual({
      id: "overflow",
      outcome: "refused",
      refusal: "command:capacity",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socket.readyState).not.toBe(WebSocket.OPEN);
    expect(await on(stub, (owner) => owner.scratch())).toEqual({
      commands: MAX_COMMANDS,
      staged: 0,
    });
    expect(first).toMatchObject({ outcome: "performed" });
  });

  it("refuses a settlement rather than reporting placeholder success", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    await admit(stub);
    expect(
      await send(stub, "settle", {
        command: "settle",
        completion: { executionId: "execution", status: "completed" },
        expectedWorkspaceRootId: ROOT_ID,
      }),
    ).toEqual({ id: "settle", outcome: "refused", refusal: "command:unavailable" });
  });
});
