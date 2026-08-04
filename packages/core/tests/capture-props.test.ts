/**
 * Tier CP — capture props (spec §6.5).
 *
 * A capture is a prop the engine does not resolve. The component evaluates it
 * itself, so the value arrives live: no JSON gate, no clone, and therefore an
 * operand a schema cannot describe — a RegExp, `undefined`, a specific object.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { Component, capture, hasCapture } from "../src/component-api.ts";
import { expandSegments } from "../src/expand.ts";
import { scanSegments } from "../src/scanner.ts";
import type { EvalEnv, FunctionComponentDefinition, Json } from "../src/types.ts";

describe("Tier CP — capture props", () => {
  it("CP1: delivers an operand by identity, unserialized", function* () {
    const marker = { live: true };
    const re = /abc/;
    let seen: Record<string, unknown> = {};
    const def: FunctionComponentDefinition = {
      kind: "function",
      name: "Probe",
      props: { type: "object", properties: {}, additionalProperties: false },
      captures: ["actual", "expected"],
      // deno-lint-ignore require-yield
      *fn(): Operation<unknown> {
        return "";
      },
    };
    const probing: FunctionComponentDefinition = {
      ...def,
      *fn(): Operation<unknown> {
        seen = {
          hasActual: yield* hasCapture("actual"),
          hasMissing: yield* hasCapture("nope"),
          actual: yield* capture("actual"),
          expected: yield* capture("expected"),
        };
        return "";
      },
    };
    yield* scoped(function* () {
      const env: EvalEnv = { values: { marker, re } };
      yield* Component.around({ env: () => env }, { at: "min" });
      yield* Component.around(
        {
          // deno-lint-ignore require-yield
          *importComponent() {
            return probing;
          },
        },
        { at: "min" },
      );
      yield* expandSegments(
        scanSegments("<Probe actual={marker} expected={re} />\n"),
        {},
        {},
        new Set(),
      );
    });
    expect(seen.hasActual).toBe(true);
    expect(seen.hasMissing).toBe(false);
    expect(seen.actual).toBe(marker);
    expect(seen.expected).toBe(re);
  });

  it("CP2: a return binds by reference under `as`, and renders nothing without it", function* () {
    const payload = { kind: "by-ref" };
    const def: FunctionComponentDefinition = {
      kind: "function",
      name: "Living",
      props: { type: "object", properties: {}, additionalProperties: false },
      // deno-lint-ignore require-yield
      *fn(): Operation<unknown> {
        return payload;
      },
    };

    const env: EvalEnv = { values: {} };
    const rendered = yield* scoped(function* () {
      yield* Component.around({ env: () => env }, { at: "min" });
      yield* Component.around(
        {
          // deno-lint-ignore require-yield
          *importComponent() {
            return def;
          },
        },
        { at: "min" },
      );
      return yield* expandSegments(
        scanSegments('<Living as="caught" />\n\n<Living />\n'),
        {},
        {},
        new Set(),
      );
    });

    // The very object, not a copy of it, and not its stringified text.
    expect(env.values.caught).toBe(payload);
    // A non-string return renders nothing rather than being stringified in.
    expect(rendered.some((s) => s.type === "text" && s.content.includes("by-ref"))).toBe(false);
  });

  it("CP3: never evaluates a capture the component does not ask for", function* () {
    let evaluated = 0;
    const def: FunctionComponentDefinition = {
      kind: "function",
      name: "Lazy",
      props: { type: "object", properties: {}, additionalProperties: false },
      captures: ["boom"],
      // deno-lint-ignore require-yield
      *fn(): Operation<unknown> {
        return "";
      },
    };

    yield* scoped(function* () {
      const env: EvalEnv = {
        values: {
          detonate: () => {
            evaluated += 1;
            throw new Error("should never run");
          },
        },
      };
      yield* Component.around({ env: () => env }, { at: "min" });
      yield* Component.around(
        {
          // deno-lint-ignore require-yield
          *importComponent() {
            return def;
          },
        },
        { at: "min" },
      );
      yield* expandSegments(scanSegments("<Lazy boom={detonate()} />\n"), {}, {}, new Set());
    });

    // Deferred: the expression is not evaluated during prop resolution, so a
    // capture the component skips is inert.
    expect(evaluated).toBe(0);
  });

  it("CP4: an operand expression that throws is the component's failure", function* () {
    const boom = new Error("operand exploded");
    let caught: unknown;
    const def: FunctionComponentDefinition = {
      kind: "function",
      name: "Asking",
      props: { type: "object", properties: {}, additionalProperties: false },
      captures: ["actual"],
      *fn(): Operation<unknown> {
        try {
          yield* capture("actual");
        } catch (error) {
          caught = error;
        }
        return "";
      },
    };

    yield* scoped(function* () {
      const env: EvalEnv = {
        values: {
          detonate: () => {
            throw boom;
          },
        },
      };
      yield* Component.around({ env: () => env }, { at: "min" });
      yield* Component.around(
        {
          // deno-lint-ignore require-yield
          *importComponent() {
            return def;
          },
        },
        { at: "min" },
      );
      yield* expandSegments(scanSegments("<Asking actual={detonate()} />\n"), {}, {}, new Set());
    });

    // The component owns the failure: it caught it, rather than the engine
    // turning it into a prop printed error before the component ever ran. The
    // wrapper names the operand, and the original is reachable by identity
    // through its cause.
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toContain("actual={detonate()}");
    expect(reaches(caught, boom)).toBe(true);
  });

  it("CP5: the JSON gate still holds for props that are not captures", function* () {
    const observed: string[] = [];
    const def: FunctionComponentDefinition = {
      kind: "function",
      name: "Ordinary",
      props: { type: "object", properties: { n: {} }, additionalProperties: false },
      // deno-lint-ignore require-yield
      *fn(): Operation<unknown> {
        return "";
      },
    };

    yield* scoped(function* () {
      const env: EvalEnv = { values: { nothing: undefined } };
      yield* Component.around({ env: () => env }, { at: "min" });
      yield* Component.around({
        *raise([segment], next) {
          observed.push(segment.message);
          return yield* next(segment);
        },
      });
      yield* Component.around(
        {
          // deno-lint-ignore require-yield
          *importComponent() {
            return def;
          },
        },
        { at: "min" },
      );
      yield* expandSegments(scanSegments("<Ordinary n={nothing} />\n"), {}, {}, new Set());
    });

    // Undeclared as a capture, so it still meets the gate that rejects a
    // non-serializable value — the widening is opt-in, not global.
    expect(observed.join(" ")).toContain("non-serializable");
  });

  it("CP6: `as` binds a non-string return by identity, not its text", function* () {
    const payload = { verdict: "kept" };
    const def: FunctionComponentDefinition = {
      kind: "function",
      name: "Verdict",
      props: { type: "object", properties: {}, additionalProperties: false },
      // deno-lint-ignore require-yield
      *fn(): Operation<unknown> {
        return payload;
      },
    };

    const env: EvalEnv = { values: {} };
    yield* scoped(function* () {
      yield* Component.around({ env: () => env }, { at: "min" });
      yield* Component.around(
        {
          // deno-lint-ignore require-yield
          *importComponent() {
            return def;
          },
        },
        { at: "min" },
      );
      yield* expandSegments(scanSegments('<Verdict as="v" />\n'), {}, {}, new Set());
    });

    // Before this became the default, `as` bound the stringified text.
    expect(env.values.v).toBe(payload);
    expect(typeof env.values.v).not.toBe("string");
  });

  it("CP7: a string return still renders, a non-string does not", function* () {
    function definition(name: string, value: unknown): FunctionComponentDefinition {
      return {
        kind: "function",
        name,
        props: { type: "object", properties: {}, additionalProperties: false },
        // deno-lint-ignore require-yield
        *fn(): Operation<unknown> {
          return value;
        },
      };
    }
    const defs: Record<string, FunctionComponentDefinition> = {
      Texty: definition("Texty", "RENDERED TEXT"),
      Objecty: definition("Objecty", { hidden: true }),
    };

    const rendered = yield* scoped(function* () {
      const env: EvalEnv = { values: {} };
      yield* Component.around({ env: () => env }, { at: "min" });
      yield* Component.around(
        {
          // deno-lint-ignore require-yield
          *importComponent([name]) {
            const found = defs[name];
            if (!found) {
              throw new Error(`no component ${name}`);
            }
            return found;
          },
        },
        { at: "min" },
      );
      return yield* expandSegments(scanSegments("<Texty />\n\n<Objecty />\n"), {}, {}, new Set());
    });

    const text = rendered
      .filter((s) => s.type === "text")
      .map((s) => (s.type === "text" ? s.content : ""))
      .join("");
    expect(text).toContain("RENDERED TEXT");
    expect(text).not.toContain("hidden");
  });
});

/** Whether `target` is reachable from `error` by identity. */
function reaches(error: unknown, target: unknown, seen = new Set<unknown>()): boolean {
  if (error === target) {
    return true;
  }
  if (typeof error !== "object" || error === null || seen.has(error)) {
    return false;
  }
  seen.add(error);
  if (error instanceof AggregateError && error.errors.some((e) => reaches(e, target, seen))) {
    return true;
  }
  return error instanceof Error && error.cause !== undefined
    ? reaches(error.cause, target, seen)
    : false;
}
