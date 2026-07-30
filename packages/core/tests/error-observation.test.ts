import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { expandSegments } from "../src/expand.ts";
import { Component, raise } from "../src/component-api.ts";
import { AmbientErrorPolicy, DocumentationError } from "../src/errors.ts";
import { scanSegments } from "../src/scanner.ts";
import { renderSegments } from "../src/render.ts";

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
