/**
 * Tier FA — fatal error discovery (spec §6.11).
 *
 * `fatalCause` decides whether a failure ends the execution or becomes a
 * diagnostic, and it runs from every generic catch in expansion. A cause graph
 * is arbitrary — nothing stops one from pointing back at itself — so the
 * traversal has to survive whatever it is handed.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import {
  ContinuePastCloseDivergenceError,
  DivergenceError,
  EarlyReturnDivergenceError,
  StaleInputError,
} from "@executablemd/durable-streams";
import { InvocationTeardownError } from "../src/invocation.ts";
import {
  componentAbort,
  ContentError,
  DocumentationError,
  durabilityFailure,
  fatalCause,
  hasOrdinaryFailure,
} from "../src/errors.ts";
import { Component } from "../src/component-api.ts";
import { expandSegments } from "../src/expand.ts";
import { renderSegments } from "../src/render.ts";
import { scanSegments } from "../src/scanner.ts";

function stale(): StaleInputError {
  return new StaleInputError("journal entry no longer describes this run");
}

function documentation(): DocumentationError {
  return new DocumentationError({
    type: "error",
    message: "the document is wrong",
  });
}

/**
 * A content failure carrying something underneath, built the way an author can:
 * the public constructor takes only the segments, so anything beneath an instance
 * arrives by property assignment.
 */
function recovered(cause?: unknown): ContentError {
  const failure = new ContentError([{ type: "error", message: "content failed to expand" }]);
  if (cause !== undefined) {
    failure.cause = cause;
  }
  return failure;
}

/** The other way an author gets there: a subclass that sets its own cause. */
class AuthorContentError extends ContentError {
  constructor(cause: unknown) {
    super([{ type: "error", message: "content failed to expand" }]);
    this.cause = cause;
  }
}

/**
 * One of each durability failure, so every kind is asked the same questions. A
 * failing assertion names the class through the received value.
 */
const DURABILITY_FAILURES: Array<() => Error> = [
  stale,
  () =>
    new DivergenceError(
      "root",
      3,
      { type: "eval", name: "eval:recorded" },
      { type: "eval", name: "eval:reached" },
    ),
  () => new EarlyReturnDivergenceError("root", 2, 5),
  () => new ContinuePastCloseDivergenceError("root", 5),
];

