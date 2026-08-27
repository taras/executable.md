/**
 * Tier CF — what a function component's failure means (spec §6.8.1).
 *
 * A component that fails fails the operation it is part of. Carrying on is a
 * decision: `printErrors()` for a component that says so about itself,
 * `<PrintErrors>` for a document that says so about a region. These
 * distinguish a *failed* operation from a completed one that happens to contain
 * a printed error — reading the output alone cannot tell those apart — so each case
 * asserts the outcome, what was observed, and the identity of the failure that
 * survived, rather than searching a rendered message.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, Err, Ok, resource, scoped, spawn, suspend, until, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import { rm, writeTextFile } from "@effectionx/fs";
import { InMemoryStream, StaleInputError } from "@executablemd/durable-streams";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Component, content } from "../src/component-api.ts";
import { printErrors } from "../src/component-failures.ts";
import { registerComponents } from "../src/components/registration.ts";
import type { ComponentRegistration } from "../src/components/registration.ts";
import { ContentError, DocumentationError, ErrorMode } from "../src/errors.ts";
import { execute } from "../src/execute.ts";
import { expandSegments } from "../src/expand.ts";
import { InvocationTeardownError } from "../src/invocation.ts";
import { renderSegments } from "../src/render.ts";
import { scanSegments } from "../src/scanner.ts";
import type {
  ComponentFailure,
  ErrorSegment,
  EvalEnv,
  FunctionComponent,
  FunctionComponentDefinition,
  Json,
  Segment,
} from "../src/types.ts";

const NO_PROPS = { type: "object", properties: {}, additionalProperties: false };

function component(name: string, fn: FunctionComponent): FunctionComponentDefinition {
  return { kind: "function", name, props: NO_PROPS, fn };
}

/** A component that throws `failure` from its body. */
function throwing(name: string, failure: unknown): FunctionComponentDefinition {
  // deno-lint-ignore require-yield
  return component(name, function* (): Operation<Json> {
    throw failure;
  });
}

/** A marked component that throws `failure` from its body. */
function printing(name: string, failure: unknown): FunctionComponentDefinition {
  return component(
    name,
    printErrors(
      // deno-lint-ignore require-yield
      function* (): Operation<Json> {
        throw failure;
      },
    ),
  );
}

/** A component whose teardown fails, after its body has returned normally. */
function tearingDown(name: string, failure: unknown, body?: unknown): FunctionComponentDefinition {
  return component(name, function* (): Operation<Json> {
    yield* ensure(function* () {
      throw failure;
    });
    if (body !== undefined) {
      throw body;
    }
    return "ok";
  });
}

/** A component that renders the content it was given. */
function projecting(name: string): FunctionComponentDefinition {
  return component(name, function* (): Operation<Json> {
    return yield* content();
  });
}

/** A directory for one test's files, removed when the test scope closes. */
function useFixture(): Operation<string> {
  return resource(function* (provide) {
    const dir = yield* until(mkdtemp(join(tmpdir(), "cf-test-")));
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    yield* provide(yield* until(realpath(dir)));
  });
}

interface Run {
  /** Whether the expansion itself failed, and with what. */
  outcome: Result<Segment[]>;
  observed: ErrorSegment[];
  /**
   * Every failure that entered the `handleFailure` chain, recorded by a layer
   * outside the document. One entry per invocation that failed: a failure
   * handled twice, or one converted without being offered, shows up here.
   */
  offered: ComponentFailure[];
  output: string;
}

interface RunOptions {
  mode?: ErrorMode;
  /** Scanned as a document at this path, so invocations carry a position. */
  path?: string;
}

