/**
 * Tier FA — fatal error discovery (spec §6.11).
 *
 * `fatalCause` decides whether a failure ends the execution or becomes a
 * printed error, and it runs from every generic catch in expansion. A cause graph
 * is arbitrary — nothing stops one from pointing back at itself — so the
 * traversal has to survive whatever it is handed.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import {
  ContinuePastCloseDivergenceError,
  DivergenceError,
  DurablePersistenceError,
  EarlyReturnDivergenceError,
  StaleInputError,
  TerminalDivergenceError,
} from "@executablemd/durable-streams";
import {
  FILES_FATAL,
  FilesInvariantError,
  FilesOperationDeniedError,
  FilesProviderUnavailableError,
} from "@executablemd/runtime";
import { InvocationTeardownError } from "../src/invocation.ts";
import {
  ContentError,
  decidedByOutput,
  DocumentationError,
  durabilityFailure,
  fatalCause,
  filesFatalFailure,
} from "../src/errors.ts";
import { Component } from "../src/component-api.ts";
import { expandSegments } from "../src/expand.ts";
import { renderSegments } from "../src/render.ts";
import { scanSegments } from "../src/scanner.ts";

function stale(): StaleInputError {
  return new StaleInputError("journal entry no longer describes this run");
}

function documentation(): DocumentationError {
  return new DocumentationError(
    {
      type: "error",
      message: "the document is wrong",
    },
    "throw",
  );
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
  () => new TerminalDivergenceError("root", 2, 5, { cause: new Error("document failed") }),
  () => new ContinuePastCloseDivergenceError("root", 5),
  () => new DurablePersistenceError("yield", new Error("journal unavailable")),
];

/**
 * One of each Files infrastructure failure.
 *
 * All three are structurally tagged and carry no cause, so what a failing
 * assertion has to distinguish is the kind, not the class.
 */
const FILES_FAILURES: Array<() => Error> = [
  () => new FilesProviderUnavailableError(),
  () => new FilesOperationDeniedError("temporary-directory"),
  () => new FilesInvariantError("authority"),
  () => new FilesInvariantError("savepoint"),
  () => new FilesInvariantError("protocol"),
  () => new FilesInvariantError("teardown"),
];

/**
 * A Files failure as a **separately loaded copy** of the runtime package would
 * build it.
 *
 * Two copies can be resolved at once — a repository component reaching its own
 * runtime beside the engine's — and `instanceof` answers false across them. The
 * structural tag is the whole mechanism, so this is built by hand rather than
 * through the constructor: nothing about this object shares a class identity
 * with the one core imported.
 */