describe("Tier FA — Fatal error discovery", () => {
  it("FA1: an error that is its own cause terminates the search", function* () {
    const error = new Error("ordinary");
    error.cause = error;

    expect(fatalCause(error)).toBeUndefined();
  });

  it("FA2: two errors causing each other terminate the search", function* () {
    const first = new Error("first");
    const second = new Error("second");
    first.cause = second;
    second.cause = first;

    expect(fatalCause(first)).toBeUndefined();
  });

  it("FA3: a cyclic aggregate terminates the search", function* () {
    const inner = new Error("inner");
    const aggregate = new AggregateError([inner], "aggregate");
    inner.cause = aggregate;

    expect(fatalCause(aggregate)).toBeUndefined();
  });

  it("FA4: a cyclic teardown graph terminates the search", function* () {
    const inner = new Error("inner");
    const teardown = new InvocationTeardownError([inner]);
    inner.cause = teardown;

    expect(fatalCause(teardown)).toBeUndefined();
  });

  // FA5: cycle safety must not cost discovery — the reason the traversal
  // exists is that a fatal error arrives wrapped.
  it("FA5: a fatal error is still found inside a wrapper", function* () {
    const fatal = stale();

    expect(fatalCause(new InvocationTeardownError([fatal]))).toBe(fatal);
    expect(fatalCause(new AggregateError([new Error("other"), fatal]))).toBe(fatal);
    expect(fatalCause(new Error("wrapper", { cause: fatal }))).toBe(fatal);
  });

  it("FA6: a fatal error survives a wrapper that is also cyclic", function* () {
    const fatal = stale();
    const noise = new Error("noise");
    const teardown = new InvocationTeardownError([noise, fatal]);
    noise.cause = teardown;

    expect(fatalCause(teardown)).toBe(fatal);
  });

  it("FA7: a documentation failure is found the same way", function* () {
    const fatal = new DocumentationError({
      type: "error",
      message: "boom",
      source: "x",
    });

    expect(fatalCause(new InvocationTeardownError([fatal]))).toBe(fatal);
  });

  // FA8: the whole point, end to end. A cyclic ordinary error reaches
  // expansion's catch, is collected as a diagnostic, and the next block runs —
  // rather than overflowing the stack on the way to that decision.
  it("FA8: a cyclic ordinary error is collected and later content still runs", function* () {
    const expanded = yield* scoped(function* () {
      yield* Component.around(
        {
          // deno-lint-ignore require-yield
          *applyModifiers([_modifiers, block], _next) {
            if (block.content.includes("boom")) {
              const error = new Error("ordinary cyclic failure");
              error.cause = error;
              throw error;
            }
            return { output: "second block ran", exitCode: 0, stderr: "" };
          },
        },
        { at: "min" },
      );
      yield* Component.around({ env: () => ({ values: {} }) }, { at: "min" });
      return yield* expandSegments(
        scanSegments("```sh exec\nboom\n```\n\n```sh exec\nok\n```"),
        {},
        {},
        new Set(),
      );
    });

    const output = renderSegments(expanded);
    expect(output).toContain("ordinary cyclic failure");
    expect(output).toContain("second block ran");
  });

  it("FA9: every durability failure is discovered as fatal", function* () {
    for (const make of DURABILITY_FAILURES) {
      const planted = make();
      expect(fatalCause(planted)).toBe(planted);
      expect(durabilityFailure(planted)).toBe(planted);
      // And through a wrapper, which is how each of them actually arrives.
      const wrapped = new AggregateError([planted], "wrapped");
      expect(fatalCause(wrapped)).toBe(planted);
      expect(durabilityFailure(wrapped)).toBe(planted);
    }
  });

  it("FA10: a durability failure outranks a documentation failure in either order", function* () {
    for (const make of DURABILITY_FAILURES) {
      const planted = make();
      const doc = documentation();

      expect(fatalCause(new AggregateError([doc, planted], "mixed"))).toBe(planted);
      expect(fatalCause(new AggregateError([planted, doc], "mixed"))).toBe(planted);
    }
  });

  it("FA11: the same holds through a teardown aggregate", function* () {
    const planted = stale();
    const doc = documentation();

    expect(fatalCause(new InvocationTeardownError([doc, planted]))).toBe(planted);
    expect(fatalCause(new InvocationTeardownError([planted, doc]))).toBe(planted);
  });

  it("FA12: precedence holds however deeply either one is nested", function* () {
    const planted = stale();
    const doc = documentation();
    const shallowDoc = new AggregateError(
      [doc, new AggregateError([new AggregateError([planted], "inner")], "middle")],
      "outer",
    );
    const shallowStale = new AggregateError([planted, new AggregateError([doc], "inner")], "outer");

    expect(fatalCause(shallowDoc)).toBe(planted);
    expect(fatalCause(shallowStale)).toBe(planted);
  });

  it("FA13: a documentation failure is reported when no durability failure exists", function* () {
    const doc = documentation();

    expect(fatalCause(new AggregateError([new Error("ordinary"), doc], "mixed"))).toBe(doc);
    expect(durabilityFailure(new AggregateError([doc], "wrapped"))).toBeUndefined();
  });

  it("FA14: precedence survives a cyclic mixed graph", function* () {
    const planted = stale();
    const doc = documentation();
    const wrapper = new AggregateError([doc, planted], "mixed");
    doc.cause = wrapper;

    expect(fatalCause(wrapper)).toBe(planted);
  });

  // FA15–FA19: the two searches reach different parts of the same graph.
  // `ContentError` is public — an author constructs and subclasses it — so what
  // an instance carries underneath is arbitrary, and only the documentation
  // search may treat it as a leaf.
  it("FA15: a content failure does not hide a durability failure it carries", function* () {
    for (const make of DURABILITY_FAILURES) {
      const subclassed = new AuthorContentError(make());
      expect(durabilityFailure(subclassed)).toBe(subclassed.cause);
      expect(fatalCause(subclassed)).toBe(subclassed.cause);

      const planted = make();
      const assigned = recovered(planted);
      expect(durabilityFailure(assigned)).toBe(planted);
      expect(fatalCause(assigned)).toBe(planted);
    }
  });

  it("FA16: the same holds wherever the content failure sits in the graph", function* () {
    const planted = stale();

    expect(fatalCause(new Error("component exploded", { cause: recovered(planted) }))).toBe(
      planted,
    );
    expect(fatalCause(new AggregateError([new Error("other"), recovered(planted)], "mixed"))).toBe(
      planted,
    );
    expect(fatalCause(new InvocationTeardownError([recovered(planted)]))).toBe(planted);

    // Every wrapper at once: teardown, aggregate, an ordinary cause, and then
    // the content failure the component recovered from.
    const deep = new InvocationTeardownError([
      new AggregateError(
        [new Error("noise"), new Error("component exploded", { cause: recovered(planted) })],
        "mixed",
      ),
    ]);
    expect(durabilityFailure(deep)).toBe(planted);
    expect(fatalCause(deep)).toBe(planted);
  });

  it("FA17: a documentation failure a component recovered from is not reported again", function* () {
    const child = documentation();
    const contextual = new Error("component exploded", { cause: recovered(child) });

    expect(fatalCause(contextual)).toBeUndefined();
    expect(durabilityFailure(contextual)).toBeUndefined();

    // Stopped at the content failure, not switched off: the same documentation
    // failure reached without crossing one is still discovered.
    expect(fatalCause(new AggregateError([contextual, child], "mixed"))).toBe(child);
  });

  it("FA18: a durability failure outranks a documentation failure behind a content failure", function* () {
    const planted = stale();
    const child = documentation();
    const contextual = new Error("component exploded", {
      cause: recovered(new AggregateError([child, planted], "content")),
    });

    expect(fatalCause(contextual)).toBe(planted);
    // And against a documentation failure the search would otherwise report.
    expect(fatalCause(new AggregateError([contextual, documentation()], "mixed"))).toBe(planted);
    expect(fatalCause(new AggregateError([documentation(), contextual], "mixed"))).toBe(planted);
  });

  it("FA19: a cyclic graph through a content failure terminates", function* () {
    const selfCaused = recovered();
    selfCaused.cause = selfCaused;

    expect(fatalCause(selfCaused)).toBeUndefined();
    expect(durabilityFailure(selfCaused)).toBeUndefined();

    const planted = stale();
    const cyclic = recovered();
    const wrapper = new AggregateError([cyclic, planted], "mixed");
    cyclic.cause = wrapper;

    expect(durabilityFailure(cyclic)).toBe(planted);
    expect(fatalCause(wrapper)).toBe(planted);
  });
});

