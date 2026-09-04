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

let unique = 0;
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
        "storage:unsupported-version",
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
    await admit(stub);
    // A second acquisition, and the first one's scratch is gone rather than
    // inherited: it cannot be retried, adopted or read.
    expect(await on(stub, (owner) => owner.acquisitionId())).not.toBe(replaced);
    expect(await on(stub, (owner) => owner.scratch())).toEqual({ commands: 0, staged: 0 });
    expect(await on(stub, (owner) => owner.authoritative())).toBe(before);
    // The predecessor's own command id is free again, and staging the same
    // bytes writes a new row rather than finding the abandoned one. Nothing was
    // inherited; it was discarded and done afresh.
    expect(
      await send(stub, "stage", {
        command: "stage",
        kind: "blob",
        digest,
        bytes: encodeBase64(bytes),
      }),
    ).toMatchObject({ outcome: "performed", value: { digest } });
    expect(await on(stub, (owner) => owner.scratch())).toEqual({ commands: 1, staged: 1 });
    expect(await send(stub, "frontier-new", { command: "frontier" })).toMatchObject({
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
