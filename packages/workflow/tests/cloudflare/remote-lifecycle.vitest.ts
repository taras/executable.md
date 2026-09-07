/**
 * A run's lifecycle on its real owner.
 *
 * The facts here are the ones only a Durable Object can settle: that a starting
 * begin reaches pristine storage and makes the whole run in one transaction,
 * that the acquisition which began an execution is the only one that can finish
 * it, that the association outlives eviction because it was written down, and
 * that a second live executor advances nothing at all.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { ExecutorObject } from "./support/executor-object.ts";
import { POLICY, RUN_ID, VALID_CLAIMS } from "./support/executor-object.ts";
import { generateKeys, signToken, type TestKeys } from "./support/tokens.ts";

let unique = 0;
const NOW = 1_800_000_000;
let keys: TestKeys;

beforeAll(async () => {
  keys = await generateKeys();
});

function executor() {
  unique += 1;
  return env.EXECUTOR.get(env.EXECUTOR.idFromName(`lifecycle-${unique}-${Math.random()}`));
}

function on<T>(
  stub: ReturnType<typeof executor>,
  body: (instance: ExecutorObject) => T,
): Promise<T> {
  return runInDurableObject(stub, body);
}

/** One owner with its keys configured and one admitted executor connection. */
async function connected(stub: ReturnType<typeof executor>): Promise<void> {
  await on(stub, (owner) => owner.configure([{ kid: keys.kid, jwk: keys.publicJwk }], NOW));
  const token = await signToken(keys, {
    ...VALID_CLAIMS,
    iat: NOW - 10,
    nbf: NOW - 10,
    exp: NOW + 600,
  });
  const admitted = await on(stub, (owner) => owner.admitConnection({ token }));
  expect(admitted).toBe("admitted");
}

