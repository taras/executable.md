/**
 * Answering a run on its real owner.
 *
 * The facts here are the ones only a Durable Object can settle: that a delivery
 * is one row written in one transaction and a refusal writes nothing at all,
 * that answering takes no acquisition and leaves a live executor's socket,
 * execution and lifecycle exactly where they were, and that spending the answer
 * and publishing the event that answers the wait are one transaction — so a
 * commit either leaves the row pending with no event, or consumed with exactly
 * one.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { serializeDurableEvent } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import type { ExecutorObject } from "./support/executor-object.ts";
import { POLICY, RUN_ID, VALID_CLAIMS } from "./support/executor-object.ts";
import { generateKeys, signToken, type TestKeys } from "./support/tokens.ts";
import { run, until, type Operation } from "effection";
import { sha256Hex } from "../../src/workspace/sha256.ts";
import {
  cloudflareDeliveryLink,
  type DeliveryAdmission,
} from "../../src/cloudflare/delivery-client.ts";
import { canonicalJson } from "../../src/storage/record.ts";

let unique = 0;
const NOW = 1_800_000_000;
let keys: TestKeys;

const SUSPENSION = "wait-1";
const REQUEST = { kind: "approval", release: "1.4" };
const SCHEMA = {
  type: "object",
  properties: { approved: { type: "boolean" }, note: { type: "string" } },
  required: ["approved"],
  additionalProperties: false,
};
const ANSWER = { approved: true };
const FINGERPRINT = sha256Hex(canonicalJson({ request: REQUEST, responseSchema: SCHEMA }));

/**
 * A synthetic credential, assembled at run time.
 *
 * Written out as a literal it would be rejected by push protection, and joining
 * the parts leaves the runtime value identical — so what the gate sees here is
 * exactly what it would see in a delivered answer.
 */
const CANARY = `ghp_${"abcdefghijklmnopqrstuvwxyz0123456789".slice(0, 36)}`;

beforeAll(async () => {
  keys = await generateKeys();
});

function executor() {
  unique += 1;
  return env.EXECUTOR.get(env.EXECUTOR.idFromName(`delivery-${unique}-${Math.random()}`));
}

async function on<T>(
  stub: ReturnType<typeof executor>,
  body: (instance: ExecutorObject) => T | Promise<T>,
): Promise<T> {
  return await runInDurableObject(stub, body);
}

async function token(): Promise<string> {
  return await signToken(keys, { ...VALID_CLAIMS, iat: NOW - 10, nbf: NOW - 10, exp: NOW + 600 });
}

/** One owner with its keys configured and one admitted executor connection. */
async function connected(stub: ReturnType<typeof executor>): Promise<void> {
  await on(stub, (owner) => owner.configure([{ kid: keys.kid, jwk: keys.publicJwk }], NOW));
  const presented = await token();
  const admitted = await on(stub, (owner) => owner.admitConnection({ token: presented }));
  expect(admitted).toBe("admitted");
}

