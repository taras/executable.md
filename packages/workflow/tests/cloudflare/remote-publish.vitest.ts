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
import type { ExecutorObject as _ExecutorObject } from "./support/executor-object.ts";
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
import { locatorFingerprintOf } from "../../src/composition/locator.ts";
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
const LOCATOR = "https://git.example.invalid/octo/app.git";

const REPOSITORY = {
  kind: "repository",
  locator: LOCATOR,
  record: {
    name: "app",
    locatorFingerprint: locatorFingerprintOf(LOCATOR),
    requestedBase: null,
    creationCommit: "9".repeat(40),
    primaryBranch: "main",
    objectFormat: "sha1",
    checkoutPath: "/app",
  },
};

/** Stage the one missing piece over an accepted connection. */
async function stageThrough(socket: WebSocket): Promise<void> {
  await ask(socket, "stage-blob", {
    command: "stage",
    kind: "blob",
    digest: NEXT_BLOB_ID,
    bytes: encodeBase64(NEXT_BYTES),
  });
  const manifest = new TextEncoder().encode(
    JSON.stringify({ version: 1, chunks: [{ hash: NEXT_BLOB_ID, size: NEXT_BYTES.length }] }),
  );
  await ask(socket, "stage-manifest", {
    command: "stage",
    kind: "manifest",
    digest: sha256Hex(manifest),
    bytes: encodeBase64(manifest),
  });
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
    const socket = await connect(stub);
    await stageThrough(socket);

    const before = await on(stub, (owner) => owner.published());
    expect(before).toMatchObject({ currentRootId: ROOT_ID, roots: 1, events: [] });

    const answer = await ask(socket, "publish", commit());
    expect(answer).toEqual(expect.objectContaining({ outcome: "performed" }));
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
    const frontier = record(record(await ask(socket, "read", { command: "frontier" }))["value"]);
    expect(frontier["workspaceRootId"]).toBe(NEXT_ROOT_ID);
    expect(
      record(await ask(socket, "root", { command: "root", workspaceRootId: NEXT_ROOT_ID })),
    ).toMatchObject({ outcome: "performed" });
  });

  it("admits root, journal anchor and every mapping as one state", async () => {
    // The invocation snapshot D3c begins from. It is one read on the owner
    // because it is one fact: mappings taken from one moment and a root from
    // another would let an invocation start against a Workspace its retained
    // rows do not describe, and nothing later could tell.
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    const socket = await connect(stub);

    const empty = record(record(await ask(socket, "empty", { command: "mappings" }))["value"]);
    expect(empty).toEqual({
      workspaceRootId: ROOT_ID,
      journalEventId: null,
      repositories: [],
      worktrees: [],
      agentSessions: [],
    });

    await stageThrough(socket);
    const published = await ask(socket, "publish", commit());
    expect(published).toEqual(expect.objectContaining({ outcome: "performed" }));

    // One commit moved the pointer, retained the mapping and wrote the row.
    // The next snapshot observes all of it, and observes it together.
    const after = record(record(await ask(socket, "after", { command: "mappings" }))["value"]);
    expect(after["workspaceRootId"]).toBe(NEXT_ROOT_ID);
    expect(typeof after["journalEventId"]).toBe("string");
    expect(after["repositories"]).toEqual([{ record: REPOSITORY.record, locator: LOCATOR }]);
    expect(after["worktrees"]).toEqual([]);
    expect(after["agentSessions"]).toEqual([]);

    // The same anchor the frontier reports, from the same owner state.
    const frontier = record(
      record(await ask(socket, "frontier", { command: "frontier" }))["value"],
    );
    expect([frontier["workspaceRootId"], frontier["journalEventId"]]).toEqual([
      after["workspaceRootId"],
      after["journalEventId"],
    ]);
  });

  it("returns no partial snapshot when more is retained than one may carry", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    const socket = await connect(stub);
    // Under the ceiling the snapshot answers whole.
    await on(stub, (owner) => owner.fillRepositories(0, 200));
    const held = record(record(await ask(socket, "under", { command: "mappings" }))["value"]);
    expect(Array.isArray(held["repositories"]) && held["repositories"]).toHaveLength(200);

    // Over it, the answer is a refusal rather than as much as would fit. A
    // partial snapshot would describe a run holding fewer Repositories than it
    // does, and every reconciliation against it would be decided wrongly.
    await on(stub, (owner) => owner.fillRepositories(200, 200));
    const answer = await ask(socket, "over", { command: "mappings" });
    expect(answer["outcome"]).toBe("refused");
    expect(answer["value"]).toBe(undefined);
  });

  it("keeps the expected root current for a journal-only transaction", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    const socket = await connect(stub);
    const answer = await ask(
      socket,
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
    const socket = await connect(stub);
    expect(
      await ask(socket, "empty", commit({ publication: null, mappings: [], events: [] })),
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
    const socket = await connect(stub);
    await stageThrough(socket);
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
    expect(await ask(socket, "doomed", commit())).toMatchObject({ outcome: "performed" });
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
      const socket = await connect(stub);
      await stageThrough(socket);
      const before = await on(stub, (owner) => owner.published());
      const answer = await ask(socket, "refused", request);
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
    const socket = await connect(stub);
    // Nothing staged: the proposal names a piece the owner neither holds nor
    // was given by this connection.
    const before = await on(stub, (owner) => owner.published());
    expect(await ask(socket, "unstaged", commit())).toMatchObject({ outcome: "refused" });
    expect(await on(stub, (owner) => owner.published())).toEqual(before);
  });

  it("refuses a mapping that would rewrite an established identity", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    const socket = await connect(stub);
    await stageThrough(socket);
    expect(await ask(socket, "first", commit())).toMatchObject({ outcome: "performed" });
    const published = await on(stub, (owner) => owner.published());

    // The same Repository name, a different creation commit. Creation identity
    // is immutable, so this is refused rather than allowed to overwrite it.
    expect(
      await ask(
        socket,
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

  it("retains only records that are exactly what the serializer produced", async () => {
    // A record the database will accept as JSON is not a durable event. One
    // retained here would be history a later read cannot parse, and the run
    // would become unreplayable at the moment it was told it had committed.
    const valid = event("real");
    const cases: Record<string, string> = {
      "JSON that is not an event": "{}",
      "an event without its terminating newline": valid.trimEnd(),
      "a noncanonical re-encoding": `${JSON.stringify(JSON.parse(valid.trimEnd()), null, 1)}\n`,
      "not JSON at all": "event-1",
    };
    for (const [description, record_] of Object.entries(cases)) {
      const stub = executor();
      await on(stub, (owner) => owner.initialize());
      const socket = await connect(stub);
      const before = await on(stub, (owner) => owner.published());
      const answer = await ask(
        socket,
        "bad-event",
        commit({ publication: null, mappings: [], events: [record_] }),
      );
      // The id is empty because the command never finished parsing: an id is
      // echoed once the request has been read, and this one was not.
      expect([description, answer]).toEqual([
        description,
        { id: "", outcome: "refused", refusal: "command:malformed-member" },
      ]);
      expect([description, await on(stub, (owner) => owner.published())]).toEqual([
        description,
        before,
      ]);
      // Nothing recorded a decision for work that never happened. A malformed
      // member is a broken channel rather than an answer, so the connection is
      // gone too — which is why the ledger is read through the object.
      expect([description, await on(stub, (owner) => owner.scratch())]).toEqual([
        description,
        { commands: 0, staged: 0 },
      ]);
    }
  });

  it("refuses a mapping that disagrees with retained identity in any field", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    // A real accepted connection: this walks several cases and a pair socket
    // does not survive the object being reset between them.
    const socket = await connect(stub);
    await stageThrough(socket);
    expect(await ask(socket, "first", commit())).toMatchObject({ outcome: "performed" });
    const published = await on(stub, (owner) => owner.published());
    const anchor = String((published["events"] as Record<string, unknown>[])[0]?.["event_id"]);

    // Every field that establishes creation identity, one at a time. A partial
    // comparison would report performed for a proposal that disagrees with what
    // an earlier execution established.
    const conflicts: Record<string, Record<string, unknown>> = {
      "a different locator, with its own fingerprint": {
        kind: "repository",
        locator: "https://git.example.invalid/other.git",
        record: {
          ...REPOSITORY.record,
          locatorFingerprint: locatorFingerprintOf("https://git.example.invalid/other.git"),
        },
      },
      "a different requested base": {
        ...REPOSITORY,
        record: { ...REPOSITORY.record, requestedBase: "release" },
      },
      "a different creation commit": {
        ...REPOSITORY,
        record: { ...REPOSITORY.record, creationCommit: "1".repeat(40) },
      },
      "a different primary branch": {
        ...REPOSITORY,
        record: { ...REPOSITORY.record, primaryBranch: "trunk" },
      },
      "a different checkout path": {
        ...REPOSITORY,
        record: { ...REPOSITORY.record, checkoutPath: "/elsewhere" },
      },
    };
    for (const [description, mapping] of Object.entries(conflicts)) {
      const answer = await ask(
        socket,
        `conflict-${description}`,
        commit({
          expectedWorkspaceRootId: NEXT_ROOT_ID,
          expectedJournalEventId: anchor,
          publication: null,
          mappings: [mapping],
          events: [],
        }),
      );
      expect([description, answer["refusal"]]).toEqual([description, "command:mapping-conflict"]);
      expect([description, await on(stub, (owner) => owner.published())]).toEqual([
        description,
        published,
      ]);
    }
  });

  it("refuses a new checkout mapping that no publication creates", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    const socket = await connect(stub);
    const before = await on(stub, (owner) => owner.published());

    // A mapping-only commit would retain a claim about a directory nothing put
    // there, and the next execution would find the claim and not the files.
    expect(
      await ask(
        socket,
        "no-publication",
        commit({ publication: null, mappings: [REPOSITORY], events: [] }),
      ),
    ).toMatchObject({ refusal: "command:mapping-conflict" });
    expect(await on(stub, (owner) => owner.published())).toEqual(before);

    // A Worktree whose Repository is neither retained nor proposed belongs to
    // nothing.
    await stageThrough(socket);
    expect(
      await ask(
        socket,
        "orphan-worktree",
        commit({
          mappings: [
            {
              kind: "worktree",
              record: {
                repositoryName: "absent",
                name: "feature",
                requestedBranch: "feature",
                requestedBase: null,
                creationCommit: "2".repeat(40),
                checkoutPath: "/app",
              },
            },
          ],
        }),
      ),
    ).toMatchObject({ refusal: "command:mapping-conflict" });
    expect(await on(stub, (owner) => owner.published())).toEqual(before);
  });

  it("refuses one proposal naming one mapping twice", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    const socket = await connect(stub);
    await stageThrough(socket);
    const before = await on(stub, (owner) => owner.published());
    expect(
      await ask(socket, "duplicate", commit({ mappings: [REPOSITORY, REPOSITORY] })),
    ).toMatchObject({ refusal: "command:mapping-conflict" });
    expect(await on(stub, (owner) => owner.published())).toEqual(before);
  });

  it("refuses to append history over a current root that is damaged", async () => {
    // A commit accepts its starting root as the run's frontier. One whose graph
    // cannot be materialized is not a frontier, and a proposal is not a licence
    // to repair it.
    const damage: Record<string, (owner: ExecutorObject) => void> = {
      "a blob whose bytes are not its identity": (owner) => owner.damageRetainedBlob(),
      "a blob whose recorded size is wrong": (owner) => owner.damageBlobSize(),
      "a manifest whose recorded size is wrong": (owner) => owner.damageManifestSize(),
      "a reference no manifest names": (owner) =>
        owner.addExtraBlobReference(new TextEncoder().encode("unaccounted for")),
    };
    for (const [description, arrange] of Object.entries(damage)) {
      const stub = executor();
      await on(stub, (owner) => owner.initialize());
      await on(stub, arrange);
      const socket = await connect(stub);
      const before = await on(stub, (owner) => owner.published());
      const answer = await ask(
        socket,
        "over-damage",
        commit({ publication: null, mappings: [], events: [event("noted")] }),
      );
      expect([description, answer["refusal"]]).toEqual([description, "storage:corrupt"]);
      expect([description, await on(stub, (owner) => owner.published())]).toEqual([
        description,
        before,
      ]);
    }
  });

  it("retains only a locator this system would hand to Git", async () => {
    // A matching fingerprint says the two values agree with each other. It says
    // nothing about whether the locator is one that may ever be used, and an
    // authenticated proposal must not be able to retain a credential or an
    // executable transport form.
    const refused: Record<string, string> = {
      "a credential in the URL": "https://user:token@git.example.invalid/octo/app.git",
      "an executable transport form": "ext::sh -c 'curl example.invalid'",
      "a query that can carry a token": "https://git.example.invalid/app.git?access_token=abc",
      "an unknown scheme": "javascript:alert(1)",
      "a relative path": "../elsewhere",
    };
    for (const [description, locator] of Object.entries(refused)) {
      const stub = executor();
      await on(stub, (owner) => owner.initialize());
      const socket = await connect(stub);
      await stageThrough(socket);
      const before = await on(stub, (owner) => owner.published());
      const answer = await ask(
        socket,
        "bad-locator",
        commit({
          mappings: [
            {
              kind: "repository",
              locator,
              record: { ...REPOSITORY.record, locatorFingerprint: locatorFingerprintOf(locator) },
            },
          ],
        }),
      );
      expect([description, answer["refusal"]]).toEqual([description, "command:malformed-member"]);
      expect([description, await on(stub, (owner) => owner.published())]).toEqual([
        description,
        before,
      ]);
    }
  });

  it("retains the exact admitted locator, not its fingerprint", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    const socket = await connect(stub);
    await stageThrough(socket);
    expect(await ask(socket, "publish", commit())).toMatchObject({ outcome: "performed" });
    // The row a later restoration reads has to name the repository, not a
    // digest of it.
    expect(await on(stub, (owner) => owner.repositoryLocator("app"))).toBe(LOCATOR);
  });

  it("accepts a Repository and its Worktree in either order", async () => {
    const worktree = {
      kind: "worktree",
      record: {
        repositoryName: "app",
        name: "feature",
        requestedBranch: "feature",
        requestedBase: null,
        creationCommit: "2".repeat(40),
        checkoutPath: "/app",
      },
    };
    // Which of the two comes first in an array is not a difference between
    // proposals, so both spellings of one transaction must be accepted.
    for (const [description, mappings] of Object.entries({
      "parent first": [REPOSITORY, worktree],
      "child first": [worktree, REPOSITORY],
    })) {
      const stub = executor();
      await on(stub, (owner) => owner.initialize());
      const socket = await connect(stub);
      await stageThrough(socket);
      const answer = await ask(socket, "both", commit({ mappings }));
      expect([description, answer["outcome"]]).toEqual([description, "performed"]);
      expect([description, await on(stub, (owner) => owner.published())]).toMatchObject([
        description,
        { currentRootId: NEXT_ROOT_ID, repositories: [{ name: "app", checkout_path: "/app" }] },
      ]);
    }
  });

  it("refuses a blob whose bytes were never retained beside its metadata", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    // A metadata row with no bytes is a half-written identity. Completing it
    // from staging would repair authoritative damage as a side effect.
    await on(stub, (owner) => owner.removeBlobBytesOnly(NEXT_BLOB_ID, NEXT_BYTES.length));
    const socket = await connect(stub);
    await stageThrough(socket);
    const before = await on(stub, (owner) => owner.published());
    expect(await ask(socket, "half", commit())).toMatchObject({ refusal: "storage:corrupt" });
    expect(await on(stub, (owner) => owner.published())).toEqual(before);
    expect(await on(stub, (owner) => owner.scratch())).toMatchObject({ commands: 2 });
  });

  it("returns the same decision to a connection that replaced the one that lost it", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    const socket = await connect(stub);
    await stageThrough(socket);

    // The owner commits. The runner never sees the answer, and the connection
    // that asked is gone — which is exactly the case the acquisition-scoped
    // ledger cannot answer, because a replacement acquisition discards it.
    const first = await ask(socket, "recovered", commit());
    expect(first).toMatchObject({ outcome: "performed" });
    const published = await on(stub, (owner) => owner.published());
    socket.close(1000, "lost");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await evictDurableObject(stub);

    // A new connection, a new acquisition, the identical closed request.
    const replacement = await connect(stub);
    expect(await ask(replacement, "recovered", commit())).toEqual(first);

    // One root, one mapping, one set of journal rows.
    expect(await on(stub, (owner) => owner.published())).toEqual(published);

    // And the identity still cannot be reused for something else.
    expect(
      await ask(replacement, "recovered", commit({ events: [event("different")] })),
    ).toMatchObject({ outcome: "refused", refusal: "command:duplicate-conflict" });
    expect(await on(stub, (owner) => owner.published())).toEqual(published);
  });

  it("performs a proposal whose first attempt never reached the owner", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    const socket = await connect(stub);
    await stageThrough(socket);
    const before = await on(stub, (owner) => owner.published());

    // The first attempt was lost on the way out, so the owner never saw it.
    socket.close(1000, "lost before arriving");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await evictDurableObject(stub);

    const replacement = await connect(stub);
    await stageThrough(replacement);
    expect(await ask(replacement, "never-arrived", commit())).toMatchObject({
      outcome: "performed",
    });
    const after = await on(stub, (owner) => owner.published());
    expect(after["currentRootId"]).toBe(NEXT_ROOT_ID);
    expect(after).not.toEqual(before);
  });

  it("grants a closed or foreign socket no publication", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    const socket = await connect(stub);
    await stageThrough(socket);
    const before = await on(stub, (owner) => owner.published());
    expect(
      await on(stub, (owner) =>
        record(owner.sendAsStranger(JSON.stringify({ id: "foreign", ...commit() }))),
      ),
    ).toMatchObject({ outcome: "refused", refusal: "acquisition:foreign-connection" });
    expect(await on(stub, (owner) => owner.published())).toEqual(before);
  });
});