/** Expand `source`, reporting whether the operation itself failed. */
function run(
  source: string,
  definitions: Record<string, FunctionComponentDefinition>,
  options: RunOptions = {},
): Operation<Run> {
  return scoped(function* () {
    const observed: ErrorSegment[] = [];
    const offered: ComponentFailure[] = [];
    if (options.mode) {
      yield* ErrorMode.set(options.mode);
    }
    yield* Component.around({
      *raise([segment], next) {
        observed.push(segment);
        return yield* next(segment);
      },
      *handleFailure([failure], next) {
        offered.push(failure);
        return yield* next(failure);
      },
    });
    const env: EvalEnv = { values: {} };
    yield* Component.around({ env: () => env }, { at: "min" });
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *importComponent([name]) {
          const definition = definitions[name];
          if (!definition) {
            throw new Error(`Cannot resolve component: ${name}`);
          }
          return definition;
        },
      },
      { at: "min" },
    );
    const origin =
      options.path === undefined ? undefined : { path: options.path, baseOffset: 0, baseLine: 1 };
    try {
      const segments = yield* expandSegments(scanSegments(source, origin), {}, {}, new Set());
      return { outcome: Ok(segments), observed, offered, output: renderSegments(segments) };
    } catch (error) {
      // Nothing is lost if expansion ever throws a bare value: the original
      // becomes the cause rather than being replaced by a description of it.
      const failure = error instanceof Error ? error : new Error(String(error), { cause: error });
      return { outcome: Err(failure), observed, offered, output: "" };
    }
  });
}

/** The failure a run ended with, failing the test if it completed instead. */
function failureOf(result: Run): Error {
  if (result.outcome.ok) {
    throw new Error("expected the expansion to fail, but it completed");
  }
  return result.outcome.error;
}

/**
 * The `DocumentationError` a throwing error mode settled a printed failure into.
 *
 * Under a printing error mode the link between a printed error and the failure it was
 * built from travels beside the observation chain rather than on the segment, so
 * this is where a test reads what a boundary actually converted.
 */
function documentationError(result: Run): DocumentationError {
  const error = failureOf(result);
  if (!(error instanceof DocumentationError)) {
    throw new Error(`expected a DocumentationError, got ${String(error)}`);
  }
  return error;
}

/** The wrapper contracts a failure can carry other failures through. */
function nestedCauses(error: object): unknown[] {
  if (error instanceof InvocationTeardownError) {
    return error.causes;
  }
  if (error instanceof AggregateError) {
    return error.errors;
  }
  if (error instanceof Error && error.cause !== undefined) {
    return [error.cause];
  }
  return [];
}

/** Every failure reachable from this one, so identity can be asserted. */
function reachableFrom(error: unknown, seen = new Set<unknown>()): unknown[] {
  if (typeof error !== "object" || error === null || seen.has(error)) {
    return [];
  }
  seen.add(error);
  return [error, ...nestedCauses(error).flatMap((cause) => reachableFrom(cause, seen))];
}

