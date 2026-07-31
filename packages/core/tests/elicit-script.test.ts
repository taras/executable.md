/**
 * The scripted-response queue (spec §6.16).
 *
 * `Elicit.test.md` shows what a passing document looks like. These cover the two
 * ways the queue fails, which a document cannot assert about itself: `<Elicit>`
 * is unmarked, so its failure is a thrown error rather than a raised segment
 * `<AssertThrows>` could capture, and an unused answer fails when the enclosing
 * scope ends rather than at any line the document wrote.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";

import { Elicitation } from "../src/elicitation-api.ts";
import { scriptElicitations } from "../src/elicit-script.ts";
import type { Json } from "../src/types.ts";

function ask(): Operation<unknown> {
  return Elicitation.operations.elicit({ message: "ask", schema: { type: "object" } });
}

/** Run `body` under a queue, reporting how it ended. */
function* underQueue(
  responses: readonly Json[],
  body: () => Operation<void>,
): Operation<{ failure?: string }> {
  try {
    yield* scoped(function* () {
      yield* scriptElicitations(responses);
      yield* body();
    });
    return {};
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
}

describe("scriptElicitations", () => {
  it("answers in order, one per elicitation", function* () {
    const seen: unknown[] = [];

    const outcome = yield* underQueue([{ n: 1 }, { n: 2 }, { n: 3 }], function* () {
      seen.push(yield* ask(), yield* ask(), yield* ask());
    });

    expect(outcome.failure).toBe(undefined);
    expect(seen).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("fails when an elicitation has no scripted answer", function* () {
    const outcome = yield* underQueue([{ n: 1 }], function* () {
      yield* ask();
      yield* ask();
    });

    expect(outcome.failure).toContain("no scripted response for elicitation 2");
    expect(outcome.failure).toContain("1 scripted, 1 already consumed");
  });

  /**
   * The failure arrives from the scope ending, not from a call — which is what
   * makes it a teardown failure inside a `<Test>`, and what lets a test that has
   * quietly stopped eliciting stop passing.
   */
  it("fails when scripted answers are left unused", function* () {
    const outcome = yield* underQueue([{ n: 1 }, { n: 2 }], function* () {
      yield* ask();
    });

    expect(outcome.failure).toContain("1 scripted elicitation response never used");
    expect(outcome.failure).toContain("2 scripted, 1 consumed");
  });

  it("says so in the plural when several are left", function* () {
    const outcome = yield* underQueue([{ n: 1 }, { n: 2 }, { n: 3 }], function* () {});

    expect(outcome.failure).toContain("3 scripted elicitation responses never used");
  });

  it("is satisfied by an empty queue that nothing asked", function* () {
    const outcome = yield* underQueue([], function* () {});

    expect(outcome.failure).toBe(undefined);
  });

  /** Leaving the scope removes the queue, so the next test starts with none. */
  it("is removed with the scope that installed it", function* () {
    yield* scoped(function* () {
      yield* scriptElicitations([{ n: 1 }]);
      yield* ask();
    });

    let failure: string | undefined;
    try {
      yield* ask();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }

    expect(failure).toContain("no elicitation provider configured");
  });
});