function creation(): Record<string, unknown> {
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

/** Ask the delivery plane, with a correct admission unless one is supplied. */
async function deliver(
  stub: ReturnType<typeof executor>,
  body: Record<string, unknown> | string,
  admission: Partial<{ release: string | null; token: string | null; runId: string | null }> = {},
): Promise<Record<string, unknown>> {
  const presented = "token" in admission ? (admission.token ?? null) : await token();
  const named = {
    release: "release" in admission ? (admission.release ?? null) : POLICY.release,
    token: presented,
    runId: "runId" in admission ? (admission.runId ?? null) : RUN_ID,
  };
  const encoded = typeof body === "string" ? body : JSON.stringify(body);
  const answered = await on(stub, (owner) => owner.deliverRequest(named, encoded));
  return JSON.parse(answered);
}

function requestEvent(suspensionId = SUSPENSION): string {
  return serializeDurableEvent({
    type: "yield",
    coroutineId: "root",
    description: {
      type: "suspension_request",
      name: suspensionId,
      suspensionId,
      request: REQUEST,
      responseSchema: SCHEMA,
    },
    result: { status: "ok", value: null },
  });
}

function answerEvent(suspensionId = SUSPENSION, value: Json = ANSWER): string {
  return serializeDurableEvent({
    type: "yield",
    coroutineId: "root",
    description: { type: "suspension_answer", name: suspensionId, suspensionId },
    result: { status: "ok", value },
  });
}

/** What the owner's current frontier is, for a proposal to be built against. */
async function frontier(
  stub: ReturnType<typeof executor>,
): Promise<{ rootId: string; eventId: string | null }> {
  return await on(stub, (owner) => ({
    rootId: owner.currentRootId(),
    eventId: owner.journalRecords().at(-1)?.eventId ?? null,
  }));
}

/**
 * One run left suspended at one wait, with a live executor connection.
 *
 * The whole of what delivery reads: a run whose status is `suspended` and whose
 * stop reason names the retained request event it stopped on.
 */
async function suspended(
  stub: ReturnType<typeof executor>,
  suspensionId = SUSPENSION,
): Promise<string> {
  await connected(stub);
  const begun = await ask(stub, {
    id: "begin-1",
    command: "begin",
    runId: RUN_ID,
    action: "start",
    creation: creation(),
    retrieval: null,
    executionId: "execution-1",
  });
  expect(begun["outcome"]).toBe("performed");

  const at = await frontier(stub);
  const committed = await ask(stub, {
    id: "commit-1",
    command: "commit",
    expectedWorkspaceRootId: at.rootId,
    expectedJournalEventId: at.eventId,
    publication: null,
    mappings: [],
    events: [requestEvent(suspensionId)],
    answer: null,
  });
  expect(committed["outcome"]).toBe("performed");
  const decided = committed["value"];
  const minted =
    decided !== null && typeof decided === "object"
      ? Reflect.get(decided, "journalEventIds")
      : undefined;
  const eventId = Array.isArray(minted) ? String(minted[0]) : "";

  const settled = await ask(stub, {
    id: "settle-1",
    command: "settle",
    completion: {
      executionId: "execution-1",
      status: "suspended",
      reason: { kind: "journal", eventId },
    },
    expectedWorkspaceRootId: at.rootId,
  });
  expect(settled["outcome"]).toBe("performed");
  return eventId;
}

/**
 * One delivery, as it crosses.
 *
 * It carries the value and the gate decision and nothing else — there is no
 * lower operation that takes a value without them, which is the point.
 */
function delivery(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation: "deliver",
    suspensionId: SUSPENSION,
    answer: canonicalJson(ANSWER),
    secretDetection: true,
    ...overrides,
  };
}

/**
 * Resume the suspended run on a fresh acquisition, and hold the execution open.
 *
 * What a claim needs: an acquisition that began an execution the run has not
 * moved past. A settled execution and a bare admitted socket are both proved
 * elsewhere in this file to obtain nothing.
 */
async function resumed(
  stub: ReturnType<typeof executor>,
  executionId = "execution-2",
): Promise<void> {
  await on(stub, (owner) => owner.dropConnections());
  await connected(stub);
  const begun = await ask(stub, {
    id: `begin-${executionId}`,
    command: "begin",
    runId: RUN_ID,
    action: "resume",
    creation: null,
    retrieval: null,
    executionId,
  });
  expect(begun["outcome"]).toBe("performed");
}

