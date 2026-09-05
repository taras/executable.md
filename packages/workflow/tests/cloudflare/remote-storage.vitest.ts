/**
 * Finding and creating a run on its own owner.
 *
 * Against a real Durable Object, because what is being claimed is that a
 * creation either commits whole or leaves the object exactly as it was — and
 * "whole" here means the schema, the run record, the starting Workspace and the
 * pointer that selects it, written in one transaction the runtime either
 * applies or does not.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { call, run, type Operation } from "effection";
import type { ExecutorObject } from "./support/executor-object.ts";
import { POLICY, RUN_ID, VALID_CLAIMS } from "./support/executor-object.ts";
import { generateKeys, signToken, type TestKeys } from "./support/tokens.ts";
import { cloudflareRunLink } from "../../src/cloudflare/client.ts";
import {
  type OwnerSocket,
  type SocketListener,
  useOwnerConnection,
} from "../../src/remote/client.ts";
import type { CreateWorkflowRunRequest, WorkflowRunDatabase } from "../../src/storage/api.ts";
import { WorkflowRunStorage } from "../../src/storage/api.ts";
import { useRemoteRunStorage } from "../../src/remote/storage.ts";
import type { RemoteWorkspaceLink } from "../../src/remote/database.ts";
import {
  WorkflowDatabaseCorruptError,
  WorkflowRunConflictError,
  WorkflowRunIdMismatchError,
  WorkflowRunNotFoundError,
} from "../../src/storage/errors.ts";
import type { Result } from "effection";

let unique = 0;
const NOW = 1_800_000_000;
let keys: TestKeys;

beforeAll(async () => {
  keys = await generateKeys();
});

function executor() {
  unique += 1;
  return env.EXECUTOR.get(env.EXECUTOR.idFromName(`storage-${unique}-${Math.random()}`));
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

function ownerSocket(socket: WebSocket): OwnerSocket {
  const listeners = new Map<SocketListener, EventListener>();
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    addEventListener(type, listener) {
      // The event's data is read out and handed over as the small shape the
      // listener declares, rather than the runtime event being renamed into
      // it: a message carries text, and every other kind carries nothing.
      const forward: EventListener = (event) => {
        const data: unknown = Reflect.get(event, "data");
        listener(typeof data === "string" ? { data } : {});
      };
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

function creation(overrides: Partial<CreateWorkflowRunRequest> = {}): CreateWorkflowRunRequest {
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
    ...overrides,
  };
}

/**
 * The storage provider, installed the way a host installs one.
 *
 * Through `WorkflowRunStorage.operations` rather than by calling the adapter
 * directly: what is under test is the provider a caller reaches, including
 * that every failure comes back inside `Result` rather than escaping.
 *
 * One connection for the whole body. The connection owns the socket and closes
 * it when its scope ends, so a second one over the same socket would be asking
 * through a channel the first already ended.
 */
function installed<T>(socket: WebSocket, body: () => Operation<T>): Promise<T> {
  return run(function* () {
    const connection = yield* useOwnerConnection(ownerSocket(socket));
    let identifier = 0;
    yield* useRemoteRunStorage(
      cloudflareRunLink(connection, () => `open-${(identifier += 1)}`, RUN_ID),
    );
    return yield* body();
  });
}

function create(request: CreateWorkflowRunRequest): Operation<Result<WorkflowRunDatabase>> {
  return WorkflowRunStorage.operations.create(request);
}

function lookup(runId: string): Operation<Result<WorkflowRunDatabase>> {
  return WorkflowRunStorage.operations.lookup(runId);
}

/**
 * The provider takes one value, and that value is the link.
 *
 * A type-level assertion because that is where the property lives: giving
 * `useRemoteRunStorage` a second parameter — the opener/link pair this
 * correction removed — stops this file compiling. A runtime check could not
 * say anything about a shape that no longer exists.
 */
type OneCapability =
  Parameters<typeof useRemoteRunStorage> extends [RemoteWorkspaceLink] ? true : never;
const ONE_CAPABILITY: OneCapability = true;

/** The error a refused result carries, having proved it refused at all. */
function failure(result: Result<unknown>): Error {
  if (result.ok) {
    throw new Error("expected a refused result");
  }
  return result.error;
}

