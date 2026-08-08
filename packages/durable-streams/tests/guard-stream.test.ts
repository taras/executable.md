/**
 * Tests for guardDurableStream — the pre-persistence boundary.
 *
 * Each test drives an instrumented stream that records `gate:*` and
 * `backend:*` onto one timeline, so ordering and absence are asserted
 * directly rather than inferred from a backend snapshot.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { exists, readTextFile, rm } from "@effectionx/fs";
import { ensure, sleep, spawn, suspend, until } from "effection";
import type { Operation } from "effection";
import { appendFile } from "node:fs/promises";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  durableAll,
  durableCall,
  durableRun,
  guardDurableStream,
  InMemoryStream,
  serializeDurableEvent,
} from "../mod.ts";
import type { DurableEvent, DurableStream, Workflow } from "../mod.ts";

/** A short, readable identity for an event in a timeline assertion. */
function label(event: DurableEvent): string {
  if (event.type === "yield") {
    return `yield(${event.description.name})`;
  }
  return `close(${event.coroutineId})`;
}

/** A backend that records every call it receives on a shared timeline. */
function recordingStream(timeline: string[], events: DurableEvent[] = []): DurableStream {
  const backend = new InMemoryStream(events);
  return {
    *readAll(): Operation<DurableEvent[]> {
      timeline.push("backend:readAll");
      return yield* backend.readAll();
    },
    *append(event: DurableEvent): Operation<void> {
      timeline.push(`backend:${label(event)}`);
      yield* backend.append(event);
    },
  };
}

/**
 * A file backend shaped like the CLI's FileStream: it appends the shared
 * NDJSON record and answers readAll() from the events it accepted, so a test
 * can compare the bytes on disk against exactly those events.
 */
function fileStream(journalPath: string): DurableStream {
  const accepted: DurableEvent[] = [];
  return {
    // deno-lint-ignore require-yield
    *readAll(): Operation<DurableEvent[]> {
      return accepted.map((event) => structuredClone(event));
    },
    *append(event: DurableEvent): Operation<void> {
      yield* until(appendFile(journalPath, serializeDurableEvent(event)));
      accepted.push(event);
    },
  };
}

function backendAppends(timeline: string[]): string[] {
  return timeline.filter((entry) => entry.startsWith("backend:") && entry !== "backend:readAll");
}

/** The events of one coroutine, in the order the backend received them. */
function coroutineOrder(events: DurableEvent[], coroutineId: string): string[] {
  return events.filter((event) => event.coroutineId === coroutineId).map(label);
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "xmd-guard-"));
}

/** A durable-call executor that takes some time and returns a Json value. */
function waited(ms: number, value: string): () => Operation<string> {
  return function* () {
    yield* sleep(ms);
    return value;
  };
}

const EVENT: DurableEvent = {
  type: "yield",
  coroutineId: "root",
  description: { type: "call", name: "stepA" },
  result: { status: "ok", value: "alpha" },
};