describe("Tier CF — failing is the default", () => {
  it("CF1: an unmarked component's failure fails the operation, and nothing follows", function* () {
    const boom = new Error("boom");
    const result = yield* run("<Boom />\n\nAFTER\n", { Boom: throwing("Boom", boom) });

    // The exact object, so its type and cause survive.
    expect(failureOf(result)).toBe(boom);
    expect(result.output).toBe("");
    expect(result.observed).toEqual([]);
  });

  it("CF1b: a registered default fails by default, with nothing after it", function* () {
    const boom = new Error("registered boom");
    const dir = yield* useFixture();
    yield* writeTextFile(join(dir, "doc.md"), "<Widget />\n\nAFTER\n");

    const registration: ComponentRegistration = {
      name: "Widget",
      origin: "host",
      props: NO_PROPS,
      // deno-lint-ignore require-yield
      *fn(): Operation<Json> {
        throw boom;
      },
    };

    const observed: ErrorSegment[] = [];
    const { result, output } = yield* scoped(function* () {
      yield* Component.around({
        *raise([segment], next) {
          observed.push(segment);
          return yield* next(segment);
        },
      });
      yield* registerComponents([registration]);
      const execution = yield* execute({
        path: join(dir, "doc.md"),
        stream: new InMemoryStream(),
        includes: [dir],
      });
      const subscription = yield* execution.output;
      let next = yield* subscription.next();
      while (!next.done) {
        next = yield* subscription.next();
      }
      return { result: yield* execution, output: next.value };
    });

    // Resolved through the registry by the real selector, not a stubbed import:
    // registration alone does not make a component's failure into a note.
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(boom);
    // Nothing became a printed error, and nothing after the failure ran.
    expect(observed).toEqual([]);
    expect(output).not.toContain("AFTER");
    expect(output).not.toContain("registered boom");
  });

  it("CF2: a teardown-only failure propagates after teardown finishes", function* () {
    const boom = new Error("cleanup");
    const result = yield* run("<T />\n", { T: tearingDown("T", boom) });

    // Wrapped by the invocation boundary, which accounts for every stage that
    // failed — so the original is a member of it rather than the wrapper.
    const error = failureOf(result);
    expect(error).toBeInstanceOf(InvocationTeardownError);
    if (!(error instanceof InvocationTeardownError)) {
      throw new Error("expected an InvocationTeardownError");
    }
    expect(error.causes).toContain(boom);
    expect(error.cause).toBe(boom);
  });

  it("CF3: body and teardown both failing propagates the complete aggregate", function* () {
    const body = new Error("body");
    const teardown = new Error("teardown");
    const result = yield* run("<T />\n", { T: tearingDown("T", teardown, body) });

    const error = failureOf(result);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) {
      throw new Error("expected an AggregateError");
    }
    // Both accounts survive, in that order: what the body did, then what
    // dismantling it did. Neither replaces the other.
    expect(error.errors).toHaveLength(2);
    expect(error.errors[0]).toBe(body);
    const [, second] = error.errors;
    expect(second).toBeInstanceOf(InvocationTeardownError);
    if (!(second instanceof InvocationTeardownError)) {
      throw new Error("expected the second member to be an InvocationTeardownError");
    }
    expect(second.causes).toContain(teardown);
  });

  it("CF4: a non-Error throw is normalized with the exact value as its cause", function* () {
    const result = yield* run("<Boom />\n", { Boom: throwing("Boom", "just a string") });

    const error = failureOf(result);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) {
      throw new Error("expected an Error");
    }
    expect(error.cause).toBe("just a string");
  });
});

