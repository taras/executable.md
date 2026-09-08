/**
 * Tier WAD — answering a durable wait on a run somebody else owns.
 *
 * Two halves that must not be confused, and neither is observable alone.
 * **Delivery** happens while nothing is running: it asks the owner what the run
 * is waiting at, judges the offered value against exactly that, crosses the
 * secret gate, and asks the owner to retain it. **The claim** is what spends
 * it: an execution standing at that same wait publishes one answer event and
 * enlists the consumption in the same transaction, and the value reaches the
 * document only once the owner has committed both.
 *
 * The owner-side facts — that the retention is one row written in one
 * transaction, that a refusal writes nothing, and that consuming and appending
 * commit together — are proved against a real Durable Object in
 * `tests/cloudflare/remote-delivery.vitest.ts`. These are the runner's half:
 * what is judged before anything is sent, what is sent, and what a claim
 * enlists.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { call, Err, Ok, type Operation, race, type Result, scoped } from "effection";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { serializeDurableEvent } from "@executablemd/durable-streams";
import { collect, inlineSource, prepareElicitation, registerComponents } from "@executablemd/core";
import type { JsonObject } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { retainedWorkflowInstallation } from "../src/run.ts";
import { installRemoteInputDelivery } from "../src/remote/delivery.ts";
import { installRemoteSuspensionAnswers } from "../src/remote/answers.ts";
import type {
  RemoteAnswerRetained,
  RemoteAnswerRetention,
  RemoteDeliveryLink,
  RemoteRetainedAnswer,
  RemoteRetainedWaitRecord,
} from "../src/remote/answer-link.ts";
import type { CommitIntent, StartingFrontier } from "../src/remote/collector.ts";
import type { CommitDecision } from "../src/remote/publication.ts";
import { useRemoteRunDatabase, type RemoteRunLink } from "../src/remote/database.ts";
import { routeRemoteRunJournal } from "../src/remote/journal-route.ts";
import type { RemoteFrontierSnapshot } from "../src/remote/read.ts";
import { WorkflowInputDelivery, type WorkflowAnswerRetention } from "../src/suspension/delivery.ts";
import { SUSPENSION_ANSWER, SUSPENSION_REQUEST } from "../src/suspension/effects.ts";
import { suspensionRequestFingerprint } from "../src/suspension/api.ts";
import { suspendFor } from "../src/suspension/suspend.ts";
import { createSuspensionController } from "../src/deno/suspension.ts";
import type { SuspensionNotice } from "../src/deno/suspension.ts";
import type { DefinitionRetrieval, DocumentExecutionRecord } from "../src/storage/record.ts";
import { establishJournalProvenance } from "@executablemd/durable-streams";

const RUN_ID = "release-1.4";
const SUSPENSION = "wait-1";
const REQUEST_EVENT = "event-request";
const SCHEMA = {
  type: "object",
  properties: { approved: { type: "boolean" }, note: { type: "string" } },
  required: ["approved"],
  additionalProperties: false,
};
const REQUEST = { kind: "approval", release: "1.4" };
const SECOND = { kind: "approval", release: "1.5" };
const ANSWER: Json = { approved: true };
const ROOT = "a".repeat(64);

/**
 * A synthetic credential, assembled at run time.
 *
 * Written out as a literal it would be rejected by push protection, and joining
 * the parts leaves the runtime value identical — so what the scanner sees here
 * is exactly what it would see in a delivered answer.
 */
const CANARY = `ghp_${"abcdefghijklmnopqrstuvwxyz0123456789".slice(0, 36)}`;

const FINGERPRINT = suspensionRequestFingerprint({ request: REQUEST, responseSchema: SCHEMA });

/** What one retained event describes, for events that describe anything. */
function describedType(event: DurableEvent): string {
  return event.type === "yield" ? event.description.type : event.type;
}

function waitRecord(overrides: Partial<RemoteRetainedWaitRecord> = {}): RemoteRetainedWaitRecord {
  return {
    runId: RUN_ID,
    suspensionId: SUSPENSION,
    requestEventId: REQUEST_EVENT,
    request: REQUEST,
    responseSchema: SCHEMA,
    requestFingerprint: FINGERPRINT,
    ...overrides,
  };
}

