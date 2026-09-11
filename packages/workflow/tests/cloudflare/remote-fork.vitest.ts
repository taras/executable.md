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
import { forkSelectionAnchor } from "../../src/cloudflare/fork-anchor.ts";
import { sha256Hex } from "../../src/workspace/sha256.ts";
import { WORKSPACE_ROOT_DOMAIN } from "../../src/workspace/root-manifest.ts";
import { forkRunRecordEvent } from "../../src/journal-events.ts";

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

// The canonical record this destination's own identity implies. Composed by
// the shared helper, because the owner holds the head to exactly that.
const HEAD = serializeDurableEvent(
  forkRunRecordEvent({ runId: RUN_ID, base: "main", pinnedCommit: "0".repeat(40) }),
);

const IMPORT = serializeDurableEvent({
  type: "yield",
  coroutineId: "root",
  description: { type: "import_component", name: "__root__" },
  result: { status: "ok", value: { kind: "repository", path: "README.md", content: "# fork" } },
});

const ROOT_PART = {
  rootId: ROOT_ID,
  formatVersion: 1,
  manifest: ROOT_MANIFEST,
  manifestHashes: [MANIFEST_ID],
  blobHashes: [BLOB_ID],
};
const MANIFEST_PART = { hash: MANIFEST_ID, size: FILE_BYTES.length, lastSeen: 7 };
const BLOB_PART = { hash: BLOB_ID, size: FILE_BYTES.length, lastSeen: 9 };
const INHERITED_PART = {
  eventId: "event-work",
  record: event("work"),
  workspaceRootId: ROOT_ID,
};

