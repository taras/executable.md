/**
 * Tier IS — invocation shape (spec §5.5).
 *
 * `hasContent()` reports how the element was written, so a component whose two
 * forms mean different things can branch before projecting anything. Driven
 * through `expandSegments` with the shared harness.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import { renderSegments } from "../src/render.ts";
import { hasContent } from "../src/content-context.ts";
import { component, expandAll, WATCH_BLOCK_OWN } from "./invocation-harness.ts";

describe("Tier IS — Invocation shape", () => {
  function reporter(name: string) {
    return component(name, () =>
      (function* (): Operation<string> {
        return (yield* hasContent()) ? "paired" : "self-closing";
      })(),
    );
  }

  it("IS1: an element written with content reports having content", function* () {
    const expanded = yield* expandAll(`<Shape>anything</Shape>`, { Shape: reporter("Shape") }, []);

    expect(renderSegments(expanded)).toContain("paired");
  });

  // IS2: the shape of the invocation, not what it renders — an empty pair is
  // still a pair.
  it("IS2: an empty pair of tags still reports having content", function* () {
    const expanded = yield* expandAll(`<Shape></Shape>`, { Shape: reporter("Shape") }, []);

    expect(renderSegments(expanded)).toContain("paired");
  });

  it("IS3: a self-closing element reports having none", function* () {
    const expanded = yield* expandAll(`<Shape />`, { Shape: reporter("Shape") }, []);

    expect(renderSegments(expanded)).toContain("self-closing");
  });

  // IS4: asking the question must not project. A component that only calls
  // hasContent() never runs the blocks it was handed.
  it("IS4: hasContent() does not render the children it reports on", function* () {
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