describe("guardDurableStream", () => {
  it("delegates readAll without invoking the gate", function* () {
    const timeline: string[] = [];
    const guarded = guardDurableStream(recordingStream(timeline, [EVENT]), function* () {
      timeline.push("gate");
    });

    expect(yield* guarded.readAll()).toEqual([EVENT]);
    expect(timeline).toEqual(["backend:readAll"]);
  });

  it("runs the gate to completion before the backend append", function* () {
    const timeline: string[] = [];
    const guarded = guardDurableStream(recordingStream(timeline), function* (event) {
      timeline.push(`gate:${label(event)}`);
      yield* sleep(1);
      timeline.push(`gate:resumed:${label(event)}`);
    });

    yield* guarded.append(EVENT);

    expect(timeline).toEqual([
      "gate:yield(stepA)",
      "gate:resumed:yield(stepA)",
      "backend:yield(stepA)",
    ]);
  });

  it("appends the original event to the backend exactly once", function* () {
    const backend = new InMemoryStream();
    const seen: DurableEvent[] = [];
    const inspected: string[] = [];

    const guarded = guardDurableStream(
      {
        readAll: () => backend.readAll(),
        *append(event: DurableEvent): Operation<void> {
          seen.push(event);
          yield* backend.append(event);
        },
      },
      // A gate derives the persisted representation through the shared
      // serializer. It returns nothing, so it cannot hand back a replacement.
      // deno-lint-ignore require-yield
      function* (event) {
        inspected.push(serializeDurableEvent(event));
      },
    );

    yield* guarded.append(EVENT);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(EVENT);
    expect(backend.appendCount).toBe(1);
    expect(inspected).toEqual([`${JSON.stringify(EVENT)}\n`]);
  });

  it("keeps a rejected event out of an in-memory backend", function* () {
    const timeline: string[] = [];
    const rejection = new Error("rejected");
    const guarded = guardDurableStream(
      recordingStream(timeline),
      // deno-lint-ignore require-yield
      function* () {
        throw rejection;
      },
    );

    let failure: unknown;
    try {
      yield* guarded.append(EVENT);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBe(rejection);
    expect(backendAppends(timeline)).toEqual([]);
  });

  it("keeps a rejected event out of a file backend", function* () {
    const dir = makeTmpDir();
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    const journalPath = path.join(dir, "journal.jsonl");

    const guarded = guardDurableStream(
      fileStream(journalPath),
      // deno-lint-ignore require-yield
      function* (event) {
        if (serializeDurableEvent(event).includes("stepA")) {
          throw new Error("rejected");
        }
      },
    );

    let failure: Error | undefined;
    try {
      yield* guarded.append(EVENT);
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }

    expect(failure?.message).toBe("rejected");
    expect(yield* exists(journalPath)).toBe(false);
  });

  it("keeps gate rejection distinct from backing-stream failure", function* () {
    const backend = new InMemoryStream();
    const rejection = new Error("policy rejected the event");
    const guarded = guardDurableStream(
      backend,
      // deno-lint-ignore require-yield
      function* (event) {
        if (event.type === "yield") {
          throw rejection;
        }
      },
    );
    let failure: unknown;

    try {
      yield* durableRun(
        function* (): Workflow<string> {
          return yield* durableCall("step", waited(0, "value"));
        },
        { stream: guarded },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBe(rejection);
    expect(backend.snapshot()).toHaveLength(1);
    expect(backend.snapshot()[0]?.type).toBe("close");
  });

  it("hands the gate a copy, so mutating it cannot change what is persisted", function* () {
    const backend = new InMemoryStream();
    const original = structuredClone(EVENT);

    const guarded = guardDurableStream(
      backend,
      // deno-lint-ignore require-yield
      function* (event) {
        // A gate that tries to rewrite the record, at both levels.
        Reflect.set(event, "coroutineId", "tampered");
        Reflect.set(event, "type", "close");
        if (event.type === "yield") {
          Reflect.set(event.description, "name", "tampered");
        }
        Reflect.set(event.result, "status", "cancelled");
      },
    );

    yield* guarded.append(EVENT);

    // Neither the persisted event nor the caller's own object moved.
    expect(backend.snapshot()).toEqual([original]);
    expect(EVENT).toEqual(original);
  });

  it("keeps an event out of the backend when the gate is cancelled", function* () {
    const timeline: string[] = [];
    const guarded = guardDurableStream(recordingStream(timeline), function* (event) {
      timeline.push(`gate:${label(event)}`);
      yield* suspend();
    });

    const task = yield* spawn(function* () {
      yield* guarded.append(EVENT);
    });

    yield* sleep(1);
    yield* task.halt();

    expect(timeline).toEqual(["gate:yield(stepA)"]);
  });

  it("does not invoke the gate for replayed journal entries", function* () {
    const gated: string[] = [];
    const stream = new InMemoryStream();

    function* workflow(): Workflow<string> {
      const a = yield* durableCall("stepA", waited(0, "alpha"));
      const b = yield* durableCall("stepB", waited(0, "beta"));
      return `${a}-${b}`;
    }

    expect(yield* durableRun(workflow, { stream })).toBe("alpha-beta");
    const liveAppends = stream.appendCount;

    const guarded = guardDurableStream(
      stream,
      // deno-lint-ignore require-yield
      function* (event) {
        gated.push(label(event));
      },
    );

    expect(yield* durableRun(workflow, { stream: guarded })).toBe("alpha-beta");
    expect(gated).toEqual([]);
    expect(stream.appendCount).toBe(liveAppends);
  });

  it("gates every live event of a run, including concurrent children", function* () {
    const gated: string[] = [];
    const backend = new InMemoryStream();
    const guarded = guardDurableStream(
      backend,
      // deno-lint-ignore require-yield
      function* (event) {
        gated.push(label(event));
      },
    );

    function* workflow(): Workflow<string[]> {
      return yield* durableAll([
        function* () {
          return yield* durableCall("slow", waited(20, "slow"));
        },
        function* () {
          return yield* durableCall("fast", waited(1, "fast"));
        },
      ]);
    }

    expect(yield* durableRun(workflow, { stream: guarded })).toEqual(["slow", "fast"]);

    const persisted = backend.snapshot();

    // Every persisted event crossed the gate, exactly once, in backend order.
    expect(gated).toEqual(persisted.map(label));
    expect(gated).toHaveLength(backend.appendCount);

    // Cross-coroutine interleaving is permitted by the protocol; per-coroutine
    // order is not. Each child's yield still precedes its own close.
    const childIds = [...new Set(persisted.map((event) => event.coroutineId))].filter(
      (id) => id !== "root",
    );
    expect(childIds).toHaveLength(2);
    for (const childId of childIds) {
      const order = coroutineOrder(persisted, childId);
      expect(order).toHaveLength(2);
      expect(order[0]!.startsWith("yield(")).toBe(true);
      expect(order[1]).toBe(`close(${childId})`);
    }
  });
});
