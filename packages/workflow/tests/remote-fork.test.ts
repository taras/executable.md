/**
 * Tier WRH — how a remote fork crosses from a source snapshot to a destination.
 *
 * That the destination commits whole or not at all, and that its copied prefix
 * outlives the source, are owner facts and are proved against a real Durable
 * Object in `tests/cloudflare/remote-fork.vitest.ts`. These are the runner's
 * half: that the source is read through the no-acquisition plane, that every
 * member of the snapshot is offered before anything is committed, and that what
 * the final command claims is what was actually offered.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { type Operation, scoped } from "effection";
import { serializeDurableEvent } from "@executablemd/durable-streams";
import { WorkflowLifecycle } from "../src/lifecycle/api.ts";
import type { ExecutorLock } from "../src/lifecycle/api.ts";
import type { WorkflowForkRequest } from "../src/lifecycle/execution.ts";
import type { WorkflowExecutionTransitions } from "../src/lifecycle/execution.ts";
import { useRemoteLifecycle } from "../src/remote/lifecycle.ts";
import type { RemoteForkSource } from "../src/remote/read.ts";
import type { RemoteForkCommit, RemoteForkPart } from "../src/remote/lifecycle-link.ts";
import { installedHost, RUN_ID, ROOT, type Script } from "./support/remote-lifecycle-host.ts";

const SOURCE_RUN_ID = "6dktgrv2zyutngh7bbddr2tyg2b5a567cg725hu5e7u42orerxaa";
const DESTINATION = "7ektgrv2zyutngh7bbddr2tyg2b5a567cg725hu5e7u42orerxaa";

function event(name: string): string {
  return serializeDurableEvent({
    type: "yield",
    coroutineId: "root",
    description: { type: "test", name },
    result: { status: "ok", value: name },
  });
}

function source(): RemoteForkSource {
  return {
    sourceRunId: SOURCE_RUN_ID,
    anchor: "f".repeat(64),
    checkpointEventId: "event-work",
    checkpointWorkspaceRootId: ROOT,
    runRecordWorkspaceRootId: ROOT,
    rootImportWorkspaceRootId: ROOT,
    inherited: [
      { eventId: "event-a", record: event("a"), workspaceRootId: ROOT },
      { eventId: "event-b", record: event("b"), workspaceRootId: ROOT },
    ],
    roots: [
      {
        rootId: ROOT,
        formatVersion: 1,
        manifest: "{}",
        manifestHashes: ["b".repeat(64)],
        blobHashes: ["c".repeat(64)],
      },
    ],
    manifests: [{ hash: "b".repeat(64), size: 3, lastSeen: 0, encoded: new Uint8Array([1, 2, 3]) }],
    blobs: [{ hash: "c".repeat(64), size: 3, lastSeen: 0, content: new Uint8Array([1, 2, 3]) }],
    checkouts: [
      {
        kind: "repository",
        name: "alpha",
        locator: "https://git.example.invalid/alpha.git",
        locatorFingerprint: "d".repeat(64),
        requestedBase: null,
        creationCommit: "9".repeat(40),
        primaryBranch: "main",
        objectFormat: "sha1",
        checkoutPath: "/",
      },
    ],
  };
}

function request(runId = DESTINATION): WorkflowForkRequest {
  return {
    runId,
    selection: { sourceRunId: SOURCE_RUN_ID, checkpointEventId: "event-work" },
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
    },
    rootImport: {
      type: "yield",
      coroutineId: "root",
      description: { type: "import_component", name: "__root__" },
      result: { status: "ok", value: { kind: "repository", path: "README.md", content: "# fork" } },
    },
  };
}

function* installed<T>(
  script: Script,
  body: (transitions: WorkflowExecutionTransitions) => Operation<T>,
): Operation<T> {
  return yield* scoped(function* () {
    const transitions = yield* useRemoteLifecycle(installedHost(script));
    return yield* body(transitions);
  });
}

function* acquired(runId: string): Operation<ExecutorLock> {
  const taken = yield* WorkflowLifecycle.operations.acquireExecutor(runId);
  if (!taken.ok) {
    throw taken.error;
  }
  if (taken.value.kind !== "acquired") {
    throw new Error("expected the executor lock to be acquired");
  }
  return taken.value.lock;
}

describe("a remote fork's destination", () => {
  it("offers the whole snapshot before it commits any of it", function* () {
    const asked: string[] = [];
    const staged: RemoteForkPart[] = [];
    const commits: RemoteForkCommit[] = [];
    const outcome = yield* installed(
      { asked, staged, commits, source: source() },
      function* (transitions) {
        const lock = yield* acquired(DESTINATION);
        return yield* transitions.fork(lock, request());
      },
    );

    expect([outcome.ok, outcome.ok === false && String(outcome.error)]).toEqual([true, false]);
    // Everything was offered, and the commit came last.
    expect(asked.at(-1)).toBe("fork");
    expect(asked.filter((command) => command === "fork-stage")).toHaveLength(6);
    expect(staged.map((part) => `${part.section}:${part.position}`)).toEqual([
      "roots:0",
      // The metadata a digest cannot stand for travels beside the content.
      "manifests:0",
      "blobs:0",
      "inherited:0",
      "inherited:1",
      "checkouts:0",
    ]);
    // What the final command claims is what was offered, and where it came
    // from is the selection that was read.
    expect(commits[0]?.counts).toEqual({
      inherited: 2,
      roots: 1,
      manifests: 1,
      blobs: 1,
      checkouts: 1,
    });
    expect(commits[0]?.origin).toEqual({
      sourceRunId: SOURCE_RUN_ID,
      checkpointEventId: "event-work",
      checkpointWorkspaceRootId: ROOT,
      runRecordWorkspaceRootId: ROOT,
      rootImportWorkspaceRootId: ROOT,
      anchor: "f".repeat(64),
    });
  });

  it("carries the inherited records exactly as the source retained them", function* () {
    const staged: RemoteForkPart[] = [];
    yield* installed({ staged, source: source() }, function* (transitions) {
      const lock = yield* acquired(DESTINATION);
      return yield* transitions.fork(lock, request());
    });

    const inherited = staged.filter((part) => part.section === "inherited");
    expect(inherited.map((part) => part.part["record"])).toEqual([event("a"), event("b")]);
    expect(inherited.map((part) => part.part["eventId"])).toEqual(["event-a", "event-b"]);
  });

  it("writes the fork's own run record rather than the source's", function* () {
    const commits: RemoteForkCommit[] = [];
    yield* installed({ commits, source: source() }, function* (transitions) {
      const lock = yield* acquired(DESTINATION);
      return yield* transitions.fork(lock, request());
    });

    const head = commits[0];
    // Its own identity, and the root import its own definition produced.
    expect(JSON.stringify(head?.runRecord)).toContain(DESTINATION);
    expect(JSON.stringify(head?.runRecord)).not.toContain(SOURCE_RUN_ID);
    expect(head?.rootImport).toEqual(request().rootImport);
  });

  it("refuses a fork under a lock issued for another run, and reads nothing", function* () {
    const asked: string[] = [];
    const outcome = yield* installed({ asked, source: source() }, function* (transitions) {
      const lock = yield* acquired(RUN_ID);
      return yield* transitions.fork(lock, request());
    });

    expect(outcome.ok).toBe(false);
    // Not one part offered, and no source read: the lock was wrong before any
    // of that could matter.
    expect(asked).toEqual([]);
  });

  it("refuses a staged fork whose source it cannot read, and takes no acquisition", function* () {
    const opened: string[] = [];
    const outcome = yield* installed({ opened }, function* (transitions) {
      return yield* transitions.stageFork(request());
    });

    expect(outcome.ok).toBe(false);
    // Staging takes no destination acquisition at all, failure or not.
    expect(opened).toEqual([]);
  });

  it("stages a candidate without acquiring or committing anything", function* () {
    const asked: string[] = [];
    const opened: string[] = [];
    const outcome = yield* installed({ asked, opened, source: source() }, function* (transitions) {
      return yield* transitions.stageFork(request());
    });

    // This scripted host stages nothing, which is the point: what is proved
    // here is that nothing was acquired and nothing was committed on the way.
    expect(outcome.ok).toBe(false);
    expect(opened).toEqual([]);
    expect(asked).toEqual([]);
  });
});
