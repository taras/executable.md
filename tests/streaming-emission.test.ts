/**
 * Tier SE — Streaming emission tests + Tier BC — Block ID counter (spec §9, §6.1).
 *
 * Tests per-segment emission through the EMA Output Api and
 * blockId stability across per-segment expansion calls.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@std/expect";
import { useScope, createChannel, spawn, each, sleep } from "effection";
import { InMemoryStream } from "@effectionx/durable-streams";
import { nodeRuntime } from "@effectionx/durable-effects";
import { EMA } from "../src/ema-api.ts";
import { createBlockCounter } from "../src/expand.ts";
import { runDocument } from "../src/run-document.ts";

describe("Tier BC — Block ID counter", () => {
  // BC1: Counter increments across calls
  it("BC1: counter increments across calls", function* () {
    const counter = createBlockCounter();
    expect(counter.next()).toBe(0);
    expect(counter.next()).toBe(1);
    expect(counter.next()).toBe(2);
  });

  // BC2: Separate counters are independent
  it("BC2: separate counters are independent", function* () {
    const c1 = createBlockCounter();
    const c2 = createBlockCounter();
    expect(c1.next()).toBe(0);
    expect(c2.next()).toBe(0);
    expect(c1.next()).toBe(1);
    expect(c2.next()).toBe(1);
  });
});

describe("Tier SE — Streaming emission", () => {
  // SE1: Per-segment emission order
  it("SE1: segments emitted in document order via EMA output", function* () {
    const chunks: string[] = [];
    const scope = yield* useScope();

    // Install middleware to capture output chunks (no channel needed)
    scope.around(EMA, {
      *output([text]) {
        chunks.push(text);
      },
    });

    const output = yield* runDocument({
      docPath: "tests/fixtures/streaming/multi-segment.md",
      stream: new InMemoryStream(),
      runtime: nodeRuntime(),
    });

    // Chunks should have been emitted in order
    expect(chunks.length).toBeGreaterThan(0);
    // Full output should match collected chunks
    expect(output).toBe(chunks.join(""));
  });

  // SE10: Empty segment produces no output call
  it("SE10: no empty strings in output chunks", function* () {
    const chunks: string[] = [];
    const scope = yield* useScope();

    scope.around(EMA, {
      *output([text]) {
        chunks.push(text);
      },
    });

    yield* runDocument({
      docPath: "tests/fixtures/streaming/simple.md",
      stream: new InMemoryStream(),
      runtime: nodeRuntime(),
    });

    // No empty strings in chunks
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  // SE9: Cross-boundary communication via channel
  it("SE9: output() inside durable workflow reaches channel outside", function* () {
    const channel = createChannel<string, void>();
    const scope = yield* useScope();

    // Channel delivery — installed last so it's closest to core
    scope.around(EMA, {
      *output([text]) {
        yield* channel.send(text);
      },
    });

    const consumer = yield* spawn(function* () {
      const chunks: string[] = [];
      for (const chunk of yield* each(channel)) {
        chunks.push(chunk);
        yield* each.next();
      }
      return chunks;
    });

    // Let consumer subscribe before runDocument sends
    yield* sleep(0);

    try {
      yield* runDocument({
        docPath: "tests/fixtures/streaming/simple.md",
        stream: new InMemoryStream(),
        runtime: nodeRuntime(),
      });
    } finally {
      yield* channel.close();
    }

    const result = yield* consumer;

    expect(result.length).toBeGreaterThan(0);
    expect(result.join("")).toContain("Hello");
  });
});
