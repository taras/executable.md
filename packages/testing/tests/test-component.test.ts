/**
 * `<Test>` as a registered function component (specs/testing-spec.md).
 *
 * These pin the properties the migration off the `Component.expand` claim had
 * to preserve, each of which broke at least once while it was being made.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import { Component } from "@executablemd/core";
import type { ErrorSegment } from "@executablemd/core";
import { runDoc } from "./helpers.ts";

describe("<Test> as a function component", () => {
  // The raise interceptor answers nearest-first so <AssertThrows> can catch a
  // diagnostic before the test claims it. That must not cost the property the
  // interception exists for: a raise the test does NOT claim still fails it,
  // even when other middleware observed the segment first.
  it("fails the test on a raise an outer observer already saw", function* () {
    const observed: ErrorSegment[] = [];
    const doc = [
      "<Testing>",
      '<Test name="t">',
      '<Strict n="not a number" />',
      "</Test>",
      "</Testing>",
      "",
    ].join("\n");
    const strict = [
      "---",
      "props:",
      "  type: object",
      "  properties:",
      "    n: { type: number }",
      "  required: [n]",
      "---",
      "",
      "ok",
      "",
    ].join("\n");

    const run = yield* scoped(function* () {
      yield* Component.around({
        *raise([segment], next) {
          observed.push(segment);
          return yield* next(segment);
        },
      });
      return yield* runDoc({ "README.md": doc, "Strict.md": strict });
    });

    // The observer saw it, and the test still failed because of it.
    expect(observed.length).toBeGreaterThan(0);
    expect(run.results[0]?.status).toBe("fail");
    expect(run.results[0]?.error?.message).toContain("must be number");
  });

  // Content a component projects is the CALLER's markdown, so `{meta.x}` in it
  // resolves against the frame that wrote it. The legacy handler got this from
  // the Api form of `expandSegments`; projection has to be handed it.
  it("resolves the document's frontmatter inside a test body", function* () {
    const doc = [
      "---",
      "title: Executable MDX",
      "---",
      "",
      "<Testing>",
      '<Test name="t">',
      '<Capture as="heading"># {meta.title}</Capture>',
      '<AssertEquals actual={heading} expected={"# Executable MDX"} />',
      "</Test>",
      "</Testing>",
      "",
    ].join("\n");

    const run = yield* runDoc({ "README.md": doc });

    expect(run.results[0]?.status).toBe("pass");
    expect(run.completion.ok).toBe(true);
  });
});
