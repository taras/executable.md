/**
 * Tier 1 tests — core replay correctness.
 *
 * Tests 1-7 from the protocol specification. These validate that
 * durableRun correctly executes workflows live, replays them from
 * stored events, and handles crash recovery scenarios.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, spawn, suspend, withResolvers, type Operation } from "effection";
import {
  type DurableEvent,
  DurablePersistenceError,
  TerminalDivergenceError,
  type DurableStream,
  InMemoryStream,
  type Json,
  type DurableRootControl,
  type Workflow,
  durableAction,
  durableCall,
  durableRun,
  DurableContext,
} from "../mod.ts";
import { activeDurabilityFailure, appendDurableEvent } from "../durability.ts";

class PausedYieldStream implements DurableStream {
  readonly appendStarted = withResolvers<void>();
  readonly allowAppend = withResolvers<void>();
  readonly inner = new InMemoryStream();

  constructor(readonly order: string[]) {}

  *readAll(): Operation<DurableEvent[]> {
    return yield* this.inner.readAll();
  }

  *append(event: DurableEvent): Operation<void> {
    if (event.type === "yield") {
      this.order.push("append:started");
      this.appendStarted.resolve();
      yield* this.allowAppend.operation;
    }
    yield* this.inner.append(event);
    if (event.type === "yield") {
      this.order.push("append:completed");
    }
  }
}

class FailOnceStream implements DurableStream {
  readonly inner: InMemoryStream;
  private failed = false;

  constructor(
    readonly failure: Error,
    events: DurableEvent[] = [],
  ) {
    this.inner = new InMemoryStream(events);
  }

  *readAll(): Operation<DurableEvent[]> {
    return yield* this.inner.readAll();
  }

  *append(event: DurableEvent): Operation<void> {
    if (!this.failed) {
      this.failed = true;
      throw this.failure;
    }
    yield* this.inner.append(event);
  }

  snapshot(): DurableEvent[] {
    return this.inner.snapshot();
  }
}

/** Track which functions were actually called during live execution. */
function createCallTracker() {
  const calls: string[] = [];
  return {
    calls,
    fn<T extends Json>(name: string, value: T): () => Promise<T> {
      return () => {
        calls.push(name);
        return Promise.resolve(value);
      };
    },
  };
}

