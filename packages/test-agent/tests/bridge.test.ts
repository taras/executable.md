/**
 * Tier BR — turn-bridge tests (specs/test-agent-spec.md §Behavior
 * documents): the single ordered event channel and the prompt-offer
 * handoff between an offerer and the suspended matcher, including
 * cancellation safety in both directions and output-before-terminal
 * ordering in collectTurn().
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createChannel, Ok, race, sleep, spawn } from "effection";
import { collectTurn, createTurnBridge } from "../src/worker/bridge.ts";
import type { BridgeEvent } from "../src/worker/bridge.ts";

describe("Tier BR — turn bridge", () => {
  it("BR1: a queued offer is delivered to a later nextOffer and its response resolves", function* () {
    const bridge = createTurnBridge();
    let resolved: unknown;
    const offering = yield* spawn(function* () {
      resolved = yield* bridge.offer("hello");
    });
    yield* sleep(1);
    const offer = yield* bridge.nextOffer();
    expect(offer.text).toBe("hello");
    offer.respond(Ok({ subject: "core" }));
    yield* offering;
    expect(resolved).toEqual(Ok({ subject: "core" }));
  });

  it("BR2: a waiting nextOffer receives a subsequent offer", function* () {
    const bridge = createTurnBridge();
    let received = "";
    const waiting = yield* spawn(function* () {
      const offer = yield* bridge.nextOffer();
      received = offer.text;
      offer.respond(Ok({}));
    });
    yield* sleep(1);
    yield* bridge.offer("world");
    yield* waiting;
    expect(received).toBe("world");
  });

  it("BR3: a halted nextOffer does not swallow a later offer, and the offerer does not hang", function* () {
    const bridge = createTurnBridge();
    // A matcher starts waiting, then its turn is cancelled.
    const waiter = yield* spawn(() => bridge.nextOffer());
    yield* sleep(1);
    yield* waiter.halt();

    // The next offer must reach a live matcher, not the dead waiter.
    let responded = false;
    const offering = yield* spawn(function* () {
      const outcome = yield* bridge.offer("later");
      responded = outcome.ok;
    });
    yield* sleep(1);
    const offer = yield* bridge.nextOffer();
    expect(offer.text).toBe("later");
    offer.respond(Ok({}));
    yield* offering;
    expect(responded).toBe(true);
  });

  it("BR4: a halted offer does not reappear to a later nextOffer", function* () {
    const bridge = createTurnBridge();
    // An offer is queued (no matcher yet), then cancelled.
    const cancelled = yield* spawn(() => bridge.offer("cancelled"));
    yield* sleep(1);
    yield* cancelled.halt();

    // nextOffer must find nothing — the cancelled offer is gone.
    const outcome = yield* race([
      (function* () {
        const offer = yield* bridge.nextOffer();
        return offer.text;
      })(),
      (function* () {
        yield* sleep(25);
        return "no-offer";
      })(),
    ]);
    expect(outcome).toBe("no-offer");
  });

  it("BR5: collectTurn concatenates output before the terminal signal", function* () {
    const channel = createChannel<BridgeEvent, never>();
    const subscription = yield* channel;
    const collected = yield* spawn(() => collectTurn(subscription));
    yield* channel.send({ kind: "output", text: "part one, " });
    yield* channel.send({ kind: "output", text: "part two" });
    yield* channel.send({ kind: "suspended", stage: "next" });
    const result = yield* collected;
    expect(result).toEqual({ text: "part one, part two", end: "suspended", stage: "next" });
  });

  it("BR6: collectTurn surfaces a document failure with its message", function* () {
    const channel = createChannel<BridgeEvent, never>();
    const subscription = yield* channel;
    const collected = yield* spawn(() => collectTurn(subscription));
    yield* channel.send({ kind: "output", text: "partial" });
    yield* channel.send({ kind: "failed", error: "boom" });
    const result = yield* collected;
    expect(result).toEqual({ text: "partial", end: "failed", error: "boom" });
  });
});
