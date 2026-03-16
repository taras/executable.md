/**
 * Tier OA — EMA Output Api tests (spec §9).
 *
 * Tests the EMA Api, middleware interception, and channel delivery.
 *
 * scope.around semantics: first-installed runs first (outermost).
 * Its next() delegates to the second-installed, and so on to the core.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@std/expect";
import { useScope, createChannel } from "effection";
import { EMA } from "../src/api.ts";
import { subscribe } from "../src/subscribe.ts";

describe("Tier OA — EMA Output Api", () => {
  // OA1: Api creation
  it("OA1: EMA Api created with output operation", function* () {
    expect(EMA).toBeDefined();
    expect(EMA.operations).toBeDefined();
    expect(typeof EMA.operations.output).toBe("function");
  });

  // OA2: Core handler is no-op
  it("OA2: output with no middleware produces no error", function* () {
    yield* EMA.operations.output("hello");
  });

  // OA3: Middleware intercepts output
  it("OA3: middleware intercepts output text", function* () {
    const captured: string[] = [];
    const scope = yield* useScope();

    scope.around(EMA, {
      *output([text], next) {
        captured.push(text);
        yield* next(text);
      },
    });

    yield* EMA.operations.output("hello");
    yield* EMA.operations.output("world");

    expect(captured).toEqual(["hello", "world"]);
  });

  // OA4: Middleware transforms text
  // scope.around: first-installed runs first, next() delegates to second
  it("OA4: middleware transforms text for next handler", function* () {
    const captured: string[] = [];
    const scope = yield* useScope();

    // First installed → runs first (outermost), transforms text
    scope.around(EMA, {
      *output([text], next) {
        yield* next(text.toUpperCase());
      },
    });

    // Second installed → runs second (closer to core), captures text
    scope.around(EMA, {
      *output([text]) {
        captured.push(text);
      },
    });

    yield* EMA.operations.output("hello");

    expect(captured).toEqual(["HELLO"]);
  });

  // OA5: Channel delivery
  it("OA5: channel delivery sends text via yield* channel.send()", function* () {
    const channel = createChannel<string, void>();
    const scope = yield* useScope();

    // Channel delivery installed last — runs closest to core
    scope.around(EMA, {
      *output([text]) {
        yield* channel.send(text);
      },
    });

    const { ready, task: consumer } = yield* subscribe<string>(channel);
    yield* ready;

    yield* EMA.operations.output("hello");
    yield* EMA.operations.output("world");
    yield* channel.close();

    const result = yield* consumer;
    expect(result).toEqual(["hello", "world"]);
  });

  // OA6: Consumer collects all chunks
  it("OA6: consumer collects all emitted chunks in order", function* () {
    const channel = createChannel<string, void>();
    const scope = yield* useScope();

    scope.around(EMA, {
      *output([text]) {
        yield* channel.send(text);
      },
    });

    const { ready, task: consumer } = yield* subscribe<string>(channel);
    yield* ready;

    yield* EMA.operations.output("# Title\n\n");
    yield* EMA.operations.output("Body text\n");
    yield* EMA.operations.output("## Footer\n");
    yield* channel.close();

    const result = yield* consumer;
    expect(result.join("")).toBe("# Title\n\nBody text\n## Footer\n");
  });

  // OA7: Channel close ends consumer
  it("OA7: channel.close() causes subscription loop to complete", function* () {
    const channel = createChannel<string, void>();

    let consumerDone = false;
    const { ready, task: consumer } = yield* subscribe<string>(channel, () => {
      // no-op callback
    });
    yield* ready;

    yield* channel.close();
    yield* consumer;

    consumerDone = true;
    expect(consumerDone).toBe(true);
  });

  // OA8: Multiple middleware compose
  it("OA8: normalize + transform + channel all compose", function* () {
    const channel = createChannel<string, void>();
    const scope = yield* useScope();

    // First installed → runs first (outermost): uppercase
    scope.around(EMA, {
      *output([text], next) {
        yield* next(text.toUpperCase());
      },
    });

    // Second installed → runs second: add prefix
    scope.around(EMA, {
      *output([text], next) {
        yield* next("[ok] " + text);
      },
    });

    // Third installed → runs last (closest to core): channel delivery
    scope.around(EMA, {
      *output([text]) {
        yield* channel.send(text);
      },
    });

    const { ready, task: consumer } = yield* subscribe<string>(channel);
    yield* ready;

    yield* EMA.operations.output("hello");
    yield* channel.close();

    const result = yield* consumer;
    // Execution: uppercase("hello") → "[ok] HELLO" → channel
    expect(result).toEqual(["[ok] HELLO"]);
  });
});
