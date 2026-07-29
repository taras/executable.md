/**
 * Tier O — eval scope hierarchy (spec §4.4).
 *
 * A component invocation is a resource scope. These tests drive `expandSegments`
 * directly with a stub modifier registry, so the ordering they assert is the
 * engine's own and not a property of any particular runtime.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, race, resource, scoped, sleep, suspend } from "effection";
import type { Operation } from "effection";
import { useEvalScope } from "@effectionx/scope-eval";
import { Component } from "../src/component-api.ts";
import { expandSegments } from "../src/expand.ts";
import { renderSegments } from "../src/render.ts";
import { scanSegments } from "../src/scanner.ts";
import { useContent } from "../src/content-context.ts";
import type { ComponentDefinition, FunctionComponentDefinition, Segment } from "../src/types.ts";

type Definition = ComponentDefinition | FunctionComponentDefinition;

const NO_PROPS = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

/** Records `start:<label>` on acquisition and `stop:<label>` on teardown. */
function useWatch(timeline: string[], label: string, failOnStop = false): Operation<void> {
  return resource(function* (provide) {
    timeline.push(`start:${label}`);
    yield* ensure(() => {
      timeline.push(`stop:${label}`);
      if (failOnStop) {
        throw new Error(`teardown failed: ${label}`);
      }
    });
    yield* provide();
  });
}

function markdown(name: string, body: string): ComponentDefinition {
  return {
    kind: "markdown",
    name,
    path: `components/${name}.md`,
    meta: {},
    props: NO_PROPS,
    bodySegments: scanSegments(body),
  };
}

/**
 * A TypeScript component written the way an author would: ordinary operations,
 * no ephemeral(), no scoped(), no lifetime plumbing.
 */
function component(name: string, body: () => Operation<string>): FunctionComponentDefinition {
  return { kind: "function", name, path: `components/${name}.ts`, props: NO_PROPS, fn: body };
}

/**
 * Install the providers expansion needs, plus a `watch` modifier that retains a
 * probe in whatever eval scope is current — the same anchoring `daemon` uses.
 */
function useHarness(
  definitions: Record<string, Definition>,
  timeline: string[],
  onBlock?: (snapshot: string[]) => void,
): Operation<void> {
  return Component.around(
    {
      // deno-lint-ignore require-yield
      *importComponent([name], _next) {
        const definition = definitions[name];
        if (!definition) {
          throw new Error(`Component not found: ${name}`);
        }
        return definition;
      },
      *applyModifiers([modifiers, block], _next) {
        const label = block.content.trim();
        onBlock?.([...timeline]);
        const watches = modifiers.some((modifier) => modifier.name === "watch");
        const failing = modifiers.some((modifier) => modifier.name === "watch-fails");
        const hangs = modifiers.some((modifier) => modifier.name === "watch-hangs");
        if (modifiers.some((modifier) => modifier.name === "boom")) {
          throw new Error("body exploded");
        }
        if (watches || failing || hangs) {
          const scope = yield* Component.operations.evalScope;
          if (!scope) {
            throw new Error("watch requires an eval scope");
          }
          yield* scope.eval(() => useWatch(timeline, label, failing));
        }
        if (hangs) {
          yield* suspend();
        }
        return { output: "", exitCode: 0, stderr: "" };
      },
    },
    { at: "min" },
  );
}

function* expandAll(
  source: string,
  definitions: Record<string, Definition>,
  timeline: string[],
  onBlock?: (snapshot: string[]) => void,
): Operation<Segment[]> {
  return yield* scoped(function* () {
    const root = yield* useEvalScope();
    yield* useHarness(definitions, timeline, onBlock);
    yield* Component.around({ evalScope: () => root }, { at: "min" });
    yield* Component.around({ env: () => ({ values: {} }) }, { at: "min" });
    return yield* expandSegments(scanSegments(source), {}, {}, new Set());
  });
}

const WATCH_BLOCK = "```sh watch exec\nprojected\n```";
const BOOM_BLOCK = "```sh boom exec\nboom\n```";
const HANG_BLOCK = "```sh watch-hangs exec\nprojected\n```";
const WATCH_BLOCK_OWN = "```sh watch exec\nown\n```";
const FAILING_WATCH_BLOCK = "```sh watch-fails exec\nprojected\n```";

