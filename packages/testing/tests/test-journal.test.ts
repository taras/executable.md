/**
 * The shared failure-journal helper (#1169): an execution's journal stays in
 * memory and reaches its host once, only when the protected work fails, after
 * everything that can still append has unwound.
 */

import { describe, it, beforeAll } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, Err, Ok, resource, scoped, sleep, spawn, suspend, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import { timebox } from "@effectionx/timebox";
import { useStubFs } from "@executablemd/runtime/test";
import { execute, useTempFileCompiler } from "@executablemd/core";
import type { Json } from "@executablemd/core";
import { parseDurableEvent, serializeDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent, InMemoryStream } from "@executablemd/durable-streams";
import { useTesting } from "../src/use-testing.ts";
import { withFailureJournal } from "../src/failure-journal.ts";
import type { FailureJournalHost } from "../src/failure-journal.ts";

const PASSING = '<Test name="passes"><Assert expr={true} /></Test>\n';
const FAILING = '<Test name="fails"><Assert expr={false} /></Test>\n';

/** A host that records what it was asked to save, as the JSONL it would write. */
function recordingHost<T>(failed: (value: T) => boolean): {
  host: FailureJournalHost<T>;
  saves: string[];
  reported: Error[];
} {
  const saves: string[] = [];
  const reported: Error[] = [];
  return {
    saves,
    reported,
    host: {
      failed,
      // deno-lint-ignore require-yield
      *save(events) {
        saves.push(events.map(serializeDurableEvent).join(""));
      },
      // deno-lint-ignore require-yield
      *reportSaveFailure(error) {
        reported.push(error);
      },
    },
  };
}

/** The saved JSONL, read back through the durable parser. */
function parsed(jsonl: string): DurableEvent[] {
  return jsonl
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const event = parseDurableEvent(line);
      if (!event.ok) {
        throw event.error;
      }
      return event.value;
    });
}

/** Execute one document under a testing session against `stream`. */
function runTests(source: string, stream: InMemoryStream): Operation<Result<Json>> {
  return scoped(function* () {
    yield* useStubFs({ "README.md": source });
    yield* useTesting();
    const execution = yield* execute({ path: "README.md", stream });
    return yield* execution;
  });
}

const failedResult = (result: Result<unknown>) => !result.ok;

