/**
 * Tier RT — retained resources (spec §4.4).
 *
 * `retain()` creates a resource owned by the scope that invoked the component,
 * so it outlives the invocation and is released with the site — while nothing
 * the factory installs reaches the caller. Driven through `expandSegments`
 * with the shared harness, so what these assert is the engine's own ordering.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createContext, race, scoped, sleep, spawn, suspend } from "effection";
import type { Operation } from "effection";
import { unbox, useEvalScope } from "@effectionx/scope-eval";
import { Component } from "../src/component-api.ts";
import { expandSegments } from "../src/expand.ts";
import { renderSegments } from "../src/render.ts";
import { scanSegments } from "../src/scanner.ts";
import { useContent } from "../src/content-context.ts";
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

/** A context a retain factory tries to mutate, to prove it cannot. */
const Marker = createContext<string>("retain.test.marker");

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
  // RT1: the contract self-closing components are for — capture the value with
  // `as`, then have a later sibling read the binding while the resource behind
  // it is still alive.
  it("RT1: a captured value is consumed by a downstream sibling", function* () {
    const timeline: string[] = [];
    const observed: string[] = [];
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
      // Reads the binding the earlier element captured, and reports whether
      // the resource behind it is still live at that point.
      Reader: component("Reader", () =>
        (function* () {
          observed.push(timeline.includes("stop:dir") ? "released" : "live");
          return yield* useContent();
        })(),
      ),
    };

    const expanded = yield* expandAll(
      `<Dir as="dir" />\n\n<Reader>path is {dir}</Reader>`,
      definitions,
      timeline,
    );

    const output = renderSegments(expanded);
    // The capture renders nothing at the call site, and the sibling resolves
    // the binding it wrote.
    expect(output).not.toContain("<Dir");
    expect(output).toContain("path is /retained/path");
    expect(observed).toEqual(["live"]);
    expect(timeline).toEqual(["start:dir", "stop:dir"]);
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

  // RT8b: the missing-site answer is this invocation's, not something it
  // inherited. An unrelated `retain` provider installed further out must not
  // answer for an invocation that has no site of its own — it would create the
  // resource in a scope with no relationship to the call site.
  it("RT8b: a missing site does not fall through to an inherited provider", function* () {
    const timeline: string[] = [];
    const definitions = { Holder: retainer("Holder", timeline, "retained") };

    const expanded = yield* scoped(function* () {
      // A stray provider in an enclosing context, of the shape an embedding
      // host or an outer expansion could leave behind.
      const stray = yield* useEvalScope();
      yield* Component.around(
        {
          *retain([resource], _next) {
            timeline.push("stray");
            return unbox(yield* stray.eval(resource));
          },
        },
        { at: "min" },
      );
      yield* useHarness(definitions, timeline);
      yield* Component.around({ env: () => ({ values: {} }) }, { at: "min" });
      return yield* expandSegments(scanSegments(`<Holder />`), {}, {}, new Set());
    });

    expect(renderSegments(expanded)).toContain("invocation-site eval scope");
    // The stray provider never ran, so nothing was acquired anywhere.
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

describe("Tier RT — Site isolation", () => {
  // RT18: the factory is arbitrary code. Whatever it installs must stay with
  // the resource: a component may not reach through retain() to change what
  // its caller's later siblings see.
  //
  // Nested deliberately. The site scope for an element written inside
  // projected content is the enclosing invocation's content scope, and that
  // content expands in a task the scope owns — so anything the factory sets on
  // it is on the ancestor chain of every later sibling.
  it("RT18: a factory's context and middleware do not reach the caller", function* () {
    const timeline: string[] = [];
    const observed: Array<string | undefined> = [];
    const definitions = {
      Outer: component("Outer", () =>
        (function* (): Operation<string> {
          yield* Marker.set("from-caller");
          return yield* useContent();
        })(),
      ),
      // Installs both kinds of scope mutation, then hands back a value.
      Leaky: component("Leaky", () =>
        (function* (): Operation<string> {
          return yield* retain(() =>
            (function* (): Operation<string> {
              yield* Marker.set("from-factory");
              yield* Component.around({
                // deno-lint-ignore require-yield
                *applyModifiers(_args, _next) {
                  return { output: "HIJACKED", exitCode: 0, stderr: "" };
                },
              });
              yield* useWatch(timeline, "leaky");
              return "value";
            })(),
          );
        })(),
      ),
      // Reads what its own scope says, after the factory has run.
      Reader: component("Reader", () =>
        (function* (): Operation<string> {
          observed.push(yield* Marker.get());
          return yield* useContent();
        })(),
      ),
    };

    const expanded = yield* expandAll(
      `<Outer>\n<Leaky as="held" />\n\n<Reader>\n${WATCH_BLOCK_OWN}\n</Reader>\n</Outer>`,
      definitions,
      timeline,
    );

    // The resource is alive for the sibling — retention still works.
    expect(timeline).toContain("start:leaky");
    // ...but neither mutation escaped the factory's own scope.
    expect(observed).toEqual(["from-caller"]);
    expect(renderSegments(expanded)).not.toContain("HIJACKED");
    // The sibling's block ran through the harness's modifier, not the
    // factory's, so its watch was recorded normally.
    expect(timeline).toContain("start:own");
    // And the retained resource is released with the site.
    expect(timeline[timeline.length - 1]).toBe("stop:leaky");
  });
});
