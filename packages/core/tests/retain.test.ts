/**
 * Tier RT — retained resources and invocation shape (spec §4.4, §5.5).
 *
 * `retain()` creates a resource in the scope that invoked the component, so it
 * outlives the invocation and is released with the site scope. `hasContent()`
 * reports how the element was written. Both are driven through
 * `expandSegments` with the shared harness, so what these assert is the
 * engine's own ordering.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { race, scoped, sleep, spawn, suspend } from "effection";
import type { Operation } from "effection";
import { useEvalScope } from "@effectionx/scope-eval";
import { Component } from "../src/component-api.ts";
import { expandSegments } from "../src/expand.ts";
import { renderSegments } from "../src/render.ts";
import { scanSegments } from "../src/scanner.ts";
import { hasContent, useContent } from "../src/content-context.ts";
import { retain } from "../src/component-api.ts";
import {
  component,
  expandAll,
  HANG_BLOCK,
  markdown,
  useHarness,
  useWatch,
  WATCH_BLOCK_OWN,
} from "./invocation-harness.ts";

/** A component that retains a probe at its call site and renders its label. */
function retainer(name: string, timeline: string[], label: string) {
  return component(name, () =>
    (function* () {
      yield* retain(() => useWatch(timeline, label));
      return label;
    })(),
  );
}

describe("Tier RT — Retained resources", () => {
  // RT1: the value comes back to the call site like any other rendered result.
  it("RT1: a retained resource's value reaches a downstream sibling", function* () {
    const timeline: string[] = [];
    const definitions = {
      Dir: component("Dir", () =>
        (function* () {
          return yield* retain(() =>
            (function* (): Operation<string> {
              yield* useWatch(timeline, "dir");
              return "/retained/path";
            })(),
          );
        })(),
      ),
    };

    const expanded = yield* expandAll(`<Dir />\n\nafter`, definitions, timeline);

    expect(renderSegments(expanded)).toContain("/retained/path");
  });

  // RT2: the whole point — the resource is still live once the invocation that
  // created it has been dismantled.
  it("RT2: a retained resource stays alive after the child invocation ends", function* () {
    const timeline: string[] = [];
    const definitions = {
      Holder: retainer("Holder", timeline, "retained"),
      Probe: markdown("Probe", WATCH_BLOCK_OWN),
    };

    yield* expandAll(`<Holder />\n\n<Probe />`, definitions, timeline);

    // `own` belongs to the later sibling invocation. It starts and stops
    // entirely inside the window where `retained` is still alive.
    expect(timeline).toEqual(["start:retained", "start:own", "stop:own", "stop:retained"]);
  });

  // RT3: the site scope's ordinary completion releases it.
  it("RT3: a retained resource is released when the site scope succeeds", function* () {
    const timeline: string[] = [];
    const definitions = { Holder: retainer("Holder", timeline, "retained") };

    yield* expandAll(`<Holder />`, definitions, timeline);

    expect(timeline).toEqual(["start:retained", "stop:retained"]);
  });

  // RT4: a failure at the site tears the resource down on the way out.
  it("RT4: a retained resource is released when the site scope errors", function* () {
    const timeline: string[] = [];
    const definitions = { Holder: retainer("Holder", timeline, "retained") };
    let raised: unknown;

    try {
      yield* scoped(function* () {
        const root = yield* useEvalScope();
        yield* useHarness(definitions, timeline);
        yield* Component.around({ evalScope: () => root }, { at: "min" });
        yield* Component.around({ env: () => ({ values: {} }) }, { at: "min" });
        yield* expandSegments(scanSegments(`<Holder />`), {}, {}, new Set());
        throw new Error("site failed");
      });
    } catch (error) {
      raised = error;
    }

    expect(raised).toBeInstanceOf(Error);
    expect(timeline).toEqual(["start:retained", "stop:retained"]);
  });

  // RT5: cancellation of the site scope, with the resource live at halt time.
  it("RT5: a retained resource is released when the site scope is cancelled", function* () {
    const timeline: string[] = [];
    const definitions = { Holder: retainer("Holder", timeline, "retained") };

    yield* race([
      scoped(function* () {
        const root = yield* useEvalScope();
        yield* useHarness(definitions, timeline);
        yield* Component.around({ evalScope: () => root }, { at: "min" });
        yield* Component.around({ env: () => ({ values: {} }) }, { at: "min" });
        yield* expandSegments(scanSegments(`<Holder />`), {}, {}, new Set());
        yield* suspend();
      }),
      sleep(50),
    ]);

    expect(timeline).toEqual(["start:retained", "stop:retained"]);
  });

  // RT6: an enclosing invocation is itself a site. Its content scope owns what
  // was retained there, so nesting unwinds leaf-first.
  it("RT6: nested site scopes release retained resources leaf-first", function* () {
    const timeline: string[] = [];
    const definitions = {
      Outer: component("Outer", () =>
        (function* () {
          yield* useWatch(timeline, "outer");
          return yield* useContent();
        })(),
      ),
      Inner: retainer("Inner", timeline, "inner-retained"),
    };

    yield* expandAll(`<Outer>\n<Inner />\n</Outer>`, definitions, timeline);

    // `inner-retained` is owned by Outer's content scope — stage 1 of Outer's
    // teardown — so it stops before Outer releases its own resource.
    expect(timeline).toEqual([
      "start:outer",
      "start:inner-retained",
      "stop:inner-retained",
      "stop:outer",
    ]);
  });

  // RT7: retention is opt-in. A component that does not ask for it keeps the
  // lifetime §4.4 already gave it.
  it("RT7: a component-owned resource still stops at its own invocation", function* () {
    const timeline: string[] = [];
    const definitions = {
      Owner: component("Owner", () =>
        (function* () {
          yield* useWatch(timeline, "own");
          return "owner";
        })(),
      ),
      Probe: markdown("Probe", WATCH_BLOCK_OWN),
    };

    yield* expandAll(`<Owner />\n\n<Probe />`, definitions, timeline);

    // Unlike RT2, `own` is gone before the later sibling starts.
    expect(timeline).toEqual(["start:own", "stop:own", "start:own", "stop:own"]);
  });

  // RT8: expansion with no ambient eval scope has no site to retain into, and
  // says so rather than silently falling back to invocation lifetime.
  it("RT8: retain() without an invocation-site scope reports the missing scope", function* () {
    const timeline: string[] = [];
    const definitions = { Holder: retainer("Holder", timeline, "retained") };

    const expanded = yield* scoped(function* () {
      yield* useHarness(definitions, timeline);
      yield* Component.around({ env: () => ({ values: {} }) }, { at: "min" });
      return yield* expandSegments(scanSegments(`<Holder />`), {}, {}, new Set());
    });

    expect(renderSegments(expanded)).toContain("invocation-site eval scope");
    expect(timeline).toEqual([]);
  });

  // RT9: a resource retained at the root lives for the expansion, not for the
  // element — the site scope there is the document's.
  it("RT9: a resource retained at the root outlives every later sibling", function* () {
    const timeline: string[] = [];
    const definitions = {
      Holder: retainer("Holder", timeline, "retained"),
      Wrap: markdown("Wrap", `${WATCH_BLOCK_OWN}\n\n<Content />`),
    };

    yield* expandAll(`<Holder />\n\n<Wrap>text</Wrap>`, definitions, timeline);

    expect(timeline).toEqual(["start:retained", "start:own", "stop:own", "stop:retained"]);
  });

  // RT10: halting mid-expansion, while a later block suspends, still releases
  // what an earlier element retained.
  it("RT10: halting expansion releases what an earlier element retained", function* () {
    const timeline: string[] = [];
    const definitions = {
      Holder: retainer("Holder", timeline, "retained"),
      Wrap: markdown("Wrap", "<Content />"),
    };

    const task = yield* spawn(() =>
      expandAll(`<Holder />\n\n<Wrap>\n${HANG_BLOCK}\n</Wrap>`, definitions, timeline),
    );
    yield* sleep(20);
    expect(timeline).toContain("start:retained");

    yield* task.halt();

    expect(timeline).toContain("stop:retained");
  });
});