describe("the run's own records", () => {
  it("counts retrieval revisions authoritatively, and clearing starts again", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    const socket = await connect(stub);

    // The run is created with a retrieval row, so the first replacement is the
    // next revision rather than the first.
    const before = await on(stub, (owner) => owner.retrieval());
    expect(before).not.toBe(null);

    const first = await ask(socket, "r1", {
      command: "retrieval",
      expectedWorkspaceRootId: ROOT_ID,
      metadata: '{"locator":"https://example.invalid/a.git"}',
    });
    expect(first).toMatchObject({ outcome: "performed" });

    // Byte-identical metadata under a different id is a second replacement.
    const second = await ask(socket, "r2", {
      command: "retrieval",
      expectedWorkspaceRootId: ROOT_ID,
      metadata: '{"locator":"https://example.invalid/a.git"}',
    });
    expect(second).toMatchObject({ outcome: "performed" });
    const revisions = [first, second].map((answer) =>
      Number(record(record(answer["value"])["retrieval"])["revision"]),
    );
    expect(revisions[1]).toBe((revisions[0] ?? 0) + 1);

    // Clearing removes the row; the next replacement counts from one.
    expect(
      await ask(socket, "r3", {
        command: "retrieval",
        expectedWorkspaceRootId: ROOT_ID,
        metadata: null,
      }),
    ).toEqual({ id: "r3", outcome: "performed", value: { retrieval: null } });
    expect(await on(stub, (owner) => owner.retrieval())).toBe(null);
    const restarted = await ask(socket, "r4", {
      command: "retrieval",
      expectedWorkspaceRootId: ROOT_ID,
      metadata: '{"locator":"https://example.invalid/b.git"}',
    });
    expect(Number(record(record(restarted["value"])["retrieval"])["revision"])).toBe(1);
  });

  it("applies one retrieval replacement once across a lost answer and eviction", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    const socket = await connect(stub);
    const request = {
      command: "retrieval",
      expectedWorkspaceRootId: ROOT_ID,
      metadata: '{"locator":"https://example.invalid/once.git"}',
    };
    const performed = await ask(socket, "once", request);
    expect(performed).toMatchObject({ outcome: "performed" });
    const stored = await on(stub, (owner) => owner.retrieval());

    socket.close(1000, "lost");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await evictDurableObject(stub);

    const replacement = await connect(stub);
    // The same invocation asked again: the retained decision answers, and the
    // revision does not move.
    expect(await ask(replacement, "once", request)).toEqual(performed);
    expect(await on(stub, (owner) => owner.retrieval())).toEqual(stored);

    // The same identity for different content is a conflict, not a retry.
    expect(
      await ask(replacement, "once", { ...request, metadata: '{"locator":"other"}' }),
    ).toMatchObject({ outcome: "refused", refusal: "command:duplicate-conflict" });
    expect(await on(stub, (owner) => owner.retrieval())).toEqual(stored);
  });

  it("refuses a replacement proposed against a root the run has left", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    const socket = await connect(stub);
    const before = await on(stub, (owner) => owner.retrieval());
    expect(
      await ask(socket, "stale", {
        command: "retrieval",
        expectedWorkspaceRootId: `f${"0".repeat(63)}`,
        metadata: '{"locator":"x"}',
      }),
    ).toMatchObject({ outcome: "refused", refusal: "command:stale-root" });
    expect(await on(stub, (owner) => owner.retrieval())).toEqual(before);
  });

  it("anchors a multipage execution snapshot and excludes a later one", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    for (let index = 0; index < 129; index += 1) {
      await on(stub, (owner) =>
        owner.beginExecution(
          `execution-${index}`,
          `2026-09-04T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
        ),
      );
    }
    const socket = await connect(stub);

    // The first request carries no anchor; the owner chooses the terminal row
    // at this moment and answers with it.
    const anchored = record(
      (await ask(socket, "x1", { command: "executions", anchor: null, after: null }))["value"],
    );
    expect(anchored["anchor"]).toBe(129);
    expect(Array.isArray(anchored["rows"]) && anchored["rows"]).toHaveLength(128);
    expect(anchored["done"]).toBe(false);

    // A later execution begins while the read is in flight.
    await on(stub, (owner) => owner.beginExecution("execution-later", "2026-09-04T01:00:00.000Z"));

    const second = record(
      (await ask(socket, "x2", { command: "executions", anchor: 129, after: 128 }))["value"],
    );
    expect(Array.isArray(second["rows"]) && second["rows"]).toHaveLength(1);
    expect(second["done"]).toBe(true);
    // The one begun after the anchor is not in the snapshot.
    expect(record((second["rows"] as Record<string, unknown>[])[0] ?? {})["sequence"]).toBe(129);
  });
});