/** A scripted delivery plane, which records everything it was asked. */
function scriptedLink(
  script: {
    wait?: Result<RemoteRetainedWaitRecord>;
    retain?: Result<RemoteAnswerRetained>;
  } = {},
) {
  const asked: string[] = [];
  const retained: RemoteAnswerRetention[] = [];
  const link: RemoteDeliveryLink = {
    // deno-lint-ignore require-yield
    *wait(): Operation<Result<RemoteRetainedWaitRecord>> {
      asked.push("wait");
      return script.wait ?? Ok(waitRecord());
    },
    // deno-lint-ignore require-yield
    *retain(retention: RemoteAnswerRetention): Operation<Result<RemoteAnswerRetained>> {
      asked.push("retain");
      retained.push(retention);
      return script.retain ?? Ok({ runId: retention.runId, suspensionId: retention.suspensionId });
    },
  };
  return { link, asked, retained };
}

function delivered(
  link: RemoteDeliveryLink,
  request: { runId?: string; suspensionId?: string; value?: Json; secretDetection?: boolean } = {},
): Operation<Result<WorkflowAnswerRetention>> {
  return scoped(function* () {
    yield* installRemoteInputDelivery(link);
    return yield* WorkflowInputDelivery.operations.deliver({
      runId: request.runId ?? RUN_ID,
      suspensionId: request.suspensionId ?? SUSPENSION,
      value: request.value ?? ANSWER,
      secretDetection: request.secretDetection ?? true,
    });
  });
}

describe("delivering one typed value to a remote run", () => {
  it("judges the value against the wait the owner names, then retains it", function* () {
    const scripted = scriptedLink();
    const outcome = yield* delivered(scripted.link);

    expect([outcome.ok, outcome.ok === false && String(outcome.error)]).toEqual([true, false]);
    expect(outcome.ok && outcome.value).toEqual({ runId: RUN_ID, suspensionId: SUSPENSION });
    // The owner was asked what the run is waiting at before anything was sent
    // for retention, and the retention names what the value was judged against.
    expect(scripted.asked).toEqual(["wait", "retain"]);
    // The retention carries the value and the gate decision and nothing else.
    // There is no member saying the value was checked: the owner judges it.
    expect(scripted.retained[0]).toEqual({
      runId: RUN_ID,
      suspensionId: SUSPENSION,
      answer: ANSWER,
      secretDetection: true,
    });
  });

  it("refuses a value the retained schema does not admit, and retains nothing", function* () {
    const scripted = scriptedLink();
    const outcome = yield* delivered(scripted.link, { value: { approved: "yes" } });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error.message).toContain(
      "does not satisfy the response",
    );
    // Nothing crossed. A run must not hold a value it could never be given.
    expect(scripted.asked).toEqual(["wait"]);
  });

  it("refuses a credential without repeating it, and retains it when told to", function* () {
    const scanned = scriptedLink();
    const refused = yield* delivered(scanned.link, {
      value: { approved: true, note: CANARY },
    });

    expect(refused.ok).toBe(false);
    const message = refused.ok === false ? refused.error.message : "";
    expect(message).toContain("secret detection matched it");
    // Neither the value nor the match travels with the refusal.
    expect(message).not.toContain(CANARY);
    expect(scanned.asked).toEqual(["wait"]);

    // The explicit opt-out is the only way past the gate, and it retains the
    // value the caller offered.
    const opted = scriptedLink();
    const retained = yield* delivered(opted.link, {
      value: { approved: true, note: CANARY },
      secretDetection: false,
    });
    expect(retained.ok).toBe(true);
    expect(opted.retained[0]?.answer).toEqual({ approved: true, note: CANARY });
    // And the choice travels with it, because the owner applies the gate.
    expect(opted.retained[0]?.secretDetection).toBe(false);
  });

  it("refuses a request that is not one, before the owner is reached", function* () {
    const scripted = scriptedLink();
    const outcomes = yield* scoped(function* () {
      yield* installRemoteInputDelivery(scripted.link);
      return {
        empty: yield* WorkflowInputDelivery.operations.deliver({
          runId: "",
          suspensionId: SUSPENSION,
          value: ANSWER,
          secretDetection: true,
        }),
        unnamed: yield* WorkflowInputDelivery.operations.deliver({
          runId: RUN_ID,
          suspensionId: "",
          value: ANSWER,
          secretDetection: true,
        }),
      };
    });

    expect(outcomes.empty.ok).toBe(false);
    expect(outcomes.unnamed.ok).toBe(false);
    expect(scripted.asked).toEqual([]);
  });

  it("refuses an owner that answers about another wait", function* () {
    const scripted = scriptedLink({ wait: Ok(waitRecord({ suspensionId: "wait-2" })) });
    const outcome = yield* delivered(scripted.link);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error.message).toContain("a different wait");
    expect(scripted.asked).toEqual(["wait"]);
  });

  it("refuses an owner whose fingerprint is not the request it returned", function* () {
    const scripted = scriptedLink({
      wait: Ok(waitRecord({ requestFingerprint: "b".repeat(64) })),
    });
    const outcome = yield* delivered(scripted.link);

    expect(outcome.ok).toBe(false);
    // The value would have been judged against one request and retained against
    // another. Nothing is sent.
    expect(outcome.ok === false && outcome.error.message).toContain("a different request");
    expect(scripted.asked).toEqual(["wait"]);
  });

  it("refuses a retained request no wait could be answered for", function* () {
    const scripted = scriptedLink({ wait: Ok(waitRecord({ responseSchema: [] })) });
    const outcome = yield* delivered(scripted.link);

    expect(outcome.ok).toBe(false);
    expect(scripted.asked).toEqual(["wait"]);
  });

  it("reports what the owner refused, and nothing about how it was reached", function* () {
    const scripted = scriptedLink({ retain: Err(new Error("this run is not waiting")) });
    const outcome = yield* delivered(scripted.link);

    expect(outcome.ok).toBe(false);
    expect(scripted.asked).toEqual(["wait", "retain"]);
  });
});

