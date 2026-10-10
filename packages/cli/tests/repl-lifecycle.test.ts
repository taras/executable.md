/**
 * Tier L — what this process is doing, element by element (#881 PR 2).
 *
 * Real sessions over a real stream, executing real entries. What is asserted
 * is the reading the session actually published while work was in flight —
 * collected from its own change stream, the way the screen consumes it — and
 * not a shape a fixture assembled. Every case also checks the two things an
 * observation must never do: change what executed, or outlive its entry.
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempFileCompiler } from "@executablemd/core";
import { InMemoryStream } from "@executablemd/durable-streams";
import { each, ensure, scoped, sleep, spawn } from "effection";
import type { Operation, Result } from "effection";

import { openReplSession } from "../src/repl/session.ts";
import type { ReplSession } from "../src/repl/session.ts";
import type { ReplExecution } from "../src/repl/journal.ts";
import type { ReplLifecycleReading, ReplOccurrence } from "../src/repl/lifecycle.ts";

function execution(): ReplExecution {
  return { id: "lifecycle", stream: new InMemoryStream([]) };
}

function opened(result: Result<ReplSession>): ReplSession {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function accepted(result: Result<void>): void {
  if (!result.ok) {
    throw result.error;
  }
}

/** Every reading one session published, in order. */
interface Watched {
  readonly readings: ReplLifecycleReading[];
  /** Every call of one element seen at any point, by key. */
  calls(name: string): ReplOccurrence[];
}

function watching(session: ReplSession): Operation<Watched> {
  return {
    *[Symbol.iterator]() {
      const readings: ReplLifecycleReading[] = [];
      yield* spawn(function* () {
        for (const reading of yield* each(session.lifecycleChanges)) {
          readings.push(reading);
          yield* each.next();
        }
      });
      return {
        readings,
        calls(name: string): ReplOccurrence[] {
          const byKey = new Map<string, ReplOccurrence>();
          for (const reading of readings) {
            for (const one of reading.occurrences) {
              if (one.name === name) {
                byKey.set(one.key, one);
              }
            }
          }
          return [...byKey.values()];
        },
      };
    },
  };
}

