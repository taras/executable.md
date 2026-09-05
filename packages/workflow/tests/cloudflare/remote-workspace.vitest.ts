/**
 * The runner's Workspace coordinator, against a real owner.
 *
 * Everything on the owner's side is real here: a real Durable Object, its own
 * SQLite storage, a real accepted Hibernation WebSocket, and the production
 * client, database handle, run binding and coordinator on the other end of it.
 * What runs is `createRemoteWorkspaceEffect()` through
 * `withRemoteWorkspaceEffects()`, so the admission read, the attempt, the
 * anchor check, the mapping staging, the enlistment, the journal route and
 * D3a's atomic commit are all the production path.
 *
 * The one stand-in is the runner's host filesystem: workerd has none, and the
 * vendored DOFS cannot set a modification time, so it cannot reproduce a
 * retained mtime — which is the thing materialization refuses a host for. The
 * native adapter it stands in for is proved against real files in
 * `packages/workflow/tests/remote-workspace-files.test.ts`.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { InMemoryStream, type Workflow, type Json } from "@executablemd/durable-streams";
import { run, type Operation } from "effection";
import type { ExecutorObject } from "./support/executor-object.ts";
import { POLICY, RUN_ID, VALID_CLAIMS } from "./support/executor-object.ts";
import { generateKeys, signToken, type TestKeys } from "./support/tokens.ts";
import { createWorkerFiles } from "./support/worker-files.ts";
import { cloudflareReadLink, cloudflareRunLink } from "../../src/cloudflare/client.ts";
import {
  type OwnerSocket,
  type SocketListener,
  useOwnerConnection,
} from "../../src/remote/client.ts";
import {
  createRemoteWorkspaceEffect,
  type RemoteRun,
  useRemoteRun,
  useRemoteWorkspaceEffects,
  withRemoteWorkspaceEffects,
} from "../../src/remote/workspace.ts";
import { durableRun } from "@executablemd/durable-streams";
import { locatorFingerprintOf } from "../../src/composition/locator.ts";
import { useMaterialization } from "../../src/remote/invocation.ts";
import { JournaledEffectFailure } from "../../src/workspace/failure.ts";

let unique = 0;
const NOW = 1_800_000_000;
const LOCATOR = "https://git.example.invalid/octo/app.git";
let keys: TestKeys;

beforeAll(async () => {
  keys = await generateKeys();
});

function executor() {
  unique += 1;
  return env.EXECUTOR.get(env.EXECUTOR.idFromName(`coordinated-${unique}-${Math.random()}`));
}

function on<T>(
  stub: ReturnType<typeof executor>,
  body: (instance: ExecutorObject) => T,
): Promise<T> {
  return runInDurableObject(stub, body);
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

/** The platform socket, bound to the four members the client uses. */
function ownerSocket(socket: WebSocket): OwnerSocket {
  const listeners = new Map<SocketListener, EventListener>();
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    addEventListener(type, listener) {
      const forward: EventListener = (event) => listener(event as { data?: unknown });
      listeners.set(listener, forward);
      socket.addEventListener(type, forward);
    },
    removeEventListener(type, listener) {
      const found = listeners.get(listener);
      if (found !== undefined) {
        socket.removeEventListener(type, found);
      }
    },
  };
}

function repository() {
  return {
    record: {
      name: "app",
      locatorFingerprint: locatorFingerprintOf(LOCATOR),
      requestedBase: null,
      creationCommit: "9".repeat(40),
      primaryBranch: "main",
      objectFormat: "sha1" as const,
      checkoutPath: "/app",
    },
    locator: LOCATOR,
  };
}

/**
 * Open one production run binding over a real accepted socket.
 *
 * Everything the coordinator will use comes from here, together: the client,
 * the handle, the runtime and the routed journal.
 */
function* opened(socket: WebSocket): Operation<RemoteRun> {
  const connection = yield* useOwnerConnection(ownerSocket(socket));
  let identifier = 0;
  const next = () => `coordinated-${(identifier += 1)}`;
  const host = createWorkerFiles();
  return yield* useRemoteRun({
    link: cloudflareRunLink(connection, next, RUN_ID),
    files: host.files,
    trees: host.trees,
    createFilesystem: (at) => host.workspace(at("/")),
    journal: new InMemoryStream(),
  });
}

