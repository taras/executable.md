/**
 * Tier WS — what a durable wait publishes, and what names it.
 *
 * A suspension has two halves, and this suite is about the provider-neutral
 * one: the request that reaches the journal, and the identity that lets a later
 * execution find the same wait. What the *executor* then does with a reported
 * wait — teardown, settlement, exit code, released lock — is the CLI's, and
 * Tier WFS proves that against real processes.
 *
 * The identity claim is the one worth stating carefully. A suspension ID is
 * derived from the run and the durable coroutine position, so it is stable for
 * the same wait across executions and different for two waits in one procedure.
 * Both halves are asserted: an identity that is only stable is one that
 * collides, and one that is only distinct is one no resume can find again.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { call, type Operation, race, scoped } from "effection";
import { type Api, createApi } from "@effectionx/context-api";
import { type DurableEvent, durableCall, type Json } from "@executablemd/durable-streams";
import { collect, inlineSource, registerComponents } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { retainedWorkflowInstallation } from "../src/run.ts";
import type { WorkflowRunDatabase } from "../src/storage/api.ts";
import { useStorageRoot, withBegunRun } from "./support/storage.ts";
import type { WorkflowRun } from "../src/run.ts";
import type { WorkflowSuspensionApi } from "../src/suspension/api.ts";
import { parseSuspensionRequest, WorkflowSuspensionRequestError } from "../src/suspension/api.ts";
import { SUSPENSION_REQUEST, suspendFor } from "../src/suspension/suspend.ts";
import { createSuspensionController } from "../src/deno/suspension.ts";
import type { SuspensionNotice } from "../src/deno/suspension.ts";

const RUN: WorkflowRun = Object.freeze({
  runId: "release-1.4",
  base: "main",
  pinnedCommit: "9fceb02d0ae598e95dc970b74767f19372d61af8",
});

/**
 * One begun run, whose journal is what a suspension is verified against.
 *
 * A real database rather than a stream in memory, because entering a wait now
 * asks the run what it retained — the authority is the retained request, so a
 * suite that stubbed the journal would be proving nothing about it.
 */
function withRun<T>(body: (database: WorkflowRunDatabase) => Operation<T>): Operation<T> {
  return scoped(function* () {
    const root = yield* useStorageRoot();
    return yield* withBegunRun(root, (run) => body(run.database), RUN.runId);
  });
}

const SCHEMA = { type: "object", properties: { approved: { type: "boolean" } } };

interface Attempt {
  readonly notice: SuspensionNotice | undefined;
  readonly events: DurableEvent[];
  readonly thrown: unknown;
}

/** Every `suspension_request` this stream retained, oldest first. */
function requests(events: DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === SUSPENSION_REQUEST,
  );
}

/**
 * Run one document body under a retained run, until it suspends or ends.
 *
 * The controller stands in for the executor: it observes the reported wait, and
 * `race` then halts the execution — which is what the real owner does. Halting
 * rather than waiting is what keeps this suite finite while still exercising an
 * operation that never returns.
 */