describe("Tier FA — a component that ends the execution", () => {
  it("FA20: a marked failure is returned by identity, and stays marked", function* () {
    const failure = new Error("no such agent");
    const marked = componentAbort(failure);

    // Marking does not wrap: the same object comes back.
    expect(marked).toBe(failure);
    expect(fatalCause(marked)).toBe(failure);
    // The property a wrapper could not have: still fatal at the next boundary,
    // which is handed whatever the previous one rethrew.
    expect(fatalCause(fatalCause(failure))).toBe(failure);
  });

  it("FA21: a marked failure is found through every wrapper contract", function* () {
    const first = componentAbort(new Error("setup"));
    expect(fatalCause(new Error("wrapper", { cause: first }))).toBe(first);

    const second = componentAbort(new Error("setup"));
    expect(fatalCause(new AggregateError([new Error("other"), second], "mixed"))).toBe(second);

    const third = componentAbort(new Error("setup"));
    expect(fatalCause(new InvocationTeardownError([third]))).toBe(third);

    const nested = componentAbort(new Error("setup"));
    const deep = new AggregateError(
      [new Error("body"), new InvocationTeardownError([new Error("first"), nested])],
      "both failed",
    );
    expect(fatalCause(deep)).toBe(nested);
    // Repeating the question on what was returned answers the same.
    expect(fatalCause(fatalCause(deep))).toBe(nested);
  });

  it("FA22: durability outranks a marked failure, either way round", function* () {
    const planted = stale();
    const marked = componentAbort(new Error("setup"));

    expect(fatalCause(new AggregateError([marked, planted], "mixed"))).toBe(planted);
    expect(fatalCause(new AggregateError([planted, marked], "mixed"))).toBe(planted);
  });

  it("FA23: a recovered content failure hides a marked failure beneath it", function* () {
    const marked = componentAbort(new Error("setup"));
    const contextual = recovered();
    contextual.cause = marked;

    expect(fatalCause(contextual)).toBeUndefined();

    // Durability still looks straight through, as it always has.
    const planted = stale();
    const withDurability = recovered();
    withDurability.cause = planted;
    expect(fatalCause(withDurability)).toBe(planted);
  });

  it("FA24: a thrown non-Error becomes a marked Error carrying the original", function* () {
    const marked = componentAbort("just a string");

    expect(marked).toBeInstanceOf(Error);
    expect(marked.cause).toBe("just a string");
    expect(fatalCause(marked)).toBe(marked);
  });

  it("FA25: a frozen Error can be marked, and is not mutated", function* () {
    const frozen = Object.freeze(new Error("frozen setup"));
    const marked = componentAbort(frozen);

    expect(marked).toBe(frozen);
    expect(Object.isFrozen(marked)).toBe(true);
    expect(fatalCause(frozen)).toBe(frozen);
  });

  it("FA26: a cyclic graph holding a marked failure terminates", function* () {
    const marked = componentAbort(new Error("setup"));
    const wrapper = new AggregateError([marked], "mixed");
    marked.cause = wrapper;

    expect(fatalCause(wrapper)).toBe(marked);
  });
});

