/**
 * Tier TC — what `<Testing>` and `<Test>` guarantee, pinned before they move.
 *
 * These are characterization tests: every one passes against the handlers as
 * they are today, and the migration onto the function-component boundary (#202
 * PR 3) has to keep them passing. They exist because the behaviors the
 * migration is most likely to lose quietly are the ones nothing else asserts —
 * partial output, where a stray error settles, and which failure a teardown
 * produces.
 */

import { describe, it, beforeAll } from "@executablemd/test-support/bdd";
import { useTempFileCompiler } from "@executablemd/core";
import { expect } from "@executablemd/test-support/expect";
import { runDoc } from "./helpers.ts";

describe("Tier TC — the <Testing> boundary", () => {
  beforeAll(() => useTempFileCompiler());

  // The gap found while planning PR 3: `<Testing>` does not intercept raises —
  // that is `<Test>`'s job — so an error beside a test renders where it was
  // written and the boundary still reports. Projecting the body through
  // `content()` instead would abort the boundary and lose both.
  it("TC1: an error beside a test renders inline, and the boundary still reports", function* () {
    const doc = [
      "<Testing>",
      "",
      "<Missing />",
      "",
      '<Test name="t"><Assert expr={true} /></Test>',
      "",
      "</Testing>",
      "",
    ].join("\n");

    const run = yield* runDoc({ "README.md": doc });

    // The stray error is rendered, not swallowed and not fatal…
    expect(run.output).toContain("Failed to import component Missing");
    // …the test beside it still ran…
    expect(run.results.map((entry) => entry.status)).toEqual(["pass"]);
    // …and the boundary still reported its outcome.
    expect(run.boundaries).toEqual([{ tests: 1, failed: 0 }]);
  });

  it("TC2: text around a test is preserved in order", function* () {
    const doc = [
      "<Testing>",
      "",
      "BEFORE",
      "",
      '<Test name="t"><Assert expr={true} /></Test>',
      "",
      "AFTER",
      "",
      "</Testing>",
      "",
    ].join("\n");

    const run = yield* runDoc({ "README.md": doc });

    expect(run.output.indexOf("BEFORE")).toBeGreaterThan(-1);
    expect(run.output.indexOf("AFTER")).toBeGreaterThan(run.output.indexOf("BEFORE"));
  });

  it("TC3: an empty boundary reports zero tests", function* () {
    const run = yield* runDoc({ "README.md": "<Testing>\n\nnothing here\n\n</Testing>\n" });

    expect(run.boundaries).toEqual([{ tests: 0, failed: 0 }]);
  });
});

describe("Tier TC — what a <Test> keeps when it fails", () => {
  beforeAll(() => useTempFileCompiler());

  // The behavior `content()` cannot express: a test that fails partway still
  // shows what it rendered up to that point, then its diagnostics.
  it("TC4: output produced before a failure survives, and precedes the diagnostic", function* () {
    const doc = [
      "<Testing>",
      '<Test name="partial">',
      "",
      "RENDERED FIRST",
      "",
      "<Assert expr={false} />",
      "",
      "NEVER REACHED",
      "",
      "</Test>",
      "</Testing>",
      "",
    ].join("\n");

    const run = yield* runDoc({ "README.md": doc });

    expect(run.results.map((entry) => entry.status)).toEqual(["fail"]);
    expect(run.output).toContain("RENDERED FIRST");
    // The body stopped where it failed.
    expect(run.output).not.toContain("NEVER REACHED");
    // The diagnostic follows what was rendered, rather than replacing it.
    expect(run.output.indexOf("RENDERED FIRST")).toBeLessThan(run.output.indexOf("partial"));
  });

  it("TC5: exactly one result is recorded for a failing test", function* () {
    const doc = [
      "<Testing>",
      '<Test name="once"><Assert expr={false} /></Test>',
      "</Testing>",
      "",
    ].join("\n");

    const run = yield* runDoc({ "README.md": doc });

    expect(run.results).toHaveLength(1);
    expect(run.boundaries).toEqual([{ tests: 1, failed: 1 }]);
  });

  it("TC6: a failing test returns only text — no error segment escapes it", function* () {
    const doc = [
      "<Testing>",
      '<Test name="contained"><Missing /></Test>',
      "",
      "AFTER",
      "</Testing>",
      "",
    ].join("\n");

    const run = yield* runDoc({ "README.md": doc });

    expect(run.results.map((entry) => entry.status)).toEqual(["fail"]);
    // The failure is contained in the test's own report; the boundary carries on.
    expect(run.output).toContain("AFTER");
    expect(run.boundaries).toEqual([{ tests: 1, failed: 1 }]);
  });

  it("TC7: a later test runs after an earlier one fails", function* () {
    const doc = [
      "<Testing>",
      '<Test name="first"><Assert expr={false} /></Test>',
      '<Test name="second"><Assert expr={true} /></Test>',
      "</Testing>",
      "",
    ].join("\n");

    const run = yield* runDoc({ "README.md": doc });

    expect(run.results.map((entry) => entry.name)).toEqual(["first", "second"]);
    expect(run.results.map((entry) => entry.status)).toEqual(["fail", "pass"]);
  });

  it("TC8: a nested <Test> fails the enclosing test, and only it", function* () {
    const doc = [
      "<Testing>",
      '<Test name="outer">',
      '<Test name="inner"><Assert expr={true} /></Test>',
      "</Test>",
      "</Testing>",
      "",
    ].join("\n");

    const run = yield* runDoc({ "README.md": doc });

    expect(run.results).toHaveLength(1);
    expect(run.results[0]?.name).toBe("outer");
    expect(run.results[0]?.status).toBe("fail");
  });

  it("TC9: bindings a test captures do not escape it", function* () {
    const doc = [
      "<Testing>",
      '<Test name="captures">',
      "```js eval",
      'const scoped = "inside";',
      "```",
      '<Assert expr={scoped === "inside"} />',
      "</Test>",
      "</Testing>",
      "",
      "outside: {scoped}",
      "",
    ].join("\n");

    const run = yield* runDoc({ "README.md": doc });

    expect(run.results.map((entry) => entry.status)).toEqual(["pass"]);
    // The binding did not leak into the document after the boundary.
    expect(run.output).not.toContain("outside: inside");
  });
});