describe("delivering an answer to a run's owner", () => {
  it("answers what the run is waiting at, and retains one value for it", async () => {
    const stub = executor();
    const eventId = await suspended(stub);

    const waiting = await deliver(stub, { operation: "wait", suspensionId: SUSPENSION });
    expect(waiting["outcome"]).toBe("performed");
    expect(waiting["value"]).toEqual({
      runId: RUN_ID,
      suspensionId: SUSPENSION,
      requestEventId: eventId,
      request: REQUEST,
      responseSchema: SCHEMA,
      requestFingerprint: FINGERPRINT,
    });

    const retained = await deliver(stub, delivery());
    expect(retained).toEqual({
      outcome: "performed",
      value: { runId: RUN_ID, suspensionId: SUSPENSION },
    });

    const rows = await on(stub, (owner) => owner.retainedAnswers());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["suspension_id"]).toBe(SUSPENSION);
    expect(rows[0]?.["request_event_id"]).toBe(eventId);
    expect(rows[0]?.["request_fingerprint"]).toBe(FINGERPRINT);
    expect(rows[0]?.["answer"]).toBe(canonicalJson(ANSWER));
    expect(rows[0]?.["state"]).toBe("pending");
    expect(rows[0]?.["consumed_at"]).toBe(null);
  });

  it("takes nothing, and leaves a live executor exactly where it was", async () => {
    const stub = executor();
    await suspended(stub);
    const before = await on(stub, (owner) => ({
      run: owner.runRow(),
      executions: owner.executionRows(),
      journal: owner.journalRecords(),
      root: owner.currentRootId(),
      holders: owner.holders(),
      acquisition: owner.acquisitionId(),
    }));

    expect(await deliver(stub, delivery())).toMatchObject({ outcome: "performed" });

    const after = await on(stub, (owner) => ({
      run: owner.runRow(),
      executions: owner.executionRows(),
      journal: owner.journalRecords(),
      root: owner.currentRootId(),
      holders: owner.holders(),
      acquisition: owner.acquisitionId(),
    }));
    // The whole run, unchanged: no execution, no event, no status, no root —
    // and the acquisition that was live is the same acquisition.
    expect(after).toEqual(before);
    // The executor can still act, which is what "took nothing" means.
    expect((await ask(stub, { id: "frontier-1", command: "frontier" }))["outcome"]).toBe(
      "performed",
    );
  });

  it("re-observes one decision when its answer was lost, and refuses a different one", async () => {
    const stub = executor();
    await suspended(stub);
    const first = await deliver(stub, delivery());

    // The same delivery again, after its answer never arrived.
    const again = await deliver(stub, delivery());
    expect(again).toEqual(first);
    expect(await on(stub, (owner) => owner.retainedAnswers())).toHaveLength(1);

    // A different value under the same wait is a second answer, not a retry.
    const conflicting = await deliver(
      stub,
      delivery({ answer: canonicalJson({ approved: false }) }),
    );
    expect(conflicting).toEqual({
      outcome: "refused",
      refusal: "command:duplicate-conflict",
    });
    const rows = await on(stub, (owner) => owner.retainedAnswers());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["answer"]).toBe(canonicalJson(ANSWER));
  });

  it("refuses everything it is not, and writes nothing on the way", async () => {
    const stub = executor();
    await suspended(stub);
    const before = await on(stub, (owner) => ({
      answers: owner.retainedAnswers(),
      journal: owner.journalRecords(),
      run: owner.runRow(),
    }));

    const refusals = {
      wrongWait: await deliver(stub, { operation: "wait", suspensionId: "wait-elsewhere" }),
      wrongRequest: await deliver(stub, delivery({ suspensionId: "wait-elsewhere" })),
      // A value the retained schema does not admit, offered on exactly the
      // authenticated surface a valid one is offered on.
      rejectedValue: await deliver(stub, delivery({ answer: canonicalJson({ approved: "yes" }) })),
      // The same surface, with content the credential gate matches.
      credential: await deliver(
        stub,
        delivery({ answer: canonicalJson({ approved: true, note: CANARY }) }),
      ),
      // The gate decision is a required member, so omitting it is not a way of
      // making it.
      ungated: await deliver(stub, {
        operation: "deliver",
        suspensionId: SUSPENSION,
        answer: canonicalJson(ANSWER),
      }),
      unknownOperation: await deliver(stub, { operation: "publish" }),
      malformed: await deliver(stub, "{"),
      // An unauthenticated request is refused before the run is named, so a
      // body naming nothing this owner holds still refuses for the token.
      unauthenticatedFirst: await deliver(stub, "{", { token: "not a token" }),
      unknownMember: await deliver(stub, { ...delivery(), extra: 1 }),
      uncanonical: await deliver(stub, delivery({ answer: '{"approved":true,"a":1}' })),
      oversized: await deliver(stub, delivery({ answer: canonicalJson("x".repeat(2_000_000)) })),
      // The token is deliberately unusable. If the release were checked after
      // it, the refusal would name the token rather than the build.
      badRelease: await deliver(stub, delivery(), {
        release: "other-build",
        token: "not a token",
      }),
      badToken: await deliver(stub, delivery(), { token: "not a token" }),
      wrongRun: await deliver(stub, delivery(), { runId: "9".repeat(52) }),
    };

    for (const [named, answered] of Object.entries(refusals)) {
      expect([named, answered["outcome"]]).toEqual([named, "refused"]);
    }
    expect(refusals.wrongWait["refusal"]).toBe("command:wrong-suspension");
    expect(refusals.wrongRequest["refusal"]).toBe("command:wrong-suspension");
    expect(refusals.rejectedValue["refusal"]).toBe("command:answer-rejected");
    expect(refusals.credential["refusal"]).toBe("command:credential-detected");
    expect(refusals.ungated["refusal"]).toBe("storage:corrupt");
    expect(refusals.badRelease["refusal"]).toBe("release:release-mismatch");
    expect(String(refusals.unauthenticatedFirst["refusal"]).startsWith("token:")).toBe(true);
    expect(refusals.wrongRun["refusal"]).toBe("command:wrong-run");
    // Byte for byte, row for row: a refusal is not a small write.
    expect(
      await on(stub, (owner) => ({
        answers: owner.retainedAnswers(),
        journal: owner.journalRecords(),
        run: owner.runRow(),
      })),
    ).toEqual(before);
  });

  it("refuses a run that is not waiting, and one that is not here", async () => {
    const running = executor();
    await connected(running);
    expect(
      (
        await ask(running, {
          id: "begin-1",
          command: "begin",
          runId: RUN_ID,
          action: "start",
          creation: creation(),
          retrieval: null,
          executionId: "execution-1",
        })
      )["outcome"],
    ).toBe("performed");
    expect(
      (await deliver(running, { operation: "wait", suspensionId: SUSPENSION }))["refusal"],
    ).toBe("command:not-suspended");

    const pristine = executor();
    await on(pristine, (owner) => owner.configure([{ kid: keys.kid, jwk: keys.publicJwk }], NOW));
    expect(
      (await deliver(pristine, { operation: "wait", suspensionId: SUSPENSION }))["refusal"],
    ).toBe("command:absent");
    // Naming an absent run creates nothing.
    expect(await on(pristine, (owner) => owner.hasWorkflowSchema())).toBe(false);
  });
});