/** The anchor this selection has, computed the way the source computes it. */
function anchorOf(overrides: Record<string, unknown> = {}): string {
  return forkSelectionAnchor({
    checkpointEventId: "event-work",
    checkpointWorkspaceRootId: ROOT_ID,
    runRecordWorkspaceRootId: ROOT_ID,
    rootImportWorkspaceRootId: ROOT_ID,
    inherited: [INHERITED_PART],
    roots: [ROOT_PART],
    manifests: [{ ...MANIFEST_PART, encoded: base64(new TextEncoder().encode(DOFS_MANIFEST)) }],
    blobs: [BLOB_PART],
    checkouts: [],
    ...overrides,
  });
}

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
        part: ROOT_PART,
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
        part: INHERITED_PART,
      })
    )["outcome"],
  ).toBe("performed");
  // The metadata a digest cannot stand for, offered beside the content.
  const metadata: { section: string; part: Record<string, number | string> }[] = [
    { section: "manifests", part: MANIFEST_PART },
    { section: "blobs", part: BLOB_PART },
  ];
  for (const offered of metadata) {
    expect(
      (
        await ask(stub, {
          id: id(),
          command: "fork-stage",
          section: offered.section,
          position: 0,
          part: offered.part,
        })
      )["outcome"],
    ).toBe("performed");
  }
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
      anchor: anchorOf(),
    },
    retrieval: null,
    counts: { inherited: 1, roots: 1, manifests: 1, blobs: 1, checkouts: 0 },
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
          anchor: anchorOf({ runRecordWorkspaceRootId: "b".repeat(64) }),
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
    expect(await on(stub, (owner) => owner.forkParts())).toHaveLength(4);

    // A replacement acquisition inherits nothing its predecessor offered.
    await on(stub, (owner) => owner.dropConnections());
    await connected(stub);

    expect(await on(stub, (owner) => owner.forkParts())).toEqual([]);
  });

  it("refuses an anchor that is not this selection's, before it creates anything", async () => {
    const stub = executor();
    await connected(stub);
    let minted = 0;
    await offer(stub, () => `command-${(minted += 1)}`);

    // Well-formed, and not the digest this selection produces.
    const refused = await ask(
      stub,
      commit({
        origin: {
          sourceRunId: SOURCE_RUN_ID,
          checkpointEventId: "event-work",
          checkpointWorkspaceRootId: ROOT_ID,
          runRecordWorkspaceRootId: ROOT_ID,
          rootImportWorkspaceRootId: ROOT_ID,
          anchor: "f".repeat(64),
        },
      }),
    );

    expect(refused["outcome"]).toBe("refused");
    expect(await on(stub, (owner) => owner.hasWorkflowSchema())).toBe(false);
  });

  it("refuses a changed watermark, which no content digest stands for", async () => {
    const stub = executor();
    await connected(stub);
    let minted = 0;
    const id = () => `command-${(minted += 1)}`;
    // Everything as before, except the blob's copied watermark.
    await ask(stub, {
      id: id(),
      command: "stage",
      kind: "manifest",
      digest: MANIFEST_ID,
      bytes: base64(new TextEncoder().encode(DOFS_MANIFEST)),
    });
    await ask(stub, {
      id: id(),
      command: "stage",
      kind: "blob",
      digest: BLOB_ID,
      bytes: base64(FILE_BYTES),
    });
    await ask(stub, {
      id: id(),
      command: "fork-stage",
      section: "roots",
      position: 0,
      part: ROOT_PART,
    });
    await ask(stub, {
      id: id(),
      command: "fork-stage",
      section: "inherited",
      position: 0,
      part: INHERITED_PART,
    });
    await ask(stub, {
      id: id(),
      command: "fork-stage",
      section: "manifests",
      position: 0,
      part: MANIFEST_PART,
    });
    await ask(stub, {
      id: id(),
      command: "fork-stage",
      section: "blobs",
      position: 0,
      part: { ...BLOB_PART, lastSeen: BLOB_PART.lastSeen + 1 },
    });

    const refused = await ask(stub, commit());
    expect(refused["outcome"]).toBe("refused");
    expect(await on(stub, (owner) => owner.hasWorkflowSchema())).toBe(false);
  });

  it("refuses a head record that is not the one this fork's identity implies", async () => {
    const stub = executor();
    await connected(stub);
    let minted = 0;
    await offer(stub, () => `command-${(minted += 1)}`);

    const refused = await ask(
      stub,
      commit({
        runRecord: serializeDurableEvent(
          forkRunRecordEvent({ runId: RUN_ID, base: "other", pinnedCommit: "0".repeat(40) }),
        ),
      }),
    );

    expect(refused["outcome"]).toBe("refused");
    expect(await on(stub, (owner) => owner.hasWorkflowSchema())).toBe(false);
  });

  it("retains the watermarks the source copied rather than starting them again", async () => {
    const stub = executor();
    await connected(stub);
    let minted = 0;
    await offer(stub, () => `command-${(minted += 1)}`);
    await ask(stub, commit());

    const watermarks = await on(stub, (owner) => owner.contentWatermarks());
    expect(watermarks.manifests).toEqual([MANIFEST_PART.lastSeen]);
    expect(watermarks.blobs).toEqual([BLOB_PART.lastSeen]);
  });

  it("recovers the previous executor's work before a later fork begins again", async () => {
    const stub = executor();
    await connected(stub);
    let minted = 0;
    await offer(stub, () => `command-${(minted += 1)}`);
    expect((await ask(stub, commit()))["outcome"]).toBe("performed");

    // The executor that committed the fork is gone with its execution open.
    await on(stub, (owner) => owner.dropConnections());
    await connected(stub);
    await offer(stub, () => `later-${(minted += 1)}`);
    const again = await ask(stub, commit({ id: "fork-again", executionId: "execution-2" }));

    expect(again["outcome"]).toBe("performed");
    const executions = await on(stub, (owner) => owner.executionRows());
    // The first was closed by recovery, and exactly one replacement began.
    expect(executions).toHaveLength(2);
    expect(executions[0]?.["stop_status"]).toBe("interrupted");
    expect(executions[1]?.["stopped_at"]).toBe(null);
    expect(executions.filter((row) => row["stopped_at"] === null)).toHaveLength(1);
  });

  it("writes the retrieval its creation carried, with the run", async () => {
    const stub = executor();
    await connected(stub);
    let minted = 0;
    await offer(stub, () => `command-${(minted += 1)}`);
    await ask(stub, commit({ retrieval: { kind: "git", remote: "origin" } }));

    const retrieval = await on(stub, (owner) => owner.retrieval());
    expect(retrieval?.["revision"]).toBe(1);
    expect(JSON.parse(String(retrieval?.["metadata"]))).toEqual({
      kind: "git",
      remote: "origin",
    });
  });
});

