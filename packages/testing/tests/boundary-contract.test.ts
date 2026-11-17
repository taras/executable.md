/**
 * Tier TC — partial output, stray errors and teardown failures under
 * `<Testing>` and `<Test>`. These distinguish content projection that preserves
 * the report from one that aborts the boundary and loses it.
 */

import { describe, it, beforeAll } from "@executablemd/test-support/bdd";
import { useTempFileCompiler } from "@executablemd/core";
import { expect } from "@executablemd/test-support/expect";
import { documentCases } from "./helpers.ts";

const documentCase = documentCases("packages/testing/tests/boundary-contract.test.ts");

describe("Tier TC — the <Testing> boundary", () => {
  beforeAll(() => useTempFileCompiler());

  // The gap found while planning PR 3: `<Testing>` does not intercept raises —
  // that is `<Test>`'s job — so an error beside a test renders where it was
  // written and the boundary still reports. Projecting the body through
  // `content()` instead would abort the boundary and lose both.
  documentCase(
    "TC1: an error beside a test renders inline, and the boundary still reports",
    function* (runFresh) {
      // The region prints, which is what makes "renders inline and the boundary
      // still reports" a thing the document asked for.
      const doc = [
        "<PrintErrors>",
        "<Testing>",
        "",
        "<Missing />",
        "",
        '<Test name="t"><Assert expr={true} /></Test>',
        "",
        "</Testing>",
        "</PrintErrors>",
        "",
      ].join("\n");

      const run = yield* runFresh({ "README.md": doc });

      // The stray error is rendered, not swallowed and not fatal…
      expect(run.output).toContain("Failed to import component Missing");
      // …the test beside it still ran…
      expect(run.results.map((entry) => entry.status)).toEqual(["pass"]);
      // …and the boundary still reported its outcome.
      expect(run.boundaries).toEqual([{ tests: 1, failed: 0 }]);
    },
  );

  documentCase("TC2: text around a test is preserved in order", function* (runFresh) {
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

    const run = yield* runFresh({ "README.md": doc });

    expect(run.output.indexOf("BEFORE")).toBeGreaterThan(-1);
    expect(run.output.indexOf("AFTER")).toBeGreaterThan(run.output.indexOf("BEFORE"));
  });

  documentCase("TC3: an empty boundary reports zero tests", function* (runFresh) {
    const run = yield* runFresh({ "README.md": "<Testing>\n\nnothing here\n\n</Testing>\n" });

    expect(run.boundaries).toEqual([{ tests: 0, failed: 0 }]);
  });
});

describe("Tier TC — what a <Test> keeps when it fails", () => {
  beforeAll(() => useTempFileCompiler());

  // The behavior `content()` cannot express: a test that fails partway still
  // shows what it rendered up to that point, then its diagnostics.
  documentCase(
    "TC4: output produced before a failure survives, and precedes the diagnostic",
    function* (runFresh) {
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

      const run = yield* runFresh({ "README.md": doc });

      expect(run.results.map((entry) => entry.status)).toEqual(["fail"]);
      expect(run.output).toContain("RENDERED FIRST");
      // The body stopped where it failed.
      expect(run.output).not.toContain("NEVER REACHED");
      // The diagnostic follows what was rendered, rather than replacing it.
      expect(run.output.indexOf("RENDERED FIRST")).toBeLessThan(run.output.indexOf("partial"));
    },
  );

  documentCase("TC5: exactly one result is recorded for a failing test", function* (runFresh) {
    const doc = [
      "<Testing>",
      '<Test name="once"><Assert expr={false} /></Test>',
      "</Testing>",
      "",
    ].join("\n");

    const run = yield* runFresh({ "README.md": doc });

    expect(run.results).toHaveLength(1);
    expect(run.boundaries).toEqual([{ tests: 1, failed: 1 }]);
  });

  documentCase(
    "TC6: a failing test returns only text — no error segment escapes it",
    function* (runFresh) {
      const doc = [
        "<Testing>",
        '<Test name="contained"><Missing /></Test>',
        "",
        "AFTER",
        "</Testing>",
        "",
      ].join("\n");

      const run = yield* runFresh({ "README.md": doc });

      expect(run.results.map((entry) => entry.status)).toEqual(["fail"]);
      // The failure is contained in the test's own report; the boundary carries on.
      expect(run.output).toContain("AFTER");
      expect(run.boundaries).toEqual([{ tests: 1, failed: 1 }]);
    },
  );

  documentCase("TC7: a later test runs after an earlier one fails", function* (runFresh) {
    const doc = [
      "<Testing>",
      '<Test name="first"><Assert expr={false} /></Test>',
      '<Test name="second"><Assert expr={true} /></Test>',
      "</Testing>",
      "",
    ].join("\n");

    const run = yield* runFresh({ "README.md": doc });

    expect(run.results.map((entry) => entry.name)).toEqual(["first", "second"]);
    expect(run.results.map((entry) => entry.status)).toEqual(["fail", "pass"]);
  });

  documentCase("TC8: a nested <Test> fails the enclosing test, and only it", function* (runFresh) {
    const doc = [
      "<Testing>",
      '<Test name="outer">',
      '<Test name="inner"><Assert expr={true} /></Test>',
      "</Test>",
      "</Testing>",
      "",
    ].join("\n");

    const run = yield* runFresh({ "README.md": doc });

    expect(run.results).toHaveLength(1);
    expect(run.results[0]?.name).toBe("outer");
    expect(run.results[0]?.status).toBe("fail");
  });

  documentCase("TC9: bindings a test captures do not escape it", function* (runFresh) {
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

    const run = yield* runFresh({ "README.md": doc });

    expect(run.results.map((entry) => entry.status)).toEqual(["pass"]);
    // The binding did not leak into the document after the boundary.
    expect(run.output).not.toContain("outside: inside");
  });
});