describe("reaching the delivery plane through the production client", () => {
  it("asks what the run is waiting at and retains a value through the real link", async () => {
    const stub = executor();
    const eventId = await suspended(stub);
    const presented = await token();
    const sent: string[] = [];
    const link = cloudflareDeliveryLink(
      {
        *send(admission: DeliveryAdmission, body: string): Operation<string> {
          sent.push(body);
          return yield* until(
            on(stub, (owner) =>
              owner.deliverRequest(
                { release: admission.release, token: admission.token, runId: admission.runId },
                body,
              ),
            ),
          );
        },
      },
      {
        release: POLICY.release,
        // deno-lint-ignore require-yield
        *token(): Operation<string> {
          return presented;
        },
      },
    );

    const outcome = await run(function* () {
      const waiting = yield* link.wait(RUN_ID, SUSPENSION);
      if (!waiting.ok) {
        throw waiting.error;
      }
      const retained = yield* link.retain({
        runId: RUN_ID,
        suspensionId: SUSPENSION,
        answer: ANSWER,
        secretDetection: true,
      });
      if (!retained.ok) {
        throw retained.error;
      }
      return { waiting: waiting.value, retained: retained.value };
    });

    // The client read the owner's own account of the wait, and the owner
    // retained the value under exactly the identities that account named.
    expect(outcome.waiting).toEqual({
      runId: RUN_ID,
      suspensionId: SUSPENSION,
      requestEventId: eventId,
      request: REQUEST,
      responseSchema: SCHEMA,
      requestFingerprint: FINGERPRINT,
    });
    expect(outcome.retained).toEqual({ runId: RUN_ID, suspensionId: SUSPENSION });
    const rows = await on(stub, (owner) => owner.retainedAnswers());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["answer"]).toBe(canonicalJson(ANSWER));
    // Two requests, and neither of them opened a socket or named a command.
    expect(sent.map((body) => JSON.parse(body)["operation"])).toEqual(["wait", "deliver"]);
    expect(await on(stub, (owner) => owner.holders())).toBe(1);
  });

  it("reports an owner refusal without naming how the owner was reached", async () => {
    const stub = executor();
    await suspended(stub);
    const presented = await token();
    const link = cloudflareDeliveryLink(
      {
        *send(admission: DeliveryAdmission, body: string): Operation<string> {
          return yield* until(
            on(stub, (owner) =>
              owner.deliverRequest(
                { release: admission.release, token: admission.token, runId: admission.runId },
                body,
              ),
            ),
          );
        },
      },
      {
        release: POLICY.release,
        // deno-lint-ignore require-yield
        *token(): Operation<string> {
          return presented;
        },
      },
    );

    const refused = await run(function* () {
      return yield* link.wait(RUN_ID, "wait-elsewhere");
    });

    expect(refused.ok).toBe(false);
    const message = refused.ok === false ? refused.error.message : "";
    expect(message).not.toContain(presented);
    expect(message).not.toContain("deliverRequest");
  });
});

