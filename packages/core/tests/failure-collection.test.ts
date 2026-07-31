/**
 * Tier CF — what a function component's failure means (spec §6.9).
 *
 * A component that fails fails the operation it is part of. Carrying on is a
 * decision: `collectFailures()` for a component that says so about itself,
 * `<CollectFailures>` for a document that says so about a region. These
 * distinguish a *failed* operation from a completed one that happens to contain
 * a diagnostic — reading the output alone cannot tell those apart.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped } from "effection";
import type { Operation, Result } from "effection";
import { StaleInputError } from "@executablemd/durable-streams";
import { Component } from "../src/component-api.ts";
import { collectFailures } from "../src/component-failures.ts";
import { AmbientErrorPolicy, DocumentationError } from "../src/errors.ts";
import { expandSegments } from "../src/expand.ts";
import { renderSegments } from "../src/render.ts";
import { scanSegments } from "../src/scanner.ts";
import type {
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

interface Run {
  result: Result<Segment[]>;
  observed: ErrorSegment[];
  output: string;
}

/** Expand `source`, reporting whether the operation itself failed. */
function run(
  source: string,
  definitions: Record<string, FunctionComponentDefinition>,
  policy?: "collect" | "throw",
): Operation<Run> {
  return scoped(function* () {
    const observed: ErrorSegment[] = [];
    if (policy) {
      yield* AmbientErrorPolicy.set(policy);
    }
    yield* Component.around({
      *raise([segment], next) {
        observed.push(segment);
        return yield* next(segment);
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
    try {
      const segments = yield* expandSegments(scanSegments(source), {}, {}, new Set());
      return {
        result: { ok: true, value: segments } as Result<Segment[]>,
        observed,
        output: renderSegments(segments),
      };
    } catch (error) {
      return {
        result: { ok: false, error: error as Error } as Result<Segment[]>,
        observed,
        output: "",
      };
    }
  });
}

describe("Tier CF — failing is the default", () => {
  it("CF1: an unmarked component's failure fails the operation, and nothing follows", function* () {
    const boom = new Error("boom");
    const run1 = yield* run("<Boom />\n\nAFTER\n", { Boom: throwing("Boom", boom) });

    expect(run1.result.ok).toBe(false);
    // The exact object, so its type and cause survive.
    expect(run1.result.ok === false && run1.result.error).toBe(boom);
    expect(run1.output).toBe("");
    expect(run1.observed).toEqual([]);
  });

  it("CF2: a teardown-only failure propagates after teardown finishes", function* () {
    const boom = new Error("cleanup");
    const result = yield* run("<T />\n", { T: tearingDown("T", boom) });

    expect(result.result.ok).toBe(false);
    // Wrapped by the invocation boundary, with the original reachable.
    const error = result.result.ok === false ? result.result.error : undefined;
    expect(String(error)).toContain("cleanup");
  });

  it("CF3: body and teardown both failing propagates the complete aggregate", function* () {
    const body = new Error("body");
    const teardown = new Error("teardown");
    const result = yield* run("<T />\n", { T: tearingDown("T", teardown, body) });

    expect(result.result.ok).toBe(false);
    const error = result.result.ok === false ? result.result.error : undefined;
    // Both accounts survive; neither replaces the other.
    expect(String(error) + JSON.stringify(describeCauses(error))).toContain("body");
    expect(describeCauses(error).join(" ")).toContain("teardown");
  });

  it("CF4: a non-Error throw is normalized with the exact value as its cause", function* () {
    const result = yield* run("<Boom />\n", { Boom: throwing("Boom", "just a string") });

    expect(result.result.ok).toBe(false);
    const error = result.result.ok === false ? result.result.error : undefined;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).cause).toBe("just a string");
  });
});

describe("Tier CF — collectFailures(fn)", () => {
  it("CF5: a marked component reports once and lets later work run", function* () {
    const boom = new Error("boom");
    const marked = component(
      "Boom",
      collectFailures(
        // deno-lint-ignore require-yield
        function* (): Operation<Json> {
          throw boom;
        },
      ),
    );

    const result = yield* run("<Boom />\n\nAFTER\n", { Boom: marked });

    expect(result.result.ok).toBe(true);
    expect(result.observed).toHaveLength(1);
    expect(result.output).toContain("boom");
    expect(result.output).toContain("AFTER");
  });

  it("CF6: the marker is function identity, not component name", function* () {
    const boom = new Error("boom");
    // Same name, different function object: it inherits nothing.
    const result = yield* run("<Boom />\n", { Boom: throwing("Boom", boom) });

    expect(result.result.ok).toBe(false);
    expect(result.result.ok === false && result.result.error).toBe(boom);
  });

  it("CF7: a marked component collects a teardown-only failure", function* () {
    const marked = component(
      "T",
      collectFailures(function* (): Operation<Json> {
        yield* ensure(function* () {
          throw new Error("cleanup");
        });
        return "ok";
      }),
    );

    const result = yield* run("<T />\n\nAFTER\n", { T: marked });

    expect(result.result.ok).toBe(true);
    expect(result.observed).toHaveLength(1);
    expect(result.output).toContain("AFTER");
  });
});

describe("Tier CF — <CollectFailures>", () => {
  it("CF8: it handles a child's failure and continues to the next child", function* () {
    const result = yield* run(
      "<CollectFailures>\n<Boom />\n\nSTILL RUNS\n</CollectFailures>\n\nAFTER\n",
      { Boom: throwing("Boom", new Error("boom")) },
    );

    expect(result.result.ok).toBe(true);
    expect(result.observed).toHaveLength(1);
    expect(result.output).toContain("STILL RUNS");
    expect(result.output).toContain("AFTER");
  });

  it("CF9: it reaches a failure nested inside another component", function* () {
    const outer = component("Outer", function* (): Operation<Json> {
      return yield* Component.operations.content();
    });
    const result = yield* run(
      "<CollectFailures>\n<Outer>\n<Boom />\n</Outer>\n</CollectFailures>\n\nAFTER\n",
      { Outer: outer, Boom: throwing("Boom", new Error("nested")) },
    );

    expect(result.result.ok).toBe(true);
    // Handled once, by the nearest boundary — not again on the way out.
    expect(result.observed).toHaveLength(1);
    expect(result.output).toContain("AFTER");
  });

  it("CF10: it does not collect a durability failure", function* () {
    const stale = new StaleInputError("the journal no longer describes this run");
    const result = yield* run("<CollectFailures>\n<Boom />\n</CollectFailures>\n", {
      Boom: throwing("Boom", stale),
    });

    expect(result.result.ok).toBe(false);
    expect(result.result.ok === false && result.result.error).toBe(stale);
  });

  it("CF11: under a throwing policy it reports once and still stops", function* () {
    const result = yield* run(
      "<CollectFailures>\n<Boom />\n</CollectFailures>\n\nAFTER\n",
      { Boom: throwing("Boom", new Error("boom")) },
      "throw",
    );

    // Collection converts the failure into a diagnostic; the caller's policy
    // still decides what a diagnostic means, and documentation stops.
    expect(result.result.ok).toBe(false);
    expect(result.result.ok === false && result.result.error).toBeInstanceOf(DocumentationError);
    expect(result.observed).toHaveLength(1);
  });
});

/** Every message reachable through a failure's causes and aggregate members. */
function describeCauses(error: unknown, seen = new Set<unknown>()): string[] {
  if (typeof error !== "object" || error === null || seen.has(error)) {
    return [];
  }
  seen.add(error);
  const messages = error instanceof Error ? [error.message] : [];
  const nested: unknown[] = [];
  if (error instanceof AggregateError) {
    nested.push(...error.errors);
  }
  if (error instanceof Error && error.cause !== undefined) {
    nested.push(error.cause);
  }
  const causes = error as { causes?: unknown[] };
  if (Array.isArray(causes.causes)) {
    nested.push(...causes.causes);
  }
  return [...messages, ...nested.flatMap((one) => describeCauses(one, seen))];
}