function creation(runId = RUN_ID): Record<string, unknown> {
  return {
    runId,
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

/** Send one command as the connection admitted most recently. */
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

async function started(
  stub: ReturnType<typeof executor>,
  id: string,
  executionId: string,
): Promise<Record<string, unknown>> {
  return await ask(stub, {
    id,
    command: "begin",
    runId: RUN_ID,
    action: "start",
    creation: creation(),
    retrieval: null,
    executionId,
  });
}

describe("a run's lifecycle on its owner", () => {
  it("makes the whole run on pristine storage, in one begin", async () => {
    const stub = executor();
    await connected(stub);

    const before = await on(stub, (owner) => owner.objectCount());
    const answered = await started(stub, "command-1", "execution-1");

    expect(answered["outcome"]).toBe("performed");
    // Everything a run owns appeared together: the schema, the marker, the run
    // record, its starting Workspace, the first execution and `running`.
    expect(before).toBe(0);
    const state = await on(stub, (owner) => ({
      run: owner.runRow(),
      executions: owner.executionRows(),
      schema: owner.hasWorkflowSchema(),
    }));
    expect(state.schema).toBe(true);
    expect(state.run?.["status"]).toBe("running");
    expect(state.executions).toHaveLength(1);
    expect(state.executions[0]?.["execution_id"]).toBe("execution-1");
  });

  it("refuses a second live executor, and that executor advances nothing", async () => {
    const stub = executor();
    await connected(stub);
    await started(stub, "command-1", "execution-1");
    const before = await on(stub, (owner) => owner.runRow());

    const token = await signToken(keys, {
      ...VALID_CLAIMS,
      iat: NOW - 10,
      nbf: NOW - 10,
      exp: NOW + 600,
    });
    const second = await on(stub, (owner) => owner.admitConnection({ token }));

    expect(second).toBe("acquisition:already-running");
    expect(await on(stub, (owner) => owner.runRow())).toEqual(before);
    expect(await on(stub, (owner) => owner.holders())).toBe(1);
  });

  it("lets only the acquisition that began an execution settle it", async () => {
    const stub = executor();
    await connected(stub);
    await started(stub, "command-1", "execution-1");
    const root = await on(stub, (owner) => owner.currentRootId());

    const foreign = await ask(stub, {
      id: "command-2",
      command: "settle",
      completion: { executionId: "execution-elsewhere", status: "completed" },
      expectedWorkspaceRootId: root,
    });
    expect(foreign).toEqual({
      id: "command-2",
      outcome: "refused",
      refusal: "command:wrong-execution",
    });

    const settled = await ask(stub, {
      id: "command-3",
      command: "settle",
      completion: { executionId: "execution-1", status: "completed" },
      expectedWorkspaceRootId: root,
    });
    expect(settled["outcome"]).toBe("performed");
    expect((await on(stub, (owner) => owner.runRow()))?.["status"]).toBe("completed");
  });

  it("holds the association where an evicted object can still find it", async () => {
    const stub = executor();
    await connected(stub);
    await started(stub, "command-1", "execution-1");

    // Nothing in memory survives eviction; what the settlement is checked
    // against has to be retained, so this proves it was.
    const held = await on(stub, (owner) => owner.heldExecutions());
    expect(held).toHaveLength(1);
    expect(held[0]?.["execution_id"]).toBe("execution-1");
  });

  it("begins one execution per acquisition", async () => {
    const stub = executor();
    await connected(stub);
    await started(stub, "command-1", "execution-1");

    const again = await ask(stub, {
      id: "command-2",
      command: "begin",
      runId: RUN_ID,
      action: "resume",
      creation: null,
      retrieval: null,
      executionId: "execution-2",
    });

    expect(again).toEqual({
      id: "command-2",
      outcome: "refused",
      refusal: "command:duplicate-conflict",
    });
    expect(await on(stub, (owner) => owner.executionRows())).toHaveLength(1);
  });

  it("answers a repeated command with the decision it already made", async () => {
    const stub = executor();
    await connected(stub);
    const first = await started(stub, "command-1", "execution-1");
    const again = await started(stub, "command-1", "execution-1");

    expect(again).toEqual(first);
    // One execution, not two: the retry found the decision rather than
    // applying it a second time.
    expect(await on(stub, (owner) => owner.executionRows())).toHaveLength(1);
  });

  it("refuses a repeat that carries different content", async () => {
    const stub = executor();
    await connected(stub);
    await started(stub, "command-1", "execution-1");

    const changed = await ask(stub, {
      id: "command-1",
      command: "begin",
      runId: RUN_ID,
      action: "start",
      creation: creation(),
      retrieval: null,
      executionId: "execution-2",
    });

    expect(changed["refusal"]).toBe("command:duplicate-conflict");
  });

  it("closes what a lost executor left, before the next one begins", async () => {
    const stub = executor();
    await connected(stub);
    await started(stub, "command-1", "execution-1");

    // The connection is gone; nothing about time says so, and nothing needs to.
    await on(stub, (owner) => owner.dropConnections());
    await connected(stub);
    const resumed = await ask(stub, {
      id: "command-2",
      command: "begin",
      runId: RUN_ID,
      action: "resume",
      creation: null,
      retrieval: null,
      executionId: "execution-2",
    });

    expect(resumed["outcome"]).toBe("performed");
    const executions = await on(stub, (owner) => owner.executionRows());
    expect(executions).toHaveLength(2);
    // The stale one was finished as interrupted; the replacement is open.
    expect(executions[0]?.["stop_status"]).toBe("interrupted");
    expect(executions[1]?.["stopped_at"]).toBe(null);
  });

  it("cancels a run without beginning anything, and stays cancelled", async () => {
    const stub = executor();
    await connected(stub);
    await started(stub, "command-1", "execution-1");
    await on(stub, (owner) => owner.dropConnections());
    await connected(stub);

    const cancelled = await ask(stub, { id: "command-2", command: "cancel", runId: RUN_ID });
    expect(cancelled["outcome"]).toBe("performed");

    const state = await on(stub, (owner) => ({
      run: owner.runRow(),
      executions: owner.executionRows(),
    }));
    expect(state.run?.["status"]).toBe("cancelled");
    // Cancelling begins nothing. The one execution is the one the lost
    // executor left, closed as interrupted by the recovery that ran first —
    // cancelling the run does not rewrite what that execution became.
    expect(state.executions).toHaveLength(1);
    expect(state.executions[0]?.["stop_status"]).toBe("interrupted");
  });

  it("writes the retrieval a start carried, with the run it creates", async () => {
    const stub = executor();
    await connected(stub);

    const answered = await ask(stub, {
      id: "command-1",
      command: "begin",
      runId: RUN_ID,
      action: "start",
      creation: creation(),
      retrieval: { kind: "git", remote: "origin" },
      executionId: "execution-1",
    });

    expect(answered["outcome"]).toBe("performed");
    const retrieval = await on(stub, (owner) => owner.retrieval());
    // Revision one, written in the transaction that made the run.
    expect(retrieval?.["revision"]).toBe(1);
    expect(JSON.parse(String(retrieval?.["metadata"]))).toEqual({
      kind: "git",
      remote: "origin",
    });
  });

  it("writes no retrieval row when a start carries none", async () => {
    const stub = executor();
    await connected(stub);
    await started(stub, "command-1", "execution-1");

    expect(await on(stub, (owner) => owner.retrieval())).toBe(null);
  });

  it("refuses a retrieval nothing is being created for, and one too large", async () => {
    const stub = executor();
    await connected(stub);

    // A resume creates nothing, so there is nothing for a retrieval to belong
    // to. Carrying one is a request this build does not answer.
    const orphan = await ask(stub, {
      id: "command-1",
      command: "begin",
      runId: RUN_ID,
      action: "resume",
      creation: null,
      retrieval: { kind: "git" },
      executionId: "execution-1",
    });
    // Refused while the command was still being read, so the answer names no
    // command at all.
    expect(orphan).toEqual({ id: "", outcome: "refused", refusal: "command:malformed-member" });

    const huge = await ask(stub, {
      id: "command-2",
      command: "begin",
      runId: RUN_ID,
      action: "start",
      creation: creation(),
      retrieval: { remote: "x".repeat(2 * 1024 * 1024) },
      executionId: "execution-1",
    });
    expect(huge["outcome"]).toBe("refused");

    // Neither one made anything.
    expect(await on(stub, (owner) => owner.hasWorkflowSchema())).toBe(false);
  });

  it("leaves an existing run's retrieval alone when it is taken up again", async () => {
    const stub = executor();
    await connected(stub);
    await ask(stub, {
      id: "command-1",
      command: "begin",
      runId: RUN_ID,
      action: "start",
      creation: creation(),
      retrieval: { kind: "git", remote: "origin" },
      executionId: "execution-1",
    });
    await on(stub, (owner) => owner.dropConnections());
    await connected(stub);

    await ask(stub, {
      id: "command-2",
      command: "begin",
      runId: RUN_ID,
      action: "resume",
      creation: null,
      retrieval: null,
      executionId: "execution-2",
    });

    const retrieval = await on(stub, (owner) => owner.retrieval());
    // Replaceable state, not identity: a resume neither compares it nor
    // clears it.
    expect(retrieval?.["revision"]).toBe(1);
  });

  it("hands a replacement acquisition the execution a lost answer began", async () => {
    const stub = executor();
    await connected(stub);
    const first = await started(stub, "command-1", "execution-1");
    expect(first["outcome"]).toBe("performed");

    // The answer never arrived and the connection died. The replacement asks
    // the same question, with the same identity.
    await on(stub, (owner) => owner.dropConnections());
    await connected(stub);
    const again = await started(stub, "command-1", "execution-1");

    expect(again).toEqual(first);
    // One execution, and it is this acquisition's to settle now.
    expect(await on(stub, (owner) => owner.executionRows())).toHaveLength(1);
    const held = await on(stub, (owner) => owner.heldExecutions());
    expect(held).toHaveLength(1);
    expect(held[0]?.["execution_id"]).toBe("execution-1");

    const root = await on(stub, (owner) => owner.currentRootId());
    const settled = await ask(stub, {
      id: "command-3",
      command: "settle",
      completion: { executionId: "execution-1", status: "completed" },
      expectedWorkspaceRootId: root,
    });
    expect(settled["outcome"]).toBe("performed");
  });

  it("refuses a retained decision the run has already moved past", async () => {
    const stub = executor();
    await connected(stub);
    // One executor begins and loses its answer.
    expect((await started(stub, "command-1", "execution-1"))["outcome"]).toBe("performed");

    // Another takes the run, recovers that execution and begins its own.
    await on(stub, (owner) => owner.dropConnections());
    await connected(stub);
    const recovered = await ask(stub, {
      id: "command-2",
      command: "begin",
      runId: RUN_ID,
      action: "resume",
      creation: null,
      retrieval: null,
      executionId: "execution-2",
    });
    expect(recovered["outcome"]).toBe("performed");

    // The first executor retries its retained command under a later
    // acquisition. Its execution is closed, so it is history rather than
    // authority.
    await on(stub, (owner) => owner.dropConnections());
    await connected(stub);
    const retried = await started(stub, "command-1", "execution-1");

    expect(retried).toEqual({
      id: "command-1",
      outcome: "refused",
      refusal: "command:stale-journal",
    });
    // And it cannot settle what it did not keep.
    const root = await on(stub, (owner) => owner.currentRootId());
    const settled = await ask(stub, {
      id: "command-4",
      command: "settle",
      completion: { executionId: "execution-1", status: "completed" },
      expectedWorkspaceRootId: root,
    });
    expect(settled["refusal"]).toBe("command:wrong-execution");
    // Exactly one execution is open, and it is the recovering executor's.
    const executions = await on(stub, (owner) => owner.executionRows());
    expect(executions.filter((row) => row["stopped_at"] === null)).toHaveLength(1);
  });
});