describe("Tier L — the reading one entry leaves behind", () => {
  beforeAll(() => useTempFileCompiler());

  it("L1: a repeated element is two calls, never one overwritten by the other", function* () {
    const session = opened(yield* openReplSession({ execution: execution() }));
    const watched = yield* watching(session);
    accepted(yield* session.submit('<Json value={1} as="a" />\n\n<Json value={2} as="b" />\n'));
    yield* session.join();
    yield* sleep(0);

    const seen = watched.calls("Json");
    expect(seen.length).toBe(2);
    expect(new Set(seen.map((one) => one.key)).size).toBe(2);
    // Both reached a terminal observation of their own.
    expect(seen.map((one) => one.phase).sort()).toEqual(["settled", "settled"]);
  });

  it("L1: a nested element is a child of the call that reached it", function* () {
    const session = opened(yield* openReplSession({ execution: execution() }));
    const watched = yield* watching(session);
    accepted(yield* session.submit('<Each in={[1, 2]} let="n"><Json value={n} /></Each>\n'));
    yield* session.join();
    yield* sleep(0);

    const outer = watched.calls("Each");
    const inner = watched.calls("Json");
    expect(outer.length).toBe(1);
    expect(inner.length).toBe(2);
    // Each iteration's element names the call it was reached through, and
    // the two iterations are separate calls rather than one id twice.
    for (const one of inner) {
      expect(one.parent).toBe(outer[0].key);
    }
    expect(new Set(inner.map((one) => one.key)).size).toBe(2);
  });

  it("L2: an element waiting on a question says so, and stops when it is answered", function* () {
    const session = opened(yield* openReplSession({ execution: execution() }));
    accepted(
      yield* session.submit(
        '<Elicit schema={{ type: "object", properties: { note: { type: "string" } }, ' +
          'required: ["note"], additionalProperties: false }} as="answer">Answer this.</Elicit>\n',
      ),
    );
    // Several turns: the phases a consumer is told travel through its own
    // queue, and the question itself is published from inside the element.
    for (let turn = 0; turn < 5; turn += 1) {
      yield* sleep(0);
    }

    const waiting = session.lifecycle.occurrences.filter((one) => one.waiting.length > 0);
    // The element that is waiting, what it is waiting on, and that it is
    // the only one: a session-wide "busy" would name every element here.
    expect(
      session.lifecycle.occurrences.map((one) => `${one.name}:${one.phase}:${one.waiting.join()}`),
    ).toEqual(["Elicit:active:question"]);
    expect(waiting.map((one) => one.name)).toEqual(["Elicit"]);

    const question = session.elicitation.pending;
    if (question === undefined) {
      throw new Error("this session is waiting on no question");
    }
    question.submit({ note: "answered" });
    yield* session.join();
    yield* sleep(0);
    // The entry closed, so its reading went with it.
    expect(session.lifecycle.occurrences).toEqual([]);
    expect(session.live).toBe(false);
  });

  it("L2: ordinary work is not a wait", function* () {
    const session = opened(yield* openReplSession({ execution: execution() }));
    const watched = yield* watching(session);
    accepted(yield* session.submit('<Json value={1} as="a" />\n'));
    yield* session.join();
    yield* sleep(0);

    const waited = watched.readings.flatMap((reading) =>
      reading.occurrences.filter((one) => one.waiting.length > 0),
    );
    expect(waited).toEqual([]);
  });

  it("L3: an entry that closes takes its reading, and says it is no longer live", function* () {
    const session = opened(yield* openReplSession({ execution: execution() }));
    accepted(yield* session.submit('<Json value={1} as="a" />\n'));
    yield* session.join();
    yield* sleep(0);

    expect(session.lifecycle.entry).toBe(undefined);
    expect(session.lifecycle.occurrences).toEqual([]);
    expect(session.live).toBe(false);
    // The entry really ran: the reading going is the reading going, not the
    // work never having happened.
    expect(session.model.entries.length).toBe(1);
    expect(session.model.entries[0]?.terminal?.status).toBe("ok");
  });

  it("L3: everything this entry held is released before the session says it is not live", function* () {
    // The frozen ordering, observed rather than read off the comment that
    // states it. An installation of this entry's own records, at the moment it
    // is released, what the session was still saying about itself. If the
    // liveness finalizer had been registered after the things this entry
    // acquires, it would run before them and this would read `false` — and a
    // reader woken then would be told the entry was over while its provider,
    // its middleware and its Agent attachment were still standing.
    let liveWhenReleased: boolean | undefined;
    let released = false;
    const session = opened(
      yield* openReplSession({
        execution: execution(),
        installations: [
          {
            *install(): Operation<void> {
              yield* ensure(() => {
                released = true;
                liveWhenReleased = session.live;
              });
            },
          },
        ],
      }),
    );
    const watched = yield* watching(session);
    accepted(yield* session.submit('<Json value={1} as="a" />\n'));
    yield* session.join();
    yield* sleep(0);

    // The installation really was released, so this is an ordering rather
    // than an assertion about something that never ran.
    expect(released).toBe(true);
    expect(liveWhenReleased).toBe(true);
    // And by now the session says what it is.
    expect(session.live).toBe(false);
    // The wake arrived with no input: nothing was typed, nothing activated,
    // and a reader waiting for the entry to end was still told.
    expect(watched.readings.length).toBeGreaterThan(0);
    expect(watched.readings[watched.readings.length - 1].occurrences).toEqual([]);
    expect(watched.readings[watched.readings.length - 1].entry).toBe(undefined);
  });

  it("L3: a late producer update cannot revive a reading the entry took with it", function* () {
    const session = opened(yield* openReplSession({ execution: execution() }));
    accepted(yield* session.submit('<Json value={1} as="a" />\n'));
    yield* session.join();
    yield* sleep(0);
    expect(session.lifecycle.occurrences).toEqual([]);

    // Whatever is still draining from the entry that closed — a terminal
    // phase published as its dispatch unwound — arrives after the generation
    // it belonged to is gone, and is refused by generation rather than
    // appended to nothing.
    for (let turn = 0; turn < 5; turn += 1) {
      yield* sleep(0);
    }
    expect(session.lifecycle.occurrences).toEqual([]);
    expect(session.lifecycle.entry).toBe(undefined);
  });

  it("L3: observing changes neither the outcome nor what the document rendered", function* () {
    const source = '<Each in={[1, 2]} let="n"><Json value={n} /></Each>\n';
    const rendered: string[] = [];
    for (const collect of [true, false]) {
      yield* scoped(function* () {
        const session = opened(yield* openReplSession({ execution: execution() }));
        if (collect) {
          yield* watching(session);
        }
        accepted(yield* session.submit(source));
        yield* session.join();
        rendered.push(session.model.entries[0]?.terminal?.output ?? "");
      });
    }
    expect(rendered[0]).toBe(rendered[1]);
    expect(rendered[0]).not.toBe("");
  });
});
