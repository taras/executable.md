/**
 * Tier WRH12 — a completed run replayed through its real durable owner.
 *
 * The rule this file exists for has two halves that pull in opposite
 * directions. A completed replay must reach *no* external-effect provider; and
 * it must reach the run's durable owner, because that is where the retained
 * result is and an ephemeral runner holds no copy of it. Reading its own
 * history is not attaching a provider, and proving that distinction needs the
 * real thing: a real Durable Object, its own SQLite storage, a real accepted
 * Hibernation WebSocket, and the production executor connection over it.
 *
 * What runs on this side is the production decision — `retainedReplay()` over
 * the frontier the owner answered with — handed to canonical
 * `executeInstalled()`. The shared CLI assembles exactly these two around the
 * same values; it is not itself importable here, because it resolves a terminal
 * renderer a Worker has no use for. That orchestration is proved in
 * `packages/cli/tests/workflow-replay.test.ts` against the local host.
 *
 * Nothing in this file imports `@executablemd/workflow/deno`. It could not: the
 * adapter behind that specifier reaches `node:sqlite`, which workerd does not
 * have. A completed replay that runs here is a completed replay that needed
 * none of it.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { run, until, type Operation, type Result, Ok, scoped } from "effection";
import { executeInstalled, retainedSource } from "@executablemd/core/host";
import type { ExecutionInstallation, RetainedRootDocument } from "@executablemd/core/host";
import type { Json } from "@executablemd/durable-streams";
import type { ExecutorObject } from "./support/executor-object.ts";
import { POLICY, RUN_ID, VALID_CLAIMS } from "./support/executor-object.ts";
import { generateKeys, signToken, type TestKeys } from "./support/tokens.ts";
import { type OwnerSocket, type SocketListener } from "../../src/remote/client.ts";
import { useExecutorConnection } from "../../src/cloudflare/executor-connection.ts";
import { useRemoteLifecycle } from "../../src/remote/lifecycle.ts";
import type { RemoteLifecycleHost } from "../../src/remote/lifecycle.ts";
import type { RemoteExecutorConnection } from "../../src/remote/lifecycle-link.ts";
import type { RemoteReadPlane } from "../../src/remote/read.ts";
import type { WorkflowRunDatabase } from "../../src/storage/api.ts";
import { WorkflowLifecycle } from "../../src/lifecycle/api.ts";
import type {
  WorkflowExecutionTransitions,
  WorkflowRunCreation,
} from "../../src/lifecycle/execution.ts";
import { retainedReplay } from "../../src/replay.ts";
import { DOCUMENT_FAILED } from "../../src/lifecycle/policy.ts";
import { retainedWorkflowInstallation } from "../../src/run.ts";
import { workflowBundleInstallation } from "../../src/bundle.ts";
import { gitBlobId } from "../../src/git-blob.ts";

let unique = 0;
const NOW = 1_800_000_000;
const COMMIT = "0".repeat(40);
const DOCUMENT = "# Remote\n\nthe owner recorded this line.\n";
/** A document that fails: the name resolves to nothing, and nothing is searched. */
const FAILING = "# Remote\n\npartial line.\n\n<Missing />\n";
let keys: TestKeys;

beforeAll(async () => {
  keys = await generateKeys();
});

function executor() {
  unique += 1;
  return env.EXECUTOR.get(env.EXECUTOR.idFromName(`replay-${unique}-${Math.random()}`));
}

function on<T>(
  stub: ReturnType<typeof executor>,
  body: (instance: ExecutorObject) => T,
): Promise<T> {
  return runInDurableObject(stub, body);
}

/** One real accepted executor WebSocket, admitted the way a runner's is. */
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

/**
 * The provider's host, reaching this exact owner.
 *
 * Two of its four members refuse. The read plane and fork staging are the
 * planes a replay has no business on, so entering either is a planted failure
 * rather than something an assertion has to notice afterwards.
 */
