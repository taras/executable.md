/**
 * Tier WN — Whitespace normalization middleware tests (spec §9.4).
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createChannel, type Operation } from "effection";
import { DocumentOutput } from "../src/api.ts";
import { useNormalizedOutput } from "../src/output/normalize.ts";
import { subscribe } from "../src/subscribe.ts";

/**
 * Helper: install normalize middleware + channel, emit text, collect results.
 *
 * Install order: normalize first (outermost), channel last (closest to core).
 */
function* collectNormalized(texts: (string | [string, boolean])[]): Operation<string[]> {
  const channel = createChannel<string, void>();
  // First: normalization (runs first — outermost)
  yield* useNormalizedOutput();

  // Last: channel delivery (runs last — closest to core)
  yield* DocumentOutput.around({
    *output([text]) {
      yield* channel.send(text);
    },
  });

  const { ready, task: consumer } = yield* subscribe<string>(channel);
  yield* ready;

  for (const text of texts) {
    if (typeof text === "string") {
      yield* DocumentOutput.operations.output(text);
      continue;
    }
    yield* DocumentOutput.operations.output(text[0], text[1]);
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

  // WN8: An exact write is presentation-free
  it("WN8: exact bytes pass through untouched", function* () {
    // Every rewrite this middleware makes, in one write: a line ending in
    // spaces, one ending in a tab, and a run of four newlines.
    const exact = "one   \ntwo\t\n\n\n\nthree";
    const result = yield* collectNormalized([[exact, true]]);
    expect(result).toEqual([exact]);
  });

  // WN9: The bypass is per write, not a switch
  it("WN9: prose around an exact write is still normalized", function* () {
    const result = yield* collectNormalized([
      "before   \n\n",
      ["kept   \n\n\n\n", true],
      "\n\nafter   \n\n\nend",
    ]);

    // The prose before it is normalized as it always was.
    expect(result[0]).toBe("before\n\n");
    // The exact write is not.
    expect(result[1]).toBe("kept   \n\n\n\n");
    // And the prose after it is normalized again — including the leading-newline
    // collapse, which means the exact write's own trailing newlines were still
    // counted rather than the tracking being abandoned.
    expect(result[2]).toBe("\nafter\n\nend");
  });
});