describe("Tier CF — printErrors(fn)", () => {
  it("CF5: a marked component reports once and lets later work run", function* () {
    const boom = new Error("boom");
    const result = yield* run("<Boom />\n\nAFTER\n", { Boom: printing("Boom", boom) });

    expect(result.outcome.ok).toBe(true);
    expect(result.observed).toHaveLength(1);
    expect(result.output).toContain("boom");
    expect(result.output).toContain("AFTER");
  });

  it("CF6: the marker is function identity, not component name", function* () {
    const boom = new Error("boom");
    // Marked first, so the name really has been spoken for...
    printing("Boom", new Error("never invoked"));
    // ...and this is a different function object invoked under that same name.
    const result = yield* run("<Boom />\n\nAFTER\n", { Boom: throwing("Boom", boom) });

    expect(failureOf(result)).toBe(boom);
    expect(result.observed).toEqual([]);
    expect(result.output).toBe("");
  });

  it("CF7: a marked component prints a teardown-only failure", function* () {
    const timeline: string[] = [];
    const marked = component(
      "T",
      printErrors(function* (): Operation<Json> {
        yield* ensure(function* () {
          timeline.push("cleanup");
        });
        yield* ensure(function* () {
          throw new Error("cleanup failed");
        });
        return "ok";
      }),
    );

    const result = yield* scoped(function* () {
      yield* Component.around({
        *raise([segment], next) {
          timeline.push("reported");
          return yield* next(segment);
        },
      });
      return yield* run("<T />\n\nAFTER\n", { T: marked });
    });

    expect(result.outcome.ok).toBe(true);
    expect(result.observed).toHaveLength(1);
    // The boundary sits outside the whole invocation, so teardown had already
    // run to completion when the failure it produced was converted — not merely
    // that both happened.
    expect(timeline).toEqual(["cleanup", "reported"]);
    expect(result.output).toContain("AFTER");
  });

  it("CF7b: a marked component prints an unmarked nested failure it projected", function* () {
    const nested = new Error("nested");
    const outer = component(
      "Outer",
      printErrors(function* (): Operation<Json> {
        return yield* content();
      }),
    );
    const source = "<Outer>\n<Boom />\n</Outer>\n\nAFTER\n";
    const definitions = { Outer: outer, Boom: throwing("Boom", nested) };

    const printed = yield* run(source, definitions);
    expect(printed.outcome.ok).toBe(true);
    expect(printed.observed).toHaveLength(1);
    expect(printed.output).toContain("AFTER");
    // The child's own invocation is what failed and what was handled — once.
    // The outer component's content transport is not offered as a failure of
    // its own, so this stays at one rather than becoming two.
    expect(printed.offered).toHaveLength(1);
    expect(printed.offered[0].name).toBe("Boom");
    expect(printed.offered[0].error).toBe(nested);

    // The child's failure is what the boundary converted, by identity.
    const thrown = yield* run(source, definitions, { mode: "throw" });
    expect(reachableFrom(documentationError(thrown).cause)).toContain(nested);
  });

  it("CF7c: a marked component does not print a durability failure", function* () {
    const stale = new StaleInputError("the journal no longer describes this run");
    const result = yield* run("<Boom />\n\nAFTER\n", { Boom: printing("Boom", stale) });

    expect(failureOf(result)).toBe(stale);
    expect(result.observed).toEqual([]);
  });

  it("CF7d: under a throwing error mode a marked component reports once and still stops", function* () {
    const boom = new Error("boom");
    const result = yield* run(
      "<Boom />\n\nAFTER\n",
      { Boom: printing("Boom", boom) },
      {
        mode: "throw",
      },
    );

    expect(result.observed).toHaveLength(1);
    // The failure the boundary was handed and the printed error's cause are one
    // object — not two things that describe the same mishap.
    expect(result.offered).toHaveLength(1);
    expect(result.offered[0].error).toBe(boom);
    expect(documentationError(result).cause).toBe(result.offered[0].error);
  });

  it("CF7e: a printed teardown-only failure keeps the original inside its cause", function* () {
    const cleanup = new Error("cleanup");
    const marked = component(
      "T",
      printErrors(function* (): Operation<Json> {
        yield* ensure(function* () {
          throw cleanup;
        });
        return "ok";
      }),
    );

    const result = yield* run("<T />\n", { T: marked }, { mode: "throw" });

    // A teardown-only invocation hands over the boundary's account of teardown
    // rather than the raw cleanup error — which is a member of it.
    expect(result.offered).toHaveLength(1);
    const offered = result.offered[0].error;
    expect(offered).toBeInstanceOf(InvocationTeardownError);
    if (!(offered instanceof InvocationTeardownError)) {
      throw new Error("expected an InvocationTeardownError");
    }
    expect(offered.causes).toContain(cleanup);
    expect(offered.cause).toBe(cleanup);
    expect(documentationError(result).cause).toBe(offered);
  });

  it("CF7f: body and teardown both failing print as one complete aggregate", function* () {
    const body = new Error("body");
    const teardown = new Error("teardown");
    const marked = () =>
      component(
        "T",
        printErrors(function* (): Operation<Json> {
          yield* ensure(function* () {
            throw teardown;
          });
          throw body;
        }),
      );

    /** The complete aggregate a run handed to its boundary. */
    function aggregateOf(result: Run): AggregateError {
      expect(result.offered).toHaveLength(1);
      const offered = result.offered[0].error;
      expect(offered).toBeInstanceOf(AggregateError);
      if (!(offered instanceof AggregateError)) {
        throw new Error("expected an AggregateError");
      }
      // What the body did, then what dismantling it did: neither replaces the
      // other, and both originals survive by identity.
      expect(offered.errors).toHaveLength(2);
      expect(offered.errors[0]).toBe(body);
      const [, second] = offered.errors;
      expect(second).toBeInstanceOf(InvocationTeardownError);
      if (!(second instanceof InvocationTeardownError)) {
        throw new Error("expected the second member to be an InvocationTeardownError");
      }
      expect(second.causes).toContain(teardown);
      return offered;
    }

    const printed = yield* run("<T />\n\nAFTER\n", { T: marked() });
    expect(printed.outcome.ok).toBe(true);
    expect(printed.observed).toHaveLength(1);
    expect(printed.output).toContain("AFTER");
    aggregateOf(printed);

    // The same account under the other error mode. Each invocation builds its own
    // aggregate, so identity holds within a run rather than across two.
    const thrown = yield* run("<T />\n\nAFTER\n", { T: marked() }, { mode: "throw" });
    expect(thrown.observed).toHaveLength(1);
    expect(documentationError(thrown).cause).toBe(aggregateOf(thrown));
  });

  it("CF7g: the failure carries the invocation's name, position and complete error", function* () {
    const cleanup = new Error("cleanup");
    let seen: ComponentFailure | undefined;
    const marked = component(
      "T",
      printErrors(function* (): Operation<Json> {
        yield* ensure(function* () {
          throw cleanup;
        });
        return "ok";
      }),
    );

    yield* scoped(function* () {
      yield* Component.around({
        *handleFailure([failure], next) {
          seen = failure;
          return yield* next(failure);
        },
      });
      yield* run("intro\n\n<T />\n", { T: marked }, { path: "doc.md" });
    });

    expect(seen?.name).toBe("T");
    expect(seen?.position?.path).toBe("doc.md");
    expect(seen?.position?.line).toBe(3);
    expect(seen?.position?.column).toBe(1);
    // A detached copy of the call site, not the element the parser built.
    expect(Object.isFrozen(seen?.position)).toBe(true);
    // Delivered after teardown, and complete: the payload carries the
    // boundary's whole account of dismantling, with the original inside it.
    expect(seen?.error).toBeInstanceOf(InvocationTeardownError);
    if (!(seen?.error instanceof InvocationTeardownError)) {
      throw new Error("expected the offered error to be an InvocationTeardownError");
    }
    expect(seen.error.causes).toContain(cleanup);
    expect(seen.error.cause).toBe(cleanup);
  });

  it("CF7h: halting a marked invocation tears down without reporting anything", function* () {
    const timeline: string[] = [];
    const acquired = withResolvers<void>();
    const marked = component(
      "Hang",
      printErrors(function* (): Operation<Json> {
        yield* ensure(function* () {
          timeline.push("released");
        });
        timeline.push("acquired");
        acquired.resolve();
        yield* suspend();
        return "never reached";
      }),
    );

    const observed: ErrorSegment[] = [];
    const offered: ComponentFailure[] = [];
    yield* scoped(function* () {
      yield* Component.around({
        *raise([segment], next) {
          observed.push(segment);
          return yield* next(segment);
        },
        *handleFailure([failure], next) {
          offered.push(failure);
          return yield* next(failure);
        },
      });
      const task = yield* spawn(() => run("<Hang />\n", { Hang: marked }));
      yield* acquired.operation;
      yield* task.halt();
    });

    // Cancellation is not a printed error: cleanup completed before halt returned,
    // and nothing was converted into an ErrorSegment on the way out.
    expect(timeline).toEqual(["acquired", "released"]);
    expect(observed).toEqual([]);
    expect(offered).toEqual([]);
  });
});