describe("one judgment, wherever a response is judged", () => {
  /**
   * The cases the boundaries have to agree about.
   *
   * `multipleOf` is here because it is where the compiler this replaced and the
   * settled draft-07 judgment disagreed: `0.3` is a multiple of `0.1`, and the
   * value is now accepted everywhere rather than accepted at one boundary and
   * refused at another.
   */
  const cases: { name: string; schema: JsonObject; value: Json; admitted: boolean }[] = [
    { name: "a valid answer", schema: SCHEMA, value: ANSWER, admitted: true },
    {
      name: "an answer the schema does not admit",
      schema: SCHEMA,
      value: { approved: "yes" },
      admitted: false,
    },
    {
      name: "a non-representable step",
      schema: { type: "number", multipleOf: 0.1 },
      value: 0.3,
      admitted: true,
    },
    {
      name: "a self-contained reference",
      schema: {
        definitions: { flag: { type: "boolean" } },
        type: "object",
        properties: { approved: { $ref: "#/definitions/flag" } },
        required: ["approved"],
      },
      value: { approved: true },
      admitted: true,
    },
    {
      name: "a self-contained reference the value fails",
      schema: {
        definitions: { flag: { type: "boolean" } },
        type: "object",
        properties: { approved: { $ref: "#/definitions/flag" } },
        required: ["approved"],
      },
      value: { approved: "yes" },
      admitted: false,
    },
  ];

  it("reaches the same verdict through the document path and remote delivery", function* () {
    const verdicts: { name: string; document: boolean; remote: boolean }[] = [];
    for (const example of cases) {
      // What `<Elicit>` judges a provider's answer with, and what the local
      // host judges a delivered answer with: one prepared validator.
      const prepared = yield* prepareElicitation(example.schema, "workflow answer");
      const document = prepared.validator.judge(example.value).length === 0;

      // The remote delivery boundary, whole: a scripted owner returns the
      // retained wait and the production installer judges the value.
      const scripted = scriptedLink({
        wait: Ok(
          waitRecord({
            request: REQUEST,
            responseSchema: example.schema,
            requestFingerprint: suspensionRequestFingerprint({
              request: REQUEST,
              responseSchema: example.schema,
            }),
          }),
        ),
      });
      const outcome = yield* delivered(scripted.link, {
        value: example.value,
        secretDetection: false,
      });
      verdicts.push({ name: example.name, document, remote: outcome.ok });
    }

    expect(verdicts.filter((verdict) => verdict.document !== verdict.remote)).toEqual([]);
    expect(verdicts).toEqual(
      cases.map((example) => ({
        name: example.name,
        document: example.admitted,
        remote: example.admitted,
      })),
    );
  });

  /** One schema written as JSON, so every declared name survives. */
  function parsedSchema(text: string): JsonObject {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("the fixture schema is not an object");
    }
    const held: JsonObject = {};
    for (const name of Object.getOwnPropertyNames(parsed)) {
      held[name] = Reflect.get(parsed, name);
    }
    return held;
  }

  it("refuses a schema no answer can be judged against, before anything is sent", function* () {
    const unusable: JsonObject[] = [
      { type: "object", properties: { decision: { $ref: "other.json#/x" } } },
      // Parsed rather than written as a literal: an object literal takes
      // `__proto__` as the prototype and the key never exists.
      parsedSchema('{"type":"object","properties":{"__proto__":{"type":"string"}}}'),
      { type: "not-a-type" },
      { type: "object", nope: 1 },
      { $async: true, type: "object" },
    ];

    for (const schema of unusable) {
      const scripted = scriptedLink({
        wait: Ok(
          waitRecord({
            responseSchema: schema,
            requestFingerprint: suspensionRequestFingerprint({
              request: REQUEST,
              responseSchema: schema,
            }),
          }),
        ),
      });
      const outcome = yield* delivered(scripted.link, { secretDetection: false });
      expect([JSON.stringify(schema), outcome.ok, scripted.asked]).toEqual([
        JSON.stringify(schema),
        false,
        ["wait"],
      ]);
    }
  });
});