function lifecycleHost(stub: ReturnType<typeof executor>): RemoteLifecycleHost {
  let executions = 0;
  let commands = 0;
  const next = () => `command-${(commands += 1)}`;
  return {
    *admit(runId: string): Operation<Result<RemoteExecutorConnection | "already-running">> {
      return yield* useExecutorConnection(
        {
          *open(): Operation<Result<OwnerSocket>> {
            return Ok(ownerSocket(yield* until(connect(stub))));
          },
          ids: () => next,
        },
        runId,
      );
    },
    // deno-lint-ignore require-yield
    *source(): Operation<Result<RemoteReadPlane>> {
      throw new Error("PLANTED-READ-PLANE-REACHED");
    },
    // deno-lint-ignore require-yield
    *stage(): Operation<Result<WorkflowRunDatabase>> {
      throw new Error("PLANTED-STAGING-REACHED");
    },
    ids: { execution: () => `execution-${(executions += 1)}`, command: next },
  };
}

const CREATION: WorkflowRunCreation = {
  definition: {
    version: 1,
    kind: "git",
    objectFormat: "sha1",
    objectId: COMMIT,
    rootDocumentPath: "README.md",
  },
  base: "main",
  props: {},
};

/** One component the definition is closed over, named the way Git names it. */
const STAGE = { name: "Stage", path: "Stage.md", content: "staged.\n" };
const STAGE_HASH = gitBlobId(STAGE.content, "sha1");
const BUNDLED_DOCUMENT = "# Remote\n\n<Stage />\n";

const BUNDLED: WorkflowRunCreation = {
  definition: {
    ...CREATION.definition,
    components: [{ name: STAGE.name, path: STAGE.path, sourceHash: STAGE_HASH }],
  },
  base: "main",
  props: {},
};

/** The run contract every execution of this run installs. */
function runContract(): ExecutionInstallation {
  return retainedWorkflowInstallation({
    runId: RUN_ID,
    base: CREATION.base,
    pinnedCommit: COMMIT,
  });
}

/** What one document execution rendered, and how it ended. */
interface Rendered {
  readonly output: string;
  readonly result: Result<Json>;
}

/** Take the acquisition this provider issues, or say why there is none. */
function* acquired(): Operation<{ runId: string }> {
  const taken = yield* WorkflowLifecycle.operations.acquireExecutor(RUN_ID);
  if (!taken.ok) {
    throw taken.error;
  }
  if (taken.value.kind !== "acquired") {
    throw new Error("expected this connection to be the run's executor");
  }
  return taken.value.lock;
}

/** One canonical execution over the owner-backed journal, rendered in full. */
function* canonical(
  database: WorkflowRunDatabase,
  root: RetainedRootDocument,
  installations: readonly ExecutionInstallation[],
): Operation<Rendered> {
  const running = yield* executeInstalled(
    { ...root, stream: database.journal, componentDirs: [] },
    installations,
  );
  const subscription = yield* running.output;
  let next = yield* subscription.next();
  while (!next.done) {
    next = yield* subscription.next();
  }
  return { output: next.value, result: yield* running };
}

/** Everything about this owner a replay must leave alone. */
function ownerState(stub: ReturnType<typeof executor>) {
  return on(stub, (owner) => ({
    run: owner.runRow(),
    executions: owner.executionRows().length,
    currentRootId: owner.currentRootId(),
    journal: owner.journalRecords(),
    published: owner.published(),
    answers: owner.retainedAnswers(),
  }));
}

