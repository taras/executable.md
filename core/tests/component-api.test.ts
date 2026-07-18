/**
 * Component Api tests — default operations, missing-provider diagnostics,
 * scoped middleware overrides, and nested provider precedence.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import {
  Component,
  importComponent,
  applyModifiers,
  raise,
  env,
  evalScope,
  codeBlock,
  persistent,
  content,
} from "../src/component-api.ts";
import { persistFactory } from "../src/modifiers/persist.ts";
import type { ComponentDefinition, ErrorSegment } from "../src/types.ts";

function stubComponent(name: string): ComponentDefinition {
  return { kind: "markdown", name, path: `${name}.md`, meta: {}, inputs: {}, bodySegments: [] };
}

function* messageOf(operation: Operation<unknown>): Operation<string> {
  try {
    yield* operation;
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("Component Api", () => {
  // ----- Defaults -----

  it("importComponent without a provider throws a missing-provider error", function* () {
    const message = yield* messageOf(importComponent("Missing"));
    expect(message).toContain('importComponent("Missing")');
    expect(message).toContain("has no provider");
  });

  it("applyModifiers without a provider throws a missing-provider error", function* () {
    const block = { language: "bash", content: "x", blockId: "test:0" };
    const message = yield* messageOf(applyModifiers([{ name: "exec" }], block));
    expect(message).toContain("applyModifiers");
    expect(message).toContain("has no provider");
  });

  it("codeBlock without a provider throws a missing-provider error", function* () {
    const message = yield* messageOf(codeBlock());
    expect(message).toContain("codeBlock");
    expect(message).toContain("has no provider");
  });

  it("content without a provider throws a missing-provider error", function* () {
    const message = yield* messageOf(content());
    expect(message).toContain("content");
    expect(message).toContain("has no provider");
  });

  it("raise returns the supplied ErrorSegment by default", function* () {
    const segment: ErrorSegment = { type: "error", message: "boom", source: "test" };
    const returned = yield* raise(segment);
    expect(returned).toBe(segment);
  });

  it("env and evalScope default to undefined; persistent defaults to false", function* () {
    expect(yield* env()).toBe(undefined);
    expect(yield* evalScope()).toBe(undefined);
    expect(yield* persistent()).toBe(false);
  });

  // ----- Scoped overrides -----

  it("a scoped max middleware wraps importComponent and is removed on scope exit", function* () {
    const real = stubComponent("Real");
    const aliased = stubComponent("Aliased");
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *importComponent([name], _next) {
          if (name === "Real") {
            return real;
          }
          throw new Error(`Component not found: ${name}`);
        },
      },
      { at: "min" },
    );

    const inside = yield* scoped(function* () {
      yield* Component.around({
        *importComponent([name], next) {
          if (name === "Alias") {
            return aliased;
          }
          return yield* next(name);
        },
      });
      return {
        alias: yield* importComponent("Alias"),
        delegated: yield* importComponent("Real"),
      };
    });
    expect(inside.alias).toBe(aliased);
    expect(inside.delegated).toBe(real);

    // Outside the scope the alias middleware is gone.
    const message = yield* messageOf(importComponent("Alias"));
    expect(message).toContain("Component not found: Alias");
  });

  it("a scoped applyModifiers provider overrides an inherited one and is removed on exit", function* () {
    const block = { language: "bash", content: "x", blockId: "test:0" };
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *applyModifiers(_args, _next) {
          return { output: "outer\n", exitCode: 0, stderr: "" };
        },
      },
      { at: "min" },
    );

    const inner = yield* scoped(function* () {
      yield* Component.around(
        {
          // deno-lint-ignore require-yield
          *applyModifiers(_args, _next) {
            return { output: "inner\n", exitCode: 0, stderr: "" };
          },
        },
        { at: "min" },
      );
      return yield* applyModifiers([], block);
    });
    expect(inner.output).toBe("inner\n");

    const outer = yield* applyModifiers([], block);
    expect(outer.output).toBe("outer\n");
  });

  // ----- Nested precedence without sibling leakage -----

  it("nested env providers override ancestors without leaking into siblings", function* () {
    const outerEnv = { values: { tag: "outer" } };
    const innerEnv = { values: { tag: "inner" } };
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *env(_args, _next) {
          return outerEnv;
        },
      },
      { at: "min" },
    );

    const first = yield* scoped(function* () {
      yield* Component.around(
        {
          // deno-lint-ignore require-yield
          *env(_args, _next) {
            return innerEnv;
          },
        },
        { at: "min" },
      );
      return yield* env();
    });
    expect(first).toBe(innerEnv);

    // A sibling scope sees the ancestor provider, not the first sibling's.
    const second = yield* scoped(function* () {
      return yield* env();
    });
    expect(second).toBe(outerEnv);
  });

  // ----- Persistent evaluation flag -----

  it("persistent() is true inside the persist modifier chain and false outside", function* () {
    let observed: boolean | undefined = undefined;
    const middleware = persistFactory(undefined);
    const terminal = function* () {
      observed = yield* persistent();
      return { output: "", exitCode: 0, stderr: "" };
    };
    yield* middleware([], terminal) as unknown as Operation<unknown>;
    expect(observed).toBe(true);
    expect(yield* persistent()).toBe(false);
  });

  // ----- Content provider dispatch -----

  it("content(slot) dispatches through the installed provider", function* () {
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *content([slot], _next) {
          if (slot !== undefined) {
            return `slot:${slot}`;
          }
          return "default";
        },
      },
      { at: "min" },
    );
    expect(yield* content()).toBe("default");
    expect(yield* content("header")).toBe("slot:header");
  });
});
