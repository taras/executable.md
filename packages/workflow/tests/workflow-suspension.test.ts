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
import {
  type DurableEvent,
  durableCall,
  type DurableStream,
  InMemoryStream,
  type Json,
} from "@executablemd/durable-streams";
import { collect, inlineSource, registerComponents } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { retainedWorkflowInstallation } from "../src/run.ts";
import type { WorkflowRun } from "../src/run.ts";
import { parseSuspensionRequest, WorkflowSuspensionRequestError } from "../src/suspension/api.ts";
import { SUSPENSION_REQUEST, suspendFor } from "../src/suspension/suspend.ts";
import { createSuspensionController } from "../src/deno/suspension.ts";
import type { SuspensionNotice } from "../src/deno/suspension.ts";

const RUN: WorkflowRun = Object.freeze({
  runId: "release-1.4",
  base: "main",
  pinnedCommit: "9fceb02d0ae598e95dc970b74767f19372d61af8",
});

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
function attempt(stream: DurableStream, body: () => Operation<unknown>): Operation<Attempt> {
  return scoped(function* () {
    const suspension = createSuspensionController();
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
    const stream = new InMemoryStream();

    const attempted = yield* attempt(stream, function* () {
      yield* suspendFor({ request: { kind: "approval" }, responseSchema: SCHEMA });
    });

    const published = requests(attempted.events);
    expect(published).toHaveLength(1);

    const description = published[0]?.type === "yield" ? published[0].description : undefined;
    expect(description?.name).toBe(attempted.notice?.suspensionId);
    expect(description?.suspensionId).toBe(attempted.notice?.suspensionId);
    expect(description?.request).toEqual({ kind: "approval" });
    expect(description?.responseSchema).toEqual(SCHEMA);

    // The controller was told what the document is waiting for, in full.
    expect(attempted.notice?.request.request).toEqual({ kind: "approval" });
    expect(attempted.notice?.request.responseSchema).toEqual(SCHEMA);
  });

  it("WS2: the same wait keeps its id on replay and appends nothing", function* () {
    const stream = new InMemoryStream();

    const first = yield* attempt(stream, function* () {
      yield* durableCall("prior", function* () {
        return "done";
      });
      yield* suspendFor({ request: { kind: "approval" }, responseSchema: SCHEMA });
    });

    // The retained history a resume starts from: everything the first execution
    // committed, with no root Close — the halt left none.
    const retained = yield* stream.readAll();
    expect(
      retained.filter((event) => event.type === "close" && event.coroutineId === "root"),
    ).toHaveLength(0);

    const resumed = yield* attempt(new InMemoryStream(retained), function* () {
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

  it("WS3: two waits in one procedure receive different ids", function* () {
    const stream = new InMemoryStream();
    const seen: string[] = [];

    yield* attempt(stream, function* () {
      // The first wait is entered and never returns, so the second is reached
      // by giving the first its own execution: the ids are what differ, and a
      // position is what makes them differ.
      yield* suspendFor({ request: { kind: "first" }, responseSchema: SCHEMA });
    });
    const firstEvents = yield* stream.readAll();
    for (const event of requests(firstEvents)) {
      if (event.type === "yield") {
        seen.push(String(event.description.name));
      }
    }

    const second = new InMemoryStream();
    yield* attempt(second, function* () {
      yield* durableCall("between", function* () {
        return "done";
      });
      yield* suspendFor({ request: { kind: "second" }, responseSchema: SCHEMA });
    });
    for (const event of requests(yield* second.readAll())) {
      if (event.type === "yield") {
        seen.push(String(event.description.name));
      }
    }

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("WS4: an unusable request or schema refuses before anything is published", function* () {
    for (const invalid of [
      { request: undefined, responseSchema: SCHEMA },
      { request: { kind: "approval" }, responseSchema: undefined },
      { request: { kind: "approval" }, responseSchema: [] },
      { request: { kind: "approval" }, responseSchema: "object" },
    ]) {
      expect(() => parseSuspensionRequest(invalid)).toThrow(WorkflowSuspensionRequestError);
    }

    // A request that is a well-typed `Json` and still cannot be retained: the
    // journal holds what `JSON.stringify` produces, and a cycle produces
    // nothing. This is the case a type cannot catch, which is why the operation
    // checks rather than trusting its own signature.
    const cyclic: Record<string, Json> = {};
    cyclic.self = cyclic;

    const stream = new InMemoryStream();
    const attempted = yield* attempt(stream, function* () {
      yield* suspendFor({ request: cyclic, responseSchema: SCHEMA });
    });

    // Refused before publication and before any notice: nothing was retained
    // and no wait was reported to an executor.
    expect(requests(attempted.events)).toHaveLength(0);
    expect(attempted.notice).toBeUndefined();
    expect(String(attempted.thrown)).toContain("JSON this run can store");
  });
});
