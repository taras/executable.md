import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { expandSegments } from "../src/expand.ts";
import { Component } from "../src/component-api.ts";
import { scanSegments } from "../src/scanner.ts";
import { renderSegments } from "../src/render.ts";
import type { ComponentDefinition, EvalEnv, InvocationContext, Segment } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeComponent(name: string, body: string): ComponentDefinition {
  return {
    kind: "markdown",
    name,
    path: `components/${name}.md`,
    meta: {},
    inputs: {},
    bodySegments: scanSegments(body),
  };
}

function useTestComponents(components: Record<string, ComponentDefinition>): Operation<void> {
  return Component.around(
    {
      // deno-lint-ignore require-yield
      *importComponent([name], _next) {
        const comp = components[name];
        if (!comp) {
          throw new Error(`Component not found: ${name}`);
        }
        return comp;
      },
    },
    { at: "min" },
  );
}

function useTestEnv(testEnv: EvalEnv): Operation<void> {
  return Component.around({ env: () => testEnv }, { at: "min" });
}

// ---------------------------------------------------------------------------
// expandInvocation hook
// ---------------------------------------------------------------------------

describe("expandInvocation hook", () => {
  it("falls through to normal expansion when no extension is installed", function* () {
    const output = yield* scoped(function* () {
      yield* useTestComponents({ Greeting: makeComponent("Greeting", "Hello world!") });
      yield* useTestEnv({ values: {} });
      const expanded = yield* expandSegments(scanSegments("<Greeting />"), {}, {}, new Set());
      return renderSegments(expanded);
    });
    expect(output).toBe("Hello world!");
  });

  it("lets an extension claim a name and produce segments", function* () {
    const output = yield* scoped(function* () {
      yield* useTestComponents({});
      yield* useTestEnv({ values: {} });
      yield* Component.around({
        *expandInvocation([invocation, ctx], next) {
          if (invocation.name === "Shout") {
            const inner = yield* ctx.expand(invocation.children);
            return { segments: [{ type: "text", content: renderSegments(inner).toUpperCase() }] };
          }
          return yield* next(invocation, ctx);
        },
      });
      const expanded = yield* expandSegments(
        scanSegments("<Shout>hi there</Shout>"),
        {},
        {},
        new Set(),
      );
      return renderSegments(expanded);
    });
    expect(output).toBe("HI THERE");
  });

  it("delegated names still expand normally alongside claimed names", function* () {
    const output = yield* scoped(function* () {
      yield* useTestComponents({ Greeting: makeComponent("Greeting", "Hello!") });
      yield* useTestEnv({ values: {} });
      yield* Component.around({
        // deno-lint-ignore require-yield
        *expandInvocation([invocation, ctx], next) {
          if (invocation.name === "Nothing") {
            return { segments: [] };
          }
          return yield* next(invocation, ctx);
        },
      });
      const expanded = yield* expandSegments(
        scanSegments("<Nothing />before<Greeting />"),
        {},
        {},
        new Set(),
      );
      return renderSegments(expanded);
    });
    expect(output).toBe("beforeHello!");
  });

  it("distinguishes handled-with-no-output from unhandled", function* () {
    const seen: string[] = [];
    yield* scoped(function* () {
      yield* useTestComponents({ Greeting: makeComponent("Greeting", "Hello!") });
      yield* useTestEnv({ values: {} });
      yield* Component.around({
        // deno-lint-ignore require-yield
        *expandInvocation([invocation, ctx], next) {
          seen.push(invocation.name);
          if (invocation.name === "Silent") {
            return { segments: [] };
          }
          return yield* next(invocation, ctx);
        },
      });
      const expanded = yield* expandSegments(
        scanSegments("<Silent /><Greeting />"),
        {},
        {},
        new Set(),
      );
      expect(renderSegments(expanded)).toBe("Hello!");
    });
    expect(seen).toEqual(["Silent", "Greeting"]);
  });

  it("extension error segments follow the ambient raise policy", function* () {
    const raised: string[] = [];
    const output = yield* scoped(function* () {
      yield* useTestComponents({});
      yield* useTestEnv({ values: {} });
      yield* Component.around({
        *raise([segment], next) {
          raised.push(segment.message);
          return yield* next(segment);
        },
      });
      yield* Component.around({
        // deno-lint-ignore require-yield
        *expandInvocation([invocation, ctx], next) {
          if (invocation.name === "Broken") {
            const error: Segment = { type: "error", message: "broken thing", source: "Broken" };
            return { segments: [error] };
          }
          return yield* next(invocation, ctx);
        },
      });
      const expanded = yield* expandSegments(scanSegments("<Broken />"), {}, {}, new Set());
      return renderSegments(expanded);
    });
    expect(raised).toEqual(["broken thing"]);
    expect(output).toContain("broken thing");
  });

  it("passes projectedEnv and parent meta/props through the context", function* () {
    let observed: InvocationContext | undefined;
    yield* scoped(function* () {
      yield* useTestComponents({});
      yield* useTestEnv({ values: {} });
      yield* Component.around({
        // deno-lint-ignore require-yield
        *expandInvocation([invocation, ctx], next) {
          if (invocation.name === "Probe") {
            observed = ctx;
            return { segments: [] };
          }
          return yield* next(invocation, ctx);
        },
      });
      yield* expandSegments(
        scanSegments("<Probe />"),
        { title: "Doc" },
        { color: "red" },
        new Set(),
      );
    });
    expect(observed?.meta).toEqual({ title: "Doc" });
    expect(observed?.props).toEqual({ color: "red" });
  });
});