function foreignFilesFatal(): Error {
  const error = new Error("Files provider is not installed");
  error.name = "FilesProviderUnavailableError";
  return Object.assign(error, {
    data: Object.freeze({ type: FILES_FATAL, kind: "provider-unavailable" }),
  });
}

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
    const fatal = new DocumentationError(
      {
        type: "error",
        message: "boom",
        source: "x",
      },
      "throw",
    );

    expect(fatalCause(new InvocationTeardownError([fatal]))).toBe(fatal);
  });

  // FA8: the whole point, end to end. A cyclic ordinary error reaches
  // expansion's catch, becomes a printed error, and the next block runs —
  // rather than overflowing the stack on the way to that decision.
  it("FA8: a cyclic ordinary error is printed and later content still runs", function* () {
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

  // FA20–FA27: a Files infrastructure failure is the third fatal kind. It is
  // not something the document did and not something it can act on, so it
  // travels like a durability failure — through every wrapper, and through a
  // recovery boundary — and ranks between the two existing kinds.
  it("FA20: every Files infrastructure failure is discovered as fatal", function* () {
    for (const make of FILES_FAILURES) {
      const planted = make();
      expect(fatalCause(planted)).toBe(planted);
      expect(filesFatalFailure(planted)).toBe(planted);

      const wrapped = new AggregateError([planted], "wrapped");
      expect(fatalCause(wrapped)).toBe(planted);
      expect(filesFatalFailure(wrapped)).toBe(planted);

      // Not a durability failure: the two questions stay separate.
      expect(durabilityFailure(planted)).toBeUndefined();
    }
  });

  it("FA21: a Files failure is found through every wrapper the engine builds", function* () {
    const planted = new FilesProviderUnavailableError();

    expect(fatalCause(new InvocationTeardownError([planted]))).toBe(planted);
    expect(fatalCause(new AggregateError([new Error("other"), planted]))).toBe(planted);
    expect(fatalCause(new Error("wrapper", { cause: planted }))).toBe(planted);

    const deep = new InvocationTeardownError([
      new AggregateError(
        [new Error("noise"), new Error("component exploded", { cause: planted })],
        "mixed",
      ),
    ]);
    expect(fatalCause(deep)).toBe(planted);
  });

  it("FA22: a Files failure outranks a documentation failure in either order", function* () {
    for (const make of FILES_FAILURES) {
      const planted = make();
      const doc = documentation();

      expect(fatalCause(new AggregateError([doc, planted], "mixed"))).toBe(planted);
      expect(fatalCause(new AggregateError([planted, doc], "mixed"))).toBe(planted);
      expect(fatalCause(new InvocationTeardownError([doc, planted]))).toBe(planted);
      expect(fatalCause(new InvocationTeardownError([planted, doc]))).toBe(planted);
    }
  });

  it("FA23: a durability failure outranks a Files failure in either order", function* () {
    for (const make of DURABILITY_FAILURES) {
      const durability = make();
      const files = new FilesInvariantError("protocol");

      expect(fatalCause(new AggregateError([files, durability], "mixed"))).toBe(durability);
      expect(fatalCause(new AggregateError([durability, files], "mixed"))).toBe(durability);
    }
  });

  it("FA24: all three kinds at once resolve durability, then Files, then documentation", function* () {
    const durability = stale();
    const files = new FilesInvariantError("savepoint");
    const doc = documentation();

    // All six orders of the three. Position is exactly what must not decide
    // this, so a sample of the orderings would leave the claim partly untested —
    // and the one ordering left out is the one that would ship the bug.
    for (const members of [
      [durability, files, doc],
      [durability, doc, files],
      [files, durability, doc],
      [files, doc, durability],
      [doc, durability, files],
      [doc, files, durability],
    ]) {
      expect(fatalCause(new AggregateError(members, "mixed"))).toBe(durability);
      // The other wrapper the engine builds, with the same members.
      expect(fatalCause(new InvocationTeardownError(members))).toBe(durability);
    }

    expect(fatalCause(new AggregateError([doc, files], "mixed"))).toBe(files);
    expect(fatalCause(new AggregateError([files, doc], "mixed"))).toBe(files);

    // Nesting cannot change it either: the shallowest member loses to the kind.
    const nested = new AggregateError(
      [doc, new InvocationTeardownError([new AggregateError([files], "inner")])],
      "outer",
    );
    expect(fatalCause(nested)).toBe(files);
  });

  it("FA25: a content failure does not hide a Files failure it carries", function* () {
    for (const make of FILES_FAILURES) {
      const planted = make();
      expect(filesFatalFailure(recovered(planted))).toBe(planted);
      expect(fatalCause(recovered(planted))).toBe(planted);
      expect(fatalCause(new AuthorContentError(planted))).toBe(planted);
    }

    // And against the documentation failure a recovery boundary would otherwise
    // let the search stop at.
    const files = new FilesInvariantError("teardown");
    const contextual = new Error("component exploded", {
      cause: recovered(new AggregateError([documentation(), files], "content")),
    });
    expect(fatalCause(contextual)).toBe(files);
  });

  it("FA26: a cyclic graph carrying a Files failure terminates and still finds it", function* () {
    const planted = new FilesProviderUnavailableError();
    const noise = new Error("noise");
    const teardown = new InvocationTeardownError([noise, planted]);
    noise.cause = teardown;

    expect(fatalCause(teardown)).toBe(planted);

    const cyclic = recovered();
    const wrapper = new AggregateError([cyclic, planted], "mixed");
    cyclic.cause = wrapper;
    expect(filesFatalFailure(cyclic)).toBe(planted);
  });

  it("FA27: a Files failure from a separately loaded runtime copy is recognized", function* () {
    const foreign = foreignFilesFatal();

    // The mechanism, stated as a fact about this object: no class identity.
    expect(foreign instanceof FilesProviderUnavailableError).toBe(false);

    expect(filesFatalFailure(foreign)).toBe(foreign);
    expect(fatalCause(new InvocationTeardownError([documentation(), foreign]))).toBe(foreign);

    // A tag that is not this one is not recognized, so recognition is the tag
    // rather than the presence of a `data` member.
    const impostor = Object.assign(new Error("looks similar"), {
      data: { type: "some.other/v1", kind: "provider-unavailable" },
    });
    expect(filesFatalFailure(impostor)).toBeUndefined();
    expect(fatalCause(impostor)).toBeUndefined();
  });

  it("FA28: only an output-mode documentation failure is decided by output", function* () {
    const output = new DocumentationError({ type: "error", message: "wrong" }, "output");
    expect(decidedByOutput(output)).toBe(true);
    expect(decidedByOutput(documentation())).toBe(false);

    for (const make of FILES_FAILURES) {
      expect(decidedByOutput(make())).toBe(false);
    }
    for (const make of DURABILITY_FAILURES) {
      expect(decidedByOutput(make())).toBe(false);
    }
  });
});
