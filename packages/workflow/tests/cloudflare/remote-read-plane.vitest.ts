/**
 * Reading a run's owner without taking it.
 *
 * The claim under test is one a fake cannot make: that an ordinary
 * authenticated request answers from a real Durable Object's committed SQLite
 * state while an executor WebSocket is live, and that asking takes no
 * acquisition. Only the runtime's own acquisition set can settle that.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { run, type Operation, until } from "effection";
import type { ExecutorObject } from "./support/executor-object.ts";
import { POLICY, RUN_ID, VALID_CLAIMS } from "./support/executor-object.ts";
import { generateKeys, signToken, type TestKeys } from "./support/tokens.ts";
import {
  cloudflareReadPlane,
  FORK_SOURCE_ANSWER_BYTES,
  type ReadTransport,
} from "../../src/cloudflare/read-client.ts";
import {
  READ_PAGE_BYTES,
  READ_PAGE_ENTRIES,
  READ_REQUEST_BYTES,
} from "../../src/cloudflare/read-plane.ts";
import { cloudflareRunLink } from "../../src/cloudflare/client.ts";
import {
  useOwnerConnection,
  type OwnerSocket,
  type SocketListener,
} from "../../src/remote/client.ts";
import { useRemoteRunStorage } from "../../src/remote/storage.ts";
import { WorkflowRunStorage } from "../../src/storage/api.ts";
import type { CreateWorkflowRunRequest } from "../../src/storage/api.ts";

let unique = 0;
const NOW = 1_800_000_000;
let keys: TestKeys;

beforeAll(async () => {
  keys = await generateKeys();
});

function executor() {
  unique += 1;
  return env.EXECUTOR.get(env.EXECUTOR.idFromName(`read-${unique}-${Math.random()}`));
}

function on<T>(stub: ReturnType<typeof executor>, body: (o: ExecutorObject) => T): Promise<T> {
  return runInDurableObject(stub, body);
}

async function token(): Promise<string> {
  return await signToken(keys, { ...VALID_CLAIMS, iat: NOW - 10, nbf: NOW - 10, exp: NOW + 600 });
}

async function connect(stub: ReturnType<typeof executor>): Promise<WebSocket> {
  await on(stub, (owner) => owner.configure([{ kid: keys.kid, jwk: keys.publicJwk }], NOW));
  const response = await stub.fetch("https://owner.invalid/executor", {
    headers: {
      authorization: `Bearer ${await token()}`,
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

/** One ordinary read request, answered by the object itself. */
async function ask(
  stub: ReturnType<typeof executor>,
  admission: { release: string | null; token: string | null; runId: string | null },
  body: string,
): Promise<string> {
  return await on(stub, (owner) => owner.readRequest(admission, body));
}

/** The read plane's transport: an ordinary request, and no socket at all. */
function transportTo(stub: ReturnType<typeof executor>): ReadTransport {
  return {
    *send(admission, body: string): Operation<string> {
      // Through the object itself, which is what makes "reading took no
      // acquisition" observable rather than asserted.
      return yield* until(ask(stub, admission, body));
    },
  };
}

function creation(): CreateWorkflowRunRequest {
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
  };
}