describe("durableRun", () => {
  it("golden run: executes all effects live and records events", function* () {
    const stream = new InMemoryStream();
    const tracker = createCallTracker();

    function* workflow(): Workflow<string> {
      const a = yield* durableCall("stepA", tracker.fn("stepA", "alpha"));
      const b = yield* durableCall("stepB", tracker.fn("stepB", "beta"));
      return `${a}-${b}`;
    }

    const result = yield* durableRun(workflow, { stream });

    expect(result).toBe("alpha-beta");

    expect(tracker.calls).toEqual(["stepA", "stepB"]);

    const events = stream.snapshot();
    expect(events.length).toBe(3);

    expect(events[0]!.type).toBe("yield");
    expect(events[0]!.coroutineId).toBe("root");
    if (events[0]!.type === "yield") {
      expect(events[0]!.description).toEqual({ type: "call", name: "stepA" });
      expect(events[0]!.result).toEqual({ status: "ok", value: "alpha" });
    }

    expect(events[1]!.type).toBe("yield");
    if (events[1]!.type === "yield") {
      expect(events[1]!.description).toEqual({ type: "call", name: "stepB" });
      expect(events[1]!.result).toEqual({ status: "ok", value: "beta" });
    }

    expect(events[2]!.type).toBe("close");
    expect(events[2]!.coroutineId).toBe("root");
    if (events[2]!.type === "close") {
      expect(events[2]!.result).toEqual({ status: "ok", value: "alpha-beta" });
    }
  });

  it("full replay: returns stored result without re-executing effects", function* () {
    // Pre-populate stream with a complete run
    const events: DurableEvent[] = [
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "call", name: "stepA" },
        result: { status: "ok", value: "alpha" },
      },
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "call", name: "stepB" },
        result: { status: "ok", value: "beta" },
      },
      {
        type: "close",
        coroutineId: "root",
        result: { status: "ok", value: "alpha-beta" },
      },
    ];
    const stream = new InMemoryStream(events);
    const tracker = createCallTracker();

    function* workflow(): Workflow<string> {
      const a = yield* durableCall("stepA", tracker.fn("stepA", "alpha"));
      const b = yield* durableCall("stepB", tracker.fn("stepB", "beta"));
      return `${a}-${b}`;
    }

    const result = yield* durableRun(workflow, { stream });

    // Result comes from the stored Close event
    expect(result).toBe("alpha-beta");

    // No effects were actually called — fully replayed from stored Close
    expect(tracker.calls).toEqual([]);

    // Stream was not modified (no new events appended)
    expect(stream.appendCount).toBe(0);
  });

  it("crash before first effect: empty stream, all live", function* () {
    const stream = new InMemoryStream();
    const tracker = createCallTracker();

    function* workflow(): Workflow<string> {
      const a = yield* durableCall("stepA", tracker.fn("stepA", "alpha"));
      return a;
    }

    const result = yield* durableRun(workflow, { stream });

    expect(result).toBe("alpha");
    expect(tracker.calls).toEqual(["stepA"]);

    const events = stream.snapshot();
    expect(events.length).toBe(2); // 1 Yield + 1 Close
  });

  it("crash at position N: first N replayed, rest live", function* () {
    // Stream has only the first Yield event (simulates crash after stepA)
    const events: DurableEvent[] = [
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "call", name: "stepA" },
        result: { status: "ok", value: "alpha" },
      },
    ];
    const stream = new InMemoryStream(events);
    const tracker = createCallTracker();

    function* workflow(): Workflow<string> {
      const a = yield* durableCall("stepA", tracker.fn("stepA", "WRONG"));
      const b = yield* durableCall("stepB", tracker.fn("stepB", "beta"));
      return `${a}-${b}`;
    }

    const result = yield* durableRun(workflow, { stream });

    // stepA was replayed (returns stored "alpha", not "WRONG")
    // stepB was executed live
    expect(result).toBe("alpha-beta");

    // Only stepB was actually called
    expect(tracker.calls).toEqual(["stepB"]);

    // Stream now has: original Yield(stepA) + new Yield(stepB) + Close
    const finalEvents = stream.snapshot();
    expect(finalEvents.length).toBe(3);
    expect(finalEvents[0]!.type).toBe("yield");
    expect(finalEvents[1]!.type).toBe("yield");
    expect(finalEvents[2]!.type).toBe("close");

    // Only 2 appends: Yield(stepB) + Close
    expect(stream.appendCount).toBe(2);
  });

  it("crash after last effect: all Yields replayed, Close appended", function* () {
    // Stream has both Yield events but no Close
    const events: DurableEvent[] = [
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "call", name: "stepA" },
        result: { status: "ok", value: "alpha" },
      },
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "call", name: "stepB" },
        result: { status: "ok", value: "beta" },
      },
    ];
    const stream = new InMemoryStream(events);
    const tracker = createCallTracker();

    function* workflow(): Workflow<string> {
      const a = yield* durableCall("stepA", tracker.fn("stepA", "WRONG"));
      const b = yield* durableCall("stepB", tracker.fn("stepB", "WRONG"));
      return `${a}-${b}`;
    }

    const result = yield* durableRun(workflow, { stream });

    // Both effects replayed from journal
    expect(result).toBe("alpha-beta");
    expect(tracker.calls).toEqual([]);

    // Only Close event was appended
    expect(stream.appendCount).toBe(1);
    const finalEvents = stream.snapshot();
    expect(finalEvents.length).toBe(3);
    expect(finalEvents[2]!.type).toBe("close");
  });

  it("persist-before-resume: generator does not advance until write completes", function* () {
    const order: string[] = [];
    const stream = new PausedYieldStream(order);
    let resumed = false;

    function* workflow(): Workflow<string> {
      yield* durableCall("step1", () => {
        order.push("execute:step1");
        return Promise.resolve("one" as const);
      });
      resumed = true;
      order.push("resumed:after-step1");
      return "done";
    }

    const task = yield* spawn(() => durableRun(workflow, { stream }));
    yield* stream.appendStarted.operation;
    expect(resumed).toBe(false);
    expect(stream.inner.snapshot()).toHaveLength(0);

    stream.allowAppend.resolve();
    expect(yield* task).toBe("done");

    expect(order).toEqual([
      "execute:step1",
      "append:started",
      "append:completed",
      "resumed:after-step1",
    ]);
  });

  it("append failure cannot resolve a live effect successfully without a Yield", function* () {
    const appendFailure = new Error("yield append failed");
    const stream = new FailOnceStream(appendFailure);
    let resumed = false;
    let failure: unknown;

    function* workflow(): Workflow<string> {
      yield* durableCall("step", () => Promise.resolve("completed" as const));
      resumed = true;
      return "unjournaled-success";
    }

    try {
      yield* durableRun(workflow, { stream });
    } catch (error) {
      failure = error;
    }

    expect(resumed).toBe(false);
    expect(stream.snapshot()).toHaveLength(0);
    expect(failure).toBeInstanceOf(DurablePersistenceError);
    if (!(failure instanceof DurablePersistenceError)) {
      throw new Error("expected durable persistence failure");
    }
    expect(failure.cause).toBe(appendFailure);
  });

  it("a failed successful root Close append does not write a compensating Close", function* () {
    const appendFailure = new Error("root close append failed");
    const stream = new FailOnceStream(appendFailure);
    let failure: unknown;

    try {
      yield* durableRun(
        function* (): Workflow<string> {
          return "done";
        },
        { stream },
      );
    } catch (error) {
      failure = error;
    }

    expect(stream.snapshot()).toEqual([]);
    expect(failure).toBeInstanceOf(DurablePersistenceError);
    if (!(failure instanceof DurablePersistenceError)) {
      throw new Error("expected durable persistence failure");
    }
    expect(failure.cause).toBe(appendFailure);
  });

  it("callback effect append failure cannot become a workflow Close", function* () {
    const appendFailure = new Error("action yield append failed");
    const stream = new FailOnceStream(appendFailure);
    let resumed = false;
    let failure: unknown;

    try {
      yield* durableRun(
        function* (): Workflow<string> {
          yield* durableAction("step", (resolve) => {
            resolve("completed");
            return () => {};
          });
          resumed = true;
          return "unjournaled-success";
        },
        { stream },
      );
    } catch (error) {
      failure = error;
    }

    expect(resumed).toBe(false);
    expect(stream.snapshot()).toEqual([]);
    expect(failure).toBeInstanceOf(DurablePersistenceError);
    if (!(failure instanceof DurablePersistenceError)) {
      throw new Error("expected durable persistence failure");
    }
    expect(failure.cause).toBe(appendFailure);
  });

  it("caught persistence failure still prevents root termination", function* () {
    const appendFailure = new Error("caught yield append failed");
    const stream = new FailOnceStream(appendFailure);
    let caught = false;
    let failure: unknown;

    try {
      yield* durableRun(
        function* (): Workflow<string> {
          try {
            yield* durableCall("step", () => Promise.resolve("completed"));
          } catch {
            caught = true;
          }
          return "must-not-close";
        },
        { stream },
      );
    } catch (error) {
      failure = error;
    }

    expect(caught).toBe(true);
    expect(failure).toBeInstanceOf(DurablePersistenceError);
    expect(stream.snapshot()).toEqual([]);
  });

  it("actor handoff: Process B resumes from Process A's events", function* () {
    // Process A: execute first 2 steps then "crash" (we just take the events)
    const streamA = new InMemoryStream();
    const trackerA = createCallTracker();

    function* workflow(): Workflow<string> {
      const a = yield* durableCall("stepA", trackerA.fn("stepA", "alpha"));
      const b = yield* durableCall("stepB", trackerA.fn("stepB", "beta"));
      const c = yield* durableCall("stepC", trackerA.fn("stepC", "gamma"));
      return `${a}-${b}-${c}`;
    }

    yield* durableRun(workflow, { stream: streamA });

    // Process A executed all steps
    expect(trackerA.calls).toEqual(["stepA", "stepB", "stepC"]);

    // Simulate handoff: take only the first 2 Yield events (no Close, no stepC)
    const allEvents = streamA.snapshot();
    const partialEvents = allEvents.slice(0, 2);

    // Process B: resume with partial events
    const streamB = new InMemoryStream(partialEvents);
    const trackerB = createCallTracker();

    function* workflowB(): Workflow<string> {
      const a = yield* durableCall("stepA", trackerB.fn("stepA", "WRONG"));
      const b = yield* durableCall("stepB", trackerB.fn("stepB", "WRONG"));
      const c = yield* durableCall("stepC", trackerB.fn("stepC", "gamma"));
      return `${a}-${b}-${c}`;
    }

    const result = yield* durableRun(workflowB, { stream: streamB });

    // stepA and stepB replayed, stepC executed live
    expect(result).toBe("alpha-beta-gamma");
    expect(trackerB.calls).toEqual(["stepC"]);

    // Stream B: 2 original + 1 new Yield + 1 Close
    const finalEvents = streamB.snapshot();
    expect(finalEvents.length).toBe(4);
  });

  it("golden run with error: records Close(err) event", function* () {
    const stream = new InMemoryStream();

    function* workflow(): Workflow<string> {
      yield* durableCall("failingStep", () => Promise.reject(new Error("boom")));
      return "unreachable";
    }

    try {
      yield* durableRun(workflow, { stream });
      throw new Error("expected error from durableRun");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toContain("boom");
    }

    // Stream has Yield(err) + Close(err)
    const events = stream.snapshot();
    expect(events.length).toBe(2);

    if (events[0]!.type === "yield") {
      expect(events[0]!.result.status).toBe("err");
    }
    expect(events[1]!.type).toBe("close");
    if (events[1]!.type === "close") {
      expect(events[1]!.result.status).toBe("err");
    }
  });
});