describe("a completed run replayed through its own owner", () => {
  it("restores the retained result, and moves nothing but its own envelope", async () => {
    const stub = executor();
    const host = lifecycleHost(stub);

    // The run, made and completed the way a runner makes one: one admitted
    // connection, one begin, canonical execution over the owner's journal, one
    // settlement.
    const live = await run(function* (): Operation<Rendered> {
      return yield* scoped(function* () {
        const transitions: WorkflowExecutionTransitions = yield* useRemoteLifecycle(host);
        const lock = yield* acquired();
        const begun = yield* transitions.begin(lock, {
          runId: RUN_ID,
          action: "start",
          creation: CREATION,
        });
        if (!begun.ok) {
          throw begun.error;
        }
        const rendered = yield* canonical(
          begun.value.database,
          retainedSource("README.md", DOCUMENT),
          [
            retainedWorkflowInstallation({
              runId: RUN_ID,
              base: CREATION.base,
              pinnedCommit: COMMIT,
            }),
          ],
        );
        const settled = yield* transitions.settle(lock, {
          executionId: begun.value.execution.executionId,
          status: "completed",
        });
        if (!settled.ok) {
          throw settled.error;
        }
        return rendered;
      });
    });

    expect(live.result.ok).toBe(true);
    const before = await ownerState(stub);
    expect(before.run?.["status"]).toBe("completed");
    expect(before.journal.length).toBeGreaterThan(0);
    // The acquisition ended with its scope, so nothing holds the run.
    expect(await on(stub, (owner) => owner.holders())).toBe(0);

    // A second connection, a resume, and the replay: everything it is held to
    // comes from the frontier this owner answers with.
    const replayed = await run(function* (): Operation<Rendered> {
      return yield* scoped(function* () {
        const transitions: WorkflowExecutionTransitions = yield* useRemoteLifecycle(host);
        const lock = yield* acquired();
        const begun = yield* transitions.begin(lock, { runId: RUN_ID, action: "resume" });
        if (!begun.ok) {
          throw begun.error;
        }
        // The run kept the outcome that already won.
        expect(begun.value.replay).toBe(true);
        const database = begun.value.database;
        const frontier = yield* database.readJournalEntries();
        if (!frontier.ok) {
          throw frontier.error;
        }
        const prepared = retainedReplay(begun.value.record, frontier.value);
        if (!prepared.ok) {
          throw prepared.error;
        }
        // The document canonical execution is handed comes out of the owner's
        // own history, reported by the path the run record names.
        expect(prepared.value.root).toEqual({
          path: "README.md",
          source: DOCUMENT,
          retained: true,
        });
        const rendered = yield* canonical(database, prepared.value.root, [
          ...prepared.value.installations,
        ]);
        const settled = yield* transitions.settle(lock, {
          executionId: begun.value.execution.executionId,
          status: "completed",
        });
        if (!settled.ok) {
          throw settled.error;
        }
        return rendered;
      });
    });

    // Byte for byte, and the same result — reconstructed from the owner's own
    // history, with no definition, checkout, Workspace or provider anywhere.
    expect(replayed.output).toBe(live.output);
    expect(replayed.result.ok).toBe(true);
    expect(replayed.result.ok === true && replayed.result.value).toEqual(
      live.result.ok === true ? live.result.value : undefined,
    );

    const after = await ownerState(stub);
    // Every retained row, under the same identity, in the same order.
    expect(after.journal).toEqual(before.journal);
    expect(after.currentRootId).toBe(before.currentRootId);
    expect(after.published).toEqual(before.published);
    expect(after.answers).toEqual(before.answers);
    expect(after.run?.["status"]).toBe("completed");
    // The one durable change: the lifecycle envelope this invocation recorded.
    expect(after.executions).toBe(before.executions + 1);
    // And it is closed, so the run is not left looking live.
    expect(await on(stub, (owner) => owner.holders())).toBe(0);
  });

  it("replays a completed run its owner is asked to start again", async () => {
    const stub = executor();
    const host = lifecycleHost(stub);

    const live = await run(function* (): Operation<Rendered> {
      return yield* scoped(function* () {
        const transitions: WorkflowExecutionTransitions = yield* useRemoteLifecycle(host);
        const lock = yield* acquired();
        const begun = yield* transitions.begin(lock, {
          runId: RUN_ID,
          action: "start",
          creation: CREATION,
        });
        if (!begun.ok) {
          throw begun.error;
        }
        const rendered = yield* canonical(
          begun.value.database,
          retainedSource("README.md", DOCUMENT),
          [runContract()],
        );
        const settled = yield* transitions.settle(lock, {
          executionId: begun.value.execution.executionId,
          status: "completed",
        });
        if (!settled.ok) {
          throw settled.error;
        }
        return rendered;
      });
    });

    const before = await ownerState(stub);
    expect(before.run?.["status"]).toBe("completed");

    // The same creation named at the same run. The owner compares it with the
    // immutable record it already holds and answers `replay`, exactly as it
    // does for a resume — a caller supplying a candidate definition proves the
    // two runs are the same run; it does not make the run live again.
    const replayed = await run(function* (): Operation<Rendered> {
      return yield* scoped(function* () {
        const transitions: WorkflowExecutionTransitions = yield* useRemoteLifecycle(host);
        const lock = yield* acquired();
        const begun = yield* transitions.begin(lock, {
          runId: RUN_ID,
          action: "start",
          creation: CREATION,
        });
        if (!begun.ok) {
          throw begun.error;
        }
        expect(begun.value.replay).toBe(true);
        const frontier = yield* begun.value.database.readJournalEntries();
        if (!frontier.ok) {
          throw frontier.error;
        }
        const prepared = retainedReplay(begun.value.record, frontier.value);
        if (!prepared.ok) {
          throw prepared.error;
        }
        const rendered = yield* canonical(begun.value.database, prepared.value.root, [
          ...prepared.value.installations,
        ]);
        const settled = yield* transitions.settle(lock, {
          executionId: begun.value.execution.executionId,
          status: "completed",
        });
        if (!settled.ok) {
          throw settled.error;
        }
        return rendered;
      });
    });

    expect(replayed.output).toBe(live.output);
    expect(replayed.result.ok).toBe(true);

    const after = await ownerState(stub);
    expect(after.journal).toEqual(before.journal);
    expect(after.currentRootId).toBe(before.currentRootId);
    expect(after.published).toEqual(before.published);
    expect(after.answers).toEqual(before.answers);
    expect(after.run?.["status"]).toBe("completed");
    expect(after.executions).toBe(before.executions + 1);
    expect(await on(stub, (owner) => owner.holders())).toBe(0);
  });

  it("recovers a bundled run whose result committed and whose settlement did not", async () => {
    const stub = executor();
    const host = lifecycleHost(stub);

    // The runner committed the document's result and its connection went
    // before it settled. Nothing about time says so; the socket closing does.
    const live = await run(function* (): Operation<Rendered> {
      return yield* scoped(function* () {
        const transitions: WorkflowExecutionTransitions = yield* useRemoteLifecycle(host);
        const lock = yield* acquired();
        const begun = yield* transitions.begin(lock, {
          runId: RUN_ID,
          action: "start",
          creation: BUNDLED,
        });
        if (!begun.ok) {
          throw begun.error;
        }
        return yield* canonical(
          begun.value.database,
          retainedSource("README.md", BUNDLED_DOCUMENT),
          [runContract(), workflowBundleInstallation([{ ...STAGE, sourceHash: STAGE_HASH }])],
        );
      });
    });

    expect(live.result.ok).toBe(true);
    expect(live.output).toContain("staged.");
    const before = await ownerState(stub);
    // The crash window: the outcome is committed and the lifecycle row is not.
    expect(before.run?.["status"]).toBe("running");
    expect(before.executions).toBe(1);
    expect(await on(stub, (owner) => owner.holders())).toBe(0);

    const replayed = await run(function* (): Operation<Rendered> {
      return yield* scoped(function* () {
        const transitions: WorkflowExecutionTransitions = yield* useRemoteLifecycle(host);
        const lock = yield* acquired();
        const begun = yield* transitions.begin(lock, { runId: RUN_ID, action: "resume" });
        if (!begun.ok) {
          throw begun.error;
        }
        // The owner's own transaction recognized the retained result, closed
        // the stale execution and published the terminal it implies.
        expect(begun.value.replay).toBe(true);
        expect(begun.value.record.status).toBe("completed");
        const frontier = yield* begun.value.database.readJournalEntries();
        if (!frontier.ok) {
          throw frontier.error;
        }
        const prepared = retainedReplay(begun.value.record, frontier.value);
        if (!prepared.ok) {
          throw prepared.error;
        }
        const rendered = yield* canonical(begun.value.database, prepared.value.root, [
          ...prepared.value.installations,
        ]);
        const settled = yield* transitions.settle(lock, {
          executionId: begun.value.execution.executionId,
          status: "completed",
        });
        if (!settled.ok) {
          throw settled.error;
        }
        return rendered;
      });
    });

    // Byte for byte, including the bundled component, from history alone.
    expect(replayed.output).toBe(live.output);
    expect(replayed.result.ok).toBe(true);

    const after = await ownerState(stub);
    expect(after.journal).toEqual(before.journal);
    expect(after.currentRootId).toBe(before.currentRootId);
    expect(after.published).toEqual(before.published);
    expect(after.answers).toEqual(before.answers);
    expect(after.run?.["status"]).toBe("completed");
    // The stale envelope closed and one replay envelope opened and closed.
    expect(after.executions).toBe(2);
    expect(await on(stub, (owner) => owner.holders())).toBe(0);
  });

  it("recovers a run whose committed document result is a failure to failed", async () => {
    const stub = executor();
    const host = lifecycleHost(stub);

    // The document failed and the connection went before anything settled. The
    // coroutine returned, so its own settlement is `ok`; what it returned says
    // the document failed, and that is what the run is.
    const live = await run(function* (): Operation<Rendered> {
      return yield* scoped(function* () {
        const transitions: WorkflowExecutionTransitions = yield* useRemoteLifecycle(host);
        const lock = yield* acquired();
        const begun = yield* transitions.begin(lock, {
          runId: RUN_ID,
          action: "start",
          creation: CREATION,
        });
        if (!begun.ok) {
          throw begun.error;
        }
        return yield* canonical(begun.value.database, retainedSource("README.md", FAILING), [
          runContract(),
        ]);
      });
    });

    expect(live.result.ok).toBe(false);
    expect(live.output).toContain("partial line.");
    const before = await ownerState(stub);
    expect(before.run?.["status"]).toBe("running");

    const replayed = await run(function* (): Operation<Rendered> {
      return yield* scoped(function* () {
        const transitions: WorkflowExecutionTransitions = yield* useRemoteLifecycle(host);
        const lock = yield* acquired();
        // A resume is what the settled lifecycle refuses for a failed run, so
        // the run is named again by the compatible start it was created with.
        const begun = yield* transitions.begin(lock, {
          runId: RUN_ID,
          action: "start",
          creation: CREATION,
        });
        if (!begun.ok) {
          throw begun.error;
        }
        // The owner's own recovery read the document's result, not the
        // coroutine's settlement.
        expect(begun.value.record.status).toBe("failed");
        expect(begun.value.replay).toBe(true);
        const frontier = yield* begun.value.database.readJournalEntries();
        if (!frontier.ok) {
          throw frontier.error;
        }
        const prepared = retainedReplay(begun.value.record, frontier.value);
        if (!prepared.ok) {
          throw prepared.error;
        }
        const rendered = yield* canonical(begun.value.database, prepared.value.root, [
          ...prepared.value.installations,
        ]);
        const settled = yield* transitions.settle(lock, {
          executionId: begun.value.execution.executionId,
          status: "failed",
          reason: { kind: "host", code: DOCUMENT_FAILED },
        });
        if (!settled.ok) {
          throw settled.error;
        }
        return rendered;
      });
    });

    // The same failure and the same partial output, from history alone.
    expect(replayed.result.ok).toBe(false);
    expect(replayed.output).toBe(live.output);

    const recovered = await ownerState(stub);
    expect(recovered.run?.["status"]).toBe("failed");
    expect(recovered.journal).toEqual(before.journal);
    expect(recovered.currentRootId).toBe(before.currentRootId);
    expect(recovered.published).toEqual(before.published);
    expect(recovered.answers).toEqual(before.answers);
    expect(await on(stub, (owner) => owner.holders())).toBe(0);
  });

  it("refuses a lifecycle row its retained result contradicts, and moves nothing", async () => {
    const stub = executor();
    const host = lifecycleHost(stub);

    // A run whose journal records that its root ended by raising, settled as
    // though it had completed. The two cannot both be this run's outcome.
    await run(function* () {
      return yield* scoped(function* () {
        const transitions: WorkflowExecutionTransitions = yield* useRemoteLifecycle(host);
        const lock = yield* acquired();
        const begun = yield* transitions.begin(lock, {
          runId: RUN_ID,
          action: "start",
          creation: CREATION,
        });
        if (!begun.ok) {
          throw begun.error;
        }
        const { database } = begun.value;
        const appended = yield* database.transact(function* (transaction) {
          yield* transaction.journal.append({
            type: "yield",
            coroutineId: "root",
            description: { type: "import_component", name: "__root__" },
            result: {
              status: "ok",
              value: { kind: "repository", path: "README.md", content: DOCUMENT },
            },
          });
          // The members in the order the protocol's own parser rebuilds them.
          // The owner requires a proposed event to serialize back to the exact
          // bytes it was sent as, so a differently ordered record is refused
          // while the command is still being read.
          yield* transaction.journal.append({
            type: "close",
            coroutineId: "root",
            result: { status: "err", error: { message: "the executor died", name: "Error" } },
          });
        });
        if (!appended.ok) {
          throw appended.error;
        }
        const settled = yield* transitions.settle(lock, {
          executionId: begun.value.execution.executionId,
          status: "completed",
        });
        if (!settled.ok) {
          throw settled.error;
        }
      });
    });

    const before = await ownerState(stub);
    expect(before.run?.["status"]).toBe("completed");

    const refusal = await run(function* (): Operation<string> {
      return yield* scoped(function* () {
        const transitions: WorkflowExecutionTransitions = yield* useRemoteLifecycle(host);
        const lock = yield* acquired();
        const begun = yield* transitions.begin(lock, { runId: RUN_ID, action: "resume" });
        if (!begun.ok) {
          throw begun.error;
        }
        const frontier = yield* begun.value.database.readJournalEntries();
        if (!frontier.ok) {
          throw frontier.error;
        }
        const prepared = retainedReplay(begun.value.record, frontier.value);
        if (prepared.ok) {
          throw new Error("expected the contradictory retained state to be refused");
        }
        return prepared.error.message;
      });
    });

    expect(refusal).toContain("describe different outcomes");
    // Nothing this run holds moved, and no replacement outcome was published:
    // the one difference is the envelope the begin boundary had to insert, and
    // the settled recovery closes exactly that.
    const after = await ownerState(stub);
    expect(after.journal).toEqual(before.journal);
    expect(after.currentRootId).toBe(before.currentRootId);
    expect(after.published).toEqual(before.published);
    expect(after.answers).toEqual(before.answers);
    expect(after.run?.["status"]).toBe("completed");
    expect(after.executions).toBe(before.executions + 1);
    expect(await on(stub, (owner) => owner.holders())).toBe(0);
  });

  it("hands the run to the next connection when the replay's own ends", async () => {
    const stub = executor();
    const host = lifecycleHost(stub);

    await run(function* () {
      return yield* scoped(function* () {
        const transitions: WorkflowExecutionTransitions = yield* useRemoteLifecycle(host);
        const lock = yield* acquired();
        const begun = yield* transitions.begin(lock, {
          runId: RUN_ID,
          action: "start",
          creation: CREATION,
        });
        if (!begun.ok) {
          throw begun.error;
        }
        yield* canonical(begun.value.database, retainedSource("README.md", DOCUMENT), [
          retainedWorkflowInstallation({
            runId: RUN_ID,
            base: CREATION.base,
            pinnedCommit: COMMIT,
          }),
        ]);
        const settled = yield* transitions.settle(lock, {
          executionId: begun.value.execution.executionId,
          status: "completed",
        });
        if (!settled.ok) {
          throw settled.error;
        }
      });
    });

    const outcome = await run(function* () {
      const first = yield* scoped(function* () {
        yield* useRemoteLifecycle(host);
        const lock = yield* acquired();
        return lock.runId;
      });
      // The first acquisition is over. A replacement takes the run, which is
      // what "the connection is the acquisition" means when the replay ends.
      const second = yield* scoped(function* () {
        yield* useRemoteLifecycle(host);
        const taken = yield* WorkflowLifecycle.operations.acquireExecutor(RUN_ID);
        return taken.ok ? taken.value.kind : "refused";
      });
      return { first, second };
    });

    expect(outcome.first).toBe(RUN_ID);
    expect(outcome.second).toBe("acquired");
    // Nothing the first connection did outlives it, and the run is still the
    // completed run both acquisitions found.
    expect((await on(stub, (owner) => owner.runRow()))?.["status"]).toBe("completed");
    expect(await on(stub, (owner) => owner.holders())).toBe(0);
  });
});
