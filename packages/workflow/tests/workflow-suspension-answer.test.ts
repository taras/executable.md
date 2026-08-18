/**
 * Tier WA — delivering one typed value to one durable wait, and spending it.
 *
 * Two operations that must not be confused, proved against a real run in a real
 * file. **Delivery** happens while nothing is running: it judges a value against
 * the schema the wait retained, crosses the secret gate, and retains it. It
 * appends no journal event, begins no document execution and leaves the run
 * `suspended`. **Resume** is what spends it: the execution reaches the same
 * wait, publishes one durable answer event and consumes the retained value in
 * one transaction, and the document continues from the value.
 *
 * The claims worth stating carefully are the ones a weaker implementation would
 * also seem to satisfy. A value correlates to *this* wait and no other. A
 * refusal writes nothing at all. And the consume and the publication are one
 * transaction, so a failure between them leaves the answer pending rather than
 * a run whose history says it was answered and whose delivery state says it was
 * not.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { call, type Operation, race, scoped } from "effection";
import { DatabaseSync } from "node:sqlite";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { collect, inlineSource, registerComponents } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import type { Result } from "effection";
import { retainedWorkflowInstallation } from "../src/run.ts";
import { SUSPENSION_ANSWER, WorkflowInputDelivery, type WorkflowAnswerRetention } from "../mod.ts";
import { SUSPENSION_REQUEST, suspendFor } from "../src/suspension/suspend.ts";
import { createSuspensionController } from "../src/deno/suspension.ts";
import type { SuspensionNotice } from "../src/deno/suspension.ts";
import { useWorkflowInputDelivery } from "../src/deno/delivery.ts";
import { WorkflowLifecycle } from "../src/lifecycle/api.ts";
import {
  allowJournalInserts,
  creation,
  refuseJournalInsertNamed,
  runPath,
  tamper,
  useStorageRoot,
  withExecutorRun,
  withRunHost,
} from "./support/storage.ts";

const RUN_ID = "release-1.4";
const SCHEMA = {
  type: "object",
  properties: { approved: { type: "boolean" }, note: { type: "string" } },
  required: ["approved"],
  additionalProperties: false,
};
const REQUEST = { kind: "approval", release: "1.4" };
const ANSWER: Json = { approved: true };

/**
 * A synthetic credential, assembled at run time.
 *
 * Written out as a literal it would be rejected by push protection, and joining
 * the parts leaves the runtime value identical — so what the scanner sees here
 * is exactly what it would see in a delivered answer.
 */
const CANARY = `ghp_${"abcdefghijklmnopqrstuvwxyz0123456789".slice(0, 36)}`;

interface Attempted {
  readonly notice: SuspensionNotice | undefined;
  readonly returned: unknown;
  readonly thrown: unknown;
  readonly events: readonly DurableEvent[];
}

/**
 * Run the waiting document once against a real run, and settle what it did.
 *
 * The controller stands in for the executor, exactly as the CLI arranges it:
 * it observes a reported wait, `race` halts the execution around it, and the
 * run is settled `suspended` with a stop reason naming the retained request —
 * which is the state delivery reads. A run that did not wait is left alone.
 */