describe("Tier O — Eval scope hierarchy", () => {
  // O3: the invocation's eval scope dies with the invocation, not the document.
  it("O3: a resource retained by a component invocation stops when it completes", function* () {
    const timeline: string[] = [];
    const definitions = { Holder: markdown("Holder", "```sh watch exec\nown\n```\n\nbody") };

    yield* expandAll("<Holder />\n\nafter", definitions, timeline);

    expect(timeline).toEqual(["start:own", "stop:own"]);
  });

  // O4: the resource is live while the projected content runs — not merely
  // acquired and released around it.
  it("O4: a directly acquired resource is alive while projected content runs", function* () {
    const timeline: string[] = [];
    const observed: string[][] = [];
    const definitions = {
      Probe: component("Probe", () =>
        (function* () {
          yield* useWatch(timeline, "own");
          return yield* useContent();
        })(),
      ),
    };

    yield* expandAll(`<Probe>\n${WATCH_BLOCK}\n</Probe>`, definitions, timeline, (snapshot) => {
      observed.push(snapshot);
    });

    // Snapshot taken while the projected block was executing.
    expect(observed).toEqual([["start:own"]]);
  });

  // O5: a resource the component acquires directly outlives the content it
  // projects, and is released only once that content has stopped.
  it("O5: a directly acquired resource stops only after projected content", function* () {
    const timeline: string[] = [];
    const definitions = {
      Probe: component("Probe", () =>
        (function* () {
          yield* useWatch(timeline, "own");
          return yield* useContent();
        })(),
      ),
    };

    yield* expandAll(`<Probe>\n${WATCH_BLOCK}\n</Probe>`, definitions, timeline);

    expect(timeline).toEqual(["start:own", "start:projected", "stop:projected", "stop:own"]);
  });

  // O6: the ordering belongs to the invocation boundary, not to the order the
  // author happened to acquire things in.
  it("O6: same ordering when the resource is acquired after the first projection", function* () {
    const timeline: string[] = [];
    const definitions = {
      Probe: component("Probe", () =>
        (function* () {
          const content = yield* useContent();
          yield* useWatch(timeline, "own");
          return content;
        })(),
      ),
    };

    yield* expandAll(`<Probe>\n${WATCH_BLOCK}\n</Probe>`, definitions, timeline);

    expect(timeline).toEqual(["start:projected", "start:own", "stop:projected", "stop:own"]);
  });

  // O9: a stage that throws does not strand the ones after it.
  it("O9: a failing content teardown still lets the later stages run", function* () {
    const timeline: string[] = [];
    const definitions = {
      Probe: component("Probe", () =>
        (function* () {
          yield* useWatch(timeline, "own");
          return yield* useContent();
        })(),
      ),
    };

    const expanded = yield* expandAll(
      `<Probe>\n${FAILING_WATCH_BLOCK}\n</Probe>`,
      definitions,
      timeline,
    );

    // Stage 1 threw, and stages 2 and 3 still ran, in order.
    expect(timeline).toEqual(["start:own", "start:projected", "stop:projected", "stop:own"]);
    // The component reports the teardown failure rather than swallowing it.
    expect(renderSegments(expanded)).toContain("teardown failed: projected");
  });

  // O10: the same, when the component's own resource is the one that fails.
  it("O10: a failing body teardown is reported after every stage has run", function* () {
    const timeline: string[] = [];
    const definitions = {
      Probe: component("Probe", () =>
        (function* () {
          yield* useWatch(timeline, "own", true);
          return yield* useContent();
        })(),
      ),
    };

    const expanded = yield* expandAll(`<Probe>\n${WATCH_BLOCK}\n</Probe>`, definitions, timeline);

    expect(timeline).toEqual(["start:own", "start:projected", "stop:projected", "stop:own"]);
    expect(renderSegments(expanded)).toContain("teardown failed: own");
  });

  // O7: the same contract for a Markdown provider projecting <Content />.
  // Acquiring the provider's own resource AFTER the projection is what
  // separates a real content scope from eval-scope LIFO: under LIFO the
  // later-created resource would be released first.
  it("O7: Markdown <Content /> content stops before the provider's own resource", function* () {
    const timeline: string[] = [];
    const definitions = {
      Provider: markdown("Provider", `<Content />\n\n${WATCH_BLOCK_OWN}`),
    };

    yield* expandAll(`<Provider>\n${WATCH_BLOCK}\n</Provider>`, definitions, timeline);

    expect(timeline).toEqual(["start:projected", "start:own", "stop:projected", "stop:own"]);
  });

  // O11/O12: the same teardown order on a propagated body error, for both
  // component forms. The body throws after projecting, so the projected
  // resource is still alive when the invocation starts unwinding.
  it("O11: Markdown — a body error still stops projected content first", function* () {
    const timeline: string[] = [];
    const definitions = {
      Provider: markdown("Provider", `<Content />\n\n${BOOM_BLOCK}`),
    };

    yield* expandAll(`<Provider>\n${WATCH_BLOCK}\n</Provider>`, definitions, timeline);

    expect(timeline).toEqual(["start:projected", "stop:projected"]);
  });

  it("O12: TypeScript — a body error still stops projected content first", function* () {
    const timeline: string[] = [];
    const definitions = {
      Probe: component("Probe", () =>
        (function* () {
          yield* useWatch(timeline, "own");
          yield* useContent();
          throw new Error("body exploded");
        })(),
      ),
    };

    yield* expandAll(`<Probe>\n${WATCH_BLOCK}\n</Probe>`, definitions, timeline);

    expect(timeline).toEqual(["start:own", "start:projected", "stop:projected", "stop:own"]);
  });

  // O13/O14: cancellation mid-projection tears down in the same order. The
  // projected block suspends, so the halt lands while content is live —
  // unlike Q7, which cancels the root and asserts nothing about ordering.
  it("O13: Markdown — cancellation stops projected content before the invocation", function* () {
    const timeline: string[] = [];
    const definitions = {
      Provider: markdown("Provider", `${WATCH_BLOCK_OWN}\n\n<Content />`),
    };

    yield* race([
      expandAll(`<Provider>\n${HANG_BLOCK}\n</Provider>`, definitions, timeline),
      sleep(50),
    ]);

    expect(timeline).toEqual(["start:own", "start:projected", "stop:projected", "stop:own"]);
  });

  it("O14: TypeScript — cancellation stops projected content before the invocation", function* () {
    const timeline: string[] = [];
    const definitions = {
      Probe: component("Probe", () =>
        (function* () {
          yield* useWatch(timeline, "own");
          return yield* useContent();
        })(),
      ),
    };

    yield* race([expandAll(`<Probe>\n${HANG_BLOCK}\n</Probe>`, definitions, timeline), sleep(50)]);

    expect(timeline).toEqual(["start:own", "start:projected", "stop:projected", "stop:own"]);
  });

  // O15: TypeScript nesting and sibling isolation, mirroring O18 for Markdown.
  it("O15: TypeScript — nested invocations are leaf-first and siblings isolated", function* () {
    const timeline: string[] = [];
    const definitions = {
      Outer: component("Outer", () =>
        (function* () {
          yield* useWatch(timeline, "outer");
          return yield* useContent();
        })(),
      ),
      Inner: component("Inner", () =>
        (function* () {
          yield* useWatch(timeline, "inner");
          return yield* useContent();
        })(),
      ),
    };

    yield* expandAll(
      `<Outer>\n<Inner>\ntext\n</Inner>\n</Outer>\n\n<Outer>\ntext\n</Outer>`,
      definitions,
      timeline,
    );

    expect(timeline).toEqual([
      "start:outer",
      "start:inner",
      "stop:inner",
      "stop:outer",
      "start:outer",
      "stop:outer",
    ]);
  });

  // O18: nesting tears down leaf-first and siblings never interleave.
  it("O18: nested invocations tear down leaf-first; siblings stay isolated", function* () {
    const timeline: string[] = [];
    const definitions = {
      Outer: markdown("Outer", "```sh watch exec\nouter\n```\n\n<Content />"),
      Inner: markdown("Inner", "```sh watch exec\ninner\n```\n\n<Content />"),
    };

    yield* expandAll(
      `<Outer>\n<Inner>\ntext\n</Inner>\n</Outer>\n\n<Outer>\ntext\n</Outer>`,
      definitions,
      timeline,
    );

    expect(timeline).toEqual([
      "start:outer",
      "start:inner",
      "stop:inner",
      "stop:outer",
      "start:outer",
      "stop:outer",
    ]);
  });

  // O19: expansion no longer needs an ambient eval scope to exist.
  it("O19: a component expands and projects with no ambient eval scope", function* () {
    const definitions = { Wrap: markdown("Wrap", "before <Content /> after") };
    const timeline: string[] = [];

    const expanded = yield* scoped(function* () {
      yield* useHarness(definitions, timeline);
      yield* Component.around({ env: () => ({ values: {} }) }, { at: "min" });
      return yield* expandSegments(scanSegments("<Wrap>middle</Wrap>"), {}, {}, new Set());
    });

    const output = renderSegments(expanded);
    expect(output).toContain("before");
    expect(output).toContain("middle");
    expect(output).toContain("after");
  });

  // O21: the boundary owns its own scope — nothing is left on the caller's.
  it("O21: invocation resources are gone as soon as expansion returns", function* () {
    const timeline: string[] = [];
    const definitions = { Holder: markdown("Holder", "```sh watch exec\nown\n```") };

    yield* scoped(function* () {
      const root = yield* useEvalScope();
      yield* useHarness(definitions, timeline);
      yield* Component.around({ evalScope: () => root }, { at: "min" });
      yield* Component.around({ env: () => ({ values: {} }) }, { at: "min" });
      yield* expandSegments(scanSegments("<Holder />"), {}, {}, new Set());
      // Still inside the parent scope: the invocation is already dismantled.
      expect(timeline).toEqual(["start:own", "stop:own"]);
    });
  });
});
