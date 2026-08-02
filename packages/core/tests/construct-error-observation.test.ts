import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { expandSegments } from "../src/expand.ts";
import { Component, content } from "../src/component-api.ts";
import { collectFailures } from "../src/component-failures.ts";
import { AmbientErrorPolicy, ContentError, DocumentationError } from "../src/errors.ts";
import { scanSegments } from "../src/scanner.ts";
import { renderSegments } from "../src/render.ts";
import type {
  ComponentDefinition,
  ErrorSegment,
  FunctionComponentDefinition,
  Json,
  PropsSchema,
  Segment,
} from "../src/types.ts";

/**
 * The one-observation contract inside the engine's own constructs (spec §6.5,
 * §6.9).
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
 *
 * The constructs under test are the engine's, so nothing here claims a name.
 * `<Broken />` is a component that fails on its own terms, resolved through the
 * `importComponent` middleware these install because they drive `expandSegments`
 * directly — there is no registry in this harness. The diagnostic the engine
 * builds for a failed invocation is the ErrorSegment they observe. See
 * `error-observation.test.ts` for the same contract measured across the
 * extension boundary instead.
 */

const OPEN_SCHEMA: PropsSchema = { type: "object", properties: {}, additionalProperties: true };

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
    props: OPEN_SCHEMA,
    *fn(_props) {
      return yield* content();
    },
  };
}

/**
 * Fails on its own terms, without asking for content.
 *
 * It collects: what these assert is how a failure that *becomes* a diagnostic
 * is attributed and observed, which only happens inside a collection boundary.
 */
