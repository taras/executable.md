/**
 * Committing a fork on a real destination owner.
 *
 * Staging is scratch and the commit is one transaction: what this suite settles
 * is that a destination is either absent or whole, that the parts it was built
 * from stop being anything the moment they are adopted, and that a transfer
 * which does not add up refuses without leaving a half-run behind.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { serializeDurableEvent } from "@executablemd/durable-streams";
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
const SOURCE_RUN_ID = "6dktgrv2zyutngh7bbddr2tyg2b5a567cg725hu5e7u42orerxaa";
let keys: TestKeys;

beforeAll(async () => {
  keys = await generateKeys();
});

function executor() {
  unique += 1;
  return env.EXECUTOR.get(env.EXECUTOR.idFromName(`fork-${unique}-${Math.random()}`));
}

function on<T>(
  stub: ReturnType<typeof executor>,
  body: (instance: ExecutorObject) => T,
): Promise<T> {
  return runInDurableObject(stub, body);
}

async function connected(stub: ReturnType<typeof executor>): Promise<void> {
  await on(stub, (owner) => owner.configure([{ kid: keys.kid, jwk: keys.publicJwk }], NOW));
  const token = await signToken(keys, {
    ...VALID_CLAIMS,
    iat: NOW - 10,
    nbf: NOW - 10,
    exp: NOW + 600,
  });
  expect(await on(stub, (owner) => owner.admitConnection({ token }))).toBe("admitted");
}

async function ask(
  stub: ReturnType<typeof executor>,
  command: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const answered = await on(stub, (owner) => owner.sendLatest(JSON.stringify(command)));
  if (answered === null || typeof answered !== "object") {
    throw new Error("expected one command answer");
  }
  return Object.fromEntries(Object.entries(answered));
}

function base64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }
  return btoa(text);
}

function event(name: string): string {
  return serializeDurableEvent({
    type: "yield",
    coroutineId: "root",
    description: { type: "test", name },
    result: { status: "ok", value: name },
  });
}

const HEAD = serializeDurableEvent({
  type: "yield",
  coroutineId: "root",
  description: { type: "workflow_run", name: "workflow_run", base: "main" },
  result: {
    status: "ok",
    value: { runId: RUN_ID, base: "main", pinnedCommit: "0".repeat(40) },
  },
});

const IMPORT = serializeDurableEvent({
  type: "yield",
  coroutineId: "root",
  description: { type: "import_component", name: "__root__" },
  result: { status: "ok", value: { kind: "repository", path: "README.md", content: "# fork" } },
});

/** Offer everything one small source is made of, as the runner would. */
async function offer(stub: ReturnType<typeof executor>, id: () => string): Promise<void> {
  expect(
    (
      await ask(stub, {
        id: id(),
        command: "stage",
        kind: "manifest",
        digest: MANIFEST_ID,
        bytes: base64(new TextEncoder().encode(DOFS_MANIFEST)),
      })
    )["outcome"],
  ).toBe("performed");
  expect(
    (
      await ask(stub, {
        id: id(),
        command: "stage",
        kind: "blob",
        digest: BLOB_ID,
        bytes: base64(FILE_BYTES),
      })
    )["outcome"],
  ).toBe("performed");
  expect(
    (
      await ask(stub, {
        id: id(),
        command: "fork-stage",
        section: "roots",
        position: 0,
        part: {
          rootId: ROOT_ID,
          formatVersion: 1,
          manifest: ROOT_MANIFEST,
          manifestHashes: [MANIFEST_ID],
          blobHashes: [BLOB_ID],
        },
      })
    )["outcome"],
  ).toBe("performed");
  expect(
    (
      await ask(stub, {
        id: id(),
        command: "fork-stage",
        section: "inherited",
        position: 0,
        part: { eventId: "event-work", record: event("work"), workspaceRootId: ROOT_ID },
      })
    )["outcome"],
  ).toBe("performed");
}

/** The event ids one published snapshot reports, in journal order. */
function journalOf(published: Record<string, unknown>): string[] {
  const events = published["events"];
  return Array.isArray(events)
    ? events.map((row) => String(Reflect.get(Object(row), "event_id")))
    : [];
}

function commit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "fork-commit",
    command: "fork",
    runId: RUN_ID,
    creation: {
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
    },
    origin: {
      sourceRunId: SOURCE_RUN_ID,
      checkpointEventId: "event-work",
      checkpointWorkspaceRootId: ROOT_ID,
      runRecordWorkspaceRootId: ROOT_ID,
      rootImportWorkspaceRootId: ROOT_ID,
      anchor: "f".repeat(64),
    },
    counts: { inherited: 1, roots: 1, checkouts: 0 },
    runRecord: HEAD,
    rootImport: IMPORT,
    executionId: "execution-1",
    ...overrides,
  };
}