describe("Tier CF — <PrintErrors>", () => {
  it("CF8: it handles a child's failure and continues to the next child", function* () {
    const result = yield* run("<PrintErrors>\n<Boom />\n\nSTILL RUNS\n</PrintErrors>\n\nAFTER\n", {
      Boom: throwing("Boom", new Error("boom")),
    });

    expect(result.outcome.ok).toBe(true);
    expect(result.observed).toHaveLength(1);
    expect(result.output).toContain("STILL RUNS");
    expect(result.output).toContain("AFTER");
  });

  it("CF9: it reaches a failure nested inside another component", function* () {
    const nested = new Error("nested");
    const source = "<PrintErrors>\n<Outer>\n<Boom />\n</Outer>\n</PrintErrors>\n\nAFTER\n";
    const definitions = { Outer: projecting("Outer"), Boom: throwing("Boom", nested) };

    const result = yield* run(source, definitions);
    expect(result.outcome.ok).toBe(true);
    // Handled once, by the nearest boundary — not again on the way out.
    expect(result.observed).toHaveLength(1);
    expect(result.output).toContain("AFTER");

    const thrown = yield* run(source, definitions, { mode: "throw" });
    expect(reachableFrom(documentationError(thrown).cause)).toContain(nested);
  });

  it("CF9b: the nearest of two nested boundaries handles it, and only it", function* () {
    const boom = new Error("boom");
    const result = yield* run(
      "<PrintErrors>\n<PrintErrors>\n<Boom />\n</PrintErrors>\n\nINNER DONE\n" +
        "</PrintErrors>\n\nAFTER\n",
      { Boom: throwing("Boom", boom) },
    );

    expect(result.outcome.ok).toBe(true);
    expect(result.output).toContain("INNER DONE");
    expect(result.output).toContain("AFTER");
    // The inner boundary is terminal: it answers rather than delegating, so the
    // enclosing one never converts the same failure a second time. Two
    // conversions would be two printed errors, and a re-offer would be two entries.
    expect(result.observed).toHaveLength(1);
    expect(result.offered).toHaveLength(1);
    expect(result.offered[0].error).toBe(boom);
  });

  it("CF9c: a marked component inside the element is handled once, by itself", function* () {
    const boom = new Error("boom");
    const result = yield* run("<PrintErrors>\n<Boom />\n\nSTILL RUNS\n</PrintErrors>\n\nAFTER\n", {
      Boom: printing("Boom", boom),
    });

    expect(result.outcome.ok).toBe(true);
    expect(result.output).toContain("STILL RUNS");
    expect(result.output).toContain("AFTER");
    // The component's own boundary is nearer than the element's, and terminal.
    expect(result.observed).toHaveLength(1);
    expect(result.offered).toHaveLength(1);
    expect(result.offered[0].error).toBe(boom);
  });

  it("CF10: it does not print a durability failure", function* () {
    const stale = new StaleInputError("the journal no longer describes this run");
    const result = yield* run("<PrintErrors>\n<Boom />\n</PrintErrors>\n", {
      Boom: throwing("Boom", stale),
    });

    expect(failureOf(result)).toBe(stale);
  });

  it("CF11: under a throwing error mode it reports once and still stops", function* () {
    const boom = new Error("boom");
    const result = yield* run(
      "<PrintErrors>\n<Boom />\n</PrintErrors>\n\nAFTER\n",
      { Boom: throwing("Boom", boom) },
      { mode: "throw" },
    );

    // Printing converts the failure into a printed error; the caller's error mode
    // still decides what a printed error means, and documentation stops. The
    // printed error keeps the exact failure it was built from.
    expect(documentationError(result).cause).toBe(boom);
    expect(result.observed).toHaveLength(1);
  });
});

