/**
 * Tier WRH — the candidate a remote fork is admitted by, assembled locally.
 *
 * A staged fork is not a run: nothing acquires anything, no owner is contacted,
 * and no host discovers it. What it is, is the fork's own database, built from
 * the snapshot the accepted no-acquisition plane returned and thrown away with
 * the scope that asked for it. These are the observations that distinguish a
 * real candidate from an interface: its identity, its inherited history in
 * order with the records byte for byte, its Workspace root, its checkouts and
 * its lineage, read back out of the database it handed over.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { Err, Ok, type Operation, type Result, scoped } from "effection";
import { serializeDurableEvent } from "@executablemd/durable-streams";
import { exists } from "@effectionx/fs";
import { useStorageRoot } from "./support/storage.ts";
import { useWorkflowRunConnections } from "../src/deno/connections.ts";
import { stageRemoteFork } from "../src/deno/remote-staging.ts";
import { workflowForkStaging } from "../src/deno/path.ts";
import { installRemoteWorkflowLifecycle } from "../src/deno/remote-host.ts";
import { WorkflowRequestError } from "../src/storage/errors.ts";
import type { WorkflowForkRequest } from "../src/lifecycle/execution.ts";
import type { RemoteForkSource } from "../src/remote/read.ts";
import { forkRunRecordEvent } from "../src/journal-events.ts";
import { sha256Hex } from "../src/workspace/sha256.ts";
import { WORKSPACE_ROOT_DOMAIN } from "../src/workspace/root-manifest.ts";
import type { WorkflowRunDatabase } from "../src/storage/api.ts";

const SOURCE_RUN_ID = "6dktgrv2zyutngh7bbddr2tyg2b5a567cg725hu5e7u42orerxaa";
const DESTINATION = "7ektgrv2zyutngh7bbddr2tyg2b5a567cg725hu5e7u42orerxaa";

const FILE = new TextEncoder().encode("inherited by the fork");
const BLOB = sha256Hex(FILE);
const CONTENT = new TextEncoder().encode(
  JSON.stringify({ version: 1, chunks: [{ hash: BLOB, size: FILE.length }] }),
);
const MANIFEST = sha256Hex(CONTENT);
const ROOT_MANIFEST = JSON.stringify({
  format: 1,
  entries: [
    { path: "/", kind: "directory", mode: 493, mtime: 0 },
    {
      path: "/NOTES.md",
      kind: "file",
      mode: 420,
      mtime: 0,
      size: FILE.length,
      manifest: MANIFEST,
      hardlink: null,
    },
  ],
});
const ROOT = sha256Hex(`${WORKSPACE_ROOT_DOMAIN}${ROOT_MANIFEST}`);

function event(name: string): string {
  return serializeDurableEvent({
    type: "yield",
    coroutineId: "root",
    description: { type: "test", name },
    result: { status: "ok", value: name },
  });
}

/** One small committed source, as the accepted read plane returns it. */
function source(): RemoteForkSource {
  return {
    sourceRunId: SOURCE_RUN_ID,
    anchor: "a".repeat(64),
    checkpointEventId: "event-second",
    checkpointWorkspaceRootId: ROOT,
    runRecordWorkspaceRootId: ROOT,
    rootImportWorkspaceRootId: ROOT,
    inherited: [
      { eventId: "event-first", record: event("first"), workspaceRootId: ROOT },
      { eventId: "event-second", record: event("second"), workspaceRootId: ROOT },
    ],
    roots: [
      {
        rootId: ROOT,
        formatVersion: 1,
        manifest: ROOT_MANIFEST,
        manifestHashes: [MANIFEST],
        blobHashes: [BLOB],
      },
    ],
    manifests: [{ hash: MANIFEST, size: FILE.length, lastSeen: 4, encoded: CONTENT }],
    blobs: [{ hash: BLOB, size: FILE.length, lastSeen: 6, content: FILE }],
    checkouts: [
      {
        kind: "repository",
        name: "alpha",
        locator: "https://git.example.invalid/alpha.git",
        locatorFingerprint: "b".repeat(64),
        requestedBase: null,
        creationCommit: "9".repeat(40),
        primaryBranch: "main",
        objectFormat: "sha1",
        checkoutPath: "/",
      },
    ],
  };
}

function request(): WorkflowForkRequest {
  return {
    runId: DESTINATION,
    selection: { sourceRunId: SOURCE_RUN_ID, checkpointEventId: "event-second" },
    creation: {
      definition: {
        version: 1,
        kind: "git",
        objectFormat: "sha1",
        objectId: "0".repeat(40),
        rootDocumentPath: "README.md",
      },
      base: "main",
      props: {},
      retrieval: { kind: "git", remote: "origin" },
    },
    rootImport: {
      type: "yield",
      coroutineId: "root",
      description: { type: "import_component", name: "__root__" },
      result: { status: "ok", value: { kind: "repository", path: "README.md", content: "# fork" } },
    },
  };
}