describe("spending a retained answer", () => {
  it("releases the value only to an acquisition holding the open execution", async () => {
    const stub = executor();
    const eventId = await suspended(stub);
    await deliver(stub, delivery());
    const claim = (id: string) => ({
      id,
      command: "answer",
      suspensionId: SUSPENSION,
      requestEventId: eventId,
    });

    // The socket that suspended the run is still admitted and its execution is
    // settled. It holds no execution, so it is told nothing.
    const settled = await ask(stub, claim("answer-settled"));
    expect(settled).toEqual({
      id: "answer-settled",
      outcome: "refused",
      refusal: "command:wrong-execution",
    });

    // A replacement acquisition that has begun nothing is in the same position.
    await on(stub, (owner) => owner.dropConnections());
    await connected(stub);
    const admitted = await ask(stub, claim("answer-admitted"));
    expect(admitted).toEqual({
      id: "answer-admitted",
      outcome: "refused",
      refusal: "command:wrong-execution",
    });

    // The execution that resumed the run is the one that may read it.
    await resumed(stub);
    const claiming = await ask(stub, claim("answer-open"));
    expect(claiming["outcome"]).toBe("performed");
    expect(claiming["value"]).toEqual({
      suspensionId: SUSPENSION,
      requestEventId: eventId,
      requestFingerprint: FINGERPRINT,
      answer: canonicalJson(ANSWER),
      state: "pending",
    });

    // And it may read only the wait this run is standing at, named by the
    // event that run published its request as.
    expect(
      (
        await ask(stub, {
          id: "answer-elsewhere",
          command: "answer",
          suspensionId: "wait-elsewhere",
          requestEventId: eventId,
        })
      )["refusal"],
    ).toBe("command:wrong-suspension");
    expect(
      (
        await ask(stub, {
          id: "answer-wrong-event",
          command: "answer",
          suspensionId: SUSPENSION,
          requestEventId: "event-elsewhere",
        })
      )["refusal"],
    ).toBe("command:wrong-suspension");
  });

  it("says nothing about a wait nothing was delivered to", async () => {
    const stub = executor();
    const eventId = await suspended(stub);
    await resumed(stub);

    // The wait exists and is the one this run is standing at; no value is
    // retained for it. That is nothing rather than a refusal.
    const answered = await ask(stub, {
      id: "answer-1",
      command: "answer",
      suspensionId: SUSPENSION,
      requestEventId: eventId,
    });

    expect(answered).toEqual({ id: "answer-1", outcome: "performed", value: null });
  });

  it("consumes the row and appends its event in one transaction", async () => {
    const stub = executor();
    const eventId = await suspended(stub);
    await deliver(stub, delivery());
    await resumed(stub);
    const at = await frontier(stub);

    const committed = await ask(stub, {
      id: "commit-answer",
      command: "commit",
      expectedWorkspaceRootId: at.rootId,
      expectedJournalEventId: at.eventId,
      publication: null,
      mappings: [],
      events: [answerEvent()],
      answer: {
        suspensionId: SUSPENSION,
        requestEventId: eventId,
        requestFingerprint: FINGERPRINT,
      },
    });

    expect(committed["outcome"]).toBe("performed");
    const rows = await on(stub, (owner) => owner.retainedAnswers());
    expect(rows[0]?.["state"]).toBe("consumed");
    expect(rows[0]?.["consumed_at"]).not.toBe(null);
    const journal = await on(stub, (owner) => owner.journalRecords());
    expect(journal.filter((entry) => entry.record === answerEvent())).toHaveLength(1);
  });

  it("spends nothing and appends nothing when the two do not agree", async () => {
    const stub = executor();
    const eventId = await suspended(stub);
    await deliver(stub, delivery());
    await resumed(stub);
    const at = await frontier(stub);
    const before = await on(stub, (owner) => ({
      answers: owner.retainedAnswers(),
      journal: owner.journalRecords(),
    }));

    const proposals = {
      // The event carries a different value from the one that was delivered.
      otherValue: {
        events: [answerEvent(SUSPENSION, { approved: false })],
        answer: {
          suspensionId: SUSPENSION,
          requestEventId: eventId,
          requestFingerprint: FINGERPRINT,
        },
      },
      // The consumption names a wait, and the event answers another one.
      otherWait: {
        events: [answerEvent("wait-2")],
        answer: {
          suspensionId: SUSPENSION,
          requestEventId: eventId,
          requestFingerprint: FINGERPRINT,
        },
      },
      // Nothing is published at all, and the row is asked to be spent anyway.
      noEvent: {
        events: [],
        answer: {
          suspensionId: SUSPENSION,
          requestEventId: eventId,
          requestFingerprint: FINGERPRINT,
        },
      },
      // The delivery this names is not the one the owner retained.
      otherRequest: {
        events: [answerEvent()],
        answer: {
          suspensionId: SUSPENSION,
          requestEventId: eventId,
          requestFingerprint: "c".repeat(64),
        },
      },
      // One matching answer event, and a second one for the same wait carrying
      // another value. One retained answer ends one wait.
      twoForOneWait: {
        events: [answerEvent(), answerEvent(SUSPENSION, { approved: false })],
        answer: {
          suspensionId: SUSPENSION,
          requestEventId: eventId,
          requestFingerprint: FINGERPRINT,
        },
      },
      // One matching answer event, and a second one for another wait entirely.
      twoForTwoWaits: {
        events: [answerEvent(), answerEvent("wait-2")],
        answer: {
          suspensionId: SUSPENSION,
          requestEventId: eventId,
          requestFingerprint: FINGERPRINT,
        },
      },
      // An answer event no consumption authorizes at all.
      unauthorized: { events: [answerEvent()], answer: null },
      // The same, for a wait nothing was ever delivered to.
      unauthorizedElsewhere: { events: [answerEvent("wait-2")], answer: null },
    };

    let attempt = 0;
    for (const [named, proposal] of Object.entries(proposals)) {
      attempt += 1;
      const refused = await ask(stub, {
        id: `spend-${attempt}`,
        command: "commit",
        expectedWorkspaceRootId: at.rootId,
        expectedJournalEventId: at.eventId,
        publication: null,
        mappings: [],
        ...proposal,
      });
      const expected =
        named === "twoForOneWait" ||
        named === "twoForTwoWaits" ||
        named === "unauthorized" ||
        named === "unauthorizedElsewhere" ||
        // A consumption with no answer event at all is the same violation seen
        // from the other side: nothing it spends would end anything.
        named === "noEvent"
          ? "command:answer-unauthorized"
          : "command:answer-unavailable";
      expect([named, refused["outcome"], refused["refusal"]]).toEqual([named, "refused", expected]);
    }

    // Neither half happened: the row is still pending and no event was kept.
    expect(
      await on(stub, (owner) => ({
        answers: owner.retainedAnswers(),
        journal: owner.journalRecords(),
      })),
    ).toEqual(before);
  });

  it("refuses a consumption from an acquisition that holds no open execution", async () => {
    const stub = executor();
    const eventId = await suspended(stub);
    await deliver(stub, delivery());
    const at = await frontier(stub);
    const before = await on(stub, (owner) => ({
      answers: owner.retainedAnswers(),
      journal: owner.journalRecords(),
    }));
    const spend = (id: string) => ({
      id,
      command: "commit",
      expectedWorkspaceRootId: at.rootId,
      expectedJournalEventId: at.eventId,
      publication: null,
      mappings: [],
      events: [answerEvent()],
      answer: {
        suspensionId: SUSPENSION,
        requestEventId: eventId,
        requestFingerprint: FINGERPRINT,
      },
    });

    // The acquisition that suspended the run: still admitted, execution
    // settled. A socket is not an execution.
    expect((await ask(stub, spend("spend-settled")))["refusal"]).toBe("command:wrong-execution");

    // A replacement acquisition that has begun nothing.
    await on(stub, (owner) => owner.dropConnections());
    await connected(stub);
    expect((await ask(stub, spend("spend-admitted")))["refusal"]).toBe("command:wrong-execution");

    expect(
      await on(stub, (owner) => ({
        answers: owner.retainedAnswers(),
        journal: owner.journalRecords(),
      })),
    ).toEqual(before);
  });

  it("refuses to spend an answer a second time", async () => {
    const stub = executor();
    const eventId = await suspended(stub);
    await deliver(stub, delivery());
    await resumed(stub);
    const at = await frontier(stub);
    const spend = (id: string, expected: string | null) => ({
      id,
      command: "commit",
      expectedWorkspaceRootId: at.rootId,
      expectedJournalEventId: expected,
      publication: null,
      mappings: [],
      events: [answerEvent()],
      answer: {
        suspensionId: SUSPENSION,
        requestEventId: eventId,
        requestFingerprint: FINGERPRINT,
      },
    });

    expect((await ask(stub, spend("spend-1", at.eventId)))["outcome"]).toBe("performed");
    const after = await frontier(stub);
    const again = await ask(stub, spend("spend-2", after.eventId));

    expect(again).toEqual({
      id: "spend-2",
      outcome: "refused",
      refusal: "command:answer-unavailable",
    });
    // One answer event, and the row spent once.
    const journal = await on(stub, (owner) => owner.journalRecords());
    expect(journal.filter((entry) => entry.record === answerEvent())).toHaveLength(1);
    expect((await on(stub, (owner) => owner.retainedAnswers()))[0]?.["state"]).toBe("consumed");
  });
});
