/**
 * Tier SDL — delivering a rendered result to a stream.
 *
 * Tier SX proves what a real pipe receives. These rows prove the *lifetime* of
 * the one listener delivery installs, which a real pipe cannot show: a stream
 * is a process-global object, so a listener that outlived its delivery would
 * accumulate across invocations and could absorb a later, unrelated failure.
 *
 * The sink is an `EventEmitter`, and that is load-bearing rather than
 * convenient: emitting `error` with nothing listening throws. A row that emits
 * the trailing event therefore fails outright if delivery has already detached,
 * instead of quietly asserting nothing.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, spawn, withResolvers } from "effection";
import { EventEmitter } from "node:events";
import process from "node:process";
import { deliverWhole } from "../src/stdout-delivery.ts";
import type { DeliverySink } from "../src/stdout-delivery.ts";

/** What the stream does once delivery hands it the text. */
type SinkPlan = (sink: RecordingSink, callback: (error?: Error | null) => void) => void;

class RecordingSink extends EventEmitter implements DeliverySink {
  /** The error a destroyed stream holds until it emits it. */
  errored: Error | null = null;
  readonly written: string[] = [];
  readonly started = withResolvers<void>();
  readonly emitted = withResolvers<void>();
  /** How many listeners the trailing event found, which is the whole question. */
  listenersAtEmit = 0;

  constructor(private readonly plan: SinkPlan) {
    super();
  }

  write(text: string, callback: (error?: Error | null) => void): boolean {
    this.written.push(text);
    this.started.resolve();
    this.plan(this, callback);
    return true;
  }

  emitTrailing(error: Error): void {
    this.listenersAtEmit = this.listenerCount("error");
    this.emit("error", error);
    this.emitted.resolve();
  }
}

const EPIPE = new Error("write EPIPE");
const OTHER = new Error("a later, unrelated stdout failure");

/** A stream that takes everything, the way a file redirect does. */
const ACCEPTS: SinkPlan = (_sink, callback) => callback();

/**
 * Node and Deno: the callback carries the failure, and the stream holds that
 * same error until it emits it.
 *
 * The event is scheduled rather than emitted here, because a turn is exactly
 * what separates the two arrivals on a real pipe — long enough for a delivery
 * that settled at the callback to have resumed and detached already.
 */
const CALLBACK_THEN_EVENT: SinkPlan = (sink, callback) => {
  sink.errored = EPIPE;
  callback(EPIPE);
  setTimeout(() => {
    sink.errored = null;
    sink.emitTrailing(EPIPE);
  }, 0);
};

/** The reverse arrival order, with a distinct second error to rank the two. */
const EVENT_THEN_CALLBACK: SinkPlan = (sink, callback) => {
  sink.emit("error", EPIPE);
  callback(OTHER);
};

/** Bun: the failure is reported once, and the stream holds nothing after it. */
const REPORTED_ONCE: SinkPlan = (_sink, callback) => callback(EPIPE);

/** A stream still working, or one that never answers at all. */
const NEVER_ANSWERS: SinkPlan = () => {};

const REFUSES: SinkPlan = () => {
  throw EPIPE;
};

function listeners(sink: EventEmitter): number {
  return sink.listenerCount("error");
}

describe("Tier SDL — the listener lives for one delivery", () => {
  it("SDL1: a delivery that succeeds leaves the stream as it found it", function* () {
    const sink = new RecordingSink(ACCEPTS);
    const before = listeners(sink);

    const result = yield* deliverWhole("catalog", sink);

    expect(result.ok).toBe(true);
    expect(sink.written).toEqual(["catalog"]);
    expect(listeners(sink)).toBe(before);
  });

  it("SDL2: the trailing event still finds the listener, which is gone after it", function* () {
    const sink = new RecordingSink(CALLBACK_THEN_EVENT);
    // A sentinel, so that detaching too early is this row's assertion rather
    // than an unhandled `error` event thrown from a timer.
    sink.on("error", () => {});
    const before = listeners(sink);

    const result = yield* deliverWhole("catalog", sink);
    yield* sink.emitted.operation;

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error).toBe(EPIPE);
    // Delivery was still observing when the event landed, and only then let go.
    expect(sink.listenersAtEmit).toBe(before + 1);
    expect(listeners(sink)).toBe(before);
  });

  it("SDL3: the event may arrive first, and the first arrival is the verdict", function* () {
    const sink = new RecordingSink(EVENT_THEN_CALLBACK);
    const before = listeners(sink);

    const result = yield* deliverWhole("catalog", sink);

    expect(result.ok ? undefined : result.error).toBe(EPIPE);
    expect(listeners(sink)).toBe(before);
  });

  it("SDL4: a failure the stream reports once settles without waiting for a second", function* () {
    const sink = new RecordingSink(REPORTED_ONCE);
    const before = listeners(sink);

    // Nothing is owed, because the stream holds no error. Waiting for a
    // trailing event here would never return.
    const result = yield* deliverWhole("catalog", sink);

    expect(result.ok ? undefined : result.error).toBe(EPIPE);
    expect(listeners(sink)).toBe(before);
  });

  it("SDL5: a write that refuses outright detaches too", function* () {
    const sink = new RecordingSink(REFUSES);
    const before = listeners(sink);

    const result = yield* deliverWhole("catalog", sink);

    expect(result.ok ? undefined : result.error).toBe(EPIPE);
    expect(listeners(sink)).toBe(before);
  });

  it("SDL6: a delivery that never settles detaches when its scope ends", function* () {
    const sink = new RecordingSink(NEVER_ANSWERS);
    const before = listeners(sink);

    yield* scoped(function* () {
      yield* spawn(() => deliverWhole("catalog", sink));
      yield* sink.started.operation;
      expect(listeners(sink)).toBe(before + 1);
    });

    expect(listeners(sink)).toBe(before);
  });

  it("SDL7: no finished delivery absorbs a later, unrelated failure", function* () {
    const sink = new RecordingSink(ACCEPTS);
    const seen: Error[] = [];
    sink.on("error", (error: Error) => seen.push(error));

    yield* deliverWhole("catalog", sink);
    sink.emit("error", OTHER);

    // One listener, the sentinel's, and it received the error whole.
    expect(listeners(sink)).toBe(1);
    expect(seen).toEqual([OTHER]);
  });

  it("SDL8: the real process.stdout is left as it was found", function* () {
    const before = listeners(process.stdout);

    // Empty, so this row writes nothing a reporter could mistake for output.
    const result = yield* deliverWhole("", process.stdout);

    expect(result.ok).toBe(true);
    expect(listeners(process.stdout)).toBe(before);
  });
});