/** Stage one candidate and observe it, inside a scope that then ends. */
function* staged<T>(
  root: string,
  body: (database: WorkflowRunDatabase) => Operation<T>,
): Operation<T> {
  return yield* scoped(function* () {
    const connections = yield* useWorkflowRunConnections();
    const built = yield* stageRemoteFork(connections, root, request(), source(), {
      runRecord: forkRunRecordEvent({
        runId: DESTINATION,
        base: "main",
        pinnedCommit: "0".repeat(40),
      }),
      rootImport: request().rootImport,
    });
    if (!built.ok) {
      throw built.error;
    }
    return yield* body(built.value);
  });
}

describe("a remote fork's staged candidate", () => {
  it("is a real database holding the fork's own identity and history", function* () {
    const root = yield* useStorageRoot();
    const seen = yield* staged(root, function* (database) {
      const history = yield* database.readJournalEntries();
      if (!history.ok) {
        throw history.error;
      }
      return {
        record: database.record,
        events: history.value.map((entry) => entry.eventId),
        events2: history.value.map((entry) => serializeDurableEvent(entry.event)),
      };
    });

    // Its own identity, not the source's.
    expect(seen.record.runId).toBe(DESTINATION);
    expect(seen.record.base).toBe("main");
    // Its own two head records, then the prefix it inherited, in order.
    expect(seen.events).toHaveLength(4);
    expect(seen.events.slice(2)).toEqual(["event-first", "event-second"]);
    // The events the source retained, in the source's order.
    expect(seen.events2.slice(2)).toEqual([event("first"), event("second")]);
  });

  it("restores the checkpoint's Workspace as the fork's own", function* () {
    const root = yield* useStorageRoot();
    const seen = yield* staged(root, function* (database) {
      const history = yield* database.readJournalEntries();
      if (!history.ok) {
        throw history.error;
      }
      // Every retained row names the Workspace root it was written against;
      // the fork's own rows name the checkpoint's.
      return {
        workspaceRootId: history.value.at(-1)?.workspaceRootId ?? "",
      };
    });

    expect(seen.workspaceRootId).toBe(ROOT);
  });

  it("keeps the retrieval its creation carried", function* () {
    const root = yield* useStorageRoot();
    const held = yield* staged(root, function* (database) {
      return database.retrieval;
    });

    expect(held?.metadata).toEqual({ kind: "git", remote: "origin" });
  });

  it("takes no lock, and nothing discovers it", function* () {
    const root = yield* useStorageRoot();
    const path = workflowForkStaging(root, DESTINATION);
    const during = yield* staged(root, function* () {
      return yield* exists(path);
    });

    // It was there while its scope was open, and the run's own path never was:
    // staging assembles a candidate, not a run.
    expect(during).toBe(true);
    expect(yield* exists(path)).toBe(false);
  });

  it("replaces what an interrupted attempt left rather than continuing it", function* () {
    const root = yield* useStorageRoot();
    const first = yield* staged(root, function* (database) {
      const history = yield* database.readJournalEntries();
      return history.ok ? history.value.length : -1;
    });
    // A second candidate at the same path is built from scratch, so it holds
    // exactly what one assembly holds rather than two.
    const second = yield* staged(root, function* (database) {
      const history = yield* database.readJournalEntries();
      return history.ok ? history.value.length : -1;
    });

    expect(first).toBe(4);
    expect(second).toBe(4);
  });

  it("is what the provider's own stageFork() returns, through the real host", function* () {
    const root = yield* useStorageRoot();
    const opened: string[] = [];
    const seen = yield* scoped(function* () {
      const transitions = yield* installRemoteWorkflowLifecycle({
        root,
        // Reaching an owner is the one thing a staged fork must never do, so
        // this records any attempt and refuses.
        *admit(runId: string) {
          opened.push(runId);
          return Err(new WorkflowRequestError("a staged fork admits nothing"));
        },
        // deno-lint-ignore require-yield
        *source(runId: string) {
          return Ok({
            runId,
            // deno-lint-ignore require-yield
            *inspect(): Operation<Result<never>> {
              throw new WorkflowRequestError("a staged fork inspects nothing");
            },
            // deno-lint-ignore require-yield
            *history(): Operation<Result<never>> {
              throw new WorkflowRequestError("a staged fork reads no history");
            },
            // deno-lint-ignore require-yield
            *forkSource(): Operation<Result<RemoteForkSource>> {
              return Ok(source());
            },
          });
        },
      });
      const built = yield* transitions.stageFork(request());
      if (!built.ok) {
        throw built.error;
      }
      const history = yield* built.value.readJournalEntries();
      return {
        runId: built.value.record.runId,
        events: history.ok ? history.value.map((entry) => entry.eventId) : [],
        retrieval: built.value.retrieval?.metadata,
      };
    });

    // A real candidate came back from the production seam, with the same
    // assembly the kernel produces.
    expect(seen.runId).toBe(DESTINATION);
    expect(seen.events.slice(2)).toEqual(["event-first", "event-second"]);
    expect(seen.retrieval).toEqual({ kind: "git", remote: "origin" });
    // And nothing was acquired on the way.
    expect(opened).toEqual([]);
  });
});