/**
 * The other ending a root may have, and only where it was asked for.
 *
 * A generator's return cannot be observed by the `catch` that writes this
 * root's terminals, so an ordinary halt has always unwound without recording
 * one — which is what leaves an interrupted run resumable. One trusted caller
 * needs the opposite ending, and asks for it through this run's own control.
 *
 * What is under test is the authority rather than the plumbing: who may ask,
 * when the ask is still answerable, and what is actually retained.
 */
describe("durableRun: the cancelled ending, asked for through its own control", () => {
  it("absent the hook, a halted root still records nothing", function* () {
    const stream = new InMemoryStream();
    const started = withResolvers<void>();
    const task = yield* spawn(function* () {
      return yield* durableRun(
        function* () {
          started.resolve();
          yield* withResolvers<void>().operation;
          return "unreachable";
        },
        { stream },
      );
    });
    yield* started.operation;
    yield* task.halt();

    // Exactly the behaviour every caller has always seen.
    expect(stream.snapshot().some((event) => event.type === "close")).toBe(false);
  });

  it("an accepted request records exactly one cancelled close", function* () {
    const stream = new InMemoryStream();
    const started = withResolvers<void>();
    let control: DurableRootControl | undefined;
    const task = yield* spawn(function* () {
      return yield* durableRun(
        function* () {
          started.resolve();
          yield* withResolvers<void>().operation;
          return "unreachable";
        },
        { stream, control: (own) => (control = own) },
      );
    });
    yield* started.operation;
    if (control === undefined) {
      throw new Error("this run handed out no control");
    }

    // Asked while the root is open, so it is answerable — and nothing is
    // retained by the asking itself.
    expect(control.requestInterruption()).toBe(true);
    expect(control.settled()).toBe(undefined);
    // Repeated asks are the same ask.
    expect(control.requestInterruption()).toBe(true);

    yield* task.halt();

    const closes = stream.snapshot().filter((event) => event.type === "close");
    expect(closes.length).toBe(1);
    const only = closes[0];
    if (only === undefined || only.type !== "close") {
      throw new Error("this run recorded no close");
    }
    expect(only.coroutineId).toBe("root");
    expect(only.result.status).toBe("cancelled");
    // The protocol's cancelled result carries a status and nothing else.
    expect(Object.keys(only.result)).toEqual(["status"]);
    // And the control says what was actually retained, not what was asked.
    expect(control.settled()).toBe("cancelled");
  });

  it("a terminal already being written keeps the ending it was writing", function* () {
    const order: string[] = [];
    const stream = new PausedCloseStream(order);
    let control: DurableRootControl | undefined;
    const task = yield* spawn(function* () {
      return yield* durableRun(
        function* () {
          return "done";
        },
        { stream, control: (own) => (control = own) },
      );
    });
    yield* stream.appendStarted.operation;
    if (control === undefined) {
      throw new Error("this run handed out no control");
    }

    // The root is no longer open: its own terminal is already on its way to
    // the stream, so the ask is refused rather than cancelling that write and
    // compensating over a backend that may already hold it.
    expect(control.requestInterruption()).toBe(false);
    stream.allowAppend.resolve();
    expect(yield* task).toBe("done");

    const closes = stream.inner.snapshot().filter((event) => event.type === "close");
    expect(closes.length).toBe(1);
    const only = closes[0];
    if (only === undefined || only.type !== "close") {
      throw new Error("this run recorded no close");
    }
    expect(only.result.status).toBe("ok");
    expect(control.settled()).toBe("ok");
  });
});