describe("withFailureJournal", () => {
  beforeAll(() => useTempFileCompiler());

  it("makes no persistence call when the execution and its assertions succeed", function* () {
    const { host, saves } = recordingHost(failedResult);
    let appended = 0;
    const result = yield* withFailureJournal(host, function* (stream) {
      const outcome = yield* runTests(PASSING, stream);
      appended = stream.appendCount;
      expect(outcome.ok).toBe(true);
      return outcome;
    });
    expect(result.ok).toBe(true);
    expect(appended).toBeGreaterThan(1);
    expect(saves).toEqual([]);
  });

  it("saves a returned failure once, with the events the execution recorded", function* () {
    const { host, saves } = recordingHost(failedResult);
    const result = yield* withFailureJournal(host, (stream) => runTests(FAILING, stream));
    expect(result.ok).toBe(false);
    expect(saves).toHaveLength(1);
    const events = parsed(saves[0]!);
    expect(events.some((event) => event.type === "close" && event.coroutineId === "root")).toBe(
      true,
    );
    expect(saves[0]).toContain('"test_result"');
  });

  it("saves the partial journal once when a timeout halts the protected work", function* () {
    const { host, saves } = recordingHost(failedResult);
    const boxed = yield* timebox(200, () =>
      withFailureJournal(host, function* (stream) {
        const outcome = yield* runTests(PASSING, stream);
        expect(outcome.ok).toBe(true);
        yield* suspend();
        return outcome;
      }),
    );
    expect(boxed.timeout).toBe(true);
    expect(saves).toHaveLength(1);
    expect(parsed(saves[0]!).length).toBeGreaterThan(1);
  });

  it("saves the journal of a successful document whose harness assertion then fails", function* () {
    const { host, saves } = recordingHost(failedResult);
    const assertion = new Error("the harness expected a different document");
    let caught: unknown;
    try {
      yield* withFailureJournal(host, function* (stream) {
        const outcome = yield* runTests(PASSING, stream);
        expect(outcome.ok).toBe(true);
        throw assertion;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(assertion);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toContain('"status":"pass"');
  });

  it("saves when owned teardown turns a successful document into a failure", function* () {
    const { host, saves } = recordingHost(failedResult);
    const teardown = new Error("a resource failed to release");
    let caught: unknown;
    try {
      yield* withFailureJournal(host, function* (stream) {
        yield* ensure(() => {
          throw teardown;
        });
        return yield* runTests(PASSING, stream);
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(teardown);
    expect(saves).toHaveLength(1);
  });

  it("joins teardown before saving a cancelled owner, including events teardown commits", function* () {
    const { host, saves } = recordingHost(failedResult);
    const gate = withResolvers<void>();
    let tearingDown = false;
    let continued = false;
    const TEARDOWN_EVENT: DurableEvent = {
      type: "yield",
      coroutineId: "root.teardown",
      description: { type: "call", name: "teardown-marker" },
      result: { status: "ok" },
    };
    const owner = yield* spawn(() =>
      withFailureJournal(host, function* (stream) {
        const outcome = yield* runTests(PASSING, stream);
        yield* resource<void>(function* (provide) {
          yield* ensure(function* () {
            tearingDown = true;
            yield* gate.operation;
            yield* stream.append(TEARDOWN_EVENT);
          });
          yield* provide();
        });
        yield* suspend();
        continued = true;
        return outcome;
      }),
    );
    yield* sleep(50);
    const halting = yield* spawn(() => owner.halt());
    while (!tearingDown) {
      yield* sleep(5);
    }
    expect(saves).toEqual([]);
    gate.resolve();
    yield* halting;
    expect(continued).toBe(false);
    expect(saves).toHaveLength(1);
    const events = parsed(saves[0]!);
    expect(events.at(-1)).toEqual(TEARDOWN_EVENT);
  });

  it("reports a failed save separately and keeps the original failure", function* () {
    const reported: Error[] = [];
    const refusal = new Error("the artifact directory is read-only");
    const host: FailureJournalHost<Result<Json>> = {
      failed: failedResult,
      // deno-lint-ignore require-yield
      *save() {
        throw refusal;
      },
      // deno-lint-ignore require-yield
      *reportSaveFailure(error) {
        reported.push(error);
      },
    };
    const result = yield* withFailureJournal(host, (stream) => runTests(FAILING, stream));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("1 of 1 tests failed");
    }
    expect(reported).toEqual([refusal]);

    const thrown = new Error("the harness assertion failed");
    let caught: unknown;
    try {
      yield* withFailureJournal({ ...host }, function* (stream) {
        yield* runTests(PASSING, stream);
        throw thrown;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(thrown);
    expect(reported).toEqual([refusal, refusal]);

    const unreported = yield* withFailureJournal(
      {
        ...host,
        // deno-lint-ignore require-yield
        *reportSaveFailure() {
          throw new Error("the reporter is gone too");
        },
      },
      (stream) => runTests(FAILING, stream),
    );
    expect(unreported.ok).toBe(false);
    if (!unreported.ok) {
      expect(unreported.error.message).toContain("1 of 1 tests failed");
    }
  });

  it("keeps a returned success that the host does not call failed", function* () {
    const { host, saves } = recordingHost<Result<string>>(failedResult);
    const value = yield* withFailureJournal(host, function* () {
      return Ok("nothing appended");
    });
    expect(value).toEqual(Ok("nothing appended"));
    const failure = yield* withFailureJournal(host, function* () {
      return Err(new Error("nothing appended either"));
    });
    expect(failure.ok).toBe(false);
    expect(saves).toEqual([]);
  });
});