describe("Tier RT — Invocation shape", () => {
  function reporter(name: string) {
    return component(name, () =>
      (function* () {
        return (yield* hasContent()) ? "paired" : "self-closing";
      })(),
    );
  }

  it("RT11: an element written with content reports having content", function* () {
    const expanded = yield* expandAll(`<Shape>anything</Shape>`, { Shape: reporter("Shape") }, []);

    expect(renderSegments(expanded)).toContain("paired");
  });

  // RT12: the shape of the invocation, not what it renders — an empty pair is
  // still a pair.
  it("RT12: an empty pair of tags still reports having content", function* () {
    const expanded = yield* expandAll(`<Shape></Shape>`, { Shape: reporter("Shape") }, []);

    expect(renderSegments(expanded)).toContain("paired");
  });

  it("RT13: a self-closing element reports having none", function* () {
    const expanded = yield* expandAll(`<Shape />`, { Shape: reporter("Shape") }, []);

    expect(renderSegments(expanded)).toContain("self-closing");
  });

  // RT14: asking the question must not project. A component that only calls
  // hasContent() never runs the blocks it was handed.
  it("RT14: hasContent() does not render the children it reports on", function* () {
    const timeline: string[] = [];
    const expanded = yield* expandAll(
      `<Shape>\n${WATCH_BLOCK_OWN}\n</Shape>`,
      { Shape: reporter("Shape") },
      timeline,
    );

    expect(renderSegments(expanded)).toContain("paired");
    expect(timeline).toEqual([]);
  });
});