function throwingComponent(name: string, failure: unknown): FunctionComponentDefinition {
  return {
    kind: "function",
    name,
    props: OPEN_SCHEMA,
    // deno-lint-ignore require-yield
    fn: collectFailures(function* () {
      throw failure;
    }),
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
 * `<Broken />` — a component that fails, which is how these plant an
 * ErrorSegment without any extension installed.
 *
 * A `message` prop names the failure so sibling failures stay distinguishable.
 * It collects, so the failure becomes one diagnostic reported through
 * `Component.raise` and settled by the construct that contains it, rather than
 * stopping the expansion the assertion is about.
 */
const BROKEN: FunctionComponentDefinition = {
  kind: "function",
  name: "Broken",
  props: OPEN_SCHEMA,
  // deno-lint-ignore require-yield
  fn: collectFailures(function* (props: Record<string, Json>) {
    const prop = props.message;
    throw new Error(typeof prop === "string" ? prop : "broken thing");
  }),
};

/** What the engine's diagnostic for a failed `<Broken />` reads. */
function broke(message = "broken thing"): string {
  return `Function component Broken error: ${message}`;
}

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

  function runProbe(source: string, options: ProbeOptions = {}): Operation<ConstructProbe> {
    return scoped(function* () {
      const observed: string[] = [];
      const raised: ErrorSegment[] = [];
      const values: Record<string, unknown> = {};
      const markdown = options.markdown ?? {};
      const functions: Record<string, FunctionComponentDefinition> = {
        Broken: BROKEN,
        ...(options.functions ?? {}),
      };
      yield* Component.around({
        *raise([error], next) {
          observed.push(error.message);
          raised.push(error);
          return yield* next(error);
        },
      });
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
    expect(probe.observed).toEqual([broke()]);
  });

  it("OBS8: an error in a selected <If> branch is observed once", function* () {
    const probe = yield* runProbe("<If condition={true}><Broken /></If>");
    expect(probe.observed).toEqual([broke()]);
  });

  it("OBS9: an error in an <Each> body is observed once", function* () {
    const probe = yield* runProbe('<Each in={[1]} let="n"><Broken /></Each>');
    expect(probe.observed).toEqual([broke()]);

    const twice = yield* runProbe('<Each in={[1, 2]} let="n"><Broken /></Each>');
    expect(twice.observed).toEqual([broke(), broke()]);
  });

  it("OBS10: an error in a <Capture> body is observed once", function* () {
    const probe = yield* runProbe('<Capture as="c"><Broken /></Capture>');
    expect(probe.observed).toEqual([broke()]);
  });

  it("OBS11: an error in a component body is observed once", function* () {
    const probe = yield* runProbe("<Wrap />", { markdown: BODY });
    expect(probe.observed).toEqual([broke()]);
  });

  it("OBS12: an error projected into <Content /> is observed once", function* () {
    const markdown = yield* runProbe("<Wrap><Broken /></Wrap>", { markdown: PROJECT });
    expect(markdown.observed).toEqual([broke()]);

    // Function content is a structured projection: its ErrorSegments abort the
    // generator, and the invocation is replaced by those same segments.
    const fn = yield* runProbe("<Echo><Broken /></Echo>", ECHO);
    expect(fn.observed).toEqual([broke()]);
    const returned = errorSegments(fn.segments);
    expect(returned).toHaveLength(1);
    expect(returned[0]).toBe(fn.raised[0]);
  });

  it("OBS13: an error in a <Loop> body is observed once", function* () {
    const probe = yield* runProbe("<Loop max={1}><Broken /></Loop>");
    expect(probe.observed).toEqual([broke()]);
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
    expect(capture.observed).toEqual([broke()]);
    expect("c" in capture.values).toBe(false);
    expect(capture.output).toContain(broke());

    const each = yield* runProbe('<Each in={[1]} let="n" as="e"><Broken /></Each>');
    expect(each.observed).toEqual([broke()]);
    expect("e" in each.values).toBe(false);
    expect(each.output).toContain(broke());

    const component = yield* runProbe('<Wrap as="w" />', { markdown: BODY });
    expect(component.observed).toEqual([broke()]);
    expect("w" in component.values).toBe(false);
    expect(component.output).toContain(broke());

    const fn = yield* runProbe('<Echo as="f"><Broken /></Echo>', ECHO);
    expect(fn.observed).toEqual([broke()]);
    expect("f" in fn.values).toBe(false);
    expect(fn.output).toContain(broke());
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
      expect(run.observed).toEqual([broke()]);
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
    expect(probe.observed).toEqual([broke()]);

    const returned = errorSegments(probe.segments);
    expect(returned).toHaveLength(1);
    expect(returned[0]).toBe(probe.raised[0]);
  });

  it("OBS19: a refused function capture comes back as the raised segment", function* () {
    const probe = yield* runProbe('<Echo as="f"><Broken /></Echo>', ECHO);
    expect(probe.observed).toEqual([broke()]);
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
    expect(probe.observed).toEqual([broke("first"), broke("second")]);

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
    expect(probe.observed).toEqual([broke("first"), broke("second")]);

    expect(caught).toHaveLength(1);
    const [failure] = caught;
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[0]).toBe(probe.raised[0]);
    expect(failure.errors[1]).toBe(probe.raised[1]);

    // Recovery keeps the failure from the consumer, so nothing settles.
    expect(errorSegments(probe.segments)).toHaveLength(0);
    expect(probe.output).toBe("recovered");
  });

  // OBS22: where the cause is attached, measured from inside the observation
  // chain. Raise middleware that catches what `next` throws is the earliest any
  // observer can see the DocumentationError — settlement constructs it at the end
  // of the chain — so a failure that is complete there is complete everywhere.
  it("OBS22: a contextual failure carries its cause where the chain throws it", function* () {
    const exploded = new Error("component exploded");
    const observed: ErrorSegment[] = [];
    // The cause is read where the middleware catches, not afterwards: a link
    // attached once the chain has unwound would be invisible to a test that
    // inspected the same object at the end of the run.
    const caught: Array<{ failure: DocumentationError; cause: unknown }> = [];
    let thrown: unknown;

    yield* scoped(function* () {
      yield* AmbientErrorPolicy.set("throw");
      yield* Component.around({
        *raise([error], next) {
          observed.push(error);
          try {
            return yield* next(error);
          } catch (failure) {
            if (failure instanceof DocumentationError) {
              caught.push({ failure, cause: failure.cause });
            }
            throw failure;
          }
        },
      });
      yield* Component.around(
        {
          env: () => ({ values: {} }),
          // deno-lint-ignore require-yield
          *importComponent([name], _next) {
            if (name !== "Boom") {
              throw new Error(`Component not found: ${name}`);
            }
            return throwingComponent("Boom", exploded);
          },
        },
        { at: "min" },
      );
      try {
        yield* expandSegments(scanSegments("<Boom />"), {}, {}, new Set());
      } catch (error) {
        thrown = error;
      }
    });

    expect(caught).toHaveLength(1);
    const [{ failure, cause }] = caught;
    expect(cause).toBe(exploded);
    expect(failure.message).toContain("Function component Boom error: component exploded");

    // The same object leaves the expansion, with the same cause.
    expect(thrown).toBe(failure);
    expect(thrown).toBeInstanceOf(DocumentationError);
    expect(failure.cause).toBe(exploded);

    // One observation of the contextual segment, and it is the one the failure
    // carries.
    expect(observed).toHaveLength(1);
    expect(observed[0]).toBe(failure.segment);
  });

  // OBS23: `throw undefined` is still a thrown value. The failure's own `cause`
  // property records it — membership in the attribution, not comparison with
  // undefined, is what distinguishes "translated from undefined" from "no
  // attribution at all".
  it("OBS23: a contextual failure records a thrown undefined as its cause", function* () {
    const observed: ErrorSegment[] = [];
    const caught: Array<{ failure: DocumentationError; hasCause: boolean; cause: unknown }> = [];
    let thrown: unknown;

    yield* scoped(function* () {
      yield* AmbientErrorPolicy.set("throw");
      yield* Component.around({
        *raise([error], next) {
          observed.push(error);
          try {
            return yield* next(error);
          } catch (failure) {
            if (failure instanceof DocumentationError) {
              caught.push({
                failure,
                hasCause: Object.hasOwn(failure, "cause"),
                cause: failure.cause,
              });
            }
            throw failure;
          }
        },
      });
      yield* Component.around(
        {
          env: () => ({ values: {} }),
          // deno-lint-ignore require-yield
          *importComponent([name], _next) {
            if (name !== "Boom") {
              throw new Error(`Component not found: ${name}`);
            }
            return throwingComponent("Boom", undefined);
          },
        },
        { at: "min" },
      );
      try {
        yield* expandSegments(scanSegments("<Boom />"), {}, {}, new Set());
      } catch (error) {
        thrown = error;
      }
    });

    expect(caught).toHaveLength(1);
    const [{ failure, hasCause, cause }] = caught;
    // Present already inside the middleware's catch. A thrown non-Error is
    // normalized on its way out of the invocation, so the diagnostic's cause is
    // that Error and the exact value thrown is one step further down — nothing
    // is lost, it is just no longer the outermost thing.
    expect(hasCause).toBe(true);
    expect(cause).toBeInstanceOf(Error);
    if (!(cause instanceof Error)) {
      throw new Error("expected the diagnostic's cause to be an Error");
    }
    expect(cause.cause).toBe(undefined);
    expect(Object.hasOwn(cause, "cause")).toBe(true);
    expect(thrown).toBe(failure);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toBe(failure.segment);
  });

  it("OBS24: a collected thrown undefined renders a diagnostic and produces no Error", function* () {
    const observed: ErrorSegment[] = [];
    const probe = yield* scoped(function* () {
      yield* Component.around({
        *raise([error], next) {
          observed.push(error);
          return yield* next(error);
        },
      });
      yield* Component.around(
        {
          env: () => ({ values: {} }),
          // deno-lint-ignore require-yield
          *importComponent([name], _next) {
            if (name !== "Boom") {
              throw new Error(`Component not found: ${name}`);
            }
            return throwingComponent("Boom", undefined);
          },
        },
        { at: "min" },
      );
      const segments = yield* expandSegments(scanSegments("<Boom />TAIL"), {}, {}, new Set());
      return { segments, output: renderSegments(segments) };
    });

    // Collecting settles a segment; no DocumentationError is ever constructed,
    // so there is no JavaScript Error to carry a cause.
    expect(observed).toHaveLength(1);
    expect(probe.output).toContain("Function component Boom error");
    expect(probe.output).toContain("TAIL");
  });
});
