import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { expandSegments } from "../src/expand.ts";
import { Component, content, raise } from "../src/component-api.ts";
import { AmbientErrorPolicy, ContentError, DocumentationError } from "../src/errors.ts";
import { scanSegments } from "../src/scanner.ts";
import { renderSegments } from "../src/render.ts";
import type {
  ComponentDefinition,
  ErrorSegment,
  FunctionComponentDefinition,
  Segment,
} from "../src/types.ts";

/**
 * The one-observation contract across the extension boundary (spec §6.9).
 *
 * A `Component.expand` handler returns two kinds of ErrorSegment that nothing
 * in the segment distinguishes: one it created, which it reports itself, and one
 * that came back from `Component.expandSegments()`, already reported where it
 * was produced. The engine settles whatever is returned under the caller's
 * policy, so counting middleware sees each failure once however deep the
 * expansion nested.
 */
describe("Tier OBS — error observation", () => {
  interface RaiseProbe {
    observed: string[];
    output: string;
  }

  /** Claims `<Broken />` and reports the diagnostic it creates. */
  function useBroken(): Operation<void> {
    return Component.around({
      *expand([element], next) {
        if (element.name === "Broken") {
          return {
            segments: [yield* raise({ type: "error", message: "broken thing", source: "Broken" })],
          };
        }
        return yield* next(element);
      },
    });
  }

  /** Claims `<Pass>` and hands its expanded children straight back. */
  function usePassthrough(): Operation<void> {
    return Component.around({
      *expand([element], next) {
        if (element.name === "Pass") {
          return { segments: yield* Component.operations.expandSegments(element.children) };
        }
        return yield* next(element);
      },
    });
  }

  /**
   * Claims `<Region>` and expands its children under its own collecting policy,
   * the way a component-declared `<Output>` region does.
   */
  function useCollectingRegion(): Operation<void> {
    return Component.around({
      *expand([element], next) {
        if (element.name === "Region") {
          return {
            segments: yield* scoped(function* () {
              yield* AmbientErrorPolicy.set("collect");
              return yield* Component.operations.expandSegments(element.children);
            }),
          };
        }
        return yield* next(element);
      },
    });
  }

  function runRaiseProbe(source: string): Operation<RaiseProbe> {
    return scoped(function* () {
      const observed: string[] = [];
      yield* Component.around({
        *raise([error], next) {
          observed.push(error.message);
          return yield* next(error);
        },
      });
      yield* useBroken();
      yield* usePassthrough();
      yield* useCollectingRegion();
      yield* Component.around({ env: () => ({ values: {} }) }, { at: "min" });
      const segments = yield* expandSegments(scanSegments(source), {}, {}, new Set());
      return { observed, output: renderSegments(segments) };
    });
  }

  function runUnderThrow(source: string): Operation<{ thrown: unknown; observed: string[] }> {
    return scoped(function* () {
      yield* AmbientErrorPolicy.set("throw");
      const observed: string[] = [];
      try {
        const probe = yield* runRaiseProbe(source);
        observed.push(...probe.observed);
      } catch (error) {
        if (error instanceof DocumentationError) {
          return { thrown: error, observed: [error.segment.message] };
        }
        return { thrown: error, observed };
      }
      return { thrown: undefined, observed };
    });
  }

  it("OBS1: an error a handler creates is observed once", function* () {
    const probe = yield* runRaiseProbe("<Broken />");
    expect(probe.observed).toEqual(["broken thing"]);
  });

  it("OBS2: an error transported through Component.expandSegments is observed once", function* () {
    const probe = yield* runRaiseProbe("<Pass><Broken /></Pass>");
    expect(probe.observed).toEqual(["broken thing"]);
  });

  it("OBS3: layered passthrough adds no observation", function* () {
    const probe = yield* runRaiseProbe("<Pass><Pass><Broken /></Pass></Pass>");
    expect(probe.observed).toEqual(["broken thing"]);
  });

  it("OBS4: both kinds render once under a collecting policy", function* () {
    const direct = yield* runRaiseProbe("<Broken />");
    expect(direct.output.match(/broken thing/g)).toHaveLength(1);

    const transported = yield* runRaiseProbe("before <Pass><Broken /></Pass> after");
    expect(transported.output.match(/broken thing/g)).toHaveLength(1);
    expect(transported.output).toBe("before <!-- ERROR: broken thing --> after");
  });

  it("OBS5: both kinds abort at the first error under a throwing policy", function* () {
    const direct = yield* runUnderThrow("<Broken /><Broken />");
    expect(direct.thrown).toBeInstanceOf(DocumentationError);
    expect(direct.observed).toEqual(["broken thing"]);

    const transported = yield* runUnderThrow("<Pass><Broken /><Broken /></Pass>");
    expect(transported.thrown).toBeInstanceOf(DocumentationError);
    expect(transported.observed).toEqual(["broken thing"]);
  });

  it("OBS6: an error collected under an inner policy settles again without a second observation", function* () {
    const collected: string[] = [];
    let thrown: unknown;
    yield* scoped(function* () {
      yield* AmbientErrorPolicy.set("throw");
      yield* Component.around({
        *raise([error], next) {
          collected.push(error.message);
          return yield* next(error);
        },
      });
      yield* useBroken();
      yield* useCollectingRegion();
      yield* Component.around({ env: () => ({ values: {} }) }, { at: "min" });
      try {
        yield* expandSegments(scanSegments("<Region><Broken /></Region>"), {}, {}, new Set());
      } catch (error) {
        thrown = error;
      }
    });
    expect(thrown).toBeInstanceOf(DocumentationError);
    expect(collected).toEqual(["broken thing"]);
  });
});