function attempt(
  database: WorkflowRunDatabase,
  body: () => Operation<unknown>,
): Operation<Attempt> {
  return scoped(function* () {
    const suspension = createSuspensionController({ database });
    const stream = database.journal;
    let thrown: unknown;
    let notice: SuspensionNotice | undefined;

    yield* registerComponents([
      {
        name: "Probe",
        origin: "tier-ws",
        props: { type: "object", properties: {}, additionalProperties: false },
        *fn() {
          yield* body();
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
                  retainedWorkflowInstallation(RUN),
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

    return { notice, events: yield* stream.readAll(), thrown };
  });
}

describe("Tier WS — a durable wait's request and identity", () => {
  it("WS1: publishes exactly one request carrying the id, request and schema", function* () {
    yield* withRun(function* (database) {
      const attempted = yield* attempt(database, function* () {
        yield* suspendFor({ request: { kind: "approval" }, responseSchema: SCHEMA });
      });

      const published = requests(attempted.events);
      expect(published).toHaveLength(1);

      const description = published[0]?.type === "yield" ? published[0].description : undefined;
      expect(description?.name).toBe(attempted.notice?.suspensionId);
      expect(description?.request).toEqual({ kind: "approval" });
      expect(description?.responseSchema).toEqual(SCHEMA);

      // The controller was told what the document is waiting for, in full.
      expect(attempted.notice?.request.request).toEqual({ kind: "approval" });
      expect(attempted.notice?.request.responseSchema).toEqual(SCHEMA);
    });
  });

  it("WS2: the same wait keeps its id on replay and appends nothing", function* () {
    yield* withRun(function* (database) {
      const first = yield* attempt(database, function* () {
        yield* durableCall("prior", function* () {
          return "done";
        });
        yield* suspendFor({ request: { kind: "approval" }, responseSchema: SCHEMA });
      });

      // The halt left the root open, which is what makes the run resumable.
      expect(
        first.events.filter((event) => event.type === "close" && event.coroutineId === "root"),
      ).toHaveLength(0);

      const resumed = yield* attempt(database, function* () {
        yield* durableCall("prior", function* () {
          throw new Error("a replayed effect performed itself again");
        });
        yield* suspendFor({ request: { kind: "approval" }, responseSchema: SCHEMA });
      });

      expect(resumed.notice?.suspensionId).toBe(first.notice?.suspensionId);

      // One request across both executions: the second restored it rather than
      // publishing a second one.
      expect(requests(resumed.events)).toHaveLength(1);
    });
  });

  it("WS3: two waits at different positions receive different ids", function* () {
    const seen: (string | undefined)[] = [];

    yield* withRun(function* (database) {
      const attempted = yield* attempt(database, function* () {
        yield* suspendFor({ request: { kind: "first" }, responseSchema: SCHEMA });
      });
      seen.push(attempted.notice?.suspensionId);
    });

    yield* withRun(function* (database) {
      const attempted = yield* attempt(database, function* () {
        yield* durableCall("between", function* () {
          return "done";
        });
        yield* suspendFor({ request: { kind: "second" }, responseSchema: SCHEMA });
      });
      seen.push(attempted.notice?.suspensionId);
    });

    // Same run id, different position: the identity is the position's.
    expect(seen[0]).toBeDefined();
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("WS4: an unretainable request refuses before anything is published", function* () {
    for (const invalid of [
      { request: undefined, responseSchema: SCHEMA },
      { request: { kind: "approval" }, responseSchema: undefined },
      { request: { kind: "approval" }, responseSchema: [] },
      { request: { kind: "approval" }, responseSchema: "object" },
    ]) {
      expect(() => parseSuspensionRequest(invalid)).toThrow(WorkflowSuspensionRequestError);
    }

    yield* withRun(function* (database) {
      // A request that is a well-typed `Json` and still cannot be retained: the
      // journal holds what `JSON.stringify` produces, and a cycle produces
      // nothing. This is the case a type cannot catch.
      const cyclic: Record<string, Json> = {};
      cyclic.self = cyclic;

      const attempted = yield* attempt(database, function* () {
        yield* suspendFor({ request: cyclic, responseSchema: SCHEMA });
      });

      expect(requests(attempted.events)).toHaveLength(0);
      expect(attempted.notice).toBeUndefined();
      expect(String(attempted.thrown)).toContain("JSON this run can store");
    });
  });

  it("WS5: reconstructing the provider's own name mints no authority", function* () {
    yield* withRun(function* (database) {
      // Document-side code that knows every public name: the API this provider
      // installs under, and the identifier shape it would want to claim.
      const Same: Api<WorkflowSuspensionApi> = createApi<WorkflowSuspensionApi>(
        "executablemd.workflow.suspension",
        {
          // deno-lint-ignore require-yield
          *enter(): Operation<Json> {
            throw new Error("unreachable");
          },
        },
      );

      const attempted = yield* attempt(database, function* () {
        yield* Same.operations.enter("an-identifier-this-caller-chose", {
          request: { kind: "approval" },
          responseSchema: SCHEMA,
        });
      });

      // Naming the provider reaches it. It refuses anyway, because what
      // authorizes a wait is the execution being at it — and this caller
      // published nothing and stands nowhere near one.
      expect(String(attempted.thrown)).toContain("not at that durable wait");
      expect(attempted.notice).toBeUndefined();
      expect(requests(attempted.events)).toHaveLength(0);
    });
  });

  it("WS6: a retained request does not authorize a caller standing before it", function* () {
    yield* withRun(function* (database) {
      const refusals: string[] = [];
      const reached: string[] = [];

      // Document-side code that knows the provider's name and the identifier the
      // wait ahead of it will have — on a resume it could read that identifier
      // straight out of the run's own retained history.
      function early(id: string): Operation<void> {
        return call(function* () {
          const Same: Api<WorkflowSuspensionApi> = createApi<WorkflowSuspensionApi>(
            "executablemd.workflow.suspension",
            {
              // deno-lint-ignore require-yield
              *enter(): Operation<Json> {
                throw new Error("unreachable");
              },
            },
          );
          try {
            yield* Same.operations.enter(id, {
              request: { kind: "approval" },
              responseSchema: SCHEMA,
            });
            refusals.push("accepted");
          } catch (error) {
            refusals.push(String(error).includes("not at that durable wait") ? "refused" : "other");
          }
        });
      }

      function procedure(id: string): () => Operation<unknown> {
        return function* () {
          // Attempted before the prior effect, so this call stands at a
          // position the wait ahead of it does not belong to.
          yield* early(id);
          yield* durableCall("prior", function* () {
            reached.push("performed-prior-effect");
            return "done";
          });
          yield* suspendFor({ request: { kind: "approval" }, responseSchema: SCHEMA });
        };
      }

      // First execution: the identifier is not retained yet, and the early call
      // is refused for standing in the wrong place rather than for guessing.
      const first = yield* attempt(database, procedure("an-identifier-not-yet-retained"));
      const id = first.notice?.suspensionId ?? "";
      expect(id).not.toBe("");
      expect(refusals).toEqual(["refused"]);

      // Resume: the request is retained now, and its exact identifier is what
      // the early call presents. It must still be refused — the row exists, but
      // this caller has not reached it.
      const resumed = yield* attempt(database, procedure(id));

      expect(refusals).toEqual(["refused", "refused"]);

      // Replay passed through the prior effect and the request, and the wait was
      // reported by the real `suspendFor()` with the same stable identity.
      expect(resumed.notice?.suspensionId).toBe(id);

      // Nothing was duplicated and nothing closed the root.
      expect(requests(resumed.events)).toHaveLength(1);
      expect(
        resumed.events.filter((event) => event.type === "close" && event.coroutineId === "root"),
      ).toHaveLength(0);
      expect(reached).toEqual(["performed-prior-effect"]);
    });
  });
});