describe("Tier FA — ordinary failure classification", () => {
  it("FA27: content, documentation, durability and marked failures are not ordinary", function* () {
    expect(hasOrdinaryFailure(new ContentError([]))).toBe(false);
    expect(hasOrdinaryFailure(documentation())).toBe(false);
    expect(hasOrdinaryFailure(stale())).toBe(false);
    expect(hasOrdinaryFailure(componentAbort(new Error("already")))).toBe(false);
  });

  it("FA28: an ordinary Error is ordinary, wherever it sits", function* () {
    const ordinary = new Error("cleanup failed");

    expect(hasOrdinaryFailure(ordinary)).toBe(true);
    expect(hasOrdinaryFailure(new InvocationTeardownError([ordinary]))).toBe(true);
    expect(
      hasOrdinaryFailure(
        new AggregateError([new ContentError([]), new InvocationTeardownError([ordinary])], "both"),
      ),
    ).toBe(true);
    expect(hasOrdinaryFailure(new AggregateError([documentation(), ordinary], "mixed"))).toBe(true);
    expect(
      hasOrdinaryFailure(new AggregateError([componentAbort(new Error("a")), ordinary], "mixed")),
    ).toBe(true);
  });

  it("FA29: what a failure that answers for itself carries is out of scope", function* () {
    // A documentation failure brings along whatever it was translated from, and
    // a marked one its own cause; neither makes the wrapper ordinary.
    const doc = documentation();
    doc.cause = new Error("the value it came from");
    expect(hasOrdinaryFailure(doc)).toBe(false);

    const marked = componentAbort(new Error("setup", { cause: new Error("underneath") }));
    expect(hasOrdinaryFailure(marked)).toBe(false);

    const contextual = recovered();
    contextual.cause = new Error("beneath the content failure");
    expect(hasOrdinaryFailure(contextual)).toBe(false);
  });

  it("FA30: the aggregating wrappers are never ordinary themselves", function* () {
    expect(hasOrdinaryFailure(new AggregateError([], "empty"))).toBe(false);
    expect(hasOrdinaryFailure(new InvocationTeardownError([]))).toBe(false);
  });

  it("FA31: a cyclic graph terminates", function* () {
    const cyclic = new AggregateError([new ContentError([])], "mixed");
    cyclic.cause = cyclic;

    expect(hasOrdinaryFailure(cyclic)).toBe(false);
  });
});