describe("the coordinator against a real owner", () => {
  it("publishes Files, one mapping and the filtered result as one commit", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    const before = await on(stub, (owner) => owner.published());
    const socket = await connect(stub);

    const outcome = await run(function* () {
      const opening = yield* opened(socket);
      yield* useRemoteWorkspaceEffects(opening);
      const effect = createRemoteWorkspaceEffect(
        opening,
        { type: "workspace", name: "write" },
        function* (filesystem, metadata): Operation<Json> {
          yield* filesystem.writeFile("/NOTES.md", "written by the effect\n", 0o644);
          // The checkout the Repository record names has to be in the Workspace
          // this proposal publishes; the owner refuses a mapping to a place the
          // root does not contain.
          yield* filesystem.mkdir("/app", { mode: 0o755 });
          metadata.insertRepository(repository());
          return "published";
        },
      );
      function* workflow(): Workflow<void> {
        yield effect;
      }
      yield* withRemoteWorkspaceEffects(opening, durableRun(workflow, { stream: opening.journal }));
      return yield* opening.journal.readAll();
    });
    // The result travelled inside the commit, so the ordinary journal never
    // saw it.
    expect(outcome.filter((event) => event.type === "yield")).toHaveLength(0);

    const after = await on(stub, (owner) => owner.published());
    // Content, root, references, mapping, pointer and the journal row moved
    // together, and the pointer is no longer where it started.
    expect(after["currentRootId"]).not.toBe(before["currentRootId"]);
    expect(after["roots"]).toBe(2);
    expect(after["repositories"]).toEqual([{ name: "app", checkout_path: "/app" }]);
    expect(after["events"]).toEqual([
      expect.objectContaining({ workspace_root_id: after["currentRootId"] }),
    ]);

    // A fresh admitted invocation, through the production read link: the owner
    // answers with the new root, the new anchor and the retained mapping
    // together, and that root materializes to the bytes the effect wrote.
    const second = await connect(stub);
    const observed = await run(function* () {
      const connection = yield* useOwnerConnection(ownerSocket(second));
      let identifier = 0;
      const next = () => `observe-${(identifier += 1)}`;
      const reads = cloudflareReadLink(connection, next, RUN_ID);
      const snapshot = yield* reads.invocationSnapshot();
      const host = createWorkerFiles();
      const materialization = yield* useMaterialization(
        host.files,
        host.trees,
        reads,
        snapshot.workspaceRootId,
        (reason) => {
          throw new Error(reason);
        },
      );
      const workspace = host.workspace(materialization.at("/"));
      return {
        workspaceRootId: snapshot.workspaceRootId,
        journalEventId: snapshot.journalEventId,
        repositories: snapshot.repositories.map((stored) => stored.record.name),
        notes: yield* workspace.readTextFile("/NOTES.md"),
      };
    });
    expect(observed.workspaceRootId).toBe(after["currentRootId"]);
    expect(typeof observed.journalEventId).toBe("string");
    expect(observed.repositories).toEqual(["app"]);
    expect(observed.notes).toBe("written by the effect\n");
  });

  it("commits only the filtered failed result, and moves nothing else", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    const before = await on(stub, (owner) => owner.published());
    const socket = await connect(stub);

    await run(function* () {
      const opening = yield* opened(socket);
      yield* useRemoteWorkspaceEffects(opening);
      const effect = createRemoteWorkspaceEffect(
        opening,
        { type: "workspace", name: "refuse" },
        function* (filesystem, metadata): Operation<Json> {
          yield* filesystem.writeFile("/SCRATCH.md", "discarded\n", 0o644);
          yield* filesystem.mkdir("/app", { mode: 0o755 });
          metadata.insertRepository(repository());
          throw new DocumentedFailure("this Workspace effect refused");
        },
      );
      function* workflow(): Workflow<void> {
        yield effect;
      }
      try {
        yield* withRemoteWorkspaceEffects(
          opening,
          durableRun(workflow, { stream: opening.journal }),
        );
      } catch {
        // The documented failure is the run's outcome; what it left behind is
        // the claim being made.
      }
    });

    const after = await on(stub, (owner) => owner.published());
    // The pointer did not move, no second root was retained, and the mapping
    // the effect staged never became one.
    expect(after["currentRootId"]).toBe(before["currentRootId"]);
    expect(after["roots"]).toBe(before["roots"]);
    expect(after["repositories"]).toEqual([]);
    // One row, and it names the root the run is still on.
    expect(after["events"]).toEqual([
      expect.objectContaining({ workspace_root_id: before["currentRootId"] }),
    ]);
  });
});

/** A refusal the effect publishes rather than raises, as a document's would be. */
class DocumentedFailure extends JournaledEffectFailure {
  override name = "DocumentedFailure";
}