describe("opening a run on its owner", () => {
  it("creates once, and answers the same run for a compatible repeat", async () => {
    const stub = executor();
    const socket = await connect(stub);

    const outcome = await installed(socket, function* () {
      const first = yield* create(creation());
      // The same request again is the same run, not a second one.
      const again = yield* create(creation());
      return { first: first.ok, again: again.ok };
    });
    expect(outcome).toEqual({ first: true, again: true });

    const after = await on(stub, (owner) => owner.published());
    // The schema, the run, the starting Workspace and its pointer, together.
    expect(after["roots"]).toBe(1);
    expect(after["events"]).toEqual([]);
    expect(await on(stub, (owner) => owner.runRow())).not.toBe(null);
  });

  it("names the exact immutable fields that differ, and none of their values", async () => {
    const stub = executor();
    const socket = await connect(stub);

    const refusals = await installed(socket, function* () {
      yield* create(creation());
      const reported: Error[] = [];
      for (const differing of [
        creation({ base: "other-base-entirely" }),
        creation({ props: { secret: "do-not-echo-me" } }),
        creation({
          definition: {
            version: 1,
            kind: "git",
            objectFormat: "sha1",
            objectId: "1".repeat(40),
            rootDocumentPath: "README.md",
          },
        }),
        // Two at once: the list is what differs, in the order they are read.
        creation({ base: "other-base-entirely", props: { secret: "do-not-echo-me" } }),
      ]) {
        reported.push(failure(yield* create(differing)));
      }
      return reported.map((error) => ({
        conflict: error instanceof WorkflowRunConflictError,
        fields: error instanceof WorkflowRunConflictError ? error.fields : undefined,
        text: String(error),
      }));
    });

    expect(refusals.map((entry) => entry.conflict)).toEqual([true, true, true, true]);
    expect(refusals.map((entry) => entry.fields)).toEqual([
      ["base"],
      ["props"],
      ["definition"],
      ["base", "props"],
    ]);
    for (const entry of refusals) {
      // What differs, never what it differs to, and nothing of the protocol.
      expect(entry.text).not.toContain("do-not-echo-me");
      expect(entry.text).not.toContain("other-base-entirely");
      expect(entry.text).not.toContain("command:");
    }
    // One run, exactly as the compatible creation left it.
    expect((await on(stub, (owner) => owner.published()))["roots"]).toBe(1);
  });

  it("looks up without creating, and says so when there is nothing", async () => {
    const stub = executor();
    const socket = await connect(stub);

    const seen = await installed(socket, function* () {
      const absent = failure(yield* lookup(RUN_ID));
      // Asked before anything else, so what it reports is about an owner that
      // has never held a run.
      const pristine = yield* call(() => on(stub, (owner) => owner.objectCount()));
      yield* create(creation());
      const found = yield* lookup(RUN_ID);
      return {
        absent: { missing: absent instanceof WorkflowRunNotFoundError, text: String(absent) },
        pristine,
        found: found.ok ? found.value.record.status : "refused",
      };
    });

    expect(seen.absent.missing).toBe(true);
    // Nothing of the private protocol crossed with it.
    expect(seen.absent.text).not.toContain("command:");
    // A lookup that missed created nothing.
    expect(seen.pristine).toBe(0);
    expect(seen.found).toBe("running");
  });

  it("says a run stored here is another run, without saying which", async () => {
    const stub = executor();
    const socket = await connect(stub);
    await installed(socket, () => create(creation()));
    // Intact storage, holding somebody else's run.
    const other = "6dktgrv2zyutngh7bbddr2tyg2b5a567cg725hu5e7u42orerxaa";
    await on(stub, (owner) => owner.retainAnotherRun(other));
    const before = await on(stub, (owner) => owner.runRow());

    const again = await connect(stub);
    const seen = await installed(again, function* () {
      const looked = failure(yield* lookup(RUN_ID));
      const created = failure(yield* create(creation()));
      return [looked, created].map((error) => ({
        mismatch: error instanceof WorkflowRunIdMismatchError,
        damaged: error instanceof WorkflowDatabaseCorruptError,
        text: String(error),
      }));
    });

    for (const entry of seen) {
      // Not this run, and not damage.
      expect([entry.mismatch, entry.damaged]).toEqual([true, false]);
      // The retained id belongs to that other run and does not travel.
      expect(entry.text).not.toContain(other);
      expect(entry.text).not.toContain("command:");
    }
    // Nothing was written on the way to either answer.
    expect(await on(stub, (owner) => owner.runRow())).toEqual(before);
  });

  it("initializes nothing into storage that is not this build's", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.holdForeignObject());
    const socket = await connect(stub);
    const refused = await installed(socket, function* () {
      const outcome = yield* create(creation());
      return outcome.ok ? "it was allowed" : String(outcome.error);
    });
    // A storage condition, inside `Result`, with nothing private in it.
    expect(refused).not.toBe("it was allowed");
    expect(refused).not.toContain("storage:");
    // Foreign, and left exactly as it was found.
    expect(await on(stub, (owner) => owner.hasWorkflowSchema())).toBe(false);
  });

  it("refuses every operation once the provider scope has closed", async () => {
    const stub = executor();
    const socket = await connect(stub);
    const held = await installed(socket, function* () {
      const opened = yield* create(creation());
      return opened.ok ? opened.value : undefined;
    });
    if (held === undefined) {
      throw new Error("expected a database");
    }
    // The handle outlived the scope that opened it; what it names did not, and
    // it does not reconnect.
    const late = await run(() => held.replaceRetrievalMetadata({ a: 1 }));
    expect(late.ok).toBe(false);
  });

  it("cannot open through one owner and answer with the other", async () => {
    expect(ONE_CAPABILITY).toBe(true);
    // Two owners that look alike: same public run id, same compatible
    // creation, identical retained state. Only the objects differ.
    const first = executor();
    const second = executor();
    const socketA = await connect(first);
    const socketB = await connect(second);
    await installed(socketA, () => create(creation()));
    await installed(socketB, () => create(creation()));

    // There is one value to install, and it came from one connection. A
    // provider built on A's link reads and commits through A, whatever B
    // holds — there is no second argument to give it B's.
    const again = await connect(first);
    const seen = await run(function* () {
      const connection = yield* useOwnerConnection(ownerSocket(again));
      let identifier = 0;
      yield* useRemoteRunStorage(
        cloudflareRunLink(connection, () => `pair-${(identifier += 1)}`, RUN_ID),
      );
      const opened = yield* lookup(RUN_ID);
      if (!opened.ok) {
        return "refused";
      }
      const written = yield* opened.value.transact(function* (transaction) {
        yield* transaction.journal.append({
          type: "yield",
          coroutineId: "root",
          description: { type: "test", name: "written" },
          result: { status: "ok", value: "written" },
        });
      });
      return written.ok ? "appended" : "refused";
    });
    expect(seen).toBe("appended");

    // The append landed on the owner whose link was installed, and nowhere else.
    expect((await on(first, (owner) => owner.published()))["events"]).toHaveLength(1);
    expect((await on(second, (owner) => owner.published()))["events"]).toEqual([]);
  });
});