/**
 * One owner that retains what it is told, as the real protocol would.
 *
 * It keeps the journal the transaction commits, answers the frontier from it,
 * and records the intents it received — which is what a claim has to be judged
 * by, because what a claim does is propose one.
 */
function scriptedOwner(script: { pending?: RemoteRetainedAnswer | undefined } = {}) {
  const events: { eventId: string; event: DurableEvent }[] = [];
  const intents: CommitIntent[] = [];
  const asked: string[] = [];
  let minted = 0;
  let pending = script.pending;
  let refuse = false;

  const snapshot = (): RemoteFrontierSnapshot => ({
    record: {
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
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    retrieval: undefined,
    workspaceRootId: ROOT,
    journalEventId: events.at(-1)?.eventId ?? null,
    entries: events.map((entry) => ({
      eventId: entry.eventId,
      event: entry.event,
      workspaceRootId: ROOT,
    })),
  });

  const link: RemoteRunLink = {
    // deno-lint-ignore require-yield
    *frontier(): Operation<StartingFrontier> {
      const now = snapshot();
      return {
        workspaceRootId: now.workspaceRootId,
        journalEventId: now.journalEventId,
        events: now.entries.map((entry) => entry.event),
      };
    },
    // deno-lint-ignore require-yield
    *frontierSnapshot(): Operation<RemoteFrontierSnapshot> {
      return snapshot();
    },
    // deno-lint-ignore require-yield
    *pendingAnswer(suspensionId: string): Operation<Result<RemoteRetainedAnswer | undefined>> {
      asked.push(suspensionId);
      return Ok(pending?.suspensionId === suspensionId ? pending : undefined);
    },
    // deno-lint-ignore require-yield
    *commit(intent: CommitIntent): Operation<Result<CommitDecision>> {
      intents.push(intent);
      if (refuse) {
        return Err(new Error("this owner refused the proposal"));
      }
      // What the owner does with a consumption: it spends the row, in the same
      // transaction as the events, or neither.
      if (intent.answer !== null) {
        if (pending === undefined || pending.state !== "pending") {
          return Err(new Error("there is no retained answer to spend"));
        }
        pending = { ...pending, state: "consumed" };
      }
      const ids: string[] = [];
      for (const event of intent.events) {
        minted += 1;
        const eventId = `event-${minted}`;
        events.push({ eventId, event });
        ids.push(eventId);
      }
      return Ok({ workspaceRootId: ROOT, journalEventIds: ids });
    },
    // deno-lint-ignore require-yield
    *replaceRetrieval(): Operation<Result<DefinitionRetrieval | undefined>> {
      return Ok(undefined);
    },
    // deno-lint-ignore require-yield
    *readExecutions(): Operation<Result<DocumentExecutionRecord[]>> {
      return Ok([]);
    },
  };

  return {
    link,
    intents,
    events,
    asked,
    waits(): string[] {
      return events.flatMap((entry) =>
        describedType(entry.event) === SUSPENSION_REQUEST && entry.event.type === "yield"
          ? [String(entry.event.description.name ?? "")]
          : [],
      );
    },
    get pending(): RemoteRetainedAnswer | undefined {
      return pending;
    },
    deliver(answer: Json, suspensionId: string, fingerprint = FINGERPRINT): void {
      const request = events.find(
        (entry) =>
          describedType(entry.event) === SUSPENSION_REQUEST &&
          entry.event.type === "yield" &&
          entry.event.description.name === suspensionId,
      );
      pending = {
        suspensionId,
        requestEventId: request?.eventId ?? "",
        requestFingerprint: fingerprint,
        answer,
        state: "pending",
      };
    },
    refuseNext(): void {
      refuse = true;
    },
  };
}

interface Reached {
  readonly notice: SuspensionNotice | undefined;
  readonly returned: unknown;
  readonly thrown: unknown;
}

/**
 * Run the waiting document once against a remote run, and settle what it did.
 *
 * The production pieces: the real remote handle over the scripted owner, the
 * real routed journal and provenance, the real answer provider installed beside
 * them, and the real suspension controller standing in for the executor.
 */
function reach(owner: ReturnType<typeof scriptedOwner>): Operation<Reached> {
  return scoped(function* () {
    const database = yield* useRemoteRunDatabase(owner.link, yield* owner.link.frontierSnapshot());
    // The run's own journal underneath, so an append outside a transaction is
    // a journal-only commit to the owner rather than something kept locally.
    const stream = routeRemoteRunJournal(database, database.journal);
    const provenance = establishJournalProvenance(stream);
    yield* installRemoteSuspensionAnswers({ link: owner.link, database, provenance });

    const suspension = createSuspensionController({ database });
    let thrown: unknown;
    let returned: unknown;
    let notice: SuspensionNotice | undefined;

    yield* registerComponents([
      {
        name: "Probe",
        origin: "tier-wad",
        props: { type: "object", properties: {}, additionalProperties: false },
        // Two waits, so an answered one is behind a run that is still going.
        // A document with one wait completes the moment it is answered, and a
        // completed run replays nothing.
        *fn() {
          returned = yield* suspendFor({ request: REQUEST, responseSchema: SCHEMA });
          yield* suspendFor({ request: SECOND, responseSchema: SCHEMA });
          return "";
        },
      },
    ]);

    yield* race([
      call(function* (): Operation<void> {
        try {
          yield* suspension.own(
            call(function* (): Operation<void> {
              yield* collect(
                yield* executeInstalled({ ...inlineSource("<Probe />\n"), stream }, [
                  retainedWorkflowInstallation({
                    runId: RUN_ID,
                    base: "main",
                    pinnedCommit: "9fceb02d0ae598e95dc970b74767f19372d61af8",
                  }),
                ]),
              );
            }),
          );
        } catch (error) {
          thrown = error;
        }
      }),
      call(function* (): Operation<void> {
        notice = yield* suspension.notice;
      }),
    ]);

    return { notice, returned, thrown };
  });
}

describe("a remote run's answer claim", () => {
  it("waits when nothing is retained, and publishes no answer", function* () {
    const owner = scriptedOwner();
    const reached = yield* reach(owner);

    expect(reached.notice?.suspensionId).toBeDefined();
    expect(reached.returned).toBe(undefined);
    // One request event and nothing else. A wait nobody answered is a wait.
    const published = owner.events.map((entry) => describedType(entry.event));
    expect(published).toContain(SUSPENSION_REQUEST);
    expect(published).not.toContain(SUSPENSION_ANSWER);
    expect(owner.intents.every((intent) => intent.answer === null)).toBe(true);
  });

  it("spends the retained answer and publishes exactly one answer event", function* () {
    const owner = scriptedOwner();
    // One execution reaches the wait and stops; the value arrives afterwards.
    yield* reach(owner);
    const first = owner.waits()[0] ?? "";
    owner.deliver(ANSWER, first);

    const resumed = yield* reach(owner);

    // The document received the delivered value, and it received it from the
    // wait rather than from a handler — then went on to its next wait.
    expect(resumed.returned).toEqual(ANSWER);
    expect(resumed.notice?.suspensionId).toBeDefined();
    expect(resumed.notice?.suspensionId).not.toBe(first);
    // Exactly one answer event, behind the request it answers.
    const answers = owner.events.filter(
      (entry) => describedType(entry.event) === SUSPENSION_ANSWER,
    );
    expect(answers).toHaveLength(1);
    const answered = answers[0]?.event;
    expect(answered !== undefined && answered.type === "yield" && answered.description.name).toBe(
      first,
    );
    expect(answered !== undefined && answered.type === "yield" && answered.result).toEqual({
      status: "ok",
      value: ANSWER,
    });
    const positions = owner.events.map((entry) => describedType(entry.event));
    expect(positions.indexOf(SUSPENSION_ANSWER)).toBeGreaterThan(
      positions.indexOf(SUSPENSION_REQUEST),
    );

    // And the proposal that published it is the one that spent the row.
    const spending = owner.intents.filter((intent) => intent.answer !== null);
    expect(spending).toHaveLength(1);
    expect(spending[0]?.answer?.suspensionId).toBe(first);
    expect(spending[0]?.answer?.requestFingerprint).toBe(FINGERPRINT);
    expect(spending[0]?.events).toHaveLength(1);
    expect(spending[0]?.events.map((event) => serializeDurableEvent(event))).toEqual(
      answers.map((entry) => serializeDurableEvent(entry.event)),
    );
    expect(owner.pending?.state).toBe("consumed");
  });

  it("leaves the answer pending when the owner refuses the proposal", function* () {
    const owner = scriptedOwner();
    yield* reach(owner);
    owner.deliver(ANSWER, owner.waits()[0] ?? "");
    owner.refuseNext();

    const resumed = yield* reach(owner);

    // Nothing was returned to the document, nothing was published, and the
    // answer is still there to be spent by a later execution.
    expect(resumed.returned).toBe(undefined);
    expect(owner.pending?.state).toBe("pending");
    expect(
      owner.events.filter((entry) => describedType(entry.event) === SUSPENSION_ANSWER),
    ).toHaveLength(0);
  });

  it("does not claim an answer delivered against a different request", function* () {
    const owner = scriptedOwner();
    yield* reach(owner);
    owner.deliver(ANSWER, owner.waits()[0] ?? "", "c".repeat(64));

    const resumed = yield* reach(owner);

    // The wait is reached and stays a wait: this value answers something else.
    expect(resumed.returned).toBe(undefined);
    expect(resumed.notice?.suspensionId).toBe(owner.waits()[0]);
    expect(owner.pending?.state).toBe("pending");
    expect(owner.intents.every((intent) => intent.answer === null)).toBe(true);
  });

  it("replays a published answer without reading or spending anything again", function* () {
    const owner = scriptedOwner();
    yield* reach(owner);
    const first = owner.waits()[0] ?? "";
    owner.deliver(ANSWER, first);
    yield* reach(owner);
    const published = owner.events.length;
    const asked = owner.asked.length;

    const replayed = yield* reach(owner);

    // The answer came back from the journal. Nothing was published, nothing
    // was spent, and the retained state was never asked about for that wait.
    expect(replayed.returned).toEqual(ANSWER);
    expect(owner.events).toHaveLength(published);
    expect(owner.intents.filter((intent) => intent.answer !== null)).toHaveLength(1);
    expect(owner.asked.slice(asked)).not.toContain(first);
  });
});