describe("reading a run's owner without taking it", () => {
  it("answers while an executor is live, and takes no acquisition", async () => {
    const stub = executor();
    const socket = await connect(stub);
    const bearer = await token();
    const held = (state: string) =>
      on(stub, (owner) => ({
        state,
        holders: owner.holders(),
        acquisition: owner.acquisitionId(),
        run: owner.runRow(),
      }));

    // Everything inside one scope, because the connection *is* the
    // acquisition: reading after it closed would prove nothing about
    // coexisting with a live executor.
    const seen = await run(function* () {
      const connection = yield* useOwnerConnection(ownerSocket(socket));
      let identifier = 0;
      yield* useRemoteRunStorage(
        cloudflareRunLink(connection, () => `open-${(identifier += 1)}`, RUN_ID),
      );
      yield* WorkflowRunStorage.operations.create(creation());

      const before = yield* until(held("before"));
      const answered = JSON.parse(
        yield* until(
          ask(
            stub,
            { release: POLICY.release, token: bearer, runId: RUN_ID },
            JSON.stringify({ operation: "inspect" }),
          ),
        ),
      );
      return { before, answered, after: yield* until(held("after")) };
    });

    expect(seen.before.holders).toBe(1);
    expect(seen.answered["outcome"]).toBe("performed");
    // The exact holder before and after, no second holder, and no retained row
    // changed by reading.
    expect(seen.after).toEqual({ ...seen.before, state: "after" });
  });

  it("refuses a wrong release before it verifies anything", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.configure([{ kid: keys.kid, jwk: keys.publicJwk }], NOW));
    // A body this build could not parse at all. If the release were compared
    // after parsing, this would refuse as malformed instead.
    const answered = JSON.parse(
      await ask(
        stub,
        { release: "some-other-release", token: "not-a-token", runId: RUN_ID },
        "{ this is not JSON at all",
      ),
    );
    expect(answered["outcome"]).toBe("refused");
    expect(String(answered["refusal"])).toContain("release:");
    // Nothing was created, and nobody holds anything.
    expect(await on(stub, (owner) => owner.objectCount())).toBe(0);
    expect(await on(stub, (owner) => owner.holders())).toBe(0);
  });

  it("refuses an unauthenticated read without touching the run", async () => {
    const stub = executor();
    const socket = await connect(stub);
    await run(function* () {
      const connection = yield* useOwnerConnection(ownerSocket(socket));
      let identifier = 0;
      yield* useRemoteRunStorage(
        cloudflareRunLink(connection, () => `open-${(identifier += 1)}`, RUN_ID),
      );
      return yield* WorkflowRunStorage.operations.create(creation());
    });
    const before = await on(stub, (owner) => owner.runRow());

    // Again with a body nothing could parse: authentication decides first.
    const answered = JSON.parse(
      await ask(
        stub,
        { release: POLICY.release, token: "not-a-token", runId: RUN_ID },
        "{ this is not JSON at all",
      ),
    );
    expect(answered["outcome"]).toBe("refused");
    // Not the release, and not a parse of the body either: authentication is
    // what stopped it.
    expect(String(answered["refusal"])).toContain("token:");
    // Whether an executor happened to be live is the coexistence test's claim;
    // this one is that a refused read leaves the run exactly as it was.
    expect(await on(stub, (owner) => owner.runRow())).toEqual(before);
  });

  it("answers one coherent inspection from one committed reading", async () => {
    const stub = executor();
    const socket = await connect(stub);
    await run(function* () {
      const connection = yield* useOwnerConnection(ownerSocket(socket));
      let identifier = 0;
      yield* useRemoteRunStorage(
        cloudflareRunLink(connection, () => `open-${(identifier += 1)}`, RUN_ID),
      );
      return yield* WorkflowRunStorage.operations.create(creation());
    });

    const bearer = await token();
    const answered = JSON.parse(
      await run(() =>
        transportTo(stub).send(
          { release: POLICY.release, token: bearer, runId: RUN_ID },
          JSON.stringify({ operation: "inspect" }),
        ),
      ),
    );
    expect(answered["outcome"]).toBe("performed");
    const value = answered["value"];
    // The run, its executions, the frontier, the current root and the lineage
    // all describe the same committed moment.
    expect(value["record"]["runId"]).toBe(RUN_ID);
    expect(value["record"]["status"]).toBe("running");
    expect(value["executions"]).toEqual([]);
    expect(value["journalFrontier"]).toBe(null);
    expect(value["lineage"]).toBe(null);
    expect(typeof value["currentWorkspaceRootId"]).toBe("string");
    // It agrees with what the object actually selects.
    expect(value["currentWorkspaceRootId"]).toBe(
      (await on(stub, (owner) => owner.published()))["currentRootId"],
    );
  });

  it("refuses a read addressed to another run, and writes nothing", async () => {
    const stub = executor();
    const socket = await connect(stub);
    await run(function* () {
      const connection = yield* useOwnerConnection(ownerSocket(socket));
      let identifier = 0;
      yield* useRemoteRunStorage(
        cloudflareRunLink(connection, () => `open-${(identifier += 1)}`, RUN_ID),
      );
      return yield* WorkflowRunStorage.operations.create(creation());
    });
    const before = await on(stub, (owner) => owner.runRow());

    const bearer = await token();
    const answered = JSON.parse(
      await run(() =>
        transportTo(stub).send(
          {
            release: POLICY.release,
            token: bearer,
            runId: "6dktgrv2zyutngh7bbddr2tyg2b5a567cg725hu5e7u42orerxaa",
          },
          JSON.stringify({ operation: "inspect" }),
        ),
      ),
    );
    expect(answered["outcome"]).toBe("refused");
    expect(await on(stub, (owner) => owner.runRow())).toEqual(before);
  });

  it("hands a fork the whole selection, and nothing the source keeps", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    await on(stub, (owner) => owner.appendForkableHistory());
    const socket = await connect(stub);
    const bearer = await token();

    const seen = await run(function* () {
      // The executor stays live for the whole read, so this is also the proof
      // that selecting a source takes nothing from it.
      const connection = yield* useOwnerConnection(ownerSocket(socket));
      yield* connection.ask("keep-alive", { command: "frontier" }, (value) => value);
      const before = yield* until(
        on(stub, (owner) => ({ holders: owner.holders(), run: owner.runRow() })),
      );

      const plane = cloudflareReadPlane(
        transportTo(stub),
        POLICY.release,
        // deno-lint-ignore require-yield
        function* () {
          return bearer;
        },
        RUN_ID,
      );
      const source = yield* plane.forkSource("event-work");
      // Appended after the checkpoint was selected, while the read is done.
      yield* until(on(stub, (owner) => owner.appendJournal("event-later", "later")));
      const again = yield* plane.forkSource("event-work");
      return {
        before,
        source,
        again,
        after: yield* until(
          on(stub, (owner) => ({ holders: owner.holders(), run: owner.runRow() })),
        ),
      };
    });

    expect(seen.source.ok).toBe(true);
    if (!seen.source.ok) {
      throw seen.source.error;
    }
    const source = seen.source.value;
    // The prefix without the two rows the fork writes for itself.
    expect(source.inherited.map((row) => row.eventId)).toEqual(["event-work"]);
    expect(source.checkpointEventId).toBe("event-work");
    expect(source.checkpointWorkspaceRootId).toBe(source.runRecordWorkspaceRootId);
    // Everything the destination must own independently came with it: the
    // roots the prefix names, and the content those roots close over.
    expect(source.roots.map((root) => root.rootId)).toEqual([source.checkpointWorkspaceRootId]);
    expect(source.manifests.length).toBeGreaterThan(0);
    expect(source.blobs.length).toBeGreaterThan(0);
    for (const root of source.roots) {
      for (const hash of root.manifestHashes) {
        expect(source.manifests.some((manifest) => manifest.hash === hash)).toBe(true);
      }
      for (const hash of root.blobHashes) {
        expect(source.blobs.some((blob) => blob.hash === hash)).toBe(true);
      }
    }

    // An append after the checkpoint does not enter the selection, however
    // long the sequence took.
    expect(seen.again.ok).toBe(true);
    if (seen.again.ok) {
      expect(seen.again.value.inherited.map((row) => row.eventId)).toEqual(["event-work"]);
    }
    // The executor still holds the run, and nothing about it changed.
    expect(seen.before.holders).toBe(1);
    expect(seen.after).toEqual(seen.before);
  });

  it("carries a multi-page selection in one order, with the records as retained", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.initialize());
    await on(stub, (owner) => owner.appendForkableHistory());
    // More rows than one page may carry, so the selection is a sequence the
    // client has to hold together rather than a single answer.
    await on(stub, (owner) => owner.fillJournal(200));
    await on(stub, (owner) => owner.retainQualifyingRepository("alpha"));
    await on(stub, (owner) => owner.retainQualifyingWorktree("alpha", "topic"));
    const retained = await on(stub, (owner) => owner.journalRecords());
    const socket = await connect(stub);
    const bearer = await token();

    const seen = await run(function* () {
      const connection = yield* useOwnerConnection(ownerSocket(socket));
      yield* connection.ask("keep-alive", { command: "frontier" }, (value) => value);
      const before = yield* until(
        on(stub, (owner) => ({ holders: owner.holders(), run: owner.runRow() })),
      );
      const plane = cloudflareReadPlane(
        transportTo(stub),
        POLICY.release,
        // deno-lint-ignore require-yield
        function* () {
          return bearer;
        },
        RUN_ID,
      );
      const source = yield* plane.forkSource("event-0199");
      return {
        before,
        source,
        after: yield* until(
          on(stub, (owner) => ({ holders: owner.holders(), run: owner.runRow() })),
        ),
      };
    });

    expect(seen.source.ok).toBe(true);
    if (!seen.source.ok) {
      throw seen.source.error;
    }
    const source = seen.source.value;
    // The prefix in journal order, without the two rows a fork writes for
    // itself, and every record exactly as this owner retained it.
    const inherited = retained.filter(
      (row) => row.eventId !== "event-run" && row.eventId !== "event-import",
    );
    expect(source.inherited.length).toBeGreaterThan(READ_PAGE_ENTRIES);
    expect(source.inherited.map((row) => row.eventId)).toEqual(inherited.map((row) => row.eventId));
    expect(source.inherited.map((row) => row.record)).toEqual(inherited.map((row) => row.record));

    // All three heads a destination writes against came with the selection.
    const carried = source.roots.map((root) => root.rootId);
    expect(carried).toContain(source.checkpointWorkspaceRootId);
    expect(carried).toContain(source.runRecordWorkspaceRootId);
    expect(carried).toContain(source.rootImportWorkspaceRootId);

    // The checkout graph, whole: the Repository and the Worktree that names
    // it, each in a directory the checkpoint's Workspace holds.
    expect(source.checkouts.map((checkout) => checkout.checkoutPath)).toEqual(["/", "/work"]);
    const worktrees = source.checkouts.filter((checkout) => checkout.kind === "worktree");
    expect(worktrees.map((checkout) => checkout.repositoryName)).toEqual(["alpha"]);
    expect(
      source.checkouts.filter((checkout) => checkout.kind === "repository").map((one) => one.name),
    ).toEqual(["alpha"]);

    // The executor held the run for the whole sequence, and nothing moved.
    expect(seen.before.holders).toBe(1);
    expect(seen.after).toEqual(seen.before);
  });

  it("continues a page of names JSON has to escape, and asks for the next in bytes", async () => {
    // The shape a cursor made of names cannot survive. A retained name is text
    // the schema bounds only by being non-empty, and a backslash is one
    // character that JSON writes as two — twice over, if a cursor spelled out
    // of names is then carried inside a request. These rows are near the
    // largest a page admits, so nothing but a position could ask for the next
    // one.
    const escaping = (count: number, tail: string) => `${"\\".repeat(count)}"«${tail}»`;
    const repositoryName = escaping(150_000, "repository");
    const first = escaping(80_000, "a");
    const second = escaping(80_000, "b");
    const stub = executor();
    await on(stub, (owner) => owner.configure([{ kid: keys.kid, jwk: keys.publicJwk }], NOW));
    await on(stub, (owner) => owner.initialize());
    await on(stub, (owner) => owner.appendForkableHistory());
    await on(stub, (owner) => owner.retainRepositoryAt(repositoryName, "/checkouts"));
    await on(stub, (owner) => owner.retainWorktreeAt(repositoryName, first, "/work"));
    await on(stub, (owner) => owner.retainWorktreeAt(repositoryName, second, "/"));
    const bearer = await token();

    const bytes = (text: string) => new TextEncoder().encode(text).length;
    const asked: { section: string; request: number; answer: number }[] = [];
    const measuring: ReadTransport = {
      *send(admission, body: string): Operation<string> {
        const answer = yield* until(ask(stub, admission, body));
        const value: unknown = JSON.parse(body);
        const section =
          value !== null && typeof value === "object" ? String(Reflect.get(value, "section")) : "";
        asked.push({ section, request: bytes(body), answer: bytes(answer) });
        return answer;
      },
    };

    const outcome = await run(function* () {
      const plane = cloudflareReadPlane(
        measuring,
        POLICY.release,
        // deno-lint-ignore require-yield
        function* () {
          return bearer;
        },
        RUN_ID,
      );
      return yield* plane.forkSource("event-work");
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw outcome.error;
    }
    // Three checkouts, each near the largest member a page admits, so the
    // section took three pages and two of them were continuations.
    const pages = asked.filter((one) => one.section === "checkouts");
    expect(pages.length).toBe(3);
    for (const checkout of outcome.value.checkouts) {
      expect(bytes(JSON.stringify(checkout))).toBeLessThanOrEqual(READ_PAGE_BYTES);
    }
    expect(bytes(JSON.stringify(outcome.value.checkouts[1]))).toBeGreaterThan(400_000);

    // Every request the sequence needed fits the parser's bound, because a
    // position is the same size whatever it points at. A cursor spelled out of
    // these names would have been larger than the member itself.
    for (const page of asked) {
      expect(page.request).toBeLessThanOrEqual(READ_REQUEST_BYTES);
      expect(page.answer).toBeLessThanOrEqual(FORK_SOURCE_ANSWER_BYTES);
    }
    expect(Math.max(...pages.map((one) => one.request))).toBeLessThan(1024);
    expect(Math.max(...pages.map((one) => one.answer))).toBeGreaterThan(400_000);

    // The owner resolved each continuation to exactly one further member, and
    // the composite identities came back distinct and whole.
    expect(outcome.value.checkouts.map((one) => one.checkoutPath)).toEqual([
      "/checkouts",
      "/work",
      "/",
    ]);
    expect(
      outcome.value.checkouts
        .filter((one) => one.kind === "worktree")
        .map((one) => [one.repositoryName, one.name]),
    ).toEqual([
      [repositoryName, first],
      [repositoryName, second],
    ]);
  });

  it("refuses a continuation that names no member of the anchored selection", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.configure([{ kid: keys.kid, jwk: keys.publicJwk }], NOW));
    await on(stub, (owner) => owner.initialize());
    await on(stub, (owner) => owner.appendForkableHistory());
    const bearer = await token();
    const admission = { release: POLICY.release, token: bearer, runId: RUN_ID };
    const read = async (after: unknown, overrides: Record<string, unknown> = {}) =>
      JSON.parse(
        await ask(
          stub,
          admission,
          JSON.stringify({
            operation: "fork-source",
            checkpointEventId: "event-work",
            section: "roots",
            anchor: null,
            after: null,
            ...overrides,
            ...(after === undefined ? {} : { after }),
          }),
        ),
      );

    const opening = await read(undefined);
    expect(opening["outcome"]).toBe("performed");
    const anchor: unknown = opening["value"]["anchor"];
    const total: unknown = opening["value"]["total"];
    expect(total).toBe(1);

    // A position past the end of the section it names.
    expect(await read(1, { anchor })).toEqual({
      outcome: "refused",
      refusal: "command:stale-journal",
    });
    // A position that is not one: a name, a fraction, a negative.
    for (const malformed of ["0", 0.5, -1]) {
      expect((await read(malformed, { anchor }))["outcome"]).toBe("refused");
    }
    // A position with nothing pinning the selection it counts into.
    expect((await read(0))["outcome"]).toBe("refused");
    // A section this build does not answer, and a checkpoint this run does not
    // hold, are refused whether or not a position accompanies them.
    expect((await read(0, { anchor, section: "elsewhere" }))["outcome"]).toBe("refused");
    expect((await read(0, { anchor, checkpointEventId: "event-nowhere" }))["outcome"]).toBe(
      "refused",
    );
    expect((await read(0, { anchor: "b".repeat(64) }))["outcome"]).toBe("refused");
  });

  it("refuses a checkpoint this run does not hold, and a prefix with no run", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.configure([{ kid: keys.kid, jwk: keys.publicJwk }], NOW));
    await on(stub, (owner) => owner.initialize());
    const bearer = await token();
    const plane = () =>
      cloudflareReadPlane(
        transportTo(stub),
        POLICY.release,
        // deno-lint-ignore require-yield
        function* () {
          return bearer;
        },
        RUN_ID,
      );

    // Nothing retained at all: no checkpoint to select.
    const missing = await run(() => plane().forkSource("event-nowhere"));
    expect(missing.ok).toBe(false);
    expect(String(missing.ok === false && missing.error)).not.toContain("command:");

    // A prefix that records no run of its own is not one a fork could inherit.
    await on(stub, (owner) => owner.appendJournal("event-alone", "alone"));
    const unforkable = await run(() => plane().forkSource("event-alone"));
    expect(unforkable.ok).toBe(false);
    expect(String(unforkable.ok === false && unforkable.error)).not.toContain("command:");
    // Neither refusal wrote anything.
    expect((await on(stub, (owner) => owner.published()))["events"]).toHaveLength(1);
  });

  it("changes the selection anchor when a qualifying checkout is added", async () => {
    // The case the anchor exists for. Retained mappings are appendable, and a
    // qualifying one added between sections would otherwise let a client join
    // earlier pages to checkouts from a different committed state.
    const stub = executor();
    await on(stub, (owner) => owner.configure([{ kid: keys.kid, jwk: keys.publicJwk }], NOW));
    await on(stub, (owner) => owner.initialize());
    await on(stub, (owner) => owner.appendForkableHistory());
    const bearer = await token();
    const anchorNow = async (): Promise<unknown> => {
      const answered = JSON.parse(
        await ask(
          stub,
          { release: POLICY.release, token: bearer, runId: RUN_ID },
          JSON.stringify({
            operation: "fork-source",
            checkpointEventId: "event-work",
            section: "inherited",
            anchor: null,
            after: null,
          }),
        ),
      );
      expect(answered["outcome"]).toBe("performed");
      return answered["value"]["anchor"];
    };

    const before = await anchorNow();
    expect(typeof before).toBe("string");
    // The same selection, read twice, is the same selection.
    expect(await anchorNow()).toBe(before);

    await on(stub, (owner) => owner.retainQualifyingRepository("added-between"));
    // A checkout the destination would copy changed, so the selection did.
    expect(await anchorNow()).not.toBe(before);
  });

  it("refuses a fork-source page from a selection that has moved", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.configure([{ kid: keys.kid, jwk: keys.publicJwk }], NOW));
    await on(stub, (owner) => owner.initialize());
    await on(stub, (owner) => owner.appendForkableHistory());
    const bearer = await token();

    const answered = JSON.parse(
      await ask(
        stub,
        { release: POLICY.release, token: bearer, runId: RUN_ID },
        JSON.stringify({
          operation: "fork-source",
          checkpointEventId: "event-work",
          // An anchor from a selection this owner never produced.
          section: "roots",
          anchor: "c".repeat(64),
          after: null,
        }),
      ),
    );
    expect(answered["outcome"]).toBe("refused");
    // And nothing was written on the way to refusing.
    expect((await on(stub, (owner) => owner.published()))["events"]).toHaveLength(3);
  });

  it("changes the anchor when copied metadata moves and content does not", async () => {
    // A watermark is copied into destination storage but is not implied by any
    // content identity, so a digest cannot stand for it.
    const stub = executor();
    await on(stub, (owner) => owner.configure([{ kid: keys.kid, jwk: keys.publicJwk }], NOW));
    await on(stub, (owner) => owner.initialize());
    await on(stub, (owner) => owner.appendForkableHistory());
    const bearer = await token();
    const anchorNow = async (): Promise<unknown> => {
      const answered = JSON.parse(
        await ask(
          stub,
          { release: POLICY.release, token: bearer, runId: RUN_ID },
          JSON.stringify({
            operation: "fork-source",
            checkpointEventId: "event-work",
            section: "blobs",
            anchor: null,
            after: null,
          }),
        ),
      );
      expect(answered["outcome"]).toBe("performed");
      return answered["value"]["anchor"];
    };

    const before = await anchorNow();
    expect(typeof before).toBe("string");
    await on(stub, (owner) => owner.touchBlobWatermark());
    // Identical content, different metadata: a different selection.
    expect(await anchorNow()).not.toBe(before);
  });

  it("refuses a retained value of the wrong type rather than converting it", async () => {
    const stub = executor();
    await on(stub, (owner) => owner.configure([{ kid: keys.kid, jwk: keys.publicJwk }], NOW));
    await on(stub, (owner) => owner.initialize());
    await on(stub, (owner) => owner.appendForkableHistory());
    await on(stub, (owner) => owner.damageRetainedWatermark());
    const bearer = await token();

    const answered = JSON.parse(
      await ask(
        stub,
        { release: POLICY.release, token: bearer, runId: RUN_ID },
        JSON.stringify({
          operation: "fork-source",
          checkpointEventId: "event-work",
          section: "blobs",
          anchor: null,
          after: null,
        }),
      ),
    );
    // Damage, not a zero. A reader that coerced would have answered with one.
    expect(answered["outcome"]).toBe("refused");
    expect(String(answered["refusal"])).toContain("storage:corrupt");
    // And nothing of the retained value crossed with it.
    expect(JSON.stringify(answered)).not.toContain("not a number");
  });
});