describe("committing a fork on its destination owner", () => {
  it("makes the destination whole on pristine storage, in one commit", async () => {
    const stub = executor();
    await connected(stub);
    let minted = 0;
    const id = () => `command-${(minted += 1)}`;
    await offer(stub, id);

    expect(await on(stub, (owner) => owner.hasWorkflowSchema())).toBe(false);
    const forked = await ask(stub, commit());
    expect(forked["outcome"]).toBe("performed");

    const state = await on(stub, (owner) => ({
      run: owner.runRow(),
      executions: owner.executionRows(),
      workspace: owner.published(),
      held: owner.heldExecutions(),
      parts: owner.forkParts(),
    }));
    // The prefix it inherited, its own two head records, its Workspace, its
    // lineage and its first execution all arrived together.
    expect(state.run?.["status"]).toBe("running");
    expect(state.workspace["currentRootId"]).toBe(ROOT_ID);
    expect(journalOf(state.workspace)).toContain("event-work");
    expect(journalOf(state.workspace)).toHaveLength(3);
    expect(state.executions).toHaveLength(1);
    expect(state.held).toHaveLength(1);
    // The parts stopped being anything the moment they were adopted.
    expect(state.parts).toEqual([]);
  });

  it("copies the content, so the destination needs no source afterwards", async () => {
    const stub = executor();
    await connected(stub);
    let minted = 0;
    await offer(stub, () => `command-${(minted += 1)}`);
    await ask(stub, commit());

    const workspace = await on(stub, (owner) => owner.published());
    // The blob and the reference are the destination's own rows now.
    expect(Number(workspace["blobs"])).toBeGreaterThan(0);
    expect(Number(workspace["blobRefs"])).toBeGreaterThan(0);
    expect(Number(workspace["roots"])).toBeGreaterThan(0);
  });

  it("refuses a transfer that does not add up, and leaves nothing behind", async () => {
    const stub = executor();
    await connected(stub);
    let minted = 0;
    await offer(stub, () => `command-${(minted += 1)}`);

    // One more inherited row than was ever offered.
    const refused = await ask(stub, commit({ counts: { inherited: 2, roots: 1, checkouts: 0 } }));

    expect(refused["outcome"]).toBe("refused");
    // No half-run: the destination still holds no schema at all.
    expect(await on(stub, (owner) => owner.hasWorkflowSchema())).toBe(false);
  });

  it("refuses a head root the transfer never carried", async () => {
    const stub = executor();
    await connected(stub);
    let minted = 0;
    await offer(stub, () => `command-${(minted += 1)}`);

    const refused = await ask(
      stub,
      commit({
        origin: {
          sourceRunId: SOURCE_RUN_ID,
          checkpointEventId: "event-work",
          checkpointWorkspaceRootId: ROOT_ID,
          runRecordWorkspaceRootId: "b".repeat(64),
          rootImportWorkspaceRootId: ROOT_ID,
          anchor: "f".repeat(64),
        },
      }),
    );

    expect(refused["outcome"]).toBe("refused");
    expect(await on(stub, (owner) => owner.hasWorkflowSchema())).toBe(false);
  });

  it("answers a repeated commit with the destination it already made", async () => {
    const stub = executor();
    await connected(stub);
    let minted = 0;
    await offer(stub, () => `command-${(minted += 1)}`);

    const first = await ask(stub, commit());
    const again = await ask(stub, commit());

    expect(again).toEqual(first);
    // One run, one execution, one journal: the retry found the decision.
    const state = await on(stub, (owner) => ({
      executions: owner.executionRows(),
      workspace: owner.published(),
    }));
    expect(state.executions).toHaveLength(1);
    expect(journalOf(state.workspace)).toHaveLength(3);
  });

  it("keeps one connection's offered parts to itself", async () => {
    const stub = executor();
    await connected(stub);
    let minted = 0;
    await offer(stub, () => `command-${(minted += 1)}`);
    expect(await on(stub, (owner) => owner.forkParts())).toHaveLength(2);

    // A replacement acquisition inherits nothing its predecessor offered.
    await on(stub, (owner) => owner.dropConnections());
    await connected(stub);

    expect(await on(stub, (owner) => owner.forkParts())).toEqual([]);
  });
});