function attempt(
  root: string,
  action: "start" | "resume",
  body: () => Operation<unknown>,
  fault?: (path: string) => () => void,
): Operation<Attempted> {
  return withRunHost(root, function* (transitions) {
    return yield* withExecutorRun(
      transitions,
      action === "start"
        ? { runId: RUN_ID, action, creation: creation() }
        : { runId: RUN_ID, action },
      function* (begun, executorLock) {
        const { database } = begun;
        const suspension = createSuspensionController({ database });
        const stream = database.journal;
        let thrown: unknown;
        let returned: unknown;
        let notice: SuspensionNotice | undefined;

        yield* registerComponents([
          {
            name: "Probe",
            origin: "tier-wa",
            props: { type: "object", properties: {}, additionalProperties: false },
            *fn() {
              returned = yield* body();
              return "";
            },
          },
        ]);

        // Installed with the host already open, which is the only moment an
        // injected fault can exist: recognition refuses a database carrying an
        // object version 1 does not declare, so a fault that outlived the
        // execution would be read as damage rather than as the failure it is.
        const remove = fault?.(runPath(root, RUN_ID));

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

        remove?.();
        const events = yield* stream.readAll();

        // What the executor would publish: a reported wait settles `suspended`,
        // a document that finished settles `completed`, and an execution that
        // failed settles nothing at all — which is the process dying, and the
        // state a resume has to be able to continue from.
        if (notice === undefined && thrown === undefined) {
          const finished = yield* transitions.settle(executorLock, {
            executionId: begun.execution.executionId,
            status: "completed",
          });
          if (!finished.ok) {
            throw finished.error;
          }
        }

        if (notice !== undefined) {
          const entries = yield* database.readJournalEntries();
          const request = entries.ok
            ? entries.value.find(
                (entry) =>
                  entry.event.type === "yield" &&
                  entry.event.description.type === SUSPENSION_REQUEST &&
                  entry.event.description.name === notice?.suspensionId,
              )
            : undefined;
          const settled = yield* transitions.settle(executorLock, {
            executionId: begun.execution.executionId,
            status: "suspended",
            ...(request === undefined
              ? {}
              : { reason: { kind: "journal" as const, eventId: request.eventId } }),
          });
          if (!settled.ok) {
            throw settled.error;
          }
        }

        return { notice, returned, thrown, events };
      },
    );
  });
}

/** The document body every wait in this suite asks with. */
function waiting(): Operation<unknown> {
  return suspendFor({ request: REQUEST, responseSchema: SCHEMA });
}

/** One run left suspended at its wait, and the identity of that wait. */
function* suspendedRun(root: string): Operation<string> {
  const attempted = yield* attempt(root, "start", waiting);
  const id = attempted.notice?.suspensionId;
  if (id === undefined) {
    throw new Error("the fixture document did not reach a durable wait");
  }
  return id;
}

/** One delivery, through a provider installed for that call alone. */
function deliver(
  root: string,
  request: {
    runId?: string;
    suspensionId: string;
    value?: Json;
    secretDetection?: boolean;
  },
): Operation<Result<WorkflowAnswerRetention>> {
  return scoped(function* () {
    yield* useWorkflowInputDelivery({ root });
    return yield* WorkflowInputDelivery.operations.deliver({
      runId: request.runId ?? RUN_ID,
      suspensionId: request.suspensionId,
      value: request.value ?? ANSWER,
      secretDetection: request.secretDetection ?? true,
    });
  });
}

/** Every retained answer row, read the way something outside XMD would. */
function answerRows(root: string, runId = RUN_ID): Record<string, unknown>[] {
  const database = new DatabaseSync(runPath(root, runId));
  try {
    return database.prepare("SELECT * FROM workflow_suspension_answers").all();
  } catch {
    return [];
  } finally {
    database.close();
  }
}

/** What another connection can see of this run, right now. */
function runState(root: string, runId = RUN_ID): Record<string, unknown> {
  const database = new DatabaseSync(runPath(root, runId));
  try {
    return database.prepare("SELECT status, stop_reason_event_id FROM workflow_run").get() ?? {};
  } finally {
    database.close();
  }
}

function executionCount(root: string, runId = RUN_ID): number {
  const database = new DatabaseSync(runPath(root, runId));
  try {
    const row = database.prepare("SELECT count(*) AS total FROM document_executions").get();
    return Number(row?.["total"] ?? 0);
  } finally {
    database.close();
  }
}

function eventsOfType(events: readonly DurableEvent[], type: string): DurableEvent[] {
  return events.filter((event) => event.type === "yield" && event.description.type === type);
}