describe("Tier CF — <PrintErrors> accepts no props", () => {
  /** A component that records having run, so a skipped body is observable. */
  function sentinel(ran: string[]): FunctionComponentDefinition {
    // deno-lint-ignore require-yield
    return component("Sentinel", function* (): Operation<Json> {
      ran.push("Sentinel");
      return "SENTINEL RAN";
    });
  }

  it("CF12: a literal prop is a syntax error and the body does not run", function* () {
    const ran: string[] = [];
    const result = yield* run('<PrintErrors unexpected="value">\n<Sentinel />\n</PrintErrors>\n', {
      Sentinel: sentinel(ran),
    });

    expect(result.outcome.ok).toBe(true);
    expect(result.observed).toHaveLength(1);
    expect(result.observed[0].source).toBe("PrintErrors");
    expect(result.observed[0].message).toContain("accepts no props");
    expect(result.observed[0].message).toContain("unexpected");
    // No body effect runs after invalid syntax, and nothing of it is rendered.
    expect(ran).toEqual([]);
    expect(result.output).not.toContain("SENTINEL RAN");
  });

  it("CF13: an expression prop is rejected without ever being evaluated", function* () {
    const ran: string[] = [];
    const result = yield* run(
      "<PrintErrors when={missing.property}>\n<Sentinel />\n</PrintErrors>\n",
      { Sentinel: sentinel(ran) },
    );

    // The mistake is the prop being written at all, so the printed error names
    // that rather than whatever evaluating it would have gone wrong with.
    expect(result.observed).toHaveLength(1);
    expect(result.observed[0].source).toBe("PrintErrors");
    expect(result.observed[0].message).toContain("accepts no props");
    expect(result.observed[0].message).toContain("when");
    expect(result.observed[0].message).not.toContain("missing");
    expect(ran).toEqual([]);
  });

  it("CF14: `as` and `slot` are props here, not fields of their own", function* () {
    const ran: string[] = [];
    const bound = yield* run('<PrintErrors as="captured">\n<Sentinel />\n</PrintErrors>\n', {
      Sentinel: sentinel(ran),
    });
    expect(bound.observed).toHaveLength(1);
    expect(bound.observed[0].message).toContain('Got: "as"');

    const slotted = yield* run('<PrintErrors slot="body">\n<Sentinel />\n</PrintErrors>\n', {
      Sentinel: sentinel(ran),
    });
    expect(slotted.observed).toHaveLength(1);
    expect(slotted.observed[0].message).toContain('Got: "slot"');

    expect(ran).toEqual([]);
  });

  it("CF15: the printed error is positioned, and reported exactly once", function* () {
    const ran: string[] = [];
    const result = yield* run(
      'intro\n\n<PrintErrors bad="1" worse="2">\n<Sentinel />\n</PrintErrors>\n',
      { Sentinel: sentinel(ran) },
      { path: "doc.md" },
    );

    expect(result.observed).toHaveLength(1);
    expect(result.observed[0].message).toContain("doc.md:3:1");
    // Deterministically the first invalid prop, not an arbitrary one.
    expect(result.observed[0].message).toContain('Got: "bad"');
    expect(ran).toEqual([]);
  });

  it("CF16: a valid no-props element still prints and expands its body", function* () {
    const ran: string[] = [];
    const result = yield* run(
      "<PrintErrors>\n<Sentinel />\n\n<Boom />\n\nSTILL RUNS\n</PrintErrors>\n\nAFTER\n",
      { Sentinel: sentinel(ran), Boom: throwing("Boom", new Error("boom")) },
    );

    expect(result.outcome.ok).toBe(true);
    expect(ran).toEqual(["Sentinel"]);
    expect(result.output).toContain("SENTINEL RAN");
    expect(result.output).toContain("STILL RUNS");
    expect(result.output).toContain("AFTER");
    // One printed error: the child's failure, not a syntax complaint.
    expect(result.observed).toHaveLength(1);
    expect(result.observed[0].source).toBe("Boom");
  });
});

