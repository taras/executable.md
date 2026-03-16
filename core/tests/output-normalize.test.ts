/**
 * Tier WN — Whitespace normalization middleware tests (spec §9.4).
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@std/expect";
import { useScope, createChannel, type Operation } from "effection";
import { EMA } from "../src/api.ts";
import { useNormalizedOutput } from "../src/output/normalize.ts";
import { subscribe } from "../src/subscribe.ts";

/**
 * Helper: install normalize middleware + channel, emit text, collect results.
 *
 * Install order: normalize first (outermost), channel last (closest to core).
 */
function* collectNormalized(texts: string[]): Operation<string[]> {
  const channel = createChannel<string, void>();
  const scope = yield* useScope();

  // First: normalization (runs first — outermost)
  yield* useNormalizedOutput();

  // Last: channel delivery (runs last — closest to core)
  scope.around(EMA, {
    *output([text]) {
      yield* channel.send(text);
    },
  });

  const { ready, task: consumer } = yield* subscribe<string>(channel);
  yield* ready;

  for (const text of texts) {
    yield* EMA.operations.output(text);
  }
  yield* channel.close();

  return yield* consumer;
}

describe("Tier WN — Whitespace normalization", () => {
  // WN1: Trailing whitespace stripped
  it("WN1: trailing whitespace stripped", function* () {
    const result = yield* collectNormalized(["hello \n"]);
    expect(result).toEqual(["hello\n"]);
  });

  // WN2: Leading newlines collapsed after blank line
  it("WN2: leading newlines collapsed after blank line", function* () {
    const result = yield* collectNormalized(["text\n\n", "\n\nmore"]);
    // First write ends with \n\n (trailing=2), second starts with \n\n → collapsed to \n
    expect(result[1]).toBe("\nmore");
  });

  // WN3: Run of 3+ newlines collapsed
  it("WN3: run of 3+ newlines collapsed within single write", function* () {
    const result = yield* collectNormalized(["a\n\n\nb"]);
    expect(result).toEqual(["a\n\nb"]);
  });

  // WN4: Cross-write tracking
  it("WN4: cross-write trailing newline tracking", function* () {
    const result = yield* collectNormalized(["text\n\n", "\n\nmore\n\n", "\n\nend"]);
    expect(result[0]).toBe("text\n\n");
    expect(result[1]).toBe("\nmore\n\n");
    expect(result[2]).toBe("\nend");
  });

  // WN5: Single newline preserved
  it("WN5: single newline preserved", function* () {
    const result = yield* collectNormalized(["a\nb"]);
    expect(result).toEqual(["a\nb"]);
  });

  // WN6: Empty write
  it("WN6: empty write unchanged", function* () {
    const result = yield* collectNormalized(["text\n\n", "", "more"]);
    expect(result[1]).toBe("");
  });

  // WN7: Tab trailing whitespace
  it("WN7: tab trailing whitespace stripped", function* () {
    const result = yield* collectNormalized(["text\t\n"]);
    expect(result).toEqual(["text\n"]);
  });
});