describe("Tier WA — a delivered answer, and the resume that spends it", () => {
  it("WA1: one value correlates to the exact wait it names", function* () {
    const root = yield* useStorageRoot();
    const id = yield* suspendedRun(root);

    const wrongWait = yield* deliver(root, { suspensionId: `${id}0` });
    expect(wrongWait.ok).toBe(false);
    expect(!wrongWait.ok && wrongWait.error.message).toContain("is not waiting at");
    expect(answerRows(root)).toEqual([]);

    const wrongRun = yield* deliver(root, { runId: "release-9.9", suspensionId: id });
    expect(wrongRun.ok).toBe(false);
    expect(!wrongRun.ok && wrongRun.error.name).toBe("WorkflowRunNotFoundError");
    expect(answerRows(root)).toEqual([]);

    const delivered = yield* deliver(root, { suspensionId: id });
    expect(delivered.ok).toBe(true);
    expect(delivered.ok && delivered.value).toEqual({ runId: RUN_ID, suspensionId: id });

    const rows = answerRows(root);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["suspension_id"]).toBe(id);
    expect(rows[0]?.["state"]).toBe("pending");
    expect(JSON.parse(String(rows[0]?.["answer"]))).toEqual(ANSWER);
  });

  it("WA2: a value the retained schema refuses is not retained", function* () {
    const root = yield* useStorageRoot();
    const id = yield* suspendedRun(root);

    const rejected: Json[] = [{ approved: "yes" }, { approved: true, extra: 1 }, {}, "approved"];
    for (const value of rejected) {
      const refused = yield* deliver(root, { suspensionId: id, value });
      expect(refused.ok).toBe(false);
      expect(!refused.ok && refused.error.message).toContain(
        "does not satisfy the response schema",
      );
      // Judged before persistence: the refusal wrote nothing.
      expect(answerRows(root)).toEqual([]);
    }

    // And the value the schema does describe still goes in afterwards, so the
    // refusals above left nothing behind that would block it.
    expect((yield* deliver(root, { suspensionId: id })).ok).toBe(true);
  });

  it("WA3: a credential-shaped answer crosses the gate, and only an explicit opt-out lets it past", function* () {
    const root = yield* useStorageRoot();
    const id = yield* suspendedRun(root);
    const value: Json = { approved: true, note: CANARY };

    const refused = yield* deliver(root, { suspensionId: id, value });
    expect(refused.ok).toBe(false);
    const message = !refused.ok ? refused.error.message : "";
    expect(message).toContain("secret detection matched it");
    // The account of the refusal, without the thing refused.
    expect(message).not.toContain(CANARY);
    expect(answerRows(root)).toEqual([]);

    const allowed = yield* deliver(root, { suspensionId: id, value, secretDetection: false });
    expect(allowed.ok).toBe(true);
    expect(JSON.parse(String(answerRows(root)[0]?.["answer"]))).toEqual(value);
  });

  it("WA4: delivery changes no status, no history and no execution record", function* () {
    const root = yield* useStorageRoot();
    const id = yield* suspendedRun(root);

    const before = runState(root);
    const executions = executionCount(root);
    const events = (yield* attemptEvents(root)).length;

    expect((yield* deliver(root, { suspensionId: id })).ok).toBe(true);

    expect(runState(root)).toEqual(before);
    expect(executionCount(root)).toBe(executions);
    expect((yield* attemptEvents(root)).length).toBe(events);
  });

  it("WA5: a run somebody else holds the executor lock for is still answerable", function* () {
    const root = yield* useStorageRoot();
    const id = yield* suspendedRun(root);

    const delivered = yield* withRunHost(root, function* () {
      return yield* scoped(function* () {
        // The lock a live workflow executor holds, taken through the real
        // registry and kept for the whole delivery.
        const acquired = yield* WorkflowLifecycle.operations.acquireExecutor(RUN_ID);
        expect(acquired.ok && acquired.value.kind).toBe("acquired");
        return yield* deliver(root, { suspensionId: id });
      });
    });

    expect(delivered.ok).toBe(true);
    expect(answerRows(root)).toHaveLength(1);
  });

  it("WA6: a duplicate, and an answer already spent, are both refused unchanged", function* () {
    const root = yield* useStorageRoot();
    const id = yield* suspendedRun(root);

    expect((yield* deliver(root, { suspensionId: id })).ok).toBe(true);

    const duplicate = yield* deliver(root, { suspensionId: id, value: { approved: false } });
    expect(duplicate.ok).toBe(false);
    expect(!duplicate.ok && duplicate.error.message).toContain("already has an answer waiting");
    expect(JSON.parse(String(answerRows(root)[0]?.["answer"]))).toEqual(ANSWER);

    // Spend it, then offer another. The wait is over, so there is nothing to
    // answer — the run is not suspended any more, and the row says why.
    const resumed = yield* attempt(root, "resume", waiting);
    expect(resumed.returned).toEqual(ANSWER);
    expect(answerRows(root)[0]?.["state"]).toBe("consumed");

    const late = yield* deliver(root, { suspensionId: id });
    expect(late.ok).toBe(false);
    expect(!late.ok && late.error.message).toContain("only a suspended run is waiting");
  });

  it("WA7: a run that is not waiting is refused, whatever state it is in", function* () {
    for (const terminal of ["completed", "cancelled"] as const) {
      const root = yield* useStorageRoot();
      const id = yield* suspendedRun(root);

      if (terminal === "cancelled") {
        yield* withRunHost(root, function* () {
          const cancelled = yield* WorkflowLifecycle.operations.cancel(RUN_ID);
          expect(cancelled.ok).toBe(true);
        });
      } else {
        // A resume that reaches no wait at all settles the run itself.
        yield* attempt(root, "resume", function* () {
          return "done";
        });
      }

      const refused = yield* deliver(root, { suspensionId: id });
      expect(refused.ok).toBe(false);
      expect(!refused.ok && refused.error.message).toContain("only a suspended run is waiting");
      expect(answerRows(root)).toEqual([]);
    }
  });

  it("WA8: a run nothing is stored for is reported rather than created", function* () {
    const root = yield* useStorageRoot();
    const refused = yield* deliver(root, { runId: "never-started", suspensionId: "a".repeat(32) });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error.name).toBe("WorkflowRunNotFoundError");
  });

  it("WA9: the resume publishes one answer event, consumes the delivery, and returns the value", function* () {
    const root = yield* useStorageRoot();
    const id = yield* suspendedRun(root);
    expect((yield* deliver(root, { suspensionId: id })).ok).toBe(true);

    const resumed = yield* attempt(root, "resume", waiting);

    // The document continued from the delivered value rather than waiting again.
    expect(resumed.returned).toEqual(ANSWER);
    expect(resumed.notice).toBeUndefined();

    // One request and one answer, both naming the same wait.
    expect(eventsOfType(resumed.events, SUSPENSION_REQUEST)).toHaveLength(1);
    const answers = eventsOfType(resumed.events, SUSPENSION_ANSWER);
    expect(answers).toHaveLength(1);
    const answer = answers[0];
    expect(answer?.type === "yield" && answer.description.name).toBe(id);
    expect(answer?.result.status).toBe("ok");
    expect(answer?.result.status === "ok" && answer.result.value).toEqual(ANSWER);

    const rows = answerRows(root);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["state"]).toBe("consumed");
    expect(rows[0]?.["consumed_at"]).toEqual(expect.any(String));
  });

  it("WA10: a resume replays a published answer without publishing or consuming again", function* () {
    const root = yield* useStorageRoot();
    const seen: unknown[] = [];
    const twoWaits = function* (): Operation<unknown> {
      seen.push(yield* suspendFor({ request: REQUEST, responseSchema: SCHEMA }));
      return yield* suspendFor({ request: { kind: "publish" }, responseSchema: SCHEMA });
    };

    const first = yield* attempt(root, "start", twoWaits);
    const firstWait = first.notice?.suspensionId ?? "";
    expect(firstWait).not.toBe("");
    expect(seen).toEqual([]);

    expect((yield* deliver(root, { suspensionId: firstWait })).ok).toBe(true);

    // The first wait ends with the delivered value and the procedure goes on to
    // the second one, so the run is still incomplete — which is what makes the
    // next resume a replay of an answered wait rather than of a finished run.
    const answered = yield* attempt(root, "resume", twoWaits);
    expect(seen).toEqual([ANSWER]);
    const secondWait = answered.notice?.suspensionId ?? "";
    expect(secondWait).not.toBe("");
    expect(secondWait).not.toBe(firstWait);
    expect(eventsOfType(answered.events, SUSPENSION_ANSWER)).toHaveLength(1);

    const consumedAt = answerRows(root)[0]?.["consumed_at"];
    expect(consumedAt).toEqual(expect.any(String));

    // Nothing is delivered for the second wait, so this resume replays the
    // first one's answer out of its retained event and stops at the second
    // again. The value comes back, and no second event and no second
    // consumption come with it.
    const replayed = yield* attempt(root, "resume", twoWaits);
    expect(seen).toEqual([ANSWER, ANSWER]);
    expect(replayed.notice?.suspensionId).toBe(secondWait);
    expect(eventsOfType(replayed.events, SUSPENSION_ANSWER)).toHaveLength(1);
    expect(answerRows(root)).toHaveLength(1);
    expect(answerRows(root)[0]?.["consumed_at"]).toEqual(consumedAt);
  });

  it("WA11: a failure before the publication commits leaves the answer pending", function* () {
    const root = yield* useStorageRoot();
    const id = yield* suspendedRun(root);
    expect((yield* deliver(root, { suspensionId: id })).ok).toBe(true);

    // The journal refuses the answer event, from inside SQLite, after the row
    // has been offered to it. Both halves of the claim are in one transaction,
    // so the consume goes back with it.
    const failed = yield* attempt(root, "resume", waiting, (path) => {
      refuseJournalInsertNamed(path, id);
      return () => allowJournalInserts(path);
    });

    expect(failed.returned).toBeUndefined();
    expect(eventsOfType(failed.events, SUSPENSION_ANSWER)).toHaveLength(0);
    // Still pending, and still the value that was delivered.
    expect(answerRows(root)[0]?.["state"]).toBe("pending");
    expect(answerRows(root)[0]?.["consumed_at"]).toBe(null);

    const recovered = yield* attempt(root, "resume", waiting);

    expect(recovered.returned).toEqual(ANSWER);
    expect(eventsOfType(recovered.events, SUSPENSION_ANSWER)).toHaveLength(1);
    expect(answerRows(root)[0]?.["state"]).toBe("consumed");
  });

  it("WA12: a consume that fails takes its publication back with it", function* () {
    const root = yield* useStorageRoot();
    const id = yield* suspendedRun(root);
    expect((yield* deliver(root, { suspensionId: id })).ok).toBe(true);

    // The other half of the same invariant: the event is appended first, so a
    // refusal here is the case where a two-write implementation would leave a
    // run whose history says it was answered and whose delivery state says it
    // was not.
    const failed = yield* attempt(root, "resume", waiting, (path) => {
      tamper(path, (database) => {
        database.exec(`
          CREATE TRIGGER refuse_consume BEFORE UPDATE ON workflow_suspension_answers
          BEGIN
            SELECT raise(ABORT, 'the retained answer refuses to be consumed');
          END
        `);
      });
      return () =>
        tamper(path, (database) => {
          database.exec("DROP TRIGGER IF EXISTS refuse_consume");
        });
    });

    expect(failed.returned).toBeUndefined();
    expect(eventsOfType(failed.events, SUSPENSION_ANSWER)).toHaveLength(0);
    expect(answerRows(root)[0]?.["state"]).toBe("pending");

    expect((yield* attempt(root, "resume", waiting)).returned).toEqual(ANSWER);
  });
});

/** The run's retained history, read through a host installation of its own. */
function attemptEvents(root: string): Operation<readonly DurableEvent[]> {
  return scoped(function* () {
    const database = new DatabaseSync(runPath(root, RUN_ID));
    try {
      const rows = database.prepare("SELECT record FROM journal_events ORDER BY sequence").all();
      return rows.map((row) => JSON.parse(String(row["record"])));
    } finally {
      database.close();
    }
  });
}