/** Take up a destination that already holds this fork, naming no source. */
function continuation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "fork-continue",
    command: "fork-continue",
    runId: RUN_ID,
    creation: commit()["creation"],
    origin: { sourceRunId: SOURCE_RUN_ID, checkpointEventId: "event-work" },
    runRecord: HEAD,
    rootImport: IMPORT,
    executionId: "execution-2",
    ...overrides,
  };
}

describe("continuing a fork the destination already holds", () => {
  it("answers absent when there is nothing here, and needs no source", async () => {
    const stub = executor();
    await connected(stub);

    expect(await ask(stub, continuation())).toEqual({
      id: "fork-continue",
      outcome: "refused",
      refusal: "command:absent",
    });
    expect(await on(stub, (owner) => owner.hasWorkflowSchema())).toBe(false);
  });

  it("recovers and begins one replacement, without reading any source", async () => {
    const stub = executor();
    await connected(stub);
    let minted = 0;
    await offer(stub, () => `command-${(minted += 1)}`);
    await ask(stub, commit());
    await on(stub, (owner) => owner.dropConnections());
    await connected(stub);

    const continued = await ask(stub, continuation());

    expect(continued["outcome"]).toBe("performed");
    const value = Object(Object(continued["value"])["value"]);
    expect(value["replay"]).toBe(false);
    // The lost executor's execution was closed on the way in and surfaced.
    expect(Object(value["recovered"])["stopStatus"]).toBe("interrupted");
    const executions = await on(stub, (owner) => owner.executionRows());
    expect(executions.filter((row) => row["stopped_at"] === null)).toHaveLength(1);
  });

  it("reports a terminal destination as a replay, and leaves it terminal", async () => {
    const stub = executor();
    await connected(stub);
    let minted = 0;
    await offer(stub, () => `command-${(minted += 1)}`);
    await ask(stub, commit());
    const root = await on(stub, (owner) => owner.currentRootId());
    await ask(stub, {
      id: "settle-1",
      command: "settle",
      completion: { executionId: "execution-1", status: "completed" },
      expectedWorkspaceRootId: root,
    });
    await on(stub, (owner) => owner.dropConnections());
    await connected(stub);

    const continued = await ask(stub, continuation());

    expect(continued["outcome"]).toBe("performed");
    const value = Object(Object(continued["value"])["value"]);
    expect(value["replay"]).toBe(true);
    // The outcome that won is not made mutable again.
    expect((await on(stub, (owner) => owner.runRow()))?.["status"]).toBe("completed");
  });

  it("refuses a continuation whose root import is not the one it retains", async () => {
    const stub = executor();
    await connected(stub);
    let minted = 0;
    await offer(stub, () => `command-${(minted += 1)}`);
    await ask(stub, commit());
    await on(stub, (owner) => owner.dropConnections());
    await connected(stub);

    const refused = await ask(
      stub,
      continuation({
        rootImport: serializeDurableEvent({
          type: "yield",
          coroutineId: "root",
          description: { type: "import_component", name: "__root__" },
          result: {
            status: "ok",
            value: { kind: "repository", path: "README.md", content: "# elsewhere" },
          },
        }),
      }),
    );

    expect(refused["outcome"]).toBe("performed");
    expect(Object(refused["value"])["conflict"]).toEqual(["lineage"]);
    // No replacement execution began.
    expect(await on(stub, (owner) => owner.executionRows())).toHaveLength(1);
  });

  it("refuses a continuation whose run record is not the one this fork implies", async () => {
    const stub = executor();
    await connected(stub);
    let minted = 0;
    await offer(stub, () => `command-${(minted += 1)}`);
    await ask(stub, commit());
    await on(stub, (owner) => owner.dropConnections());
    await connected(stub);

    const refused = await ask(
      stub,
      continuation({
        runRecord: serializeDurableEvent(
          forkRunRecordEvent({ runId: RUN_ID, base: "other", pinnedCommit: "0".repeat(40) }),
        ),
      }),
    );

    expect(Object(refused["value"])["conflict"]).toEqual(["lineage"]);
    expect(await on(stub, (owner) => owner.executionRows())).toHaveLength(1);
  });
});