describe("Tier CF — what a printing boundary is never offered", () => {
  it("CF17: a prop schema failure stays a structured printed error", function* () {
    const strict: FunctionComponentDefinition = {
      kind: "function",
      name: "Strict",
      props: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
      // deno-lint-ignore require-yield
      *fn(): Operation<Json> {
        return "never reached";
      },
    };

    const invalid = yield* run('<Strict n="not a number" />\n', { Strict: strict });
    expect(invalid.observed).toHaveLength(1);
    expect(invalid.observed[0].source).toBe("Strict");
    // Never converted through the failure channel — it already has a structured
    // representation of its own.
    expect(invalid.offered).toEqual([]);

    // Positive control, through the same spy: an ordinary failure does reach it,
    // so an empty `offered` above is about the schema and not about the harness.
    const boom = new Error("boom");
    const ordinary = yield* run("<Boom />\n", { Boom: throwing("Boom", boom) });
    expect(ordinary.offered).toHaveLength(1);
    expect(ordinary.offered[0].error).toBe(boom);
  });

  it("CF18: a declared `returns` violation stays a structured printed error", function* () {
    const valued: FunctionComponentDefinition = {
      kind: "function",
      name: "Valued",
      props: NO_PROPS,
      returns: {
        type: "object",
        properties: { passed: { type: "boolean" } },
        required: ["passed"],
      },
      // deno-lint-ignore require-yield
      *fn(): Operation<Json> {
        return { passed: "yes" };
      },
    };

    const result = yield* run('<Valued as="outcome" />\n', { Valued: valued });

    expect(result.observed).toHaveLength(1);
    expect(result.observed[0].source).toBe("Valued");
    expect(result.observed[0].message).toContain("Return validation failed");
    expect(result.offered).toEqual([]);
  });

  it("CF19: an uncaught content failure restores its segments without a second report", function* () {
    const boom = new Error("boom");
    const result = yield* run("<PrintErrors>\n<Outer>\n<Boom />\n</Outer>\n</PrintErrors>\n", {
      Outer: projecting("Outer"),
      Boom: throwing("Boom", boom),
    });

    // One observation, for the child's failure — the boundary converted it, so
    // the content the outer component asked for came back holding a printed error.
    // The transport that carries those already-reported segments back out is not
    // a failure of the component that projected them: it restores them instead,
    // so there is no second printed error and nothing else is offered as a failure.
    expect(result.outcome.ok).toBe(true);
    expect(result.observed).toHaveLength(1);
    expect(result.offered).toHaveLength(1);
    expect(result.offered[0].name).toBe("Boom");
    expect(result.offered[0].error).toBe(boom);

    // Restored, not rebuilt: the segment the document ends up holding is the
    // very object that was observed when the child's failure was converted.
    if (!result.outcome.ok) {
      throw new Error("expected the expansion to complete");
    }
    const restored = result.outcome.value.filter((segment) => segment.type === "error");
    expect(restored).toHaveLength(1);
    expect(restored[0]).toBe(result.observed[0]);
  });

  it("CF20: catching a content failure is recovery, and reports nothing further", function* () {
    const strict: FunctionComponentDefinition = {
      kind: "function",
      name: "Strict",
      props: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
      // deno-lint-ignore require-yield
      *fn(): Operation<Json> {
        return "never reached";
      },
    };
    let caught: ContentError | undefined;
    const recovering = component("Recovering", function* (): Operation<Json> {
      try {
        return yield* content();
      } catch (error) {
        if (error instanceof ContentError) {
          caught = error;
          return "RECOVERED";
        }
        throw error;
      }
    });

    const result = yield* run(
      '<Recovering>\n<Strict n="not a number" />\n</Recovering>\n\nAFTER\n',
      {
        Recovering: recovering,
        Strict: strict,
      },
    );

    expect(result.outcome.ok).toBe(true);
    expect(result.output).toContain("RECOVERED");
    expect(result.output).toContain("AFTER");
    // The component decided what the document says instead, so the printed error it
    // caught is not reported again — and what reached it is the same object the
    // document reported, not a copy that merely looks like one.
    expect(result.observed).toHaveLength(1);
    expect(caught?.errors).toHaveLength(1);
    expect(caught?.errors[0]).toBe(result.observed[0]);
    expect(result.output).not.toContain("not a number");
    // A schema printed error is never a component failure, before or after recovery.
    expect(result.offered).toEqual([]);
  });
});
