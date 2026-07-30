/**
 * Tier IM — invocation metadata (spec §5.5).
 *
 * `invocation()` tells a function component where it was written and nothing
 * else. These drive `expandSegments` directly, so what they assert is the
 * engine's own answer rather than a component's report of it.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { Component, invocation } from "../src/component-api.ts";
import { expandSegments } from "../src/expand.ts";
import { renderSegments } from "../src/render.ts";
import { scanSegments } from "../src/scanner.ts";
import type {
  ComponentInvocationMetadata,
  EvalEnv,
  FunctionComponentDefinition,
  Json,
  Segment,
} from "../src/types.ts";

const NO_PROPS = { type: "object", properties: {}, additionalProperties: false };

function component(name: string, fn: () => Operation<Json>): FunctionComponentDefinition {
  return { kind: "function", name, props: NO_PROPS, fn };
}

/** Expand `source` with `definitions`, as a document at `path` would. */
function run(
  source: string,
  definitions: Record<string, FunctionComponentDefinition>,
  path?: string,
): Operation<Segment[]> {
  return scoped(function* () {
    const env: EvalEnv = { values: {} };
    yield* Component.around({ env: () => env }, { at: "min" });
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *importComponent([name]) {
          const definition = definitions[name];
          if (!definition) {
            throw new Error(`no component ${name}`);
          }
          return definition;
        },
      },
      { at: "min" },
    );
    return yield* expandSegments(
      scanSegments(source, path === undefined ? undefined : { path, baseOffset: 0, baseLine: 1 }),
      {},
      {},
      new Set(),
    );
  });
}

describe("Tier IM — where a component was invoked", () => {
  it("IM1: reports the name and the call site's path, offset, line and column", function* () {
    let seen: ComponentInvocationMetadata | undefined;
    const definitions = {
      Probe: component("Probe", function* () {
        seen = yield* invocation();
        return "";
      }),
    };

    yield* run("intro\n\n<Probe />\n", definitions, "doc.md");

    expect(seen?.name).toBe("Probe");
    expect(seen?.position?.path).toBe("doc.md");
    expect(seen?.position?.line).toBe(3);
    expect(seen?.position?.column).toBe(1);
    expect(typeof seen?.position?.offset).toBe("number");
  });

  // Markdown scanned at runtime has no file, but it does have a place inside
  // the string it was scanned from — which is why a location can still be
  // written `line:column`.
  it("IM2: markdown scanned without a source reports a position with no path", function* () {
    let seen: ComponentInvocationMetadata | undefined;
    const definitions = {
      Probe: component("Probe", function* () {
        seen = yield* invocation();
        return "";
      }),
    };

    yield* run("lead\n\n<Probe />\n", definitions);

    expect(seen?.name).toBe("Probe");
    expect(seen?.position?.path).toBeUndefined();
    expect(seen?.position?.line).toBe(3);
  });

  it("IM2b: an element carrying no position at all reports none", function* () {
    let seen: ComponentInvocationMetadata | undefined;
    const definition = component("Probe", function* () {
      seen = yield* invocation();
      return "";
    });

    yield* scoped(function* () {
      const env: EvalEnv = { values: {} };
      yield* Component.around({ env: () => env }, { at: "min" });
      yield* Component.around(
        {
          // deno-lint-ignore require-yield
          *importComponent() {
            return definition;
          },
        },
        { at: "min" },
      );
      const element: Segment = {
        type: "component",
        name: "Probe",
        props: {},
        expressions: {},
        children: [],
        selfClosing: true,
      };
      return yield* expandSegments([element], {}, {}, new Set());
    });

    expect(seen?.name).toBe("Probe");
    expect(seen?.position).toBeUndefined();
    expect(Object.keys(seen ?? {})).toEqual(["name"]);
  });

  it("IM3: a nested invocation shadows, and the enclosing one is restored", function* () {
    const seen: string[] = [];
    const definitions = {
      Outer: component("Outer", function* () {
        const before = yield* invocation();
        seen.push(`${before.name}:${before.position?.line}`);
        const rendered = yield* Component.operations.content();
        const after = yield* invocation();
        seen.push(`${after.name}:${after.position?.line}`);
        return rendered;
      }),
      Inner: component("Inner", function* () {
        const inner = yield* invocation();
        seen.push(`${inner.name}:${inner.position?.line}`);
        return "";
      }),
    };

    yield* run("<Outer>\n<Inner />\n</Outer>\n", definitions, "doc.md");

    // The outer reads its own line, the inner its own, and the outer's answer
    // is unchanged after the inner has come and gone.
    expect(seen).toEqual(["Outer:1", "Inner:2", "Outer:1"]);
  });

  it("IM4: two invocations of one component each report their own site", function* () {
    const lines: (number | undefined)[] = [];
    const definitions = {
      Probe: component("Probe", function* () {
        lines.push((yield* invocation()).position?.line);
        return "";
      }),
    };

    yield* run("<Probe />\n\n<Probe />\n", definitions, "doc.md");

    expect(lines).toEqual([1, 3]);
  });

  it("IM5: it is not available outside a function component invocation", function* () {
    let message = "";
    yield* scoped(function* () {
      try {
        yield* invocation();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
    });

    expect(message).toContain("not inside a function component invocation");
  });

  it("IM6: it is gone again once the invocation returns", function* () {
    const definitions = {
      Probe: component("Probe", function* () {
        yield* invocation();
        return "";
      }),
    };

    yield* run("<Probe />\n", definitions, "doc.md");

    let message = "";
    try {
      yield* invocation();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("not inside a function component invocation");
  });

  it("IM7: the snapshot is frozen, and detached from the element", function* () {
    let seen: ComponentInvocationMetadata | undefined;
    const definitions = {
      Probe: component("Probe", function* () {
        seen = yield* invocation();
        return "";
      }),
    };

    const source = "<Probe />\n";
    yield* run(source, definitions, "doc.md");

    expect(Object.isFrozen(seen)).toBe(true);
    expect(Object.isFrozen(seen?.position)).toBe(true);

    // Expanding the same source again reports the same values: nothing the
    // first invocation was handed could have changed what the parser holds.
    let second: ComponentInvocationMetadata | undefined;
    yield* run(
      source,
      {
        Probe: component("Probe", function* () {
          second = yield* invocation();
          return "";
        }),
      },
      "doc.md",
    );
    expect(second?.position?.line).toBe(seen?.position?.line);
  });

  it("IM8: it carries the name and position, and nothing else", function* () {
    let keys: string[] = [];
    let positionKeys: string[] = [];
    const definitions = {
      Probe: component("Probe", function* () {
        const metadata = yield* invocation();
        keys = Object.keys(metadata);
        positionKeys = Object.keys(metadata.position ?? {});
        return "";
      }),
    };

    yield* run("<Probe />\n", definitions, "doc.md");

    expect([...keys].sort()).toEqual(["name", "position"]);
    expect([...positionKeys].sort()).toEqual(["column", "line", "offset", "path"]);
  });

  it("IM9: the rendered document is unaffected by asking", function* () {
    const definitions = {
      Probe: component("Probe", function* () {
        yield* invocation();
        return "probed";
      }),
    };

    const segments = yield* run("<Probe />\n", definitions, "doc.md");
    expect(renderSegments(segments)).toContain("probed");
  });
});