describe("copying content whose digest is valid in both roles", () => {
  it("keeps the manifest and blob watermarks apart", async () => {
    // A Workspace whose file is the bytes of one content manifest, and whose
    // content manifest for that file names those same bytes as its chunk. The
    // digest is then both a manifest identity and a blob identity, with its
    // own watermark in each table.
    const inner = new TextEncoder().encode(DOFS_MANIFEST);
    const shared = MANIFEST_ID;
    const outer = JSON.stringify({
      version: 1,
      chunks: [{ hash: shared, size: inner.length }],
    });
    const outerBytes = new TextEncoder().encode(outer);
    const outerId = sha256Hex(outerBytes);
    const manifest = JSON.stringify({
      format: 1,
      entries: [
        { path: "/", kind: "directory", mode: 493, mtime: 0 },
        {
          path: "/MANIFEST.json",
          kind: "file",
          mode: 420,
          mtime: 0,
          size: inner.length,
          manifest: outerId,
          hardlink: null,
        },
      ],
    });
    const rootId = sha256Hex(`${WORKSPACE_ROOT_DOMAIN}${manifest}`);
    const root = {
      rootId,
      formatVersion: 1,
      manifest,
      manifestHashes: [outerId],
      blobHashes: [shared],
    };
    const manifestPart = { hash: outerId, size: inner.length, lastSeen: 11 };
    // The same digest, in the other role, with its own watermark.
    const blobPart = { hash: shared, size: inner.length, lastSeen: 23 };
    const inheritedPart = {
      eventId: "event-work",
      record: event("work"),
      workspaceRootId: rootId,
    };

    const stub = executor();
    await connected(stub);
    let minted = 0;
    const id = () => `command-${(minted += 1)}`;
    await ask(stub, {
      id: id(),
      command: "stage",
      kind: "manifest",
      digest: outerId,
      bytes: base64(outerBytes),
    });
    await ask(stub, {
      id: id(),
      command: "stage",
      kind: "blob",
      digest: shared,
      bytes: base64(inner),
    });
    for (const part of [
      { section: "roots", body: root },
      { section: "inherited", body: inheritedPart },
      { section: "manifests", body: manifestPart },
      { section: "blobs", body: blobPart },
    ]) {
      expect(
        (
          await ask(stub, {
            id: id(),
            command: "fork-stage",
            section: part.section,
            position: 0,
            part: part.body,
          })
        )["outcome"],
      ).toBe("performed");
    }

    const forked = await ask(stub, {
      ...commit(),
      origin: {
        sourceRunId: SOURCE_RUN_ID,
        checkpointEventId: "event-work",
        checkpointWorkspaceRootId: rootId,
        runRecordWorkspaceRootId: rootId,
        rootImportWorkspaceRootId: rootId,
        anchor: forkSelectionAnchor({
          checkpointEventId: "event-work",
          checkpointWorkspaceRootId: rootId,
          runRecordWorkspaceRootId: rootId,
          rootImportWorkspaceRootId: rootId,
          inherited: [inheritedPart],
          roots: [root],
          manifests: [{ ...manifestPart, encoded: base64(outerBytes) }],
          blobs: [blobPart],
          checkouts: [],
        }),
      },
    });

    expect(forked["outcome"]).toBe("performed");
    const watermarks = await on(stub, (owner) => owner.contentWatermarks());
    // Two roles, two watermarks, neither overwriting the other.
    expect(watermarks.manifests).toEqual([11]);
    expect(watermarks.blobs).toEqual([23]);
  });
  it("refuses a continuation naming another source or another checkpoint", async () => {
    for (const changed of [
      { sourceRunId: "8fktgrv2zyutngh7bbddr2tyg2b5a567cg725hu5e7u42orerxaa" },
      { checkpointEventId: "event-elsewhere" },
    ]) {
      const stub = executor();
      await connected(stub);
      let minted = 0;
      await offer(stub, () => `command-${(minted += 1)}`);
      await ask(stub, commit());
      await on(stub, (owner) => owner.dropConnections());
      await connected(stub);

      const refused = await ask(
        stub,
        continuation({
          origin: {
            sourceRunId: SOURCE_RUN_ID,
            checkpointEventId: "event-work",
            ...changed,
          },
        }),
      );

      expect(Object(refused["value"])["conflict"]).toEqual(["lineage"]);
      // No recovery and no replacement: the first execution is still open.
      const executions = await on(stub, (owner) => owner.executionRows());
      expect(executions).toHaveLength(1);
      expect(executions[0]?.["stopped_at"]).toBe(null);
    }
  });

  it("refuses a head reassociated to another root this store retains", async () => {
    for (const head of ["run_record", "root_import"]) {
      const stub = executor();
      await connected(stub);
      let minted = 0;
      await offer(stub, () => `command-${(minted += 1)}`);
      await ask(stub, commit());
      // Another valid retained root, and the head now names it. Membership is
      // not identity: this is not the association the fork committed.
      await on(stub, (owner) => owner.reassociateHead(head));
      await on(stub, (owner) => owner.dropConnections());
      await connected(stub);

      const refused = await ask(stub, continuation());

      expect([head, Object(refused["value"])["conflict"]]).toEqual([head, ["lineage"]]);
      expect(await on(stub, (owner) => owner.executionRows())).toHaveLength(1);
    }
  });

  it("adopts the execution a lost continuation began, and settles once", async () => {
    const stub = executor();
    await connected(stub);
    let minted = 0;
    await offer(stub, () => `command-${(minted += 1)}`);
    await ask(stub, commit());
    await on(stub, (owner) => owner.dropConnections());
    await connected(stub);
    const first = await ask(stub, continuation());
    expect(first["outcome"]).toBe("performed");

    // Its answer never arrived and the connection died.
    await on(stub, (owner) => owner.dropConnections());
    await connected(stub);
    const again = await ask(stub, continuation());

    expect(again).toEqual(first);
    // The decision came back only because its execution became this
    // acquisition's, so this acquisition can settle it.
    const held = await on(stub, (owner) => owner.heldExecutions());
    expect(held.map((row) => row["execution_id"])).toEqual(["execution-2"]);
    const root = await on(stub, (owner) => owner.currentRootId());
    const settled = await ask(stub, {
      id: "settle-2",
      command: "settle",
      completion: { executionId: "execution-2", status: "completed" },
      expectedWorkspaceRootId: root,
    });
    expect(settled["outcome"]).toBe("performed");

    // And once settled, the same continuation is history rather than authority.
    await on(stub, (owner) => owner.dropConnections());
    await connected(stub);
    expect((await ask(stub, continuation()))["refusal"]).toBe("command:stale-journal");
  });

  it("says a transfer it never received is one it needs", async () => {
    const stub = executor();
    await connected(stub);

    // The destination is empty and this connection offered nothing: the final
    // command's own answer, not a malformed request.
    const refused = await ask(stub, commit());

    expect(refused).toEqual({
      id: "fork-commit",
      outcome: "refused",
      refusal: "command:needs-transfer",
    });
    expect(await on(stub, (owner) => owner.hasWorkflowSchema())).toBe(false);
  });
});