const OPEN_SCHEMA = { type: "object", properties: {}, additionalProperties: true } as const;

function markdownComponent(name: string, body: string): ComponentDefinition {
  return {
    kind: "markdown",
    name,
    path: `${name}.md`,
    meta: {},
    props: OPEN_SCHEMA,
    bodySegments: scanSegments(body),
  };
}

function errorSegments(segments: Segment[]): Segment[] {
  return segments.filter((segment) => segment.type === "error");
}

/** Renders its content through the canonical `content()` projection. */
function echoComponent(name: string): FunctionComponentDefinition {
  return {
    kind: "function",
    name,
    path: `${name}.ts`,
    props: OPEN_SCHEMA,
    *fn(_props) {
      return yield* content();
    },
  };
}

/**
 * Recovers from a failed projection and hands the caught `ContentError` to the
 * test scope, which is the only way to read the errors it carries: recovery
 * keeps the failure away from the consumer, so nothing else about the run shows
 * it happened.
 */
function recoveringComponent(name: string, caught: ContentError[]): FunctionComponentDefinition {
  return {
    kind: "function",
    name,
    path: `${name}.ts`,
    props: OPEN_SCHEMA,
    *fn(_props) {
      try {
        return yield* content();
      } catch (error) {
        if (error instanceof ContentError) {
          caught.push(error);
          return "recovered";
        }
        throw error;
      }
    },
  };
}

/**
 * The same contract inside the engine's own constructs (spec §6.5, §6.9).
 *
 * `<Each>`, `<Capture>`, a component body and content projected into
 * `<Content />` all expand segments through a nested `expandSegments`, which
 * reports each error where it is produced. None of them is an observation
 * boundary, so what they hand back is appended or settled, never reported twice.
 *
 * A function component's `content()` reads that same projection structurally.
 * ErrorSegments among the projected segments abort the generator at the
 * `yield* content()` expression, and the invocation is replaced by those
 * original segment objects — the ones `Component.raise` already returned. Their
 * identity is what proves the transport reports nothing a second time.
 */