/**
 * What an accepted request owns, and what it must not swallow.
 *
 * A Stop that reaches an open root takes its ending: the ordinary paths may
 * not acknowledge an ok or err terminal around it afterwards. But holding a
 * root is not a licence to end quietly — one whose durability already failed,
 * or whose retained history this definition did not align with, has an outcome
 * of its own, and whoever asked it to stop has to learn which one.
 */
describe("durableRun: what an accepted request owns, and what it refuses", () => {
  it("a request accepted while open ends the run, however the workflow returns", function* () {
    const stream = new InMemoryStream();
    const started = withResolvers<void>();
    const release = withResolvers<void>();
    let control: DurableRootControl | undefined;
    // Asked from beside this run rather than from a task that holds it: a
    // spawned run that fails takes its parent down with it, so a caller
    // cannot both own the run and watch it fail.
    yield* spawn(function* () {
      yield* started.operation;
      control?.requestInterruption();
      release.resolve();
    });

    let completed = false;
    let caught: unknown;
    try {
      yield* durableRun(
        function* () {
          started.resolve();
          yield* release.operation;
          return "returned after the request";
        },
        { stream, control: (own) => (control = own) },
      );
      completed = true;
    } catch (error) {
      caught = error;
    }

    // The workflow ran to its own end afterwards. That does not undo what was
    // accepted: this root was stopped, so it completes successfully for
    // nobody and publishes no value to its caller.
    expect(completed).toBe(false);
    expect(caught).toBeInstanceOf(Error);
    expect(control?.settled()).toBe("cancelled");

    // And exactly one terminal, saying stopped rather than succeeded.
    const closes = stream.snapshot().filter((event) => event.type === "close");
    expect(closes.length).toBe(1);
    const only = closes[0];
    if (only === undefined || only.type !== "close") {
      throw new Error("this run recorded no close");
    }
    expect(only.result.status).toBe("cancelled");
    expect(Object.keys(only.result)).toEqual(["status"]);
  });

  it("a request over an unaligned prefix raises divergence and records nothing", function* () {
    const stream = new InMemoryStream([
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "action", name: "retained-not-consumed" },
        result: { status: "ok", value: "retained" },
      },
    ]);
    const started = withResolvers<void>();
    let control: DurableRootControl | undefined;
    let captured: DurableContext | undefined;
    const task = yield* spawn(function* () {
      yield* durableRun(
        function* () {
          captured = yield* DurableContext.expect();
          started.resolve();
          yield* suspend();
        },
        { stream, control: (own) => (control = own) },
      );
    });
    yield* started.operation;
    if (control === undefined) {
      throw new Error("this run handed out no control");
    }
    expect(control.requestInterruption()).toBe(true);

    let failure: unknown;
    try {
      yield* task.halt();
    } catch (error) {
      failure = error;
    }
    // Retained history this definition did not reach is divergence, not a
    // stopped run, and it is not papered over with a cancelled close.
    expect(failure).toBeInstanceOf(TerminalDivergenceError);
    expect(stream.snapshot().some((event) => event.type === "close")).toBe(false);
    expect(control.settled()).toBe(undefined);
    // And the root has ended, so it accepts nothing further.
    expect(control.requestInterruption()).toBe(false);

    // That failure is this run's, not only this frame's: it is remembered in
    // the shared state, so every later append through the same context is
    // refused by the same failure rather than writing into a history that has
    // already diverged.
    if (captured === undefined) {
      throw new Error("this run published no context");
    }
    const ctx = captured;
    expect(Object.is(activeDurabilityFailure(ctx), failure)).toBe(true);
    let late: unknown;
    try {
      yield* scoped(() =>
        appendDurableEvent(ctx, {
          type: "yield",
          coroutineId: "root",
          description: { type: "action", name: "after-divergence" },
          result: { status: "ok", value: "must not append" },
        }),
      );
    } catch (error) {
      late = error;
    }
    expect(Object.is(late, failure)).toBe(true);
    expect(stream.snapshot().length).toBe(1);
  });

  it("a request after a sticky append failure escapes by identity", function* () {
    const cause = new Error("the stream refused this append");
    const stream: DurableStream = {
      *readAll(): Operation<DurableEvent[]> {
        return [];
      },
      *append(): Operation<void> {
        throw cause;
      },
    };
    const started = withResolvers<void>();
    let original: unknown;
    let control: DurableRootControl | undefined;
    const task = yield* spawn(function* () {
      yield* durableRun(
        function* () {
          try {
            yield* durableAction("rejected", (resolve) => {
              resolve("value");
              return () => {};
            });
          } catch (error) {
            original = error;
          }
          started.resolve();
          yield* suspend();
        },
        { stream, control: (own) => (control = own) },
      );
    });
    yield* started.operation;
    if (control === undefined) {
      throw new Error("this run handed out no control");
    }
    expect(original).toBeInstanceOf(DurablePersistenceError);
    expect(control.requestInterruption()).toBe(true);

    let failure: unknown;
    try {
      yield* task.halt();
    } catch (error) {
      failure = error;
    }
    // The same failure, not a copy and not a silence: a caller that asked
    // this root to stop learns what actually ended it.
    expect(Object.is(failure, original)).toBe(true);
    expect(control.settled()).toBe(undefined);
  });

  it("an owner that ended unrequested takes no later request", function* () {
    const stream = new InMemoryStream();
    const started = withResolvers<void>();
    let control: DurableRootControl | undefined;
    const task = yield* spawn(function* () {
      yield* durableRun(
        function* () {
          started.resolve();
          yield* suspend();
        },
        { stream, control: (own) => (control = own) },
      );
    });
    yield* started.operation;
    if (control === undefined) {
      throw new Error("this run handed out no control");
    }
    yield* task.halt();

    // Nothing was asked for, so nothing was recorded — and the control is
    // retired rather than left accepting a claim on an owner that has gone.
    expect(stream.snapshot().some((event) => event.type === "close")).toBe(false);
    expect(control.requestInterruption()).toBe(false);
    expect(control.settled()).toBe(undefined);
  });
});

/** A stream that holds the root's own Close until its caller lets it through. */
class PausedCloseStream implements DurableStream {
  readonly appendStarted = withResolvers<void>();
  readonly allowAppend = withResolvers<void>();
  readonly inner = new InMemoryStream();

  constructor(readonly order: string[]) {}

  *readAll(): Operation<DurableEvent[]> {
    return yield* this.inner.readAll();
  }

  *append(event: DurableEvent): Operation<void> {
    if (event.type === "close") {
      this.order.push("close:started");
      this.appendStarted.resolve();
      yield* this.allowAppend.operation;
    }
    yield* this.inner.append(event);
  }

  snapshot(): DurableEvent[] {
    return this.inner.snapshot();
  }
}
