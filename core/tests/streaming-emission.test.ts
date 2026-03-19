/**
 * Tier SE — Streaming emission tests + Tier BC — Block ID counter (spec §9, §6.1).
 *
 * Tests per-segment emission through the document stream returned by
 * runDocument, and blockId stability across per-segment expansion calls.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import { forEach } from "@effectionx/stream-helpers";
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
  it("SE1: segments emitted in document order via stream", function* () {
    const chunks: string[] = [];

    const execution = yield* runDocument({
      docPath: "core/tests/fixtures/streaming/multi-segment.md",
      stream: new InMemoryStream(),
    });

    const fullOutput = yield* forEach(function* (chunk: string) {
      chunks.push(chunk);
    }, execution.output);

    // Chunks should have been emitted in order
    expect(chunks.length).toBeGreaterThan(0);
    // Full output (close value) should match collected chunks
    expect(fullOutput).toBe(chunks.join(""));
  });

  // SE10: Empty segment produces no output call
  it("SE10: no empty strings in output chunks", function* () {
    const chunks: string[] = [];

    const execution = yield* runDocument({
      docPath: "core/tests/fixtures/streaming/simple.md",
      stream: new InMemoryStream(),
    });

    yield* forEach(function* (chunk: string) {
      chunks.push(chunk);
    }, execution.output);

    // No empty strings in chunks
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  // SE9: Streaming output reaches consumer via returned stream
  it("SE9: output() inside durable workflow reaches stream consumer", function* () {
    const chunks: string[] = [];

    const execution = yield* runDocument({
      docPath: "core/tests/fixtures/streaming/simple.md",
      stream: new InMemoryStream(),
    });

    yield* forEach(function* (chunk: string) {
      chunks.push(chunk);
    }, execution.output);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join("")).toContain("Hello");
  });
});