describe("Tier OBS — construct error observation", () => {
  interface ConstructProbe {
    observed: string[];
    /** Every segment that passed through `Component.raise`, by reference. */
    raised: ErrorSegment[];
    segments: Segment[];
    output: string;
    values: Record<string, unknown>;
  }

  interface ProbeOptions {
    markdown?: Record<string, string>;
    functions?: Record<string, FunctionComponentDefinition>;
  }

  /**
   * Claims `<Broken />` and reports the diagnostic it creates. A `message` prop
   * names the failure, so sibling failures stay distinguishable.
   */
  function useBroken(): Operation<void> {
    return Component.around({
      *expand([element], next) {
        if (element.name === "Broken") {
          const prop = element.props.message;
          const message = typeof prop === "string" ? prop : "broken thing";
          return {
            segments: [yield* raise({ type: "error", message, source: "Broken" })],
          };
        }
        return yield* next(element);
      },
    });
  }

  function runProbe(source: string, options: ProbeOptions = {}): Operation<ConstructProbe> {
    return scoped(function* () {
      const observed: string[] = [];
      const raised: ErrorSegment[] = [];
      const values: Record<string, unknown> = {};
      const markdown = options.markdown ?? {};
      const functions = options.functions ?? {};
      yield* Component.around({
        *raise([error], next) {
          observed.push(error.message);
          raised.push(error);
          return yield* next(error);
        },
      });
      yield* useBroken();
      yield* Component.around(
        {
          env: () => ({ values }),
          // deno-lint-ignore require-yield
          *applyModifiers(_args, _next) {
            return { output: "", exitCode: 0, stderr: "" };
          },
          // deno-lint-ignore require-yield
          *importComponent([name], _next) {
            const fn = functions[name];
            if (fn) {
              return fn;
            }
            const body = markdown[name];
            if (body === undefined) {
              throw new Error(`Component not found: ${name}`);
            }
            return markdownComponent(name, body);
          },
        },
        { at: "min" },
      );
      const segments: Segment[] = yield* expandSegments(scanSegments(source), {}, {}, new Set());
      return { observed, raised, segments, output: renderSegments(segments), values };
    });
  }

  function runUnderThrow(
    source: string,
    options: ProbeOptions = {},
  ): Operation<{ thrown: unknown; observed: string[] }> {
    return scoped(function* () {
      yield* AmbientErrorPolicy.set("throw");
      try {
        const probe = yield* runProbe(source, options);
        return { thrown: undefined, observed: probe.observed };
      } catch (error) {
        if (error instanceof DocumentationError) {
          return { thrown: error, observed: [error.segment.message] };
        }
        throw error;
      }
    });
  }

  const BODY = { Wrap: "<Broken />" };
  const PROJECT = { Wrap: "before <Content /> after" };
  const ECHO: ProbeOptions = { functions: { Echo: echoComponent("Echo") } };

  it("OBS7: an inline error is observed once", function* () {
    const probe = yield* runProbe("<Broken />");
    expect(probe.observed).toEqual(["broken thing"]);
  });

  it("OBS8: an error in a selected <If> branch is observed once", function* () {
    const probe = yield* runProbe("<If condition={true}><Broken /></If>");
    expect(probe.observed).toEqual(["broken thing"]);
  });

  it("OBS9: an error in an <Each> body is observed once", function* () {
    const probe = yield* runProbe('<Each in={[1]} let="n"><Broken /></Each>');
    expect(probe.observed).toEqual(["broken thing"]);

    const twice = yield* runProbe('<Each in={[1, 2]} let="n"><Broken /></Each>');
    expect(twice.observed).toEqual(["broken thing", "broken thing"]);
  });

  it("OBS10: an error in a <Capture> body is observed once", function* () {
    const probe = yield* runProbe('<Capture as="c"><Broken /></Capture>');
    expect(probe.observed).toEqual(["broken thing"]);
  });

  it("OBS11: an error in a component body is observed once", function* () {
    const probe = yield* runProbe("<Wrap />", { markdown: BODY });
    expect(probe.observed).toEqual(["broken thing"]);
  });

  it("OBS12: an error projected into <Content /> is observed once", function* () {
    const markdown = yield* runProbe("<Wrap><Broken /></Wrap>", { markdown: PROJECT });
    expect(markdown.observed).toEqual(["broken thing"]);

    // Function content is a structured projection: its ErrorSegments abort the
    // generator, and the invocation is replaced by those same segments.
    const fn = yield* runProbe("<Echo><Broken /></Echo>", ECHO);
    expect(fn.observed).toEqual(["broken thing"]);
    const returned = errorSegments(fn.segments);
    expect(returned).toHaveLength(1);
    expect(returned[0]).toBe(fn.raised[0]);
  });

  it("OBS13: an error in a <Loop> body is observed once", function* () {
    const probe = yield* runProbe("<Loop max={1}><Broken /></Loop>");
    expect(probe.observed).toEqual(["broken thing"]);
  });

  it("OBS14: a construct's own diagnostic is observed once", function* () {
    const eachProp = yield* runProbe('<Each in={[1]} let="n" bogus="x">body</Each>');
    expect(eachProp.observed).toHaveLength(1);
    expect(eachProp.observed[0]).toContain('only accepts "in", "let", and "as" props');

    const eachItems = yield* runProbe('<Each in={"nope"} let="n">body</Each>');
    expect(eachItems.observed).toHaveLength(1);
    expect(eachItems.observed[0]).toContain("must resolve to an array");

    const captureAs = yield* runProbe("<Capture>body</Capture>");
    expect(captureAs.observed).toHaveLength(1);
    expect(captureAs.observed[0]).toContain('requires an "as" prop');

    const captureEmpty = yield* runProbe('<Capture as="c" />');
    expect(captureEmpty.observed).toHaveLength(1);
    expect(captureEmpty.observed[0]).toContain("must have content");
  });

  it("OBS15: a refused capture reports its body error once and sets no binding", function* () {
    const capture = yield* runProbe('<Capture as="c"><Broken /></Capture>');
    expect(capture.observed).toEqual(["broken thing"]);
    expect("c" in capture.values).toBe(false);
    expect(capture.output).toContain("broken thing");

    const each = yield* runProbe('<Each in={[1]} let="n" as="e"><Broken /></Each>');
    expect(each.observed).toEqual(["broken thing"]);
    expect("e" in each.values).toBe(false);
    expect(each.output).toContain("broken thing");

    const component = yield* runProbe('<Wrap as="w" />', { markdown: BODY });
    expect(component.observed).toEqual(["broken thing"]);
    expect("w" in component.values).toBe(false);
    expect(component.output).toContain("broken thing");

    const fn = yield* runProbe('<Echo as="f"><Broken /></Echo>', ECHO);
    expect(fn.observed).toEqual(["broken thing"]);
    expect("f" in fn.values).toBe(false);
    expect(fn.output).toContain("broken thing");
  });

  it("OBS16: an ambient throw policy aborts at the first error on every path", function* () {
    const cases: Array<[string, ProbeOptions]> = [
      ["<Broken /><Broken />", {}],
      ["<If condition={true}><Broken /><Broken /></If>", {}],
      ['<Each in={[1, 2]} let="n"><Broken /></Each>', {}],
      ['<Capture as="c"><Broken /><Broken /></Capture>', {}],
      ["<Wrap /><Wrap />", { markdown: BODY }],
      ["<Wrap><Broken /></Wrap><Wrap><Broken /></Wrap>", { markdown: PROJECT }],
      ["<Echo><Broken /></Echo><Echo><Broken /></Echo>", ECHO],
      ["<Loop max={2}><Broken /></Loop>", {}],
    ];
    for (const [source, options] of cases) {
      const run = yield* runUnderThrow(source, options);
      expect(run.thrown).toBeInstanceOf(DocumentationError);
      expect(run.observed).toEqual(["broken thing"]);
    }
  });

  it("OBS17: a collected error still renders exactly once per path", function* () {
    const cases: Array<[string, ProbeOptions]> = [
      ["<Broken />", {}],
      ["<If condition={true}><Broken /></If>", {}],
      ['<Each in={[1]} let="n"><Broken /></Each>', {}],
      ['<Capture as="c"><Broken /></Capture>', {}],
      ["<Wrap />", { markdown: BODY }],
      ["<Wrap><Broken /></Wrap>", { markdown: PROJECT }],
      ["<Echo><Broken /></Echo>", ECHO],
      ["<Loop max={1}><Broken /></Loop>", {}],
    ];
    for (const [source, options] of cases) {
      const probe = yield* runProbe(source, options);
      expect(probe.output.match(/broken thing/g)).toHaveLength(1);
    }
  });

  it("OBS18: uncaught function content errors come back as the raised segments", function* () {
    const probe = yield* runProbe("<Echo><Broken /></Echo>", ECHO);
    expect(probe.raised).toHaveLength(1);
    expect(probe.observed).toEqual(["broken thing"]);

    const returned = errorSegments(probe.segments);
    expect(returned).toHaveLength(1);
    expect(returned[0]).toBe(probe.raised[0]);
  });

  it("OBS19: a refused function capture comes back as the raised segment", function* () {
    const probe = yield* runProbe('<Echo as="f"><Broken /></Echo>', ECHO);
    expect(probe.observed).toEqual(["broken thing"]);
    expect("f" in probe.values).toBe(false);

    const returned = errorSegments(probe.segments);
    expect(returned).toHaveLength(1);
    expect(returned[0]).toBe(probe.raised[0]);
  });

  it("OBS20: sibling content failures keep source order and one observation each", function* () {
    const probe = yield* runProbe(
      '<Echo><Broken message="first" /><Broken message="second" /></Echo>',
      ECHO,
    );
    expect(probe.observed).toEqual(["first", "second"]);

    const returned = errorSegments(probe.segments);
    expect(returned).toHaveLength(2);
    expect(returned[0]).toBe(probe.raised[0]);
    expect(returned[1]).toBe(probe.raised[1]);
  });

  it("OBS21: ContentError carries the raised segments in source order", function* () {
    const caught: ContentError[] = [];
    const probe = yield* runProbe(
      '<Recover><Broken message="first" /><Broken message="second" /></Recover>',
      { functions: { Recover: recoveringComponent("Recover", caught) } },
    );
    expect(probe.observed).toEqual(["first", "second"]);

    expect(caught).toHaveLength(1);
    const [failure] = caught;
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[0]).toBe(probe.raised[0]);
    expect(failure.errors[1]).toBe(probe.raised[1]);

    // Recovery keeps the failure from the consumer, so nothing settles.
    expect(errorSegments(probe.segments)).toHaveLength(0);
    expect(probe.output).toBe("recovered");
  });
});
