/**
 * `<Test>` as a registered function component (specs/testing-spec.md).
 *
 * These pin the properties the migration off the `Component.expand` claim had
 * to preserve, each of which broke at least once while it was being made.
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped } from "effection";
import { Component, registerComponents, useTempFileCompiler } from "@executablemd/core";
import type { ErrorSegment } from "@executablemd/core";
import { runDoc } from "./helpers.ts";

describe("<Test> as a function component", () => {
  beforeAll(() => useTempFileCompiler());

  /** An eval block whose retained work fails while the test is dismantled. */
  const FAILING_CLEANUP = [
    "```js persist eval",
    'yield* spawn(function* () { try { yield* suspend(); } finally { throw new Error("cleanup exploded"); } });',
    "```",
  ].join("\n");
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

  // An eval block is not an invocation: what it retains anchors in the test's
  // own eval scope, so its cleanup failing IS the test's invocation teardown.
  // That arrives at the session boundary after <Test> has returned, and has to
  // land on that test's staged result.
  it("records a teardown failure as that test's outcome, and fails only it", function* () {
    const doc = [
      "<Testing>",
      '<Test name="tears">',
      FAILING_CLEANUP,
      "<Assert expr={true} />",
      "</Test>",
      '<Test name="fine"><Assert expr={true} /></Test>',
      "</Testing>",
      "",
    ].join("\n");

    const run = yield* runDoc({ "README.md": doc });

    expect(run.results.map((r) => [r.name, r.status, r.error?.kind])).toEqual([
      ["tears", "fail", "teardown"],
      ["fine", "pass", undefined],
    ]);
    expect(run.results[0]?.error?.message).toContain("cleanup exploded");
  });

  // The body's account is the more useful one, so a test that already failed
  // keeps its own classification when teardown fails too.
  it("keeps the body's classification when teardown also fails", function* () {
    const doc = [
      "<Testing>",
      '<Test name="both">',
      FAILING_CLEANUP,
      "<Assert expr={false} />",
      "</Test>",
      "</Testing>",
      "",
    ].join("\n");

    const run = yield* runDoc({ "README.md": doc });

    expect(run.results[0]?.status).toBe("fail");
    expect(run.results[0]?.error?.kind).toBe("assertion");
  });

  // A component failing beside a test is not the test's outcome: the session
  // layer delegates anything that is not a <Test> invocation.
  it("does not turn a neighbouring component's failure into a test result", function* () {
    const doc = ["<Testing>", '<Test name="only"><Wilting /></Test>', "</Testing>", ""].join("\n");

    const run = yield* scoped(function* () {
      yield* registerComponents([
        {
          name: "Wilting",
          origin: "test",
          props: { type: "object", properties: {}, additionalProperties: false },
          *fn() {
            yield* ensure(function* () {
              throw new Error("component cleanup exploded");
            });
            return "";
          },
        },
      ]);
      return yield* runDoc({ "README.md": doc });
    });

    // One result, for the test that contained it — classified as an ordinary
    // error, because the component's teardown is the component's, not the
    // test's.
    expect(run.results).toHaveLength(1);
    expect(run.results[0]?.name).toBe("only");
    expect(run.results[0]?.error?.kind).toBe("error");
  });
});
